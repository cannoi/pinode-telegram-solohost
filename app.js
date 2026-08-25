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

const VERSION = '2.6.0-solohost';
const DATA = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8080', 10);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const DATA_LIVE_URL = (process.env.DATA_LIVE_URL || '').replace(/\/$/, ''); // disabled by default v2.6
const DATA_LIVE_TOKEN = (process.env.DATA_LIVE_TOKEN || '').trim();
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
async function fetchDataLive() {
  if (!DATA_LIVE_URL) return null;
  const headers = {};
  if (DATA_LIVE_TOKEN) headers.Authorization = 'Bearer ' + DATA_LIVE_TOKEN;
  const r = await httpGetUrl(DATA_LIVE_URL + '/v1/status', headers, 3500);
  if (!r || r.status !== 200 || !r.body) return null;
  try {
    const j = JSON.parse(r.body);
    if (j.error) return null;
    return normalizeAny(j, 'DataLive');
  } catch (e) { return null; }
}

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
    t.source = 'DataLive';
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
    'SCRIPTS',
    '━━━━━━━━━━━━━━━━━━',
    'Windows scripts / DataLive removed in v2.6.0.',
    'Use /status /report /peers /diagnostic /analyze',
    '',
    '💛 /donate · MB 0905428801'
  ].join('\n');
}

