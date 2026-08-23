// ============================================================
//  Pi Node Telegram Controller — SoloHost PRO v2.4.2
//  Nguồn: Horizon :31401 (chính) · Core /info · cổng · docker tùy chọn
//  Tin nhắn icon · cảnh báo thông minh · lịch sử · log · AI · script
// ============================================================
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '2.4.2-solohost-pro';
const DATA = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_HOST = (process.env.NODE_HOST || 'host.docker.internal').trim();
const HORIZON_PORT = parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401;
const CORE_PORT_CFG = parseInt(process.env.STELLAR_CORE_PORT || '11626', 10) || 11626;
const NODE_PORTS = [31401, 31402, 31403];
const CORE_PORTS = unique([CORE_PORT_CFG, 11626, 11625, 11627, 31400]);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const ALERT_ON_START = String(process.env.ALERT_ON_START || 'true').toLowerCase() !== 'false';
const NODE_LABEL = (process.env.PI_CONTAINER || 'testnet2').trim() || 'testnet2';
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const REPORT_HOURS = parseHours(process.env.REPORT_HOURS, [7, 19]);
const ALERT_COOLDOWN = Math.max(60, parseInt(process.env.ALERT_COOLDOWN_SEC || '180', 10) || 180);
const OFFLINE_CONFIRM = Math.max(2, parseInt(process.env.OFFLINE_CONFIRM_COUNT || '3', 10) || 3);
const SOCK = '/var/run/docker.sock';
const GITHUB_PRO = 'https://github.com/cannoi/pinode-telegram-controller';

const DIR_HIST = path.join(DATA, 'history');
const DIR_STATE = path.join(DATA, 'state');
const DIR_LOGS = path.join(DATA, 'logs');
const STATE_F = path.join(DIR_STATE, 'node-state.json');
const LOG_F = path.join(DIR_LOGS, 'controller.log');
const PUBLIC = path.join(__dirname, 'public');
const SCRIPTS = path.join(__dirname, 'scripts');

function unique(a) { const o = []; a.forEach(n => { if (n && o.indexOf(n) < 0) o.push(n); }); return o; }
function parseHours(raw, def) {
  const a = String(raw || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 0 && n <= 23);
  return a.length ? a : def;
}
function ensureDirs() {
  [DIR_HIST, DIR_STATE, DIR_LOGS].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} });
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
function nowStr() {
  try {
    return new Date().toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  } catch (e) { return new Date().toISOString(); }
}
function hourVN() {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: 'numeric', hour12: false }).formatToParts(new Date());
    return parseInt(p.find(x => x.type === 'hour').value, 10) % 24;
  } catch (e) { return (new Date().getUTCHours() + 7) % 24; }
}
function dayVN() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtN(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); }
function fmtAge(sec) {
  if (sec == null) return '—';
  if (sec < 60) return sec + 's';
  return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
}

function log(msg, level) {
  level = level || 'info';
  const line = '[' + nowISO() + '] [' + level + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(LOG_F, line + '\n');
    if (fs.statSync(LOG_F).size > 2e6) { try { fs.renameSync(LOG_F, LOG_F + '.1'); } catch (e) {} }
  } catch (e) {}
}

let state = loadJSON(STATE_F, {
  lastLevel: null, lastAlertAt: 0, lastReportKey: '',
  offlineStreak: 0, lastLedger: null, lastLedgerAt: 0, alertCount: 0
});
let _bestHost = null;
let _lastCollectAt = 0;

