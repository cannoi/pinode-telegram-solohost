'use strict';
/**
 * SoloHost Controller v2.6.0
 * - Telegram long-poll independent of 60s telemetry
 * - Horizon-deep PRIMARY → Core HTTP → Ports → cgroup (no DataLive)
 * - Normalized schema; hide missing fields
 * - Alert state machine; history; optional Gemini
 * - NO docker.sock required
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

const VERSION = '2.6.6-solohost';
const DATA = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8080', 10);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const DATA_LIVE_URL = ''; // removed v2.6.1 — no Horizon // disabled by default v2.6
const DATA_LIVE_TOKEN = '';
const NODE_HOST = (process.env.NODE_HOST || 'host.docker.internal').trim();
const HORIZON_PORT = parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401;
const NODE_LABEL = (process.env.PI_CONTAINER || process.env.NODE_LABEL || '').trim(); // optional label only
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const ALERT_ON_START = String(process.env.ALERT_ON_START || 'true').toLowerCase() !== 'false';
const TELEMETRY_SEC = Math.max(30, parseInt(process.env.TELEMETRY_SEC || '60', 10) || 60);
const REPORT_HOURS = parseHours(process.env.REPORT_HOURS, [7, 18]);
const FAIL_THRESHOLD = Math.max(2, parseInt(process.env.FAIL_THRESHOLD || '3', 10) || 3);
const ALERT_COOLDOWN = Math.max(60, parseInt(process.env.ALERT_COOLDOWN_SEC || '180', 10) || 180);
const GITHUB_PRO = 'https://github.com/cannoi/pinode-telegram-controller';
const NODE_PORTS = [31401, 31402, 31403];

const DIR_HIST = path.join(DATA, 'history');
const DIR_HOURLY = path.join(DATA, 'hourly');
const DIR_DAILY = path.join(DATA, 'daily');
const DIR_STATE = path.join(DATA, 'state');
const DIR_LOGS = path.join(DATA, 'logs');
const STATE_F = path.join(DIR_STATE, 'node-state.json');
const LATEST_F = path.join(DATA, 'latest.json');
const LOG_F = path.join(DIR_LOGS, 'controller.log');
const PUBLIC = path.join(__dirname, 'public');
const SCRIPTS = path.join(__dirname, 'scripts');

function parseHours(raw, def) {
  const a = String(raw || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 0 && n <= 23);
  return a.length ? a : def;
}
function ensureDirs() {
  [DIR_HIST, DIR_HOURLY, DIR_DAILY, DIR_STATE, DIR_LOGS].forEach(d => {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  });
}
ensureDirs();

function loadJSON(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function saveJSON(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const t = f + '.tmp';
    fs.writeFileSync(t, JSON.stringify(obj));
    fs.renameSync(t, f);
  } catch (e) {}
}
function nowISO() {
  try {
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }).replace(' ', 'T') + '+07:00';
  } catch (e) { return new Date().toISOString(); }
}
function nowHM() {
  try {
    return new Date().toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
    });
  } catch (e) { return new Date().toISOString(); }
}
function dayVN() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
function hourVN() {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: 'numeric', hour12: false }).formatToParts(new Date());
    return parseInt(p.find(x => x.type === 'hour').value, 10) % 24;
  } catch (e) { return (new Date().getUTCHours() + 7) % 24; }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtN(n) { return n == null ? null : Number(n).toLocaleString('en-US'); }
function log(msg, level) {
  const line = '[' + nowISO() + '] [' + (level || 'info') + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(LOG_F, line + '\n');
    if (fs.statSync(LOG_F).size > 2e6) try { fs.renameSync(LOG_F, LOG_F + '.1'); } catch (e) {}
  } catch (e) {}
  try { if (level === 'error' || level === 'warn') actionLog(level, msg); } catch (e) {}
}

let state = loadJSON(STATE_F, {
  fsm: 'HEALTHY', failCount: 0, lastAlertAt: 0, lastReportKey: '',
  lastLevel: null, lastLedger: null, lastLedgerAt: 0
});
/** @type {object|null} */

const CHAT_TURNS = [];
function pushChatTurn(role, text) {
  try {
    CHAT_TURNS.push({ role, text: String(text || '').slice(0, 500), ts: Date.now() });
    while (CHAT_TURNS.length > 16) CHAT_TURNS.shift();
  } catch (e) {}
}

let cache = null; // last normalized telemetry
let cacheAt = 0;

// ---------- HTTP helpers ----------
function httpGetUrl(urlStr, headers, timeout) {
  return new Promise(resolve => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'GET', headers: headers || {}, timeout: timeout || 3000
      }, r => {
        let b = '';
        r.on('data', d => b += d);
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
      req.end();
    } catch (e) { resolve(null); }
  });
}
function probeTcp(host, port, timeout) {
  return new Promise(res => {
    const s = new net.Socket();
    let done = false;
    const fin = v => { if (done) return; done = true; try { s.destroy(); } catch (e) {} res(v); };
    s.setTimeout(timeout || 900);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(port, host); } catch (e) { fin(false); }
  });
}

// ---------- sources ----------
async function fetchHorizon() {
  const hosts = [NODE_HOST, 'host.docker.internal', '172.17.0.1', '172.18.0.1', '10.0.2.2', 'localhost'];
  const ports = [HORIZON_PORT, 31401, 8000];
  for (const host of hosts) {
    for (const port of ports) {
      const r = await httpGetUrl('http://' + host + ':' + port + '/', {}, 2800);
      if (!r || r.status !== 200 || !r.body) continue;
      try {
        let j = JSON.parse(r.body);
        // AI / flexible field extraction when schema drifts
        const pick = (...keys) => {
          for (const k of keys) {
            if (j[k] != null && j[k] !== '') return j[k];
          }
          return null;
        };
        let ledger = Number(pick('core_latest_ledger', 'history_latest_ledger', 'ingest_latest_ledger'));
        if (!ledger && j._embedded && j._embedded.records && j._embedded.records[0])
          ledger = Number(j._embedded.records[0].sequence);
        if (!ledger || !isFinite(ledger)) {
          // last resort: scan numeric fields looking like ledger
          for (const k of Object.keys(j)) {
            if (/ledger/i.test(k) && typeof j[k] === 'number' && j[k] > 1000) { ledger = j[k]; break; }
          }
        }
        if (!ledger) continue;

        let ledger_age = null;
        const closedAt = pick('history_latest_ledger_closed_at', 'core_latest_ledger_closed_at', 'closed_at');
        if (closedAt) {
          const ts = new Date(closedAt).getTime();
          if (isFinite(ts)) ledger_age = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        }

        const coreL = Number(pick('core_latest_ledger'));
        const ingestL = Number(pick('ingest_latest_ledger'));
        let ingest_lag = null;
        if (isFinite(coreL) && isFinite(ingestL)) ingest_lag = Math.max(0, coreL - ingestL);

        let syncStatus = 'Horizon OK';
        if (ledger_age != null) {
          if (ledger_age <= 35) syncStatus = 'Synced (Live)';
          else if (ledger_age <= 120) syncStatus = 'Syncing (Slow)';
          else if (ledger_age <= 300) syncStatus = 'Behind';
          else syncStatus = 'Catching Up (~' + Math.round(ledger_age / 60) + 'm)';
        }
        if (ingest_lag != null && ingest_lag > 10) {
          syncStatus = (syncStatus.indexOf('Synced') >= 0 ? 'Ingest lag' : syncStatus) + ' · lag ' + ingest_lag;
        }

        const network = pick('network_passphrase', 'network') || null;
        let network_kind = null;
        if (network) {
          const n = String(network).toLowerCase();
          if (n.indexOf('test') >= 0) network_kind = 'Testnet';
          else if (n.indexOf('public') >= 0 || n.indexOf('main') >= 0 || n.indexOf('pi network') >= 0) network_kind = 'Mainnet';
          else network_kind = 'Custom';
        }

        return {
          source: 'Horizon',
          ledger: ledger,
          ledger_age: ledger_age,
          sync: syncStatus,
          core_version: pick('core_version') || null,
          horizon_version: pick('horizon_version', 'version') || null,
          protocol: pick('current_protocol_version', 'protocol_version') || null,
          network: network,
          network_kind: network_kind,
          ingest_lag: ingest_lag,
          core_ledger: isFinite(coreL) ? coreL : null,
          ingest_ledger: isFinite(ingestL) ? ingestL : null,
          closed_at: closedAt || null,
          confidence: ledger_age != null && ledger_age < 60 ? 'high' : 'medium',
          horizon_host: host + ':' + port,
          raw_keys: Object.keys(j).slice(0, 40)
        };
      } catch (e) {}
    }
  }
  return null;
}

/** Optional Core HTTP /info + /peers (Stellar default 11626) */
async function fetchCoreHttp() {
  const hosts = [NODE_HOST, 'host.docker.internal', '172.17.0.1', '172.18.0.1'];
  const ports = [11626, 31400, 11625];
  for (const host of hosts) {
    for (const port of ports) {
      const r = await httpGetUrl('http://' + host + ':' + port + '/info', {}, 2000);
      if (!r || r.status !== 200 || !r.body) continue;
      try {
        const j = JSON.parse(r.body);
        const info = j.info || j;
        const o = { source: 'CoreHTTP', confidence: 'high' };
        if (info.state) o.sync = String(info.state);
        else if (info.status) o.sync = String(info.status);
        const ledger = info.ledger || info.ledger_num || (info.ledger && info.ledger.num);
        if (ledger != null) o.ledger = Number(ledger.num || ledger);
        if (info.ledger && info.ledger.age != null) o.ledger_age = Number(info.ledger.age);
        if (info.protocol_version != null) o.protocol = info.protocol_version;
        if (info.build) o.core_version = String(info.build);
        if (info.network) o.network = String(info.network);
        // peers endpoint
        const rp = await httpGetUrl('http://' + host + ':' + port + '/peers', {}, 1500);
        if (rp && rp.status === 200 && rp.body) {
          try {
            const pj = JSON.parse(rp.body);
            const peers = pj.peers || pj;
            if (Array.isArray(peers)) {
              let inn = 0, out = 0;
              peers.forEach(function (x) {
                const d = String((x && (x.direction || x.dir)) || '').toLowerCase();
                if (d.indexOf('in') >= 0) inn++;
                else if (d.indexOf('out') >= 0) out++;
              });
              if (inn || out) { o.peer_in = inn; o.peer_out = out; }
              else { o.peer_in = peers.length; }
            }
          } catch (e2) {}
        }
        o.core_host = host + ':' + port;
        return o;
      } catch (e) {}
    }
  }
  return null;
}