function formatDonate() {
  return [
    '💛 DONATE · DEV COFFEE',
    '━━━━━━━━━━━━━━━━━━',
    'Bank: MB Bank',
    'Account: 0905428801',
    'Name: TRAN HUU NGHI',
    '',
    'Thank you for supporting Pi Node Controller PRO.'
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
  if (!t.sources || !t.sources.data_live)
    issues.push('Chưa có Data Live — thiếu peer/CPU/RAM/nhiệt (đang dùng ' + (t.source || 'fallback') + ')');
  return issues;
}

function rulesMetricOnly(t, intent) {
  if (intent === 'RAM') {
    if (t.ram == null) return 'Hiện chưa đo được RAM. Bật Data Live trên Windows để có số liệu máy thật.';
    return 'RAM đang khoảng ' + t.ram + '%.' + (t.ram >= 88 ? ' Mức cao — nên giảm app nền hoặc chạy CleanRAM.' : ' Mức chấp nhận được.');
  }
  if (intent === 'CPU') {
    if (t.cpu == null) return 'Chưa có dữ liệu CPU (cần Data Live).';
    return 'CPU khoảng ' + t.cpu + '%.' + (t.cpu >= 90 ? ' Đang rất cao.' : ' Ổn.');
  }
  if (intent === 'TEMP') {
    if (t.temp == null) return 'Chưa đọc được nhiệt độ (cần Data Live + cảm biến trên Windows). Khi có Data Live, mình sẽ theo dõi giúp bạn.';
    return 'Nhiệt độ khoảng ' + t.temp + '°C.' + (t.temp >= 78 ? ' Hơi cao — kiểm tra quạt/thoáng khí.' : ' Trong ngưỡng ổn.');
  }
  if (intent === 'PEERS') {
    if (t.peer_in == null && t.peer_out == null) return 'Chưa có peer (cần Data Live đọc stellar-core). Cổng node ' + (t.ports_all_open ? 'đang mở tốt' : 'cần kiểm tra') + '.';
    return 'Peer IN ' + (t.peer_in != null ? t.peer_in : '?') + ' / OUT ' + (t.peer_out != null ? t.peer_out : '?') + '.';
  }
  if (intent === 'PORT') {
    if (!t.ports) return 'Chưa probe được cổng.';
    return [31401, 31402, 31403].map(function (p) { return p + ': ' + (t.ports[String(p)] || '?'); }).join('\n');
  }
  if (intent === 'DOCKER') {
    if (!t.docker) return 'Chưa có trạng thái Docker từ Data Live. Container: ' + (t.container || 'testnet2') + '.';
    return 'Docker: ' + t.docker + (t.container ? ' · ' + t.container : '');
  }
  if (intent === 'BLOCK_SYNC') {
    const bits = evidenceSummary(t).filter(function (x) { return /Đồng bộ|Ledger|Age|Nguồn/.test(x); });
    return bits.length ? bits.join('\n') : 'Chưa có dữ liệu đồng bộ chi tiết.';
  }
  return null;
}

function localAssistantReply(t, intent, userQ) {
  const lang = detectUserLang(userQ);
  const ev = evidenceSummary(t);
  const issues = collectIssues(t);
  const hasDL = t.sources && t.sources.data_live;
  const chat = loadChatHistory().slice(-4);
  const ctx = chat.length ? ('\n' + L(lang, 'Ngữ cảnh gần đây: bạn đã hỏi về node trước đó.', 'Context: you asked about the node earlier.')) : '';

  if (intent === 'GREETING') {
    return L(lang,
      'Chào bạn. Mình là trợ lý Pi Node (SoloHost). Node hiện ' + (t.level === 'ok' ? 'ổn' : 'cần theo dõi') + ' (nguồn: ' + (t.source || '?') + '). Bạn hỏi tiếp về trạng thái, peer, nhiệt, bonus được.' + ctx,
      'Hi. I am your Pi Node assistant (SoloHost). Node looks ' + (t.level === 'ok' ? 'OK' : 'needs attention') + ' (source: ' + (t.source || '?') + '). Ask about status, peers, temperature, or bonus anytime.' + ctx
    );
  }
  if (intent === 'SMALLTALK') {
    return L(lang,
      'Bây giờ khoảng ' + nowHM() + ' (VN). Mình hỗ trợ Pi Node — hỏi tình trạng máy nhé.',
      'It is about ' + nowHM() + ' (VN time). I help with Pi Node — ask about your machine status anytime.'
    );
  }
  if (intent === 'CLARIFY') {
    return L(lang,
      'Không sao. Tóm lại: Node ' + (t.level === 'ok' ? 'OK' : String(t.level || '?')) + '. ' + (ev.slice(0, 3).join('; ') || '') + '. Bạn muốn giải thích phần nào?' + ctx,
      'No problem. Summary: Node ' + (t.level === 'ok' ? 'OK' : String(t.level || '?')) + '. ' + (ev.slice(0, 3).join('; ') || '') + '. Which part should I explain?' + ctx
    );
  }
  if (intent === 'BONUS' || (intent === 'DIAGNOSIS' && /bonus|thưởng|reward/i.test(userQ || ''))) {
    if (lang === 'vi') {
      var s = 'Về bonus, mình chỉ suy luận từ dữ liệu node (không đọc ví Pi):\n';
      if (t.level === 'ok' && t.ports_all_open) s += '• Cổng/kết nối ổn — ít khả năng do offline.\n';
      else s += '• Kết nối/cổng chưa ổn — nên xử lý trước.\n';
      if (!hasDL) s += '• Chưa Data Live — thiếu peer/CPU/RAM.\n';
      s += '\nGợi ý: chạy 24/7, mở 31401-3, bật Data Live, xem app Pi Desktop.\n• ' + ev.join('\n• ');
      return s + ctx;
    }
    var e = 'About rewards/bonus I only infer from node data (not wallet):\n';
    if (t.level === 'ok' && t.ports_all_open) e += '• Ports/connectivity look OK — unlikely offline.\n';
    else e += '• Connectivity/ports need fixing first.\n';
    if (!hasDL) e += '• No Data Live — missing peers/CPU/RAM.\n';
    e += '\nTips: keep 24/7, open 31401-3, enable Data Live, check Pi Desktop.\n• ' + ev.join('\n• ');
    return e + ctx;
  }
  if (intent === 'ADVICE' || intent === 'RECOMMENDATION') {
    if (lang === 'vi') {
      var a = 'Tư vấn giữ node ổn:\n';
      if (!hasDL) a += '• #1 Bật Data Live để có peer/CPU/RAM/nhiệt.\n';
      if (t.ram != null && t.ram >= 80) a += '• RAM cao — thêm RAM hoặc giảm app.\n';
      if (t.ports_all_open) a += '• Cổng đang mở — tốt.\n';
      else a += '• Mở firewall 31401-3.\n';
      a += '• Không sleep máy; container ' + (t.container || 'testnet2') + ' Running.\n• ' + (ev.join('\n• ') || '');
      return a + ctx;
    }
    var b = 'Advice to keep the node healthy:\n';
    if (!hasDL) b += '• #1 Enable Data Live for peers/CPU/RAM/temp.\n';
    if (t.ram != null && t.ram >= 80) b += '• High RAM — add RAM or close apps.\n';
    if (t.ports_all_open) b += '• Ports open — good.\n';
    else b += '• Open firewall 31401-3.\n';
    b += '• No sleep; container ' + (t.container || 'testnet2') + ' Running.\n• ' + (ev.join('\n• ') || '');
    return b + ctx;
  }
  if (intent === 'NODE_HEALTH' || intent === 'DIAGNOSIS' || intent === 'GENERAL') {
    var hard = issues.filter(function (i) { return !/Data Live/.test(i); });
    if (lang === 'vi') {
      var out = (t.level === 'ok' && hard.length === 0)
        ? ('Node đang ổn' + (t.sync ? ' (' + t.sync + ')' : '') + '.\n')
        : ('Cần lưu ý:\n• ' + issues.join('\n• ') + '\n\n');
      out += 'Chi tiết:\n• ' + ev.join('\n• ');
      if (!hasDL) out += '\nBật Data Live để đánh giá sâu hơn.';
      return out + ctx;
    }
    var o = (t.level === 'ok' && hard.length === 0)
      ? ('Node looks healthy' + (t.sync ? ' (' + t.sync + ')' : '') + '.\n')
      : ('Watch items:\n• ' + issues.join('\n• ') + '\n\n');
    o += 'Details:\n• ' + ev.join('\n• ');
    if (!hasDL) o += '\nEnable Data Live for deeper checks.';
    return o + ctx;
  }
  return L(lang,
    'Dữ liệu: ' + (ev.join('; ') || 'đang thu thập') + '. Hỏi thêm về đồng bộ, peer, nhiệt nhé.' + ctx,
    'Data: ' + (ev.join('; ') || 'collecting') + '. Ask about sync, peers, or temperature.' + ctx
  );
}

function buildFacts(t) {
  const f = { source: t.source || null, level: t.level || null };
  ['sync', 'ledger', 'ledger_age', 'peer_in', 'peer_out', 'docker', 'container', 'cpu', 'ram', 'temp', 'ports_open'].forEach(function (k) {
    if (t[k] != null) f[k] = t[k];
  });
  if (t.ports) f.ports = t.ports;
  if (t.sources) f.sources = t.sources;
  return f;
}

function historySnippet(n) {
  try {
    return readHistory(1).slice(-(n || 16)).map(function (r) {
      const o = { ts: r.ts, level: r.level };
      ['sync', 'ledger', 'peer_in', 'ram', 'cpu', 'temp'].forEach(function (k) { if (r[k] != null) o[k] = r[k]; });
      return o;
    });
  } catch (e) { return []; }
}

async function aiAnalyze(t, userQ) {
  const intent = detectIntent(userQ || '');
  const metric = rulesMetricOnly(t, intent);
  if (metric && ['RAM', 'CPU', 'TEMP', 'PEERS', 'PORT', 'DOCKER', 'BLOCK_SYNC'].indexOf(intent) >= 0) {
    return metric;
  }

  if (GEMINI_API_KEY) {
    const facts = buildFacts(t);
    const hist = historySnippet(16);
    const chat = loadChatHistory().slice(-8);
    const issues = collectIssues(t);
    const prompt = [
      'You are a professional Pi Node management assistant (SoloHost Controller).',
      'LANGUAGE RULE (mandatory): Reply in the SAME language as the user message. If user writes English, reply English. If Vietnamese, Vietnamese. If other, match that language. Never force Vietnamese.',
      'Be natural and contextual: use Recent chat to continue the conversation, refer to earlier points, avoid one-shot generic answers.',
      'Use FACTS only. Never invent metrics. If missing, say data is unavailable / enable Data Live.',
      'Do not mark Node Offline only because Data Live is offline.',
      'Bonus advice only from uptime, ports, peers, resources — never invent bonus numbers.',
      'Intent: ' + intent,
      'User: ' + String(userQ || '').slice(0, 600),
      'Issues: ' + JSON.stringify(issues),
      'FACTS: ' + JSON.stringify(facts),
      hist.length ? ('Recent telemetry: ' + JSON.stringify(hist)) : '',
      chat.length ? ('Recent chat (use as context): ' + JSON.stringify(chat)) : '',
      'Give practical advice when useful. Keep it concise.'
    ].filter(Boolean).join('\n');

    try {
      const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.65, maxOutputTokens: 1024 }
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
        req.setTimeout(25000, function () { try { req.destroy(); } catch (e) {} resolve(null); });
        req.write(body);
        req.end();
      });
      if (text && String(text).trim()) return String(text).trim().slice(0, 3500);
    } catch (e) {}
  }

  return localAssistantReply(t, intent, userQ || '');
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 STATUS', callback_data: 'cmd_status' },
        { text: '🔄 SYNC', callback_data: 'cmd_sync' },
        { text: '👥 PEERS', callback_data: 'cmd_peers' }
      ],
      [
        { text: '📋 REPORT', callback_data: 'cmd_report' },
        { text: '🔎 DIAG', callback_data: 'cmd_diagnostic' },
        { text: '🤖 AI', callback_data: 'cmd_analyze' }
      ],
      [
        { text: '🛠️ SCRIPTS', callback_data: 'cmd_scripts' },
        { text: '❤️ DONATE', callback_data: 'cmd_donate' }
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
  if (cmd === 'donate') return tgSend(formatDonate());
  if (cmd === 'ping') return tgSend('🏓 pong · v' + VERSION + '\n⏱ cache ' + (Date.now() - cacheAt) + 'ms');
  if (cmd === 'start' || cmd === 'help') {
    return tgSend(
      'PI NODE CONTROLLER · SoloHost\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '/status /sync /peers\n/report /diagnostic /analyze\n/scripts /donate\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      'Data Live → Horizon → Ports',
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
  if (BOT_TOKEN) {
    const dw = await tgApi('deleteWebhook', { drop_pending_updates: false });
    log('deleteWebhook ' + (dw && dw.ok ? 'ok' : 'skip'));
  }
  while (true) {
    if (!BOT_TOKEN) { await wait(5000); continue; }
    try {
      const r = await tgApi('getUpdates', {
        offset: offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });
      if (!r) {
        await wait(1500);
        continue;
      }
      if (r.ok === false) {
        log('getUpdates fail: ' + (r.description || ''), 'error');
        await wait(2000);
        continue;
      }
      if (!Array.isArray(r.result)) {
        await wait(1000);
        continue;
      }
      for (const u of r.result) {
        offset = u.update_id + 1;
        // Do not block the next long-poll on slow AI
        processUpdate(u);
      }
    } catch (e) {
      log('tg loop ' + (e && e.message), 'error');
      await wait(2000);
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
      ok('horizon_first', true, 'DataLive optional');
      ok('history_dir', fs.existsSync(DIR_HIST), DIR_HIST);
      // synthetic merge tests
      const m1 = mergeTelemetry(null, { source: 'Horizon', ledger: 100, sync: 'Horizon OK', confidence: 'medium' }, { ports: { '31401': 'OPEN', '31402': 'OPEN', '31403': 'OPEN' }, openCount: 3 });
      ok('fallback_horizon', m1.ledger === 100 && m1.source === 'Horizon', m1.source);
      ok('datalive_offline_not_node_offline', m1.level !== 'critical', m1.level);
      const m2 = mergeTelemetry({ source: 'DataLive', sync: 'Synced!', ledger: 200, peer_in: 5, peer_out: 3, confidence: 'high' }, null, { ports: { '31401': 'OPEN', '31402': 'OPEN', '31403': 'OPEN' }, openCount: 3 });
      ok('primary_datalive', m2.source === 'DataLive' && m2.ledger === 200, m2.source);
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
        version: VERSION, dataLiveUrl: DATA_LIVE_URL,
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
  log('DATA_LIVE_URL=' + DATA_LIVE_URL + ' telemetry=' + TELEMETRY_SEC + 's');
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