// ---------- net ----------
function probeTcp(host, port, timeout) {
  return new Promise(res => {
    const s = new net.Socket();
    let done = false;
    const fin = v => { if (done) return; done = true; try { s.destroy(); } catch (e) {} res(v); };
    s.setTimeout(timeout || 1000);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(port, host); } catch (e) { fin(false); }
  });
}
function httpGet(host, port, pathname, timeout) {
  return new Promise(resolve => {
    const req = http.request({ host, port, path: pathname, method: 'GET', timeout: timeout || 2500 }, r => {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}
function candidateHosts() {
  const list = [];
  const add = h => { if (h && list.indexOf(h) < 0) list.push(h); };
  add(NODE_HOST); add('host.docker.internal');
  add('172.17.0.1'); add('172.18.0.1'); add('172.19.0.1'); add('10.0.2.2');
  // IP container node nếu biết (diagnostic: 172.18.0.2 trên pi-network)
  add('172.18.0.2');
  try {
    const rows = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    for (const row of rows) {
      const p = row.split('\t');
      if (p[1] === '00000000' && p[2] && p[2] !== '00000000') {
        const hex = p[2];
        add([hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)].map(x => parseInt(x, 16)).join('.'));
        break;
      }
    }
  } catch (e) {}
  return list;
}

// ---------- Docker optional ----------
function sockReq(method, pathname, body) {
  return new Promise(resolve => {
    try { if (!fs.existsSync(SOCK)) return resolve(null); } catch (e) { return resolve(null); }
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      socketPath: SOCK, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, r => {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(7000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}
function decodeStream(raw) {
  if (!raw) return '';
  try {
    const buf = Buffer.from(raw, 'binary');
    if (buf.length < 8) return String(raw);
    let out = '', i = 0, n = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4); i += 8;
      if (size <= 0 || i + size > buf.length) break;
      out += buf.slice(i, i + size).toString('utf8'); i += size; n++;
    }
    if (n && out) return out;
  } catch (e) {}
  return String(raw);
}

async function dockerMeta() {
  const r = await sockReq('GET', '/containers/json?all=1');
  if (!r || r.status !== 200) return { access: false };
  let arr; try { arr = JSON.parse(r.body); } catch (e) { return { access: false }; }
  const want = NODE_LABEL.toLowerCase();
  let best = null, bestScore = -1;
  for (const c of arr) {
    const names = (c.Names || []).map(n => String(n).replace(/^\//, ''));
    const joined = names.join(' ').toLowerCase();
    const image = String(c.Image || '').toLowerCase();
    let score = 0;
    if (names.some(n => n.toLowerCase() === want)) score += 100;
    if (/testnet|mainnet|pi-node|stellar/.test(joined)) score += 20;
    if (/pi-node-docker|pinetwork/.test(image)) score += 40;
    if (c.State === 'running') score += 15;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best || bestScore < 15) return { access: true, found: false };
  const name = ((best.Names && best.Names[0]) || '').replace(/^\//, '');
  return {
    access: true, found: true, running: best.State === 'running',
    id: best.Id, name, image: best.Image || '', status: best.Status || best.State || ''
  };
}

async function dockerCoreInfo(id) {
  const cmd = [
    'stellar-core http-command info 2>/dev/null',
    'curl -s --max-time 3 http://127.0.0.1:11626/info 2>/dev/null',
    'wget -qO- http://127.0.0.1:11626/info 2>/dev/null',
    'curl -s --max-time 3 http://127.0.0.1:11626/peers 2>/dev/null'
  ].join(' || ');
  const ex = await sockReq('POST', '/containers/' + id + '/exec', {
    AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ['sh', '-c', cmd]
  });
  if (!ex || ex.status >= 400) return null;
  let eid; try { eid = JSON.parse(ex.body).Id; } catch (e) { return null; }
  const out = await sockReq('POST', '/exec/' + eid + '/start', { Detach: false, Tty: false });
  if (!out) return null;
  return parseCoreInfo(decodeStream(out.body), 'docker-exec');
}

async function dockerPeers(id) {
  const cmd = 'curl -s --max-time 3 http://127.0.0.1:11626/peers 2>/dev/null || wget -qO- http://127.0.0.1:11626/peers 2>/dev/null';
  const ex = await sockReq('POST', '/containers/' + id + '/exec', {
    AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ['sh', '-c', cmd]
  });
  if (!ex || ex.status >= 400) return null;
  let eid; try { eid = JSON.parse(ex.body).Id; } catch (e) { return null; }
  const out = await sockReq('POST', '/exec/' + eid + '/start', { Detach: false, Tty: false });
  if (!out) return null;
  return parsePeers(decodeStream(out.body));
}

// ---------- parsers ----------
function parseCoreInfo(body, source) {
  if (!body || !/state|ledger|Synced/i.test(body)) return null;
  try {
    const m = String(body).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const info = j.info || j;
    if (!info || typeof info !== 'object') return null;
    const ledger = info.ledger || {};
    const peers = info.peers || {};
    const stateStr = String(info.state || '');
    const low = stateStr.toLowerCase();
    let sync = 'unknown';
    if (low.includes('synced')) sync = 'synced';
    else if (/catch|join|boot|wait/.test(low)) sync = 'catching';
    else if (stateStr) sync = 'other';
    return {
      state: stateStr || 'unknown', sync,
      ledger: ledger.num != null ? Number(ledger.num) : null,
      ledgerAge: ledger.age != null ? Number(ledger.age) : null,
      peersAuth: peers.authenticated_count != null ? Number(peers.authenticated_count) : null,
      peersPending: peers.pending_count != null ? Number(peers.pending_count) : null,
      network: info.network || null,
      build: info.build || null,
      protocol: info.protocol_version != null ? info.protocol_version : null,
      source
    };
  } catch (e) { return null; }
}

function parsePeers(body) {
  if (!body) return null;
  try {
    const m = String(body).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    // dạng authenticated_count hoặc mảng peers
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const auth = j.authenticated_count != null ? Number(j.authenticated_count) : null;
      // một số bản có inbound/outbound
      const inn = j.inbound != null ? Number(j.inbound) : (j.authenticated_count != null ? Number(j.authenticated_count) : null);
      const out = j.outbound != null ? Number(j.outbound) : inn;
      return { in: inn, out: out, auth };
    }
    if (Array.isArray(j)) {
      const n = j.length;
      return { in: n, out: n, auth: n };
    }
  } catch (e) {}
  return null;
}

function parseHorizon(body, source) {
  if (!body) return null;
  try {
    const j = JSON.parse(body);
    // Root Horizon
    let ledger = null;
    if (j.core_latest_ledger != null) ledger = Number(j.core_latest_ledger);
    else if (j.history_latest_ledger != null) ledger = Number(j.history_latest_ledger);
    else if (j.ingest_latest_ledger != null) ledger = Number(j.ingest_latest_ledger);
    // /ledgers?limit=1
    if (ledger == null && j._embedded && j._embedded.records && j._embedded.records[0]) {
      ledger = Number(j._embedded.records[0].sequence);
    }
    if (ledger == null && j.sequence != null) ledger = Number(j.sequence);
    if (ledger == null) return null;
    return {
      ledger,
      network: j.network_passphrase || null,
      coreVersion: j.core_version || null,
      horizonVersion: j.horizon_version || null,
      protocol: j.current_protocol_version != null ? j.current_protocol_version : j.core_supported_protocol_version,
      source
    };
  } catch (e) { return null; }
}

// ---------- collectors ----------
async function fetchHorizon() {
  const hosts = _bestHost ? [_bestHost].concat(candidateHosts().filter(h => h !== _bestHost)) : candidateHosts();
  const paths = ['/', '/ledgers?limit=1&order=desc'];
  for (const host of hosts) {
    for (const pathName of paths) {
      const r = await httpGet(host, HORIZON_PORT, pathName, 2500);
      if (r && r.status === 200 && r.body) {
        const h = parseHorizon(r.body, host + ':' + HORIZON_PORT + pathName);
        if (h) {
          _bestHost = host;
          log('horizon ok ' + h.source + ' ledger=' + h.ledger);
          return h;
        }
      }
    }
  }
  return null;
}

async function fetchCoreHttp() {
  const hosts = _bestHost ? [_bestHost].concat(candidateHosts().filter(h => h !== _bestHost)) : candidateHosts();
  for (const host of hosts) {
    for (const port of CORE_PORTS) {
      const r = await httpGet(host, port, '/info', 2000);
      if (r && r.status === 200 && r.body) {
        const info = parseCoreInfo(r.body, host + ':' + port);
        if (info) {
          _bestHost = host;
          log('core http ok ' + info.source);
          return info;
        }
      }
    }
  }
  return null;
}

async function checkPorts() {
  const hosts = _bestHost ? [_bestHost].concat(candidateHosts().filter(h => h !== _bestHost)) : candidateHosts();
  let best = [], used = null;
  for (const host of hosts) {
    const open = [];
    await Promise.all(NODE_PORTS.map(async p => { if (await probeTcp(host, p, 900)) open.push(p); }));
    if (open.length > best.length) { best = open; used = host; if (open.length === 3) break; }
  }
  if (used && !_bestHost) _bestHost = used;
  return best.sort((a, b) => a - b);
}

// Host resources (container view — tham khảo)
function hostRes() {
  let cpu = null, ram = null;
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = k => { const m = mi.match(new RegExp(k + ':\\s+(\\d+)')); return m ? parseInt(m[1], 10) : 0; };
    const tot = g('MemTotal'), av = g('MemAvailable');
    if (tot) ram = Math.round((1 - av / tot) * 1000) / 10;
  } catch (e) {}
  return { cpu, ram, temp: null }; // temp cần sensor host — không có trong container
}

// ---------- decision engine ----------
async function collectOnce() {
  const t0 = Date.now();
  // song song: horizon + core http + ports + docker
  const [horizon, coreHttp, ports, dmeta] = await Promise.all([
    fetchHorizon(),
    fetchCoreHttp(),
    checkPorts(),
    dockerMeta()
  ]);

  let core = coreHttp;
  let peers = null;
  // docker exec nếu có sock + container
  if (dmeta && dmeta.found && dmeta.running && dmeta.id) {
    if (!core) {
      core = await dockerCoreInfo(dmeta.id);
    }
    peers = await dockerPeers(dmeta.id);
  }

  const portsOk = ports.length;
  const portsAll = portsOk === NODE_PORTS.length;

  // Gộp ledger / sync
  let ledger = core && core.ledger != null ? core.ledger : (horizon ? horizon.ledger : null);
  let ledgerAge = core && core.ledgerAge != null ? core.ledgerAge : null;
  let sync = core ? core.sync : 'unknown';
  let syncLabel = 'Chưa rõ';
  let confidence = 'LOW';

  if (core && core.sync === 'synced') {
    sync = 'synced'; syncLabel = 'Đồng bộ tốt'; confidence = 'HIGH';
  } else if (core && core.sync === 'catching') {
    sync = 'catching'; syncLabel = 'Đang đồng bộ'; confidence = 'HIGH';
  } else if (horizon && ledger != null && portsOk >= 2) {
    // Horizon sống + cổng mở → coi node online, sync unknown (không bịa Synced)
    sync = 'likely';
    syncLabel = 'Horizon OK';
    confidence = 'MED';
  } else if (portsAll) {
    sync = 'unknown';
    syncLabel = 'Cổng mở';
    confidence = 'LOW';
  }

  // Peer In/Out
  let peerIn = null, peerOut = null;
  if (peers) {
    peerIn = peers.in; peerOut = peers.out;
  } else if (core && core.peersAuth != null) {
    peerIn = peerOut = core.peersAuth;
  }

  const dockerRunning = dmeta && dmeta.found ? !!dmeta.running : null;
  const containerName = (dmeta && dmeta.name) || NODE_LABEL;

  // reachable
  let reachable = !!(core || horizon || portsOk >= 2);
  if (!core && !horizon && portsOk === 0) reachable = false;

  // level — không biến UNKNOWN thành WARNING
  let level = 'ok';
  let reason = 'Node đang vận hành ổn.';
  if (!reachable) {
    level = 'critical';
    reason = 'Node không phản hồi — kiểm tra Pi Node / Docker.';
  } else if (sync === 'catching') {
    level = 'soft';
    reason = 'Node đang bắt kịp đồng bộ — chưa cần can thiệp.';
  } else if (ledgerAge != null && ledgerAge > 300) {
    level = 'warning';
    reason = 'Ledger Age cao (' + fmtAge(ledgerAge) + ').';
  } else if (peerIn != null && peerIn < 2) {
    level = 'soft';
    reason = 'Peer thấp (' + peerIn + ') — theo dõi thêm.';
  } else if (dockerRunning === false) {
    level = 'critical';
    reason = 'Container Docker đã dừng.';
  } else if (sync === 'synced' || (sync === 'likely' && portsAll)) {
    level = 'ok';
    reason = 'Node đang vận hành ổn: đồng bộ tốt' + (dockerRunning ? ', Docker chạy' : '') + (portsAll ? ', cổng mở.' : '.');
  } else if (portsOk > 0) {
    level = 'ok';
    reason = 'Cổng node còn mở. Chi tiết Core chưa đọc được từ bên ngoài (11626 không publish).';
  }

  // ledger stalled
  if (ledger != null && state.lastLedger != null && state.lastLedgerAt) {
    const elapsed = Date.now() - state.lastLedgerAt;
    if (ledger === state.lastLedger && elapsed > 12 * 60 * 1000 && sync === 'synced') {
      level = level === 'ok' ? 'warning' : level;
      reason = 'Ledger không tăng trong ' + Math.round(elapsed / 60000) + ' phút.';
    }
  }

  const res = hostRes();
  _lastCollectAt = Date.now();

  return {
    version: VERSION,
    level, reason, confidence, reachable, sync, syncLabel,
    ledger, ledgerAge,
    peerIn, peerOut,
    ports, portsOk, portsAll,
    dockerRunning, containerName,
    core, horizon,
    res,
    network: (core && core.network) || (horizon && horizon.network) || null,
    sources: {
      core: !!(core && core.source),
      horizon: !!horizon,
      docker: !!(dmeta && dmeta.access),
      ports: portsOk
    },
    elapsedMs: Date.now() - t0,
    ts: Date.now(),
    time: nowStr()
  };
}

async function collectStatus() {
  const st = await collectOnce();
  if (!st.reachable) {
    state.offlineStreak = (state.offlineStreak || 0) + 1;
    if (state.offlineStreak < OFFLINE_CONFIRM) {
      st.level = 'soft';
      st.reason = 'Đang xác nhận mất kết nối (' + state.offlineStreak + '/' + OFFLINE_CONFIRM + ')…';
    }
  } else {
    if (state.offlineStreak > 0) log('reachable after streak=' + state.offlineStreak);
    state.offlineStreak = 0;
  }
  if (st.ledger != null && st.ledger !== state.lastLedger) {
    state.lastLedger = st.ledger;
    state.lastLedgerAt = Date.now();
  }
  saveJSON(STATE_F, state);
  return st;
}

// ---------- history ----------
function appendHistory(st) {
  try {
    const f = path.join(DIR_HIST, dayVN() + '.jsonl');
    fs.appendFileSync(f, JSON.stringify({
      t: nowISO(), level: st.level, sync: st.sync, ledger: st.ledger,
      ledgerAge: st.ledgerAge, peers: st.peerIn, portsOk: st.portsOk,
      docker: st.dockerRunning, conf: st.confidence
    }) + '\n');
  } catch (e) { log('hist ' + (e && e.message), 'error'); }
}
function readHistory(days) {
  const out = [];
  for (let i = 0; i < (days || 1); i++) {
    const d = new Date(Date.now() - i * 864e5);
    let key; try { key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
    catch (e) { key = d.toISOString().slice(0, 10); }
    try {
      fs.readFileSync(path.join(DIR_HIST, key + '.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
        .forEach(l => { try { out.push(JSON.parse(l)); } catch (e) {} });
    } catch (e) {}
  }
  return out;
}
function analyzeHistory(days) {
  const rows = readHistory(days || 1);
  if (!rows.length) return { text: '📊 Chưa đủ lịch sử. App cần chạy thêm vài giờ.' };
  const total = rows.length;
  const bad = rows.filter(r => r.level === 'critical').length;
  const soft = rows.filter(r => r.level === 'soft' || r.level === 'warning').length;
  const ok = total - bad - soft;
  const ledgers = rows.map(r => r.ledger).filter(x => x != null);
  const pct = Math.round(ok / total * 1000) / 10;
  let v = '🟢 Node hoạt động ổn định.';
  if (bad > total * 0.05) v = '🟠 Có lúc mất kết nối.';
  if (bad > total * 0.2) v = '🔴 Mất kết nối khá nhiều.';
  return {
    text: [
      '📊 <b>PHÂN TÍCH ' + (days || 1) + ' NGÀY</b>',
      '━━━━━━━━━━━━━━━━',
      '• Mẫu: <b>' + total + '</b> · Ổn định: <b>' + pct + '%</b>',
      '• Cảnh báo: ' + soft + ' · Mất KN: ' + bad,
      ledgers.length ? '• Ledger: ' + fmtN(Math.min.apply(null, ledgers)) + ' → ' + fmtN(Math.max.apply(null, ledgers)) : '',
      '', v
    ].filter(Boolean).join('\n')
  };
}

async function aiAnalyze(st) {
  const hist = analyzeHistory(1);
  if (!GEMINI_API_KEY) return hist.text + '\n\n<i>Thêm GEMINI_API_KEY để bật AI.</i>';
  const prompt = 'Trợ lý Pi Node cho người dùng phổ thông. Phân tích ngắn tiếng Việt (tối đa 7 dòng), có icon.\n' +
    JSON.stringify({ level: st.level, sync: st.sync, ledger: st.ledger, peers: st.peerIn, ports: st.portsOk, reason: st.reason });
  try {
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
    const t = await new Promise(resolve => {
      const u = new URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(GEMINI_API_KEY));
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, r => {
        let b = ''; r.on('data', d => b += d);
        r.on('end', () => {
          try {
            const j = JSON.parse(b);
            resolve(j.candidates && j.candidates[0] && j.candidates[0].content.parts[0].text);
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(18000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
      req.write(body); req.end();
    });
    return t ? '🤖 <b>AI</b>\n' + esc(t).slice(0, 1400) : hist.text;
  } catch (e) { return hist.text; }
}

// ---------- status message (đúng mẫu user) ----------
const LEVEL_HEAD = {
  ok: '🟢 TRẠNG THÁI NODE — ỔN ĐỊNH',
  soft: '🟡 TRẠNG THÁI NODE — CẦN THEO DÕI',
  warning: '🟠 TRẠNG THÁI NODE — CẢNH BÁO',
  critical: '🔴 TRẠNG THÁI NODE — MẤT KẾT NỐI'
};

function formatStatus(st) {
  const head = LEVEL_HEAD[st.level] || LEVEL_HEAD.ok;
  const dockerTxt = st.dockerRunning === true ? 'RUNNING ✅'
    : st.dockerRunning === false ? 'STOPPED ❌'
    : '— (không có sock)';
  const portsTxt = st.portsAll ? 'OPEN ✅' : (st.portsOk > 0 ? 'MỘT PHẦN ⚠️' : 'CLOSED ❌');
  const peerTxt = (st.peerIn != null || st.peerOut != null)
    ? ('In ' + (st.peerIn != null ? st.peerIn : '—') + '  /  Out ' + (st.peerOut != null ? st.peerOut : '—'))
    : '—';
  const ageTxt = st.ledgerAge != null ? ('   · age ' + fmtAge(st.ledgerAge)) : '';
  const secAgo = _lastCollectAt ? Math.max(0, Math.round((Date.now() - _lastCollectAt) / 1000)) : 0;

  const ram = st.res && st.res.ram != null ? st.res.ram + '%' : '—';
  const cpu = st.res && st.res.cpu != null ? st.res.cpu + '%' : '—';
  // Nhiệt độ host không đọc được trong SoloHost container — bỏ hoặc —
  const temp = st.res && st.res.temp != null ? st.res.temp + '°C' : null;

  const lines = [
    head,
    '━━━━━━━━━━━━━━━━',
    '🕐  ' + esc(st.time || nowStr()),
    '━━━━━━━━━━━━━━━━',
    '✅  Đồng bộ     ' + esc(st.syncLabel || '—'),
    '📦  Ledger      ' + fmtN(st.ledger) + ageTxt,
    '🔗  Peer        ' + peerTxt,
    '🐳  Docker      ' + dockerTxt,
    '🔌  Cổng        ' + portsTxt,
    '📦  Container   ' + esc(st.containerName || '—'),
    '━━━━━━━━━━━━━━━━'
  ];
  if (temp) lines.push('🧠  RAM ' + ram + '   ⚙️ CPU ' + cpu + '   🌡️ ' + temp);
  else lines.push('🧠  RAM ' + ram + '   ⚙️ CPU ' + cpu);
  lines.push('━━━━━━━━━━━━━━━━');
  lines.push('💬  ' + esc(st.reason || ''));
  lines.push('📡 Pi Node Telegram Controller PRO');
  lines.push('⏱ Dữ liệu: ' + secAgo + ' giây trước');
  return lines.join('\n');
}

function formatSync(st) {
  return [
    '🔄 <b>ĐỒNG BỘ</b>',
    '━━━━━━━━━━━━━━━━',
    '✅  ' + esc(st.syncLabel),
    '📦  Ledger  ' + fmtN(st.ledger) + (st.ledgerAge != null ? ' · age ' + fmtAge(st.ledgerAge) : ''),
    '🔗  Peer    ' + (st.peerIn != null ? st.peerIn : '—'),
    '',
    st.sync === 'synced' ? '🟢 Đồng bộ tốt.' : (st.sync === 'catching' ? '⏳ Đang bắt kịp.' : '⚪ Chưa đủ dữ liệu Core.')
  ].join('\n');
}

function formatPorts(st) {
  const lines = ['🔌 <b>CỔNG NODE</b>', '━━━━━━━━━━━━━━━━'];
  NODE_PORTS.forEach(p => lines.push((st.ports.indexOf(p) >= 0 ? '✅' : '❌') + '  ' + p));
  lines.push('');
  lines.push(st.portsAll ? '🟢 Tất cả cổng mở.' : '⚠️ Có cổng chưa mở.');
  return lines.join('\n');
}

function formatDiagnostic(st) {
  const ok = v => v ? '✅' : '❌';
  return [
    '🔎 <b>DIAGNOSTIC</b>',
    '━━━━━━━━━━━━━━━━',
    'Container   ' + esc(st.containerName),
    'Core API    ' + ok(st.sources.core) + (st.core && st.core.source ? ' · ' + esc(st.core.source) : ''),
    'Horizon     ' + ok(st.sources.horizon) + (st.horizon ? ' · :' + HORIZON_PORT : ''),
    'Docker sock ' + ok(st.sources.docker),
    'Sync        ' + esc(st.sync) + ' · confidence ' + esc(st.confidence),
    'Ledger      ' + fmtN(st.ledger),
    'Ports       ' + st.portsOk + '/' + NODE_PORTS.length,
    '',
    st.level === 'ok' ? '🟢 Không phát hiện vấn đề.' : ('💬 ' + esc(st.reason))
  ].join('\n');
}

function formatDonate() {
  return [
    '❤️ <b>DONATE</b>',
    '━━━━━━━━━━━━━━━━',
    'Ngân hàng: <b>MB Bank</b> (Ngân hàng Quân Đội)',
    'Số TK: <code>0905428801</code>',
    'Tên: <b>TRAN HUU NGHI</b>',
    '',
    'Cảm ơn bạn đã ủng hộ dự án.'
  ].join('\n');
}

function formatScripts() {
  return [
    '🛠️ <b>SCRIPT WINDOWS</b>',
    '━━━━━━━━━━━━━━━━',
    'Tải về → PowerShell <b>Run as Admin</b>:',
    '• CleanRAM.ps1',
    '• Maintenance.ps1',
    '• Reset-PiNode.ps1',
    '',
    'Web UI app có nút tải.'
  ].join('\n');
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: 'cmd_status' },
        { text: '🔄 Sync', callback_data: 'cmd_sync' },
        { text: '🔌 Ports', callback_data: 'cmd_ports' }
      ],
      [
        { text: '🔎 Diagnostic', callback_data: 'cmd_diagnostic' },
        { text: '📈 Phân tích', callback_data: 'cmd_analyze' },
        { text: '🛠️ Scripts', callback_data: 'cmd_scripts' }
      ],
      [
        { text: '💻 Windows PRO', url: GITHUB_PRO },
        { text: '❤️ Donate', callback_data: 'cmd_donate' }
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
    req.setTimeout(15000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
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
async function tgAnswerCb(id, text) {
  return tgApi('answerCallbackQuery', { callback_query_id: id, text: text || '' });
}

async function monitorTick() {
  try {
    const st = await collectStatus();
    appendHistory(st);
    const now = Date.now();
    const prev = state.lastLevel;
    const should = (() => {
      if (prev == null) return false;
      if (st.level === prev) return false;
      if (st.level === 'ok' && (prev === 'critical' || prev === 'warning')) return true;
      if (st.level === 'critical' && prev !== 'critical') return true;
      if (st.level === 'warning' && prev === 'ok') return true;
      return false;
    })();
    if (should && now - (state.lastAlertAt || 0) >= ALERT_COOLDOWN * 1000) {
      await tgSend(formatStatus(st), { reply_markup: mainKeyboard() });
      state.lastAlertAt = now;
      state.alertCount = (state.alertCount || 0) + 1;
      log('alert ' + st.level + ' ' + st.reason, 'warn');
    }
    state.lastLevel = st.level;
    const h = hourVN();
    const key = dayVN() + '-' + h;
    if (REPORT_HOURS.indexOf(h) >= 0 && state.lastReportKey !== key) {
      state.lastReportKey = key;
      await tgSend('📋 <b>Báo cáo ' + h + 'h</b>\n\n' + formatStatus(st), { reply_markup: mainKeyboard() });
    }
    saveJSON(STATE_F, state);
  } catch (e) { log('monitor ' + (e && e.message), 'error'); }
}

async function runCmd(cmd) {
  if (cmd === 'status' || cmd === 's') {
    const st = await collectStatus();
    return tgSend(formatStatus(st), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'sync' || cmd === 'dongbo') {
    return tgSend(formatSync(await collectStatus()), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'ports') return tgSend(formatPorts(await collectStatus()), { reply_markup: mainKeyboard() });
  if (cmd === 'diagnostic' || cmd === 'diag') {
    return tgSend(formatDiagnostic(await collectStatus()), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'analyze' || cmd === 'ai') {
    await tgSend('⏳ Đang phân tích…');
    const st = await collectStatus();
    return tgSend(await aiAnalyze(st), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'history') return tgSend(analyzeHistory(1).text, { reply_markup: mainKeyboard() });
  if (cmd === 'donate') return tgSend(formatDonate());
  if (cmd === 'scripts' || cmd === 'script') return tgSend(formatScripts(), { reply_markup: mainKeyboard() });
  if (cmd === 'ping') return tgSend('🏓 pong · v' + VERSION + '\n🕐 ' + esc(nowStr()), { reply_markup: mainKeyboard() });
  if (cmd === 'report') {
    return tgSend(formatStatus(await collectStatus()), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'start' || cmd === 'help') {
    return tgSend(
      '<b>PI NODE CONTROLLER</b> · SoloHost PRO\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '/status — trạng thái\n/sync — đồng bộ\n/ports — cổng\n' +
      '/diagnostic — kiểm tra sâu\n/analyze — phân tích\n' +
      '/scripts — script Windows\n/donate — ủng hộ\n' +
      '━━━━━━━━━━━━━━━━\n' +
      'Nguồn: Horizon :' + HORIZON_PORT + ' · Core · cổng · docker (tuỳ chọn)',
      { reply_markup: mainKeyboard() }
    );
  }
  return null;
}

async function handleText(text) {
  const raw = (text || '').trim();
  const cmd = raw.toLowerCase().split(/\s+/)[0].replace(/@\w+$/, '').replace(/^\//, '');
  if (raw.startsWith('/')) {
    const r = await runCmd(cmd);
    return r || tgSend('Gõ /help', { reply_markup: mainKeyboard() });
  }
  if (/node|status|thế nào|trạng thái/i.test(raw)) return runCmd('status');
  if (/đồng bộ|sync/i.test(raw)) return runCmd('sync');
  if (/cổng|port/i.test(raw)) return runCmd('ports');
  if (/donate|ủng hộ/i.test(raw)) return runCmd('donate');
  return null;
}

let offset = 0;
async function pollTelegram() {
  if (!BOT_TOKEN) return;
  try {
    const r = await tgApi('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    if (!r || !r.ok || !Array.isArray(r.result)) return;
    for (const u of r.result) {
      offset = u.update_id + 1;
      if (u.callback_query) {
        const cq = u.callback_query;
        if (CHAT_ID && String(cq.message && cq.message.chat.id) !== String(CHAT_ID)) continue;
        await tgAnswerCb(cq.id);
        if ((cq.data || '').startsWith('cmd_')) {
          try { await runCmd(cq.data.slice(4)); } catch (e) { log('cb ' + e.message, 'error'); }
        }
        continue;
      }
      const msg = u.message;
      if (!msg || !msg.text) continue;
      if (CHAT_ID && String(msg.chat.id) !== String(CHAT_ID)) continue;
      try { await handleText(msg.text); } catch (e) { log('cmd ' + e.message, 'error'); }
    }
  } catch (e) { log('tg ' + e.message, 'error'); }
}
async function tgLoop() {
  while (true) { await pollTelegram(); await wait(400); }
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.ps1': 'text/plain; charset=utf-8'
};
let INDEX_HTML = '';
try { INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); } catch (e) {
  INDEX_HTML = '<h1>Pi Node Controller ' + VERSION + '</h1>';
}

const srv = http.createServer(async (req, res) => {
  const u = (req.url || '/').split('?')[0];
  try {
    if (u === '/healthz') { res.end('ok'); return; }
    if (u === '/api/status') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(await collectStatus()));
      return;
    }
    if (u === '/api/history') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readHistory(2).slice(-120)));
      return;
    }
    if (u === '/api/analyze') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(analyzeHistory(1)));
      return;
    }
    if (u === '/api/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        version: VERSION, githubPro: GITHUB_PRO,
        hasBot: !!BOT_TOKEN, hasChat: !!CHAT_ID, hasAI: !!GEMINI_API_KEY,
        horizonPort: HORIZON_PORT, reportHours: REPORT_HOURS, time: nowStr()
      }));
      return;
    }
    if (u === '/api/logs') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      try { res.end(fs.readFileSync(LOG_F, 'utf8').slice(-8000)); }
      catch (e) { res.end('(no log)'); }
      return;
    }
    if (u === '/' || u === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(INDEX_HTML);
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
      res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream');
      res.end(data);
    });
  } catch (e) {
    log('http ' + e.message, 'error');
    res.statusCode = 500; res.end('error');
  }
});

srv.listen(PORT, '0.0.0.0', () => {
  log('SoloHost PRO v' + VERSION + ' :' + PORT);
  log('horizon=:' + HORIZON_PORT + ' corePorts=' + CORE_PORTS.join(',') + ' host=' + NODE_HOST);
  log('bot=' + (BOT_TOKEN ? 'yes' : 'NO') + ' sock=' + (fs.existsSync(SOCK) ? 'yes' : 'no'));
});

monitorTick();
setInterval(monitorTick, 15000);

if (BOT_TOKEN && CHAT_ID) {
  tgLoop();
  if (ALERT_ON_START) {
    setTimeout(async () => {
      try {
        const st = await collectStatus();
        await tgSend('✅ <b>Controller online</b>\n\n' + formatStatus(st), { reply_markup: mainKeyboard() });
      } catch (e) { log('start ' + e.message, 'error'); }
    }, 3500);
  }
} else {
  log('thiếu BOT_TOKEN/CHAT_ID', 'warn');
}