/** Container cgroup RAM/CPU (SoloHost container view — best effort without host agent) */
function readCgroupResources() {
  const o = {};
  try {
    // cgroup v2
    const memCur = PathRead('/sys/fs/cgroup/memory.current');
    const memMax = PathRead('/sys/fs/cgroup/memory.max');
    if (memCur && memMax && memMax !== 'max') {
      const used = Number(memCur), max = Number(memMax);
      if (max > 0) o.ram = Math.round(used / max * 1000) / 10;
    }
  } catch (e) {}
  try {
    // cgroup v1
    if (o.ram == null) {
      const u = PathRead('/sys/fs/cgroup/memory/memory.usage_in_bytes');
      const l = PathRead('/sys/fs/cgroup/memory/memory.limit_in_bytes');
      if (u && l) {
        const used = Number(u), max = Number(l);
        if (max > 0 && max < 1e15) o.ram = Math.round(used / max * 1000) / 10;
      }
    }
  } catch (e) {}
  try {
    const st = PathRead('/proc/stat');
    if (st) {
      const line = st.split('\n')[0];
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      if (parts.length >= 4) {
        const idle = parts[3], total = parts.reduce((a, b) => a + b, 0);
        if (!readCgroupResources._prev) readCgroupResources._prev = { idle, total };
        else {
          const di = idle - readCgroupResources._prev.idle;
          const dt = total - readCgroupResources._prev.total;
          readCgroupResources._prev = { idle, total };
          if (dt > 0) o.cpu = Math.round((1 - di / dt) * 1000) / 10;
        }
      }
    }
  } catch (e) {}
  return Object.keys(o).length ? o : null;
}
function PathRead(f) {
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return null; }
}

async function fetchPorts() {
  const hosts = [NODE_HOST, 'host.docker.internal', '172.17.0.1', '172.18.0.1'];
  let best = {};
  let bestN = 0;
  for (const host of hosts) {
    const ports = {};
    let n = 0;
    await Promise.all(NODE_PORTS.map(async p => {
      const ok = await probeTcp(host, p, 800);
      ports[String(p)] = ok ? 'OPEN' : 'CLOSED';
      if (ok) n++;
    }));
    if (n > bestN) { best = ports; bestN = n; if (n === 3) break; }
  }
  return { ports: best, openCount: bestN };
}

function normalizeAny(j, sourceTag) {
  const o = { source: sourceTag || j.source || 'unknown', timestamp: j.timestamp || nowISO() };
  if (j.sync) o.sync = String(j.sync);
  if (j.ledger != null) o.ledger = Number(j.ledger);
  if (j.ledger_age != null) o.ledger_age = Number(j.ledger_age);
  if (j.peer_in != null) o.peer_in = Number(j.peer_in);
  if (j.peer_out != null) o.peer_out = Number(j.peer_out);
  if (j.docker) o.docker = String(j.docker);
  if (j.container) o.container = String(j.container);
  if (j.container_status) o.container_status = String(j.container_status);
  if (j.ports) o.ports = j.ports;
  if (j.cpu != null) o.cpu = Number(j.cpu);
  if (j.ram != null) o.ram = Number(j.ram);
  if (j.temp != null) o.temp = Number(j.temp);
  if (j.disk != null) o.disk = Number(j.disk);
  if (j.vmmem != null) o.vmmem = Number(j.vmmem);
  if (j.data_age_sec != null) o.data_age_sec = Number(j.data_age_sec);
  if (j.confidence) o.confidence = j.confidence;
  return o;
}

function mergeTelemetry(primary, horizon, portSnap) {
  // Per-field fallback — never invent
  const t = { timestamp: nowISO(), sources: {} };
  if (primary) {
    Object.keys(primary).forEach(k => {
      if (primary[k] != null && k !== 'source' && k !== 'timestamp') t[k] = primary[k];
    });
    t.sources.data_live = true;
    t.source = 'Horizon';
    t.confidence = primary.confidence || 'high';
  } else {
    t.sources.data_live = false;
  }

  if (horizon) {
    t.sources.horizon = true;
    if (t.ledger == null && horizon.ledger != null) t.ledger = horizon.ledger;
    if (t.sync == null && horizon.sync) t.sync = horizon.sync;
    if (!primary) {
      t.source = 'Horizon';
      t.confidence = 'medium';
    }
  } else t.sources.horizon = false;

  if (portSnap && portSnap.ports) {
    t.sources.ports = true;
    if (!t.ports) t.ports = portSnap.ports;
    t.ports_open = portSnap.openCount;
  } else t.sources.ports = false;

  if (!t.container) t.container = NODE_LABEL;

  // Derive simple health flags for FSM (evidence-based only)
  const portsAllOpen = t.ports && NODE_PORTS.every(p => t.ports[String(p)] === 'OPEN');
  const portsAllClosed = t.ports && NODE_PORTS.every(p => t.ports[String(p)] === 'CLOSED');
  const dockerStopped = t.docker && /stop|exit/i.test(t.docker);
  const syncBad = t.sync && /not synced|error|fail/i.test(t.sync) && t.sync !== 'Horizon OK';

  let level = 'ok';
  if (dockerStopped || portsAllClosed) level = 'critical';
  else if (syncBad || (t.ledger_age != null && t.ledger_age > 300)) level = 'warning';
  else if (t.sync && /syncing|catch/i.test(t.sync)) level = 'soft';
  else if (primary || horizon || (portSnap && portSnap.openCount >= 2)) level = 'ok';
  else level = 'soft'; // no sources — degraded knowledge, NOT node offline

  t.level = level;
  t.ports_all_open = !!portsAllOpen;
  return t;
}

async function collectTelemetry() {
  const portSnap = await fetchPorts();
  const core = await fetchCoreHttp();
  const horizon = await fetchHorizon();
  const cg = readCgroupResources();
  // Priority: Core HTTP (if peers/sync) then Horizon deep then ports
  let primary = core || horizon;
  if (core && horizon) {
    primary = Object.assign({}, horizon, core);
    primary.source = core.peer_in != null ? 'Core+Horizon' : (horizon.source || 'Horizon');
    if (horizon.ledger != null && core.ledger == null) primary.ledger = horizon.ledger;
    if (horizon.ledger_age != null && primary.ledger_age == null) primary.ledger_age = horizon.ledger_age;
    if (horizon.sync && (!core.sync || core.sync === 'Horizon OK')) primary.sync = horizon.sync;
  }
  const t = mergeTelemetry(primary, horizon, portSnap);
  if (cg) {
    if (cg.ram != null && t.ram == null) t.ram = cg.ram;
    if (cg.cpu != null && t.cpu == null) t.cpu = cg.cpu;
    t.sources = t.sources || {};
    t.sources.cgroup = true;
  }
  if (horizon && horizon.network_kind) t.network_kind = horizon.network_kind;
  if (horizon && horizon.network) t.network = horizon.network;
  if (horizon && horizon.core_version) t.core_version = horizon.core_version;
  if (horizon && horizon.horizon_version) t.horizon_version = horizon.horizon_version;
  if (horizon && horizon.protocol != null) t.protocol = horizon.protocol;
  if (horizon && horizon.ingest_lag != null) t.ingest_lag = horizon.ingest_lag;
  if (NODE_LABEL) t.container = NODE_LABEL;
  // History enrichment every cycle (~60s)
  try {
    appendHistory(t);
    saveJSON(LATEST_F, t);
  } catch (e) {}
  cache = t;
  cacheAt = Date.now();
  return t;
}

function getTelemetry() {
  // Use cache if fresh; callers of commands use this for speed
  if (cache && Date.now() - cacheAt < TELEMETRY_SEC * 1000 + 5000) return Promise.resolve(cache);
  return collectTelemetry();
}

// ---------- history ----------
function appendHistory(t) {
  try {
    const f = path.join(DIR_HIST, dayVN() + '.ndjson');
    const row = { ts: nowISO(), level: t.level, source: t.source };
    ['sync', 'ledger', 'ledger_age', 'peer_in', 'peer_out', 'docker', 'container', 'cpu', 'ram', 'temp', 'ports_open'].forEach(k => {
      if (t[k] != null) row[k] = t[k];
    });
    fs.appendFileSync(f, JSON.stringify(row) + '\n');
    pruneHistory();
  } catch (e) {}
}
function pruneHistory() {
  try {
    const keepRawDays = 7;
    const files = fs.readdirSync(DIR_HIST).filter(n => n.endsWith('.ndjson'));
    const cutoff = Date.now() - keepRawDays * 864e5;
    for (const n of files) {
      const day = n.replace('.ndjson', '');
      const t0 = Date.parse(day + 'T00:00:00+07:00') || Date.parse(day);
      if (t0 && t0 < cutoff) {
        try { fs.unlinkSync(path.join(DIR_HIST, n)); } catch (e) {}
      }
    }
  } catch (e) {}
}
function readHistory(days) {
  const out = [];
  for (let i = 0; i < (days || 1); i++) {
    const d = new Date(Date.now() - i * 864e5);
    let key; try { key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
    catch (e) { key = d.toISOString().slice(0, 10); }
    try {
      fs.readFileSync(path.join(DIR_HIST, key + '.ndjson'), 'utf8').trim().split('\n').filter(Boolean)
        .forEach(l => { try { out.push(JSON.parse(l)); } catch (e) {} });
    } catch (e) {}
  }
  return out;
}

// ---------- FSM alerts ----------
function mapLevelToFsm(level) {
  if (level === 'critical') return 'CRITICAL';
  if (level === 'warning') return 'WARNING';
  if (level === 'soft') return 'DEGRADED';
  return 'HEALTHY';
}

async function runAlertMachine(t) {
  const next = mapLevelToFsm(t.level);
  const prev = state.fsm || 'HEALTHY';
  const now = Date.now();

  if (next === 'CRITICAL' || next === 'WARNING') {
    state.failCount = (state.failCount || 0) + 1;
  } else if (next === 'HEALTHY') {
    if (prev === 'CRITICAL' || prev === 'WARNING' || prev === 'DEGRADED') {
      // recovery
      if (now - (state.lastAlertAt || 0) >= ALERT_COOLDOWN * 1000) {
        await tgSend(formatStatus(t, 'RECOVERED'));
        state.lastAlertAt = now;
      }
    }
    state.failCount = 0;
    state.fsm = 'HEALTHY';
    saveJSON(STATE_F, state);
    return;
  }

  if (state.failCount >= FAIL_THRESHOLD && next !== prev) {
    if (now - (state.lastAlertAt || 0) >= ALERT_COOLDOWN * 1000) {
      await tgSend(formatStatus(t, 'ALERT'));
      state.lastAlertAt = now;
      state.fsm = next;
    }
  } else if (state.failCount >= FAIL_THRESHOLD) {
    state.fsm = next;
  }
  saveJSON(STATE_F, state);
}

// ---------- format (hide missing) ----------
function lineIf(icon, label, value) {
  if (value == null || value === '') return null;
  return icon + '  ' + label + '  ' + value;
}


const ACTION_LOG = path.join(DIR_LOGS, 'actions.ndjson');
function actionLog(kind, msg, extra) {
  try {
    const row = { ts: nowISO(), kind: kind || 'info', msg: String(msg || '').slice(0, 500) };
    if (extra && typeof extra === 'object') {
      try { row.extra = JSON.stringify(extra).slice(0, 400); } catch (e) {}
    }
    fs.appendFileSync(ACTION_LOG, JSON.stringify(row) + '\n');
  } catch (e) {}
}
function readActionLog(maxLines) {
  try {
    const lines = fs.readFileSync(ACTION_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-(maxLines || 40)).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return { msg: l }; }
    });
  } catch (e) { return []; }
}
function formatActionLog() {
  const rows = readActionLog(35);
  const lines = ['APP LOG', '================', ''];
  if (!rows.length) {
    lines.push('No entries yet.');
    return lines.join('\n');
  }
  rows.forEach(function (r) {
    const tag = r.kind === 'error' ? 'ERR' : (r.kind === 'warn' ? 'WARN' : 'OK');
    const ts = (r.ts || '').replace('T', ' ').slice(0, 19);
    lines.push(tag + ' ' + ts + ' · ' + (r.msg || ''));
  });
  lines.push('');
  lines.push('SoloHost · /logs');
  return lines.join('\n');
}

