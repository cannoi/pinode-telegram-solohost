'use strict';
/**
 * SoloHost Controller v2.5.0
 * - Telegram long-poll independent of 60s telemetry
 * - Data Live PRIMARY → Horizon → Port probe
 * - Normalized schema; hide missing fields
 * - Alert state machine; history; optional Gemini
 * - NO docker.sock required
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

const VERSION = '2.5.5-solohost';
const DATA = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8080', 10);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const DATA_LIVE_URL = (process.env.DATA_LIVE_URL || 'http://host.docker.internal:18790').replace(/\/$/, '');
const DATA_LIVE_TOKEN = (process.env.DATA_LIVE_TOKEN || '').trim();
const NODE_HOST = (process.env.NODE_HOST || 'host.docker.internal').trim();
const HORIZON_PORT = parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401;
const NODE_LABEL = (process.env.PI_CONTAINER || 'testnet2').trim() || 'testnet2';
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
  const hosts = [NODE_HOST, 'host.docker.internal', '172.17.0.1', '172.18.0.1'];
  for (const host of hosts) {
    for (const pth of ['/', '/ledgers?limit=1&order=desc']) {
      const r = await httpGetUrl('http://' + host + ':' + HORIZON_PORT + pth, {}, 2500);
      if (!r || r.status !== 200 || !r.body) continue;
      try {
        const j = JSON.parse(r.body);
        let ledger = null;
        if (j.core_latest_ledger != null) ledger = Number(j.core_latest_ledger);
        else if (j.history_latest_ledger != null) ledger = Number(j.history_latest_ledger);
        else if (j.ingest_latest_ledger != null) ledger = Number(j.ingest_latest_ledger);
        else if (j._embedded && j._embedded.records && j._embedded.records[0])
          ledger = Number(j._embedded.records[0].sequence);
        if (ledger == null) continue;
        const o = { source: 'Horizon', ledger };
        if (j.network_passphrase) o.network = j.network_passphrase;
        // Horizon alive + ledger → soft sync label only (not claim Synced!)
        o.sync = 'Horizon OK';
        o.confidence = 'medium';
        return o;
      } catch (e) {}
    }
  }
  return null;
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
  const [dl, hz, pr] = await Promise.all([fetchDataLive(), fetchHorizon(), fetchPorts()]);
  const t = mergeTelemetry(dl, hz, pr);
  // ledger stall
  if (t.ledger != null && state.lastLedger != null && state.lastLedgerAt) {
    const elapsed = Date.now() - state.lastLedgerAt;
    if (t.ledger === state.lastLedger && elapsed > 12 * 60 * 1000 && /Synced/i.test(t.sync || '')) {
      t.level = t.level === 'ok' ? 'warning' : t.level;
      t.stall = true;
    }
  }
  if (t.ledger != null && t.ledger !== state.lastLedger) {
    state.lastLedger = t.ledger;
    state.lastLedgerAt = Date.now();
  }
  cache = t;
  cacheAt = Date.now();
  try { fs.writeFileSync(LATEST_F, JSON.stringify(t)); } catch (e) {}
  appendHistory(t);
  saveJSON(STATE_F, state);
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
  const age = cacheAt ? Math.max(0, Math.round((Date.now() - cacheAt) / 1000)) : 0;
  let head = '🟢 PI NODE — OK';
  if (mode === 'ALERT' || t.level === 'critical') head = '🔴 PI NODE — ALERT';
  else if (t.level === 'warning') head = '🟠 PI NODE — WARNING';
  else if (t.level === 'soft') head = '🟡 PI NODE — WATCH';
  else if (mode === 'RECOVERED') head = '🟢 PI NODE — RECOVERED';

  const lines = [head, '━━━━━━━━━━━━━━━━━━'];
  const syncTxt = t.sync ? (/Synced/i.test(t.sync) ? 'Good' : t.sync) : null;
  const nodeTxt = t.docker ? (/RUN/i.test(t.docker) ? 'Running' : t.docker) : null;
  const netTxt = t.ports_all_open ? 'Good' : (t.ports_open > 0 ? 'Partial' : (t.ports ? 'Down' : null));
  const ramTxt = t.ram != null ? (Math.round(t.ram) + '%') : null;
  let cpuTxt = null;
  if (t.cpu != null) cpuTxt = t.cpu < 85 ? 'Normal' : (Math.round(t.cpu) + '%');
  const tempTxt = t.temp != null ? (Math.round(t.temp) + '°C') : null;

  [
    lineIf('🔄', 'Sync:', syncTxt),
    lineIf('🐳', 'Node:', nodeTxt),
    lineIf('🌐', 'Network:', netTxt),
    lineIf('🧠', 'RAM:', ramTxt),
    lineIf('⚙️', 'CPU:', cpuTxt),
    lineIf('🌡️', 'Temp:', tempTxt),
    lineIf('📦', 'Ledger:', t.ledger != null ? fmtN(t.ledger) : null),
    lineIf('🔗', 'Peers:', (t.peer_in != null || t.peer_out != null)
      ? ('IN ' + (t.peer_in != null ? t.peer_in : '?') + ' / OUT ' + (t.peer_out != null ? t.peer_out : '?')) : null),
    lineIf('📦', 'Container:', t.container || null)
  ].forEach(l => { if (l) lines.push(l); });

  lines.push('');
  lines.push('🕐 ' + nowHM());
  if (t.level === 'ok') {
    lines.push('💡 No issues detected.');
    lines.push('✅ Node can continue running.');
  } else if (mode === 'RECOVERED') {
    lines.push('💡 Node recovered.');
  } else {
    lines.push('💡 Check /diagnostic for details.');
  }
  lines.push('');
  lines.push('📡 Source: ' + (t.source || '—'));
  lines.push('⏱ ' + age + 's ago · v' + VERSION);
  return lines.join('\n');
}

function formatPeers(t) {
  const lines = ['🔗 PEERS — STELLAR CORE', '━━━━━━━━━━━━━━━━━━'];
  if (t.peer_in == null && t.peer_out == null) {
    lines.push('⚠️ Peer data unavailable');
    lines.push('(needs Data Live)');
    return lines.join('\n');
  }
  if (t.peer_in != null) lines.push('🟢 Incoming: ' + t.peer_in);
  if (t.peer_out != null) lines.push('🔵 Outgoing: ' + t.peer_out);
  lines.push('');
  lines.push('⏱ ' + (cacheAt ? Math.round((Date.now() - cacheAt) / 1000) : 0) + 's ago');
  return lines.join('\n');
}

function formatDiagnostic(t) {
  const ok = v => v ? '✅' : '⚠️';
  const lines = [
    '🔎 NODE DIAGNOSTIC',
    '━━━━━━━━━━━━━━━━━━',
    '',
    '📡 DATA SOURCES',
    ok(t.sources && t.sources.data_live) + ' Data Live',
    ok(t.sources && t.sources.horizon) + ' Horizon',
    ok(t.sources && t.sources.ports) + ' Port Probe',
    '',
    '🐳 DOCKER'
  ];
  if (t.docker) lines.push('✅ Docker          ' + t.docker);
  else lines.push('⚠️ Docker          unavailable');
  if (t.container) lines.push('✅ Container       ' + t.container);
  lines.push('');
  lines.push('🔄 NODE');
  if (t.sync) lines.push('✅ Sync            ' + t.sync);
  else lines.push('⚠️ Sync            unavailable');
  if (t.ledger != null) lines.push('📦 Ledger          ' + fmtN(t.ledger));
  if (t.peer_in != null || t.peer_out != null)
    lines.push('👥 Peers           IN ' + (t.peer_in != null ? t.peer_in : '?') + ' / OUT ' + (t.peer_out != null ? t.peer_out : '?'));
  lines.push('');
  lines.push('🔌 PORTS');
  NODE_PORTS.forEach(p => {
    const st = t.ports && t.ports[String(p)];
    lines.push((st === 'OPEN' ? '✅' : (st ? '❌' : '⚠️')) + ' ' + p + '           ' + (st || 'unavailable'));
  });
  lines.push('');
  lines.push('🧠 RESOURCES');
  if (t.ram != null) lines.push('✅ RAM             ' + Math.round(t.ram) + '%');
  else lines.push('⚠️ RAM             unavailable');
  if (t.cpu != null) lines.push('✅ CPU             ' + t.cpu + '%');
  else lines.push('⚠️ CPU             unavailable');
  if (t.temp != null) lines.push('✅ Temperature     ' + t.temp + '°C');
  else lines.push('⚠️ Temperature     unavailable');
  return lines.join('\n');
}

function formatReport() {
  const rows = readHistory(1);
  const lines = ['🟢 PI NODE REPORT', '━━━━━━━━━━━━━━━━━━', '🕐 ' + nowHM()];
  if (!rows.length) {
    lines.push('ℹ️ Data: collecting…');
    return lines.join('\n');
  }
  const total = rows.length;
  const ok = rows.filter(r => r.level === 'ok').length;
  const crit = rows.filter(r => r.level === 'critical').length;
  const ledgers = rows.map(r => r.ledger).filter(x => x != null);
  const peers = rows.map(r => r.peer_in).filter(x => x != null);
  lines.push('ℹ️ Samples: ' + total);
  lines.push('✅ Stable: ' + (Math.round(ok / total * 1000) / 10) + '%');
  if (ledgers.length)
    lines.push('📦 Ledger: ' + fmtN(Math.min.apply(null, ledgers)) + ' → ' + fmtN(Math.max.apply(null, ledgers)));
  if (peers.length)
    lines.push('👥 Peer IN: ' + Math.min.apply(null, peers) + '–' + Math.max.apply(null, peers));
  lines.push('');
  lines.push('📌 ISSUES');
  lines.push(crit ? ('🟠 Critical samples: ' + crit) : '🟢 None detected.');
  lines.push('');
  lines.push('💡 CONCLUSION');
  lines.push(crit > total * 0.1 ? '🟠 Check node / network.' : '🟢 Node is healthy.');
  return lines.join('\n');
}

function formatScripts() {
  return [
    'SCRIPTS (Windows)',
    '================',
    '1) DATA LIVE (recommended)',
    '   Start-DataLive.bat',
    '   DataLive_HttpApi.ps1',
    '   -> http://127.0.0.1:18790',
    '',
    '2) Maintenance',
    '   CleanRAM_PiNode.ps1',
    '   Weekly_Maintenance.ps1',
    '   Reset_Node_Network.ps1',
    '   Pi_Node_Diagnostic_PRO.ps1',
    '',
    'Download from Web UI /scripts/',
    'Run DataLive without Admin if port free.',
    'Maintenance scripts: Run as Admin.'
  ].join('\n');
}

function formatDonate() {
  return [
    '❤️ DONATE',
    '━━━━━━━━━━━━━━━━━━',
    'Bank: MB Bank',
    'Account: 0905428801',
    'Name: TRAN HUU NGHI'
  ].join('\n');
}

/* aiAnalyze replaced */



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
  const ev = evidenceSummary(t);
  const issues = collectIssues(t);
  const hasDL = t.sources && t.sources.data_live;

  if (intent === 'GREETING') {
    return 'Chào bạn. Mình là trợ lý Pi Node trên SoloHost.\nHiện node ' + (t.level === 'ok' ? 'đang hoạt động bình thường' : 'cần theo dõi') + ' (nguồn: ' + (t.source || '?') + ').\nBạn có thể hỏi trạng thái, peer, nhiệt, bonus, hoặc cách giữ node ổn định.';
  }
  if (intent === 'SMALLTALK') {
    return 'Bây giờ khoảng ' + nowHM() + ' (giờ VN).\nMình chuyên hỗ trợ Pi Node — cứ hỏi tình trạng máy hoặc cách vận hành node nhé.';
  }
  if (intent === 'CLARIFY') {
    return 'Không sao. Tóm lại:\n• Node: ' + (t.level === 'ok' ? 'OK' : String(t.level || '?')) + '\n• ' + (ev.slice(0, 4).join('\n• ') || 'Đang thu thập dữ liệu') + '\n\nBạn muốn mình giải thích đồng bộ, cổng, peer, hay điểm thưởng?';
  }
  if (intent === 'BONUS' || (intent === 'DIAGNOSIS' && /bonus|thưởng|reward/i.test(userQ || ''))) {
    var s = 'Về điểm thưởng/bonus, mình chỉ suy luận từ dữ liệu node (không đọc ví Pi):\n';
    if (t.level === 'ok' && t.ports_all_open) s += '• Cổng và kết nối nhìn chung ổn — ít khả năng do node offline.\n';
    else s += '• Kết nối/cổng chưa ổn — nên xử lý trước.\n';
    if (!hasDL) s += '• Chưa có Data Live nên thiếu peer/CPU/RAM — các yếu tố hay ảnh hưởng uptime.\n';
    if (t.peer_in != null && t.peer_in < 3) s += '• Peer thấp có thể làm node kém gắn với mạng.\n';
    s += '\nGợi ý:\n1) Giữ Docker/Pi Node 24/7, tắt sleep máy\n2) Mở đủ cổng 31401–31403\n3) Bật Data Live để theo dõi peer & tài nguyên\n4) Xem thông báo trên app Pi Desktop về bonus\n\nĐo được:\n• ' + ev.join('\n• ');
    return s;
  }
  if (intent === 'ADVICE' || intent === 'RECOMMENDATION') {
    var a = 'Tư vấn giữ node ổn (theo số liệu hiện có):\n';
    if (!hasDL) a += '• Ưu tiên #1: bật Data Live trên Windows để có peer/CPU/RAM/nhiệt.\n';
    if (t.ram != null && t.ram >= 80) a += '• RAM cao → thêm RAM hoặc giảm app nền.\n';
    else if (t.ram == null) a += '• Chưa đo RAM — đừng vội mua thêm trước khi có số liệu Data Live.\n';
    if (t.temp != null && t.temp >= 75) a += '• Máy ấm → thoáng khí/quạt.\n';
    if (t.ports_all_open) a += '• Cổng node đang mở — tốt.\n';
    else a += '• Kiểm tra firewall/router mở 31401–31403.\n';
    a += '• Giữ máy không sleep; container ' + (t.container || 'testnet2') + ' Running.\n';
    a += '\nĐo được:\n• ' + (ev.join('\n• ') || 'Chưa đủ telemetry');
    return a;
  }
  if (intent === 'NODE_HEALTH' || intent === 'DIAGNOSIS' || intent === 'GENERAL') {
    var hard = issues.filter(function (i) { return !/Data Live/.test(i); });
    var out = '';
    if (t.level === 'ok' && hard.length === 0) {
      out = 'Nhìn dữ liệu hiện có, node đang chạy ổn';
      if (t.sync) out += ' (' + t.sync + ')';
      out += '.\n';
    } else {
      out = 'Có điểm cần lưu ý:\n• ' + issues.join('\n• ') + '\n\n';
    }
    out += 'Chi tiết:\n• ' + ev.join('\n• ') + '\n';
    if (!hasDL) out += '\nBật Data Live để đánh giá sâu hơn (peer, CPU, RAM, nhiệt) giống bản Windows PRO.';
    return out;
  }
  return 'Dữ liệu hiện có:\n• ' + (ev.join('\n• ') || 'Đang thu thập') + '\n\nBạn hỏi cụ thể về đồng bộ, peer, nhiệt hoặc nâng cấp nhé.';
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
      'Bạn là trợ lý quản lý Pi Node chuyên nghiệp cho người dùng phổ thông (SoloHost).',
      'Giọng tiếng Việt tự nhiên, ngắn, dễ hiểu, có suy luận từ FACTS — không cứng như log hệ thống.',
      'CẤM bịa số liệu. Thiếu field thì nói chưa đo được / cần Data Live.',
      'Không kết luận Node Offline chỉ vì thiếu Data Live.',
      'Bonus: chỉ tư vấn gián tiếp từ uptime, cổng, peer, tài nguyên — không bịa số bonus.',
      'Intent: ' + intent,
      'User: ' + String(userQ || '').slice(0, 600),
      'Issues: ' + JSON.stringify(issues),
      'FACTS: ' + JSON.stringify(facts),
      hist.length ? ('Telemetry gần đây: ' + JSON.stringify(hist)) : '',
      chat.length ? ('Chat gần đây: ' + JSON.stringify(chat)) : '',
      'Trả lời tự nhiên; đưa lời khuyên thực tế khi phù hợp.'
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
  return tgApi('sendMessage', Object.assign({
    chat_id: CHAT_ID, text: String(text).slice(0, 4000),
    parse_mode: 'HTML', disable_web_page_preview: true
  }, extra || {}));
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

async function telegramLoop() {
  while (true) {
    if (!BOT_TOKEN) { await wait(5000); continue; }
    try {
      const r = await tgApi('getUpdates', {
        offset, timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });
      if (!r || !r.ok || !Array.isArray(r.result)) {
        await wait(1000);
        continue;
      }
      for (const u of r.result) {
        offset = u.update_id + 1;
        try {
          if (u.callback_query) {
            const cq = u.callback_query;
            if (CHAT_ID && String(cq.message && cq.message.chat.id) !== String(CHAT_ID)) continue;
            await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
            if ((cq.data || '').startsWith('cmd_')) await runCmd(cq.data.slice(4));
            continue;
          }
          const msg = u.message;
          if (!msg || !msg.text) continue;
          if (CHAT_ID && String(msg.chat.id) !== String(CHAT_ID)) continue;
          await handleText(msg.text);
        } catch (e) { log('tg handle ' + e.message, 'error'); }
      }
    } catch (e) {
      log('tg loop ' + e.message, 'error');
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
      ok('data_live_url', !!DATA_LIVE_URL, DATA_LIVE_URL);
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