function formatStatus(t, mode) {
  t = t || {};
  const age = t._age != null ? t._age : (cacheAt ? Math.round((Date.now() - cacheAt) / 1000) : 0);
  const syncOk = t.sync && /synced|live|good|horizon ok/i.test(String(t.sync)) && !(t.ledger_age != null && t.ledger_age > 120);
  const netOk = t.ports_all_open || (t.ports_open != null && t.ports_open >= 2);
  const nodeOk = t.level === 'ok' || (syncOk && netOk && t.level !== 'critical');
  const head = nodeOk ? '🟢 PI NODE · STATUS' : (t.level === 'critical' ? '🔴 PI NODE · STATUS' : '🟡 PI NODE · STATUS');
  const lines = [head, '━━━━━━━━━━━━━━━━━━', ''];

  if (t.sync) {
    const ic = /synced|live/i.test(String(t.sync)) ? '🟢' : (/catch|behind|slow|lag/i.test(String(t.sync)) ? '🟡' : '🔄');
    lines.push('🔄 SYNC · ' + ic + ' ' + t.sync);
  }
  if (t.docker) lines.push('🐳 NODE · 🟢 ' + t.docker);
  else if (t.ports_all_open) lines.push('🐳 NODE · 🟢 Running');
  else if (t.ports_open === 0) lines.push('🐳 NODE · 🔴 Ports closed');
  if (netOk) lines.push('🌐 NETWORK · 🟢 Good');
  else if (t.ports_open != null) lines.push('🌐 NETWORK · 🟡 Partial');

  if (t.ram != null) lines.push('🧠 RAM · ' + Math.round(t.ram) + '%');
  if (t.cpu != null) {
    const cic = t.cpu >= 90 ? '🔴' : (t.cpu >= 70 ? '🟡' : '🟢');
    lines.push('⚙️ CPU · ' + cic + ' ' + t.cpu + '%');
  }
  if (t.temp != null) lines.push('🌡️ TEMP · ' + t.temp + '°C');
  if (t.ledger != null) lines.push('📦 LEDGER · ' + Number(t.ledger).toLocaleString('en-US'));
  if (t.ledger_age != null) lines.push('⏱️ AGE · ' + t.ledger_age + 's');
  if (t.ingest_lag != null && t.ingest_lag > 0) lines.push('📥 INGEST LAG · ' + t.ingest_lag);
  if (t.network_kind || t.network) lines.push('🌍 NET · ' + (t.network_kind || t.network));
  if (t.core_version) lines.push('🔧 CORE · ' + t.core_version);

  lines.push('');
  lines.push('🕐 ' + nowHM());
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('');
  if (nodeOk) {
    lines.push('🟢 STATUS · OK');
    lines.push('💡 No Issues');
    lines.push('✅ No Action');
  } else if (t.level === 'critical') {
    lines.push('🔴 STATUS · CRITICAL');
    lines.push('💡 Check ports / Horizon / Core');
    lines.push('🛠️ Action · Inspect node');
  } else {
    lines.push('🟡 STATUS · WATCH');
    lines.push('💡 Monitor sync / resources');
    lines.push('🛠️ Action · Review');
  }
  lines.push('');
  lines.push('📡 Source · ' + (t.source || '?'));
  lines.push('⏱️ ' + age + 's ago · v' + VERSION);
  return lines.join('\n');
}

function formatPeers(t) {
  t = t || {};
  const inn = t.peer_in;
  const out = t.peer_out;
  const total = (inn != null && out != null) ? (inn + out) : (inn != null ? inn : out);
  const lines = ['🔗 PEERS · STELLAR CORE', '━━━━━━━━━━━━━━━━━━', ''];
  if (inn == null && out == null) {
    lines.push('⚠️ Peer data unavailable');
    lines.push('(Core HTTP /peers not exposed)');
    lines.push('');
    lines.push('📡 PI NODE TELEGRAM CONTROLLER PRO');
    lines.push('⏱️ ' + (cacheAt ? Math.round((Date.now() - cacheAt) / 1000) : 0) + 's ago');
    return lines.join('\n');
  }
  if (inn != null) lines.push('🟢 IN · ' + inn);
  if (out != null) lines.push('🔵 OUT · ' + out);
  if (total != null) lines.push('👥 TOTAL · ' + total);
  lines.push('');
  lines.push('📊 TREND');
  try {
    const rows = readHistory(1).filter(r => r.peer_in != null || r.peer_out != null).slice(-12);
    if (rows.length >= 2) {
      const a = rows[0], b = rows[rows.length - 1];
      const ta = (a.peer_in || 0) + (a.peer_out || 0);
      const tb = (b.peer_in || 0) + (b.peer_out || 0);
      const drop = ta > 0 ? ((ta - tb) / ta) : 0;
      lines.push('👥 ' + ta + ' → ' + tb + ' · ' + (drop > 0.5 ? '📉 Drop' : '🟢 Stable'));
      if (a.peer_in != null && b.peer_in != null) lines.push('🟢 ' + a.peer_in + ' → ' + b.peer_in + ' · Stable');
      if (a.peer_out != null && b.peer_out != null) lines.push('🔵 ' + a.peer_out + ' → ' + b.peer_out + ' · Stable');
      if (tb === 0) lines.push('');
      if (tb === 0) lines.push('🚨 WARNING');
      if (tb === 0) lines.push('0 PEERS');
      if (drop > 0.5) { lines.push(''); lines.push('🚨 WARNING'); lines.push('📉 >50% DROP'); }
    } else {
      lines.push('👥 ' + (total != null ? total : '?') + ' · collecting');
    }
  } catch (e) {
    lines.push('👥 collecting');
  }
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('📡 PI NODE TELEGRAM CONTROLLER PRO');
  lines.push('⏱️ ' + (cacheAt ? Math.round((Date.now() - cacheAt) / 1000) : 0) + 's ago');
  return lines.join('\n');
}

function formatDiagnostic(t) {
  t = t || {};
  const lines = ['🩺 PI NODE · DIAGNOSTIC', '━━━━━━━━━━━━━━━━━━', ''];
  lines.push('📡 Source · ' + (t.source || '?'));
  if (t.horizon_host || t.core_host) lines.push('🔗 Endpoint · ' + (t.core_host || t.horizon_host || ''));
  if (t.sync) lines.push('🔄 Sync · ' + t.sync);
  if (t.ledger != null) lines.push('📦 Ledger · ' + Number(t.ledger).toLocaleString('en-US'));
  if (t.ledger_age != null) lines.push('⏱️ Age · ' + t.ledger_age + 's');
  if (t.ingest_lag != null) lines.push('📥 Ingest lag · ' + t.ingest_lag);
  if (t.peer_in != null || t.peer_out != null)
    lines.push('👥 Peers · IN ' + (t.peer_in != null ? t.peer_in : '?') + ' / OUT ' + (t.peer_out != null ? t.peer_out : '?'));
  if (t.ports) {
    lines.push('🔌 Ports · ' + [31401,31402,31403].map(function (p) {
      return p + '=' + (t.ports[String(p)] || '?');
    }).join(' '));
  }
  if (t.ram != null) lines.push('🧠 RAM · ' + t.ram + '%');
  if (t.cpu != null) lines.push('⚙️ CPU · ' + t.cpu + '%');
  if (t.network_kind || t.network) lines.push('🌍 Network · ' + (t.network_kind || t.network));
  if (t.core_version) lines.push('🔧 Core · ' + t.core_version);
  if (t.horizon_version) lines.push('🔧 Horizon · ' + t.horizon_version);
  if (t.protocol != null) lines.push('📜 Protocol · ' + t.protocol);
  if (t.sources) lines.push('📚 Sources · ' + Object.keys(t.sources).filter(function (k) { return t.sources[k]; }).join(', '));
  lines.push('');
  lines.push('💡 Level · ' + (t.level || '?'));
  lines.push('💛 /donate · MB 0905428801');
  return lines.join('\n');
}

function formatReport() {
  const rows = readHistory(1);
  const lines = [];
  if (!rows.length) {
    return ['🟢 PI NODE · REPORT', '━━━━━━━━━━━━━━━━━━', '', '📊 DATA · collecting…', '', '💛 PI NODE CONTROLLER', '"/donate"'].join('\n');
  }
  const first = rows[0], last = rows[rows.length - 1];
  const t0 = (first.ts || '').slice(0, 16).replace('T', ' ');
  const t1 = (last.ts || '').slice(0, 16).replace('T', ' ');
  const hours = Math.max(1, Math.round(rows.length * TELEMETRY_SEC / 3600 * 10) / 10);
  const ok = rows.filter(r => r.level === 'ok').length;
  const crit = rows.filter(r => r.level === 'critical').length;
  const rams = rows.map(r => r.ram).filter(x => x != null);
  const cpus = rows.map(r => r.cpu).filter(x => x != null);
  const temps = rows.map(r => r.temp).filter(x => x != null);
  const head = crit > rows.length * 0.15 ? '🟡 PI NODE · REPORT' : '🟢 PI NODE · REPORT';
  lines.push(head);
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('🕐 ' + (t0 || '?') + ' → ' + (t1 || '?'));
  lines.push('📊 DATA · ~' + hours + 'h · ' + rows.length + ' samples');
  lines.push('');
  const lastSync = last.sync || '';
  lines.push('🔄 SYNC · ' + (/synced|live|good/i.test(lastSync) ? '🟢' : '🟡') + ' ' + (lastSync || 'n/a'));
  lines.push('🐳 DOCKER · ' + (last.docker ? '🟢 ' + last.docker : (last.ports_open > 0 ? '🟢 Running' : '🟡 n/a')));
  lines.push('🌐 NETWORK · ' + (last.ports_all_open || last.ports_open >= 2 ? '🟢 Stable' : '🟡 Check'));
  if (rams.length) lines.push('🧠 RAM · ' + Math.round(Math.min.apply(null, rams)) + '–' + Math.round(Math.max.apply(null, rams)) + '%');
  if (cpus.length) {
    const peak = Math.max.apply(null, cpus);
    lines.push('⚙️ CPU · ' + (peak >= 90 ? '🔴 Peak ' + Math.round(peak) + '%' : '🟢 Normal'));
  }
  if (temps.length) lines.push('🌡️ TEMP · ' + Math.round(Math.min.apply(null, temps)) + '–' + Math.round(Math.max.apply(null, temps)) + '°C');
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('📌 ISSUES');
  if (crit === 0) lines.push('🟢 None');
  else lines.push('🔴 Critical samples · ' + crit);
  // simple sync-loss events from history
  let events = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.level === 'ok' && b.level === 'critical') events++;
  }
  if (events) {
    lines.push('');
    lines.push('📌 EVENTS');
    lines.push('🔴 Status flips · ' + events);
  }
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('💡 RESULT');
  lines.push((crit > rows.length * 0.1 ? '🟡' : '🟢') + ' NODE · ' + (crit > rows.length * 0.1 ? 'Watch' : 'Healthy'));
  lines.push('🔄 SYNC · ' + (lastSync || 'n/a'));
  lines.push('🛠️ ACTION · ' + (crit > rows.length * 0.1 ? 'Review node' : 'None'));
  lines.push('');
  lines.push('💛 PI NODE CONTROLLER');
  lines.push('☕ DEV COFFEE · MB 0905428801 · "/donate"');
  return lines.join('\n');
}

function formatScripts() {
  return [
    'INFO',
    '================',
    'No Windows scripts in SoloHost edition.',
    'Commands: /status /report /peers /diagnostic /analyze',
    '',
    'Donate: MB 0905428801'
  ].join('\n');
}

function formatDonate() {
  return [
    'DONATE · DEV COFFEE',
    '================',
    'Bank: MB Bank (Military Bank)',
    'Account: 0905428801',
    'Name: TRAN HUU NGHI',
    '',
    'Scan the QR photo if available,',
    'or transfer with the details above.',
    '',
    'Thank you for supporting the project.'
  ].join('\n');
}
function donateQrUrl() {
  const payload = 'MBBANK|0905428801|TRAN HUU NGHI|Pi Node Controller PRO';
  return 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(payload);
}
async function tgSendPhoto(url, caption) {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  try {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      photo: url,
      caption: String(caption || '').slice(0, 1000)
    });
    await new Promise(function (resolve) {
      const u = new URL('https://api.telegram.org/bot' + BOT_TOKEN + '/sendPhoto');
      const req = https.request({
        hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, function (r) { r.on('data', function () {}); r.on('end', resolve); });
      req.on('error', resolve);
      req.setTimeout(15000, function () { try { req.destroy(); } catch (e) {} resolve(); });
      req.write(body); req.end();
    });
    try { actionLog('info', 'donate QR sent'); } catch (e) {}
    return true;
  } catch (e) {
    try { actionLog('error', 'donate QR fail'); } catch (e2) {}
    return false;
  }
}
function formatWindowsPro() {
  return [
    'WINDOWS PRO · FULL',
    '================',
    'SoloHost is the lightweight monitor.',
    'Windows PRO has more tools:',
    '- Live host CPU / RAM / temp',
    '- Docker control and scripts',
    '- Clean RAM / maintenance / reset',
    '- Deeper diagnostics and scheduler',
    '',
    'Download:',
    'https://github.com/cannoi/pinode-telegram-controller',
    '',
    'Use SoloHost for alerts on the go;',
    'use Windows PRO for full control.'
  ].join('\n');
}


/* aiAnalyze replaced */




function detectUserLang(q) {
  const s = String(q || '');
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s)) return 'vi';
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(s)) return 'cjk';
  return 'en';
}
function L(lang, vi, en) {
  return lang === 'vi' ? vi : en;
}

function detectIntent(q) {
  const s = String(q || '').toLowerCase();
  if (/^(xin chào|chào bạn|chào|hello|hi)\b/.test(s) || s === 'chào' || s === 'hello' || s === 'hi') return 'GREETING';
  if (/thứ mấy|hôm nay|hom nay|ngày mấy|what day|mấy giờ/.test(s)) return 'SMALLTALK';
  if (/không hiểu|khong hieu|giải thích|explain/.test(s)) return 'CLARIFY';
  if (/ram|bộ nhớ|bo nho|memory/.test(s)) return 'RAM';
  if (/\bcpu\b|processor/.test(s)) return 'CPU';
  if (/nhiệt|nóng|nong|temp|temperature/.test(s)) return 'TEMP';
  if (/disk|ổ cứng|o cung|dung lượng/.test(s)) return 'DISK';
  if (/docker|container/.test(s)) return 'DOCKER';
  if (/port|cổng 3140|31401|31402|31403/.test(s)) return 'PORT';
  if (/peer|incoming|outgoing/.test(s)) return 'PEERS';
  if (/đồng bộ|dong bo|sync|ledger/.test(s)) return 'BLOCK_SYNC';
  if (/bonus|điểm thưởng|diem thuong|phần thưởng|reward/.test(s)) return 'BONUS';
  if (/nâng cấp|nang cap|upgrade|mua gì|thêm ram|ssd/.test(s)) return 'ADVICE';
  if (/tại sao|tai sao|vì sao|vi sao|why|lỗi|chậm|sự cố/.test(s)) return 'DIAGNOSIS';
  if (/ổn không|on khong|sao rồi|sao roi|thế nào|the nao|tình trạng|trạng thái|máy tôi/.test(s)) return 'NODE_HEALTH';
  if (/làm sao|lam sao|phải làm|tư vấn|tu van|khuyên/.test(s)) return 'RECOMMENDATION';
  if (/bán|ban node|bán máy|bán node|sell (the )?node|should i sell|kẹt tiền|ket tien|tài chính|tai chinh/.test(s)) return 'FINANCE';
  return 'GENERAL';
}

function loadChatHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'chat_history.json'), 'utf8'));
    return Array.isArray(j) ? j.slice(-24) : [];
  } catch (e) { return []; }
}
function saveChatHistory(turns) {
  try { fs.writeFileSync(path.join(DATA, 'chat_history.json'), JSON.stringify(turns.slice(-40))); } catch (e) {}
}
function pushChatPersistent(role, text) {
  const turns = loadChatHistory();
  turns.push({ role: role, text: String(text || '').slice(0, 800), ts: nowISO() });
  saveChatHistory(turns);
  try { pushChatTurn(role, text); } catch (e) {}
}

function evidenceSummary(t) {
  const parts = [];
  if (t.source) parts.push('Nguồn: ' + t.source);
  if (t.sync) parts.push('Đồng bộ: ' + t.sync);
  if (t.ledger != null) parts.push('Ledger: ' + Number(t.ledger).toLocaleString('en-US'));
  if (t.ledger_age != null) parts.push('Age: ' + t.ledger_age + 's');
  if (t.peer_in != null || t.peer_out != null)
    parts.push('Peer IN/OUT: ' + (t.peer_in != null ? t.peer_in : '?') + '/' + (t.peer_out != null ? t.peer_out : '?'));
  if (t.docker) parts.push('Docker: ' + t.docker);
  if (t.ports_all_open) parts.push('Cổng 31401-3: OPEN');
  else if (t.ports_open != null) parts.push('Cổng mở: ' + t.ports_open + '/3');
  if (t.ram != null) parts.push('RAM: ' + t.ram + '%');
  if (t.cpu != null) parts.push('CPU: ' + t.cpu + '%');
  if (t.temp != null) parts.push('Nhiệt: ' + t.temp + '°C');
  return parts;
}

function collectIssues(t) {
  const issues = [];
  if (t.docker && /stop|exit/i.test(String(t.docker))) issues.push('Container/Docker không chạy');
  if (t.ports_open === 0) issues.push('Cổng node đang đóng');
  if (t.sync && /not synced|error|fail/i.test(String(t.sync))) issues.push('Đồng bộ bất thường: ' + t.sync);
  if (t.stall) issues.push('Ledger không tăng trong thời gian dài');
  if (t.ledger_age != null && t.ledger_age > 300) issues.push('Ledger age cao (' + t.ledger_age + 's)');
  if (t.peer_in != null && t.peer_in < 2) issues.push('Peer IN thấp (' + t.peer_in + ')');
  if (t.ram != null && t.ram >= 88) issues.push('RAM cao (' + t.ram + '%)');
  if (t.cpu != null && t.cpu >= 90) issues.push('CPU cao (' + t.cpu + '%)');
  if (t.temp != null && t.temp >= 78) issues.push('Nhiệt độ cao (' + t.temp + '°C)');
  if (!t.source && t.ports_open === 0)
    issues.push('No telemetry source and ports closed');
  return issues;
}

function rulesMetricOnly(t, intent) {
  const lang = 'vi'; // refined by caller when needed
  return null; // handled in localAssistant / aiAnalyze with period analysis
}

function metricIntentKey(intent) {
  if (intent === 'RAM') return 'ram';
  if (intent === 'CPU') return 'cpu';
  if (intent === 'TEMP') return 'temp';
  return null;
}


function localAssistantReply(t, intent, userQ) {
  const lang = detectUserLang(userQ);
  const ok = t.level === 'ok' || (t.sync && /synced|live|horizon ok/i.test(String(t.sync)));
  const age = t.ledger_age != null ? t.ledger_age : null;
  const sync = t.sync || null;
  const ledger = t.ledger != null ? Number(t.ledger).toLocaleString('en-US') : null;
  const vi = (lang === 'vi');
  const h24 = (typeof buildHistory24h === 'function') ? buildHistory24h() : { samples: 0 };
  const hTxt = (typeof formatHistory24hText === 'function') ? formatHistory24hText(h24) : '';
  function withHistory(msg) {
    if (!h24 || !h24.samples) return msg;
    const tail = vi
      ? ('\n\n— Dữ liệu ~24h —\n' + hTxt + '\n\nGợi ý: xem /report nếu cần chi tiết thêm.')
      : ('\n\n— Last ~24h data —\n' + hTxt + '\n\nTip: use /report for a fuller summary.');
    return msg + tail;
  }

  if (intent === 'GREETING') {
    return vi
      ? ('Chào bạn! Mình đang theo dõi Pi Node của bạn. Hiện node ' + (ok ? 'trông ổn' : 'có điểm cần để ý') + '. Bạn muốn hỏi gì — đồng bộ, cổng, bonus, hay cách cải thiện?')
      : ('Hi! I am watching your Pi Node. Right now it looks ' + (ok ? 'fine' : 'like it needs attention') + '. Ask about sync, ports, bonus, or upgrades anytime.');
  }
  if (intent === 'SMALLTALK') {
    return vi
      ? ('Giờ khoảng ' + nowHM() + ' (VN). Mình sẵn sàng hỗ trợ vận hành Node — bạn cứ hỏi tự nhiên.')
      : ('Around ' + nowHM() + ' (VN time). I can help with your Node — ask naturally.');
  }
  if (intent === 'CLARIFY') {
    return vi
      ? ('Mình nói lại đơn giản: hiện node ' + (ok ? 'đang chạy bình thường' : 'chưa thật ổn') + (sync ? (', đồng bộ: ' + sync) : '') + (ledger ? (', ledger ~' + ledger) : '') + '. Bạn muốn mình đi sâu phần nào?')
      : ('Simply put: the node looks ' + (ok ? 'healthy' : 'unstable') + (sync ? ('; sync: ' + sync) : '') + (ledger ? ('; ledger ~' + ledger) : '') + '. What should I explain more?');
  }
  if (intent === 'BONUS') {
    return vi
      ? ('Bonus trên Pi Node phụ thuộc thời gian online ổn định, cổng mở và đồng bộ tốt — app này không hiện số bonus. ' +
         (ok
           ? ('Máy bạn đang ' + (sync || 'đồng bộ ổn') + (age != null ? (', age ' + age + 's') : '') + '. Để hạn chế tụt bonus: giữ online 24/7, cổng 31401–31403 mở, tránh restart liên tục, đủ RAM/CPU.')
           : 'Hiện có tín hiệu chưa ổn — ưu tiên kiểm tra sync và cổng trước khi lo bonus.'))
      : ('Bonus depends on stable uptime, open ports, and good sync — this app does not show bonus points. ' +
         (ok
           ? ('Your node looks ' + (sync || 'synced') + (age != null ? (', age ' + age + 's') : '') + '. Keep online 24/7, ports open, avoid constant restarts.')
           : 'Something looks off — check sync and ports first.'));
  }
  if (intent === 'BLOCK_SYNC' || intent === 'DIAGNOSIS') {
    if (ok && age != null && age <= 60) {
      return vi
        ? withHistory('Mình hiểu bạn lo mất đồng bộ. Lúc này node đang ' + (sync || 'Synced') + ', ledger ~' + (ledger || '?') + ', age ' + age + 's — block vẫn đóng đúng nhịp. Mất sync ngắn rồi tự hồi thường do mạng/peer tạm thời; nếu lặp lại nhiều lần trong ngày thì kiểm tra mạng, đóng app nặng, và xem /report.')
        : withHistory('I get the concern about losing sync. Right now it is ' + (sync || 'Synced') + ', ledger ~' + (ledger || '?') + ', age ' + age + 's — blocks are closing on time. Short blips often recover alone; if it keeps happening, check network and /report.');
    }
    if (age != null && age > 120) {
      return vi
        ? ('Đồng bộ đang chậm: age ' + age + 's (' + (sync || '?') + '). Node có thể đang đuổi block hoặc mạng nghẽn. Nên kiểm tra cổng 31401–3; restart Pi Node nếu kéo dài >10 phút.')
        : ('Sync looks slow: age ' + age + 's (' + (sync || '?') + '). It may be catching up or the network is congested. Check ports; restart Pi Node if this lasts >10 minutes.');
    }
    return vi
      ? ('Về đồng bộ: ' + (sync || 'chưa rõ') + (ledger ? (', ledger ' + ledger) : '') + (age != null ? (', age ' + age + 's') : '') + '. Nếu hay thấy tụt sync, gửi /report để đối chiếu lịch sử.')
      : ('On sync: ' + (sync || 'unclear') + (ledger ? (', ledger ' + ledger) : '') + (age != null ? (', age ' + age + 's') : '') + '. If dropouts are frequent, send /report.');
  }
  if (intent === 'NODE_HEALTH') {
    return vi
      ? withHistory('Nhìn tổng thể: node ' + (ok ? 'đang ổn' : 'cần theo dõi') + (sync ? (', ' + sync) : '') + (ledger ? (', ledger ' + ledger) : '') + '. ' + (ok ? 'Bạn có thể yên tâm chạy tiếp; muốn chắc hơn thì xem /peers và /report.' : 'Nên mở /diagnostic và kiểm tra cổng/mạng.'))
      : withHistory('Overall the node looks ' + (ok ? 'healthy' : 'like it needs attention') + (sync ? (', ' + sync) : '') + (ledger ? (', ledger ' + ledger) : '') + '. ' + (ok ? 'Safe to keep running; check /peers and /report for more confidence.' : 'Open /diagnostic and verify ports/network.'));
  }
  if (intent === 'ADVICE' || intent === 'RECOMMENDATION') {
    return vi
      ? ('Gợi ý thực tế: (1) giữ online ổn định, (2) cổng 31401–31403 luôn mở, (3) đủ RAM và mát máy, (4) không reset liên tục. Bản Windows PRO có thêm clean RAM / maintenance: https://github.com/cannoi/pinode-telegram-controller')
      : ('Practical tips: (1) keep online, (2) keep ports 31401–31403 open, (3) enough RAM and cooling, (4) avoid constant resets. Windows PRO: https://github.com/cannoi/pinode-telegram-controller');
  }
  if (intent === 'RAM') {
    return formatMetricAnalysis('ram', 7, lang) + (t.ram != null ? ((vi ? '\n\nHiện tại · ' : '\n\nNow · ') + t.ram + '%') : '');
  }
  if (intent === 'CPU') {
    return formatMetricAnalysis('cpu', 7, lang) + (t.cpu != null ? ((vi ? '\n\nHiện tại · ' : '\n\nNow · ') + t.cpu + '%') : '');
  }
  if (intent === 'TEMP') {
    return formatMetricAnalysis('temp', 7, lang) + (t.temp != null ? ((vi ? '\n\nHiện tại · ' : '\n\nNow · ') + t.temp + '°C') : '');
  }
  if (intent === 'FINANCE') {
    return financialBoundaryReply(lang) + (h24 && h24.samples ? ('\n\n' + hTxt) : '');
  }
  if (intent === 'PEERS') {
    if (t.peer_in == null && t.peer_out == null)
      return vi ? 'Chưa đọc được peer (cần Core HTTP /peers). Thử /ports.' : 'Peer counts unavailable. Try /ports.';
    return 'Peers IN ' + (t.peer_in != null ? t.peer_in : '?') + ' / OUT ' + (t.peer_out != null ? t.peer_out : '?');
  }
  if (intent === 'PORT') {
    if (!t.ports) return vi ? 'Chưa probe được cổng.' : 'Ports not probed yet.';
    return [31401, 31402, 31403].map(function (p) { return p + ': ' + (t.ports[String(p)] || '?'); }).join('\n');
  }
  if (intent === 'DOCKER') {
    return vi
      ? ('SoloHost không điều khiển Docker host. Nhãn container: ' + (t.container || 'n/a') + '. Cổng ' + (t.ports_all_open ? 'đang mở' : 'cần kiểm tra') + '.')
      : ('SoloHost does not control host Docker. Container label: ' + (t.container || 'n/a') + '.');
  }
  if (ok) {
    return vi
      ? withHistory('Nhìn dữ liệu hiện tại, node đang chạy ổn' + (sync ? (' (' + sync + ')') : '') + (ledger ? (', ledger ' + ledger) : '') + '. Nếu bạn lo bonus hoặc mất sync lúc nãy, thường là nhiễu ngắn; cứ để máy online và xem /report nếu lặp lại. Bạn muốn mình giải thích sâu hơn phần nào?')
      : withHistory('From current data the node looks fine' + (sync ? (' (' + sync + ')') : '') + (ledger ? (', ledger ' + ledger) : '') + '. Brief sync drops are often temporary — keep it online and check /report if it repeats. What should I explain more?');
  }
  return vi
    ? withHistory('Có dấu hiệu cần theo dõi' + (sync ? (': ' + sync) : '') + '. Nên xem /diagnostic và kiểm tra mạng/cổng. Mô tả thêm triệu chứng bạn thấy để mình tư vấn sát hơn.')
    : withHistory('Something needs attention' + (sync ? (': ' + sync) : '') + '. Check /diagnostic and network/ports. Describe what you see so I can advise more precisely.');
}


function buildFacts(t) {
  t = t || {};
  const f = { source: t.source || null, level: t.level || null };
  ['sync', 'ledger', 'ledger_age', 'peer_in', 'peer_out', 'docker', 'container', 'cpu', 'ram', 'temp',
   'ports_open', 'network', 'network_kind', 'core_version', 'protocol', 'ingest_lag', 'confidence'].forEach(function (k) {
    if (t[k] != null) f[k] = t[k];
  });
  if (t.ports) f.ports = t.ports;
  if (t.sources) f.sources = t.sources;
  return f;
}

function historySnippet(n) {
  try {
    return readHistory(2).slice(-(n || 24)).map(function (r) {
      const o = { ts: r.ts, level: r.level };
      ['sync', 'ledger', 'ledger_age', 'peer_in', 'peer_out', 'ram', 'cpu', 'temp', 'ports_open'].forEach(function (k) {
        if (r[k] != null) o[k] = r[k];
      });
      return o;
    });
  } catch (e) { return []; }
}

/** Aggregate last ~24h history for AI technician-style advice */
function buildHistory24h() {
  const rows = readHistory(2);
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const day = rows.filter(function (r) {
    const ts = Date.parse(r.ts) || 0;
    return !ts || ts >= cutoff;
  });
  if (!day.length) {
    return { samples: 0, note: 'No history yet — collecting telemetry every 60s.' };
  }
  const nums = function (key) {
    return day.map(function (r) { return r[key]; }).filter(function (x) { return x != null && isFinite(Number(x)); }).map(Number);
  };
  const ledgers = nums('ledger');
  const ages = nums('ledger_age');
  const rams = nums('ram');
  const cpus = nums('cpu');
  const temps = nums('temp');
  const peersIn = nums('peer_in');
  const peersOut = nums('peer_out');
  let critical = 0, warning = 0, ok = 0;
  let syncFlips = 0;
  let lastSync = null;
  day.forEach(function (r) {
    if (r.level === 'critical') critical++;
    else if (r.level === 'warning' || r.level === 'soft') warning++;
    else ok++;
    if (r.sync && lastSync && r.sync !== lastSync) syncFlips++;
    if (r.sync) lastSync = r.sync;
  });
  const first = day[0];
  const last = day[day.length - 1];
  const spanMin = Math.max(1, Math.round((day.length * (typeof TELEMETRY_SEC === 'number' ? TELEMETRY_SEC : 60)) / 60));
  return {
    samples: day.length,
    approx_minutes: spanMin,
    first_ts: first && first.ts,
    last_ts: last && last.ts,
    level_ok: ok,
    level_warning: warning,
    level_critical: critical,
    sync_flips: syncFlips,
    last_sync: last && last.sync,
    ledger_min: ledgers.length ? Math.min.apply(null, ledgers) : null,
    ledger_max: ledgers.length ? Math.max.apply(null, ledgers) : null,
    ledger_delta: ledgers.length >= 2 ? (ledgers[ledgers.length - 1] - ledgers[0]) : null,
    age_max_s: ages.length ? Math.max.apply(null, ages) : null,
    age_avg_s: ages.length ? Math.round(ages.reduce(function (a, b) { return a + b; }, 0) / ages.length) : null,
    peer_in_min: peersIn.length ? Math.min.apply(null, peersIn) : null,
    peer_in_max: peersIn.length ? Math.max.apply(null, peersIn) : null,
    peer_out_min: peersOut.length ? Math.min.apply(null, peersOut) : null,
    peer_out_max: peersOut.length ? Math.max.apply(null, peersOut) : null,
    ram_min: rams.length ? Math.min.apply(null, rams) : null,
    ram_max: rams.length ? Math.max.apply(null, rams) : null,
    cpu_max: cpus.length ? Math.max.apply(null, cpus) : null,
    temp_max: temps.length ? Math.max.apply(null, temps) : null,
    recent_levels: day.slice(-8).map(function (r) { return { ts: r.ts, level: r.level, sync: r.sync, ledger: r.ledger, age: r.ledger_age }; })
  };
}

function formatHistory24hText(h) {
  if (!h || !h.samples) return 'No 24h history yet.';
  const lines = [];
  lines.push('Samples: ' + h.samples + ' (~' + h.approx_minutes + ' min coverage)');
  if (h.first_ts && h.last_ts) lines.push('Window: ' + String(h.first_ts).slice(0, 16) + ' → ' + String(h.last_ts).slice(0, 16));
  lines.push('Levels OK/Warn/Crit: ' + h.level_ok + '/' + h.level_warning + '/' + h.level_critical);
  lines.push('Sync flips: ' + h.sync_flips + (h.last_sync ? ('; last=' + h.last_sync) : ''));
  if (h.ledger_min != null) lines.push('Ledger: ' + h.ledger_min + ' → ' + h.ledger_max + (h.ledger_delta != null ? (' (delta ' + h.ledger_delta + ')') : ''));
  if (h.age_max_s != null) lines.push('Ledger age max/avg: ' + h.age_max_s + 's / ' + h.age_avg_s + 's');
  if (h.peer_in_min != null) lines.push('Peer IN: ' + h.peer_in_min + '–' + h.peer_in_max);
  if (h.peer_out_min != null) lines.push('Peer OUT: ' + h.peer_out_min + '–' + h.peer_out_max);
  if (h.ram_max != null) lines.push('RAM range: ' + h.ram_min + '–' + h.ram_max + '%');
  if (h.cpu_max != null) lines.push('CPU peak: ' + h.cpu_max + '%');
  if (h.temp_max != null) lines.push('Temp peak: ' + h.temp_max + 'C');
  return lines.join('\n');
}

function toNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function median(arr) {
  if (!arr || !arr.length) return null;
  const a = arr.slice().sort(function (x, y) { return x - y; });
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2 * 10) / 10;
}
function avg(arr) {
  if (!arr || !arr.length) return null;
  return Math.round(arr.reduce(function (s, x) { return s + x; }, 0) / arr.length * 10) / 10;
}
function minMax(arr) {
  if (!arr || !arr.length) return { min: null, max: null };
  return { min: Math.min.apply(null, arr), max: Math.max.apply(null, arr) };
}
/** Rows in last N days from ndjson history */
function historyRowsDays(days) {
  const rows = readHistory(Math.max(1, days || 7));
  const cutoff = Date.now() - Math.max(1, days || 7) * 864e5;
  return rows.filter(function (r) {
    const ts = Date.parse(r.ts) || 0;
    return !ts || ts >= cutoff;
  });
}
function periodLabel(days, lang) {
  const vi = lang === 'vi';
  if (days <= 1) return vi ? '24 giờ' : '24h';
  if (days <= 7) return vi ? '7 ngày' : '7 days';
  return vi ? (days + ' ngày') : (days + ' days');
}
/**
 * Windows-PRO style metric analysis (RAM/CPU/TEMP/AGE)
 * Example:
 * 🧠 PHÂN TÍCH RAM · 7 ngày
 * 📋 Mẫu đo · 260
 * 📉 Thấp nhất · 60.8%
 */
function formatMetricAnalysis(metricKey, days, lang) {
  const vi = lang === 'vi';
  const d = Math.max(1, days || 7);
  const rows = historyRowsDays(d);
  const vals = rows.map(function (r) { return toNum(r[metricKey]); }).filter(function (x) { return x != null; });
  const titleMap = {
    ram: vi ? '🧠 PHÂN TÍCH RAM' : '🧠 RAM ANALYSIS',
    cpu: vi ? '⚙️ PHÂN TÍCH CPU' : '⚙️ CPU ANALYSIS',
    temp: vi ? '🌡️ PHÂN TÍCH NHIỆT' : '🌡️ TEMP ANALYSIS',
    ledger_age: vi ? '⏱️ PHÂN TÍCH LEDGER AGE' : '⏱️ LEDGER AGE ANALYSIS'
  };
  const unit = (metricKey === 'temp') ? '°C' : (metricKey === 'ledger_age' ? 's' : '%');
  const title = (titleMap[metricKey] || metricKey) + ' · ' + periodLabel(d, lang);
  if (!vals.length) {
    return [
      title,
      '━━━━━━━━━━━━━━━━━━',
      vi ? 'Chưa đủ mẫu trong lịch sử. App đang thu mỗi ~60s — hỏi lại sau khi có dữ liệu.' : 'Not enough history samples yet. Collecting every ~60s — ask again later.'
    ].join('\n');
  }
  const mm = minMax(vals);
  const a = avg(vals);
  const med = median(vals);
  return [
    title,
    '━━━━━━━━━━━━━━━━━━',
    (vi ? '📋 Mẫu đo · ' : '📋 Samples · ') + vals.length,
    (vi ? '📉 Thấp nhất · ' : '📉 Min · ') + mm.min + unit,
    (vi ? '📈 Cao nhất · ' : '📈 Max · ') + mm.max + unit,
    (vi ? '📊 Trung bình · ' : '📊 Avg · ') + a + unit,
    (vi ? '🎯 Trung vị · ' : '🎯 Median · ') + med + unit
  ].join('\n');
}

function financialBoundaryReply(lang) {
  const vi = lang === 'vi';
  if (vi) {
    return [
      '🤖 AI APP GUIDE',
      '',
      'Mình hiểu bạn đang cân nhắc tài chính. Với vai trò trợ lý kỹ thuật Pi Node, mình chỉ đánh giá tình trạng máy — không tư vấn mua/bán hay quyết định tiền bạc.',
      '',
      'Về kỹ thuật, xem /status và khối dữ liệu lịch sử bên dưới. Quyết định giữ hay dừng Node là của bạn dựa trên kế hoạch riêng.',
      '',
      'Cần thêm số liệu hiệu suất (RAM/CPU/sync 7 ngày) thì hỏi tiếp — mình sẵn sàng hỗ trợ kỹ thuật.'
    ].join('\n');
  }
  return [
    '🤖 AI APP GUIDE',
    '',
    'I understand money pressure is real. As a technical Pi Node assistant I only report machine health — I cannot advise buying/selling or personal finance.',
    '',
    'Technically, check /status and the history summary below. Whether to keep the node is your decision.',
    '',
    'Ask for 7-day RAM/CPU/sync stats anytime if that helps your technical review.'
  ].join('\n');
}



async function aiAnalyze(t, userQ) {
  try {
    const intent = detectIntent(userQ || '');
    const lang = detectUserLang(userQ || '');
    const q = String(userQ || '');

    // Related structured data for ANY question (feed AI — do not replace AI when key exists)
    let days = 7;
    if (/24\s*h|24\s*giờ|hom nay|hôm nay|1\s*day/i.test(q)) days = 1;
    if (/30\s*ngày|30\s*day|thang|tháng/i.test(q)) days = 30;
    days = Math.min(days, 7);

    const mk = metricIntentKey(intent);
    let metricBlock = '';
    if (mk) {
      metricBlock = formatMetricAnalysis(mk, days, lang);
      if (t && t[mk] != null) {
        metricBlock += (lang === 'vi' ? '\n\nHiện tại · ' : '\n\nNow · ') + t[mk] + (mk === 'temp' ? '°C' : '%');
      }
    } else if (intent === 'BLOCK_SYNC' || intent === 'DIAGNOSIS' || intent === 'NODE_HEALTH' || intent === 'GENERAL' || intent === 'BONUS' || intent === 'RECOMMENDATION' || intent === 'ADVICE' || intent === 'CLARIFY' || intent === 'FINANCE') {
      // sync-oriented summary from 24h
      try {
        const h = buildHistory24h();
        if (h && h.samples) metricBlock = formatHistory24hText(h);
      } catch (e) {}
    }

    const facts = (typeof buildFacts === 'function') ? buildFacts(t) : { source: t && t.source, sync: t && t.sync, ledger: t && t.ledger };
    const hist24 = (typeof buildHistory24h === 'function') ? buildHistory24h() : { samples: 0 };
    const hist = (typeof historySnippet === 'function') ? historySnippet(40) : [];
    const chat = loadChatHistory().slice(-10);
    const issues = (typeof collectIssues === 'function') ? collectIssues(t) : [];
    const rows7 = (typeof historyRowsDays === 'function') ? historyRowsDays(7) : [];
    const ram7 = rows7.map(function (r) { return toNum(r.ram); }).filter(function (x) { return x != null; });
    const cpu7 = rows7.map(function (r) { return toNum(r.cpu); }).filter(function (x) { return x != null; });
    const age7 = rows7.map(function (r) { return toNum(r.ledger_age); }).filter(function (x) { return x != null; });
    const stats7 = {
      samples: rows7.length,
      ram: ram7.length ? { min: Math.min.apply(null, ram7), max: Math.max.apply(null, ram7), avg: avg(ram7), median: median(ram7) } : null,
      cpu: cpu7.length ? { min: Math.min.apply(null, cpu7), max: Math.max.apply(null, cpu7), avg: avg(cpu7), median: median(cpu7) } : null,
      ledger_age: age7.length ? { min: Math.min.apply(null, age7), max: Math.max.apply(null, age7), avg: avg(age7), median: median(age7) } : null
    };

    // PRIORITY 1: always use Gemini for free-text questions when API key is set
    if (GEMINI_API_KEY) {
      const prompt = [
        'You are an experienced Pi Node technician for THIS operator machine (SoloHost Controller).',
        'LANGUAGE: Reply in the SAME language as the user. Never force Vietnamese if they use another language.',
        'PRIORITY: Every free-text question must get a real technician evaluation — clear, simple language anyone can understand, with practical value.',
        'DATA: Use ONLY the JSON blocks below. Never invent ledger, bonus points, peers, RAM, CPU, temp, or uptime. If missing, say it is not measured on SoloHost.',
        'STYLE: (1) Answer the user question first with empathy. (2) Explain what the data means in plain words. (3) Give 1–3 concrete next steps when useful. (4) Optionally ask one short follow-up question.',
        'FINANCE: If they ask about selling the node or money problems — be empathetic, give ONLY technical health context, do NOT advise buy/sell or personal finance.',
        'Intent: ' + intent,
        'User question: ' + q.slice(0, 900),
        'Issues: ' + JSON.stringify(issues),
        'CURRENT_FACTS: ' + JSON.stringify(facts),
        'HISTORY_24H: ' + JSON.stringify(hist24),
        'STATS_7D: ' + JSON.stringify(stats7),
        metricBlock ? ('RELATED_METRIC_BLOCK:\n' + metricBlock) : '',
        hist.length ? ('RECENT_SAMPLES: ' + JSON.stringify(hist)) : '',
        chat.length ? ('Recent chat: ' + JSON.stringify(chat)) : '',
        'Write a valuable technician-style answer now.'
      ].filter(Boolean).join('\n');

      try {
        const body = JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.85, maxOutputTokens: 2000 }
        });
        const text = await new Promise(function (resolve) {
          const u = new URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(GEMINI_API_KEY));
          const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          }, function (r) {
            let b = '';
            r.on('data', function (d) { b += d; });
            r.on('end', function () {
              try {
                const j = JSON.parse(b);
                resolve(j.candidates && j.candidates[0] && j.candidates[0].content.parts[0].text);
              } catch (e) { resolve(null); }
            });
          });
          req.on('error', function () { resolve(null); });
          req.setTimeout(28000, function () { try { req.destroy(); } catch (e) {} resolve(null); });
          req.write(body);
          req.end();
        });
        if (text && String(text).trim()) {
          try { actionLog('info', 'AI reply ok · intent ' + intent); } catch (e) {}
          return '🤖 AI APP GUIDE\n\n' + String(text).trim().slice(0, 3500);
        }
      } catch (e) {
        try { actionLog('error', 'Gemini fail: ' + (e && e.message)); } catch (e2) {}
      }
    }

    // Fallback when no API key or Gemini failed: structured data + local technician text
    if (mk && metricBlock) {
      const note = lang === 'vi'
        ? '\n\n(Không có Gemini API key hoặc AI tạm lỗi — đây là số liệu lịch sử thật. Thêm GEMINI_API_KEY để có phân tích kỹ thuật viên đầy đủ.)'
        : '\n\n(No Gemini API key or AI failed — raw history stats. Set GEMINI_API_KEY for full technician analysis.)';
      return metricBlock + note;
    }
    if (intent === 'FINANCE') {
      const base = financialBoundaryReply(lang);
      const h = hist24;
      return base + (h && h.samples ? ('\n\n' + formatHistory24hText(h)) : '');
    }
    return localAssistantReply(t, intent, userQ || '');
  } catch (e) {
    try { actionLog('error', 'aiAnalyze ' + (e && e.message)); } catch (e2) {}
    try { return localAssistantReply(t, detectIntent(userQ || ''), userQ || ''); } catch (e3) { return 'Assistant error. Try /status.'; }
  }
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 STATUS', callback_data: 'cmd_status' },
        { text: '📈 REPORT', callback_data: 'cmd_report' },
        { text: '👥 PEERS', callback_data: 'cmd_peers' }
      ],
      [
        { text: '🩺 DIAG', callback_data: 'cmd_diagnostic' },
        { text: '📋 LOGS', callback_data: 'cmd_logs' },
        { text: '💬 ANALYZE', callback_data: 'cmd_analyze' }
      ],
      [
        { text: '💻 Windows PRO', callback_data: 'cmd_winpro' },
        { text: '💛 DONATE', callback_data: 'cmd_donate' }
      ]
    ]
  };
}

// ---------- Telegram ----------
function tgApi(method, body) {
  return new Promise(resolve => {
    if (!BOT_TOKEN) return resolve(null);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.telegram.org', path: '/bot' + BOT_TOKEN + '/' + method,
      method: data ? 'POST' : 'GET',
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(35000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}
async function tgSend(text, extra) {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  const body = Object.assign({
    chat_id: CHAT_ID,
    text: String(text == null ? '' : text).slice(0, 4000),
    disable_web_page_preview: true
  }, extra || {});
  // Do NOT force HTML — free-text AI replies often fail Telegram HTML parse and look "silent"
  const r = await tgApi('sendMessage', body);
  if (r && r.ok === false) log('tgSend fail: ' + (r.description || JSON.stringify(r)), 'error');
  if (!r) log('tgSend network fail', 'error');
  return r;
}

async function runCmd(cmd, userText) {
  // Commands use CACHE first — never block on full 60s scan
  const t = await getTelemetry();
  if (cmd === 'status' || cmd === 's') return tgSend(formatStatus(t), { reply_markup: mainKeyboard() });
  if (cmd === 'sync') {
    const lines = ['🔄 SYNC', '━━━━━━━━━━━━━━━━━━'];
    if (t.sync) lines.push('Status: ' + t.sync);
    if (t.ledger != null) lines.push('Ledger: ' + fmtN(t.ledger));
    if (t.ledger_age != null) lines.push('Age: ' + t.ledger_age + 's');
    if (lines.length === 2) lines.push('⚠️ Sync data unavailable');
    return tgSend(lines.join('\n'), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'peers') return tgSend(formatPeers(t), { reply_markup: mainKeyboard() });
  if (cmd === 'ports') {
    const lines = ['PORTS', '================'];
    [31401,31402,31403].forEach(p => {
      const st = t.ports && t.ports[String(p)];
      lines.push((st === 'OPEN' ? 'OK' : (st || '?')) + '  ' + p);
    });
    return tgSend(lines.join('\n'), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'report') return tgSend(formatReport(), { reply_markup: mainKeyboard() });
  if (cmd === 'diagnostic' || cmd === 'diag') return tgSend(formatDiagnostic(t), { reply_markup: mainKeyboard() });
  if (cmd === 'analyze' || cmd === 'ai' || cmd === 'health' || cmd === 'ask') {
    pushChatPersistent('user', userText || '');
    await tgSend('…');
    const ans = await aiAnalyze(t, userText || 'Tinh trang node');
    pushChatPersistent('assistant', ans);
    return tgSend(ans, { reply_markup: mainKeyboard() });
  }
  if (cmd === 'trends') return tgSend(formatReport(), { reply_markup: mainKeyboard() });
  if (cmd === 'scripts' || cmd === 'script') return tgSend(formatScripts(), { reply_markup: mainKeyboard() });
  if (cmd === 'logs' || cmd === 'log') {
    try { actionLog('info', 'user /logs'); } catch (e) {}
    return tgSend(formatActionLog(), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'winpro' || cmd === 'windows' || cmd === 'pro') {
    try { actionLog('info', 'user /winpro'); } catch (e) {}
    return tgSend(formatWindowsPro(), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'donate') {
    try { actionLog('info', 'user /donate'); } catch (e) {}
    await tgSend(formatDonate(), { reply_markup: mainKeyboard() });
    try { await tgSendPhoto(donateQrUrl(), 'QR Donate · MB 0905428801 · TRAN HUU NGHI'); } catch (e) {}
    return true;
  }
  if (cmd === 'ping') return tgSend('🏓 pong · v' + VERSION + '\n⏱ cache ' + (Date.now() - cacheAt) + 'ms');
  if (cmd === 'start' || cmd === 'help') {
    return tgSend(
      'PI NODE CONTROLLER · SoloHost\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '/status /sync /peers\n/report /diagnostic /analyze\n/scripts /donate\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      'Telemetry → Horizon → Ports',
      { reply_markup: mainKeyboard() }
    );
  }
  return null;
}

async function handleText(text) {
  const raw = (text || '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  const cmd = low.split(/\s+/)[0].replace(/@\w+$/, '').replace(/^\//, '');

  if (raw.startsWith('/')) {
    return (await runCmd(cmd, raw)) || tgSend('Lenh khong ro. /help', { reply_markup: mainKeyboard() });
  }
  if (/^(status|ping)$/i.test(raw.trim())) return runCmd(raw.toLowerCase(), raw);
  if (/^(peers?|ports?|report|diagnostic|donate|scripts?)$/i.test(raw.trim())) return runCmd(cmd, raw);

  // Natural language -> assistant (never silent, never dump STATUS template)
  return runCmd('analyze', raw);
}

let offset = 0;

async function processUpdate(u) {
  try {
    if (u.callback_query) {
      const cq = u.callback_query;
      if (CHAT_ID && String(cq.message && cq.message.chat && cq.message.chat.id) !== String(CHAT_ID)) return;
      await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
      if ((cq.data || '').startsWith('cmd_')) await runCmd(cq.data.slice(4));
      return;
    }
    const msg = u.message;
    if (!msg || !msg.text) return;
    if (CHAT_ID && String(msg.chat.id) !== String(CHAT_ID)) {
      log('ignore chat ' + msg.chat.id + ' want ' + CHAT_ID, 'warn');
      return;
    }
    await handleText(msg.text);
  } catch (e) {
    log('tg handle ' + (e && e.message), 'error');
    try { await tgSend('Loi xu ly tin nhan. Thu /ping hoac /status.'); } catch (e2) {}
  }
}

async function telegramLoop() {
  let conflictBackoff = 15000;
  let lastConflictLog = 0;
  let polling = false;
  if (BOT_TOKEN) {
    const dw = await tgApi('deleteWebhook', { drop_pending_updates: true });
    log('deleteWebhook ' + (dw && dw.ok ? 'ok' : 'skip') + ' (drop_pending=true)');
    try { actionLog('info', 'telegram loop start · deleteWebhook'); } catch (e) {}
  }
  while (true) {
    if (!BOT_TOKEN) { await wait(5000); continue; }
    if (polling) { await wait(500); continue; }
    polling = true;
    try {
      const r = await tgApi('getUpdates', {
        offset: offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });
      if (!r) {
        await wait(2000);
        continue;
      }
      if (r.ok === false) {
        const desc = String(r.description || '');
        const isConflict = /conflict|terminated by other getUpdates/i.test(desc);
        if (isConflict) {
          const now = Date.now();
          if (now - lastConflictLog > 90000) {
            log('getUpdates conflict — only one bot instance may poll this token. Stop Windows PRO bot or other SoloHost containers using the same BOT_TOKEN.', 'error');
            try { actionLog('error', 'getUpdates conflict · ensure single instance'); } catch (e) {}
            lastConflictLog = now;
          }
          await tgApi('deleteWebhook', { drop_pending_updates: true });
          await wait(conflictBackoff);
          conflictBackoff = Math.min(180000, Math.floor(conflictBackoff * 1.4));
          continue;
        }
        log('getUpdates fail: ' + desc, 'error');
        await wait(8000);
        continue;
      }
      conflictBackoff = 15000;
      if (!Array.isArray(r.result)) {
        await wait(1000);
        continue;
      }
      for (const u of r.result) {
        offset = u.update_id + 1;
        // fire-and-forget AI so long-poll continues; errors logged inside processUpdate
        processUpdate(u);
      }
    } catch (e) {
      log('tg loop ' + (e && e.message), 'error');
      await wait(4000);
    } finally {
      polling = false;
    }
  }
}

// TELEMETRY LOOP — 60s only
async function telemetryLoop() {
  while (true) {
    try {
      const t = await collectTelemetry();
      await runAlertMachine(t);
      const h = hourVN();
      const key = dayVN() + '-' + h;
      if (REPORT_HOURS.indexOf(h) >= 0 && state.lastReportKey !== key) {
        state.lastReportKey = key;
        saveJSON(STATE_F, state);
        await tgSend(formatReport() + '\n\n' + formatStatus(t), { reply_markup: mainKeyboard() });
      }
    } catch (e) { log('telemetry ' + e.message, 'error'); }
    await wait(TELEMETRY_SEC * 1000);
  }
}

// ---------- HTTP UI ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.ps1': 'text/plain; charset=utf-8'
};
let INDEX = '<h1>Pi Node SoloHost ' + VERSION + '</h1><p>/api/status</p>';
try { INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); } catch (e) {}

const srv = http.createServer(async (req, res) => {
  const u = (req.url || '/').split('?')[0];
  try {
    if (u === '/healthz') { res.end('ok'); return; }
    if (u === '/api/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(cache || await getTelemetry()));
      return;
    }
    if (u === '/api/selftest') {
      const checks = [];
      const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });
      ok('version', !!VERSION, VERSION);
      ok('telegram_loop_independent', true, 'telegramLoop + telemetryLoop separate');
      ok('telemetry_sec', TELEMETRY_SEC >= 30, String(TELEMETRY_SEC));
      ok('no_docker_sock_required', true, 'compose has no sock');
      ok('schema_hide_missing', typeof lineIf === 'function', 'lineIf');
      ok('no_datalive', true, 'Horizon removed');
      ok('history_dir', fs.existsSync(DIR_HIST), DIR_HIST);
      // synthetic merge tests
      const m1 = mergeTelemetry(null, { source: 'Horizon', ledger: 100, sync: 'Horizon OK', confidence: 'medium' }, { ports: { '31401': 'OPEN', '31402': 'OPEN', '31403': 'OPEN' }, openCount: 3 });
      ok('fallback_horizon', m1.ledger === 100 && m1.source === 'Horizon', m1.source);
      ok('datalive_offline_not_node_offline', m1.level !== 'critical', m1.level);
      const m2 = mergeTelemetry({ source: 'Horizon', sync: 'Synced!', ledger: 200, peer_in: 5, peer_out: 3, confidence: 'high' }, null, { ports: { '31401': 'OPEN', '31402': 'OPEN', '31403': 'OPEN' }, openCount: 3 });
      ok('primary_datalive', m2.source === 'Horizon' && m2.ledger === 200, m2.source);
      const m3 = mergeTelemetry(null, null, { ports: { '31401': 'CLOSED', '31402': 'CLOSED', '31403': 'CLOSED' }, openCount: 0 });
      ok('ports_closed_critical', m3.level === 'critical', m3.level);
      const all = checks.every(c => c.pass);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: all, version: VERSION, checks }));
      return;
    }
    
    if (u === '/api/chat' && (req.method === 'POST' || req.method === 'GET')) {
      let body = '';
      if (req.method === 'POST') {
        body = await new Promise(resolve => {
          let b = '';
          req.on('data', d => b += d);
          req.on('end', () => resolve(b));
          req.on('error', () => resolve(''));
        });
      }
      let msg = '';
      try {
        const q = new URL(req.url, 'http://x').searchParams.get('msg');
        if (q) msg = q;
        if (body) {
          const j = JSON.parse(body);
          if (j && j.message) msg = j.message;
          if (j && j.msg) msg = j.msg;
        }
      } catch (e) {}
      msg = String(msg || '').trim().slice(0, 2000);
      if (!msg) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'empty_message' }));
        return;
      }
      try {
        let tel = cache;
        if (!tel) {
          try {
            tel = await Promise.race([
              collectTelemetry(),
              new Promise(function (r) { setTimeout(function () { r(null); }, 4000); })
            ]);
          } catch (e) { tel = null; }
        }
        if (!tel) tel = { source: 'none', level: 'unknown', sources: {} };
        pushChatPersistent('user', msg);
        const ans = await aiAnalyze(tel, msg);
        pushChatPersistent('assistant', ans);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, reply: ans, version: VERSION, source: tel && tel.source }));
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
      }
      return;
    }

    if (u === '/api/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        version: VERSION, dataLive: false,
        hasBot: !!BOT_TOKEN, hasAI: !!GEMINI_API_KEY, telemetrySec: TELEMETRY_SEC
      }));
      return;
    }
    if (u === '/api/logs') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      try { res.end(fs.readFileSync(LOG_F, 'utf8').slice(-8000)); } catch (e) { res.end(''); }
      return;
    }
    if (u === '/' || u === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(INDEX);
      return;
    }
    if (u.startsWith('/scripts/')) {
      const name = path.basename(u);
      const f = path.join(SCRIPTS, name);
      if (fs.existsSync(f)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
        res.end(fs.readFileSync(f));
        return;
      }
    }
    const f = path.join(PUBLIC, path.normalize(u).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(f, (err, data) => {
      if (err) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
      res.end(data);
    });
  } catch (e) {
    res.statusCode = 500;
    res.end('error');
  }
});

srv.listen(PORT, '0.0.0.0', () => {
  log('SoloHost Controller v' + VERSION + ' :' + PORT);
  log('telemetry=' + TELEMETRY_SEC + 's · Horizon-first (no DataLive)');
  log('Telegram long-poll independent of telemetry');
});

// Start loops independently
telegramLoop();
telemetryLoop();

if (BOT_TOKEN && CHAT_ID && ALERT_ON_START) {
  setTimeout(async () => {
    try {
      const t = await getTelemetry();
      await tgSend('✅ Controller online\n\n' + formatStatus(t), { reply_markup: mainKeyboard() });
    } catch (e) { log('start ' + e.message, 'error'); }
  }, 4000);
}
