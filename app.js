// ============================================================
//  Pi Node Telegram Controller — SoloHost Edition PRO v2.4.0
//  Không docker.sock · HTTP đa nguồn · cảnh báo thông minh
//  Báo cáo đơn giản · lịch sử · log · AI · script PowerShell
// ============================================================
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '2.4.0-solohost-pro';
const DATA = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_HOST = (process.env.NODE_HOST || 'host.docker.internal').trim();
const STELLAR_CORE_PORT = parseInt(process.env.STELLAR_CORE_PORT || '11626', 10) || 11626;
const CORE_PORTS_TRY = uniqueInts([STELLAR_CORE_PORT, 11626, 31400]);
const NODE_PORTS = [31401, 31402, 31403];
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const ALERT_ON_START = String(process.env.ALERT_ON_START || 'true').toLowerCase() !== 'false';
const NODE_LABEL = (process.env.PI_CONTAINER || process.env.NODE_LABEL || 'Pi Node').trim() || 'Pi Node';
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const _rh = String(process.env.REPORT_HOURS || '').trim();
const REPORT_HOURS = (() => {
  const a = (_rh || '7,19').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 0 && n <= 23);
  return a.length ? a : [7, 19];
})();
const ALERT_COOLDOWN = Math.max(60, parseInt(process.env.ALERT_COOLDOWN_SEC || '180', 10) || 180);
const OFFLINE_CONFIRM = Math.max(2, parseInt(process.env.OFFLINE_CONFIRM_COUNT || '3', 10) || 3);
const GITHUB_PRO = 'https://github.com/cannoi/pinode-telegram-controller';
const GITHUB_SOLO = 'https://github.com/cannoi/pinode-telegram-solohost';

const DIR_HIST = path.join(DATA, 'history');
const DIR_STATE = path.join(DATA, 'state');
const DIR_LOGS = path.join(DATA, 'logs');
const STATE_F = path.join(DIR_STATE, 'node-state.json');
const LOG_F = path.join(DIR_LOGS, 'controller.log');
const PUBLIC = path.join(__dirname, 'public');
const SCRIPTS = path.join(__dirname, 'scripts');

function uniqueInts(arr) {
  const o = [];
  arr.forEach(n => { if (n && o.indexOf(n) < 0) o.push(n); });
  return o;
}

// ---------- dirs ----------
function ensureDirs() {
  [DIR_HIST, DIR_STATE, DIR_LOGS].forEach(d => {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  });
}
ensureDirs();

function loadJSON(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; }
}
function saveJSON(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 0));
    fs.renameSync(tmp, f);
  } catch (e) { log('saveJSON err ' + (e && e.message)); }
}

// ---------- logging ----------
function log(msg, level) {
  level = level || 'info';
  const line = '[' + nowISO() + '] [' + level + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(LOG_F, line + '\n');
    // rotate ~2MB
    const st = fs.statSync(LOG_F);
    if (st.size > 2 * 1024 * 1024) {
      try { fs.renameSync(LOG_F, LOG_F + '.1'); } catch (e) {}
    }
  } catch (e) {}
}

// ---------- time VN ----------
function nowISO() {
  try {
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }).replace(' ', 'T') + '+07:00';
  } catch (e) { return new Date().toISOString(); }
}
function nowStr() {
  try {
    return new Date().toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (e) { return new Date().toISOString(); }
}
function hourVNNow() {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: 'numeric', hour12: false }).formatToParts(new Date());
    const h = p.find(x => x.type === 'hour');
    return h ? parseInt(h.value, 10) % 24 : ((new Date().getUTCHours() + 7) % 24);
  } catch (e) { return (new Date().getUTCHours() + 7) % 24; }
}
function dayVN() {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  } catch (e) { return new Date().toISOString().slice(0, 10); }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtLedger(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}
function fmtAge(sec) {
  if (sec == null) return '—';
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

// ---------- state ----------
let state = loadJSON(STATE_F, {
  lastLevel: null,          // ok | soft | warning | critical
  lastAlertAt: 0,
  lastReportKey: '',
  offlineStreak: 0,
  onlineStreak: 0,
  lastLedger: null,
  lastLedgerAt: 0,
  alertCount: 0
});

// ---------- network helpers ----------
function probeTcp(host, port, timeout) {
  return new Promise(function (res) {
    const s = new net.Socket();
    let done = false;
    const fin = v => { if (done) return; done = true; try { s.destroy(); } catch (e) {} res(v); };
    s.setTimeout(timeout || 1200);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(port, host); } catch (e) { fin(false); }
  });
}

function candidateHosts() {
  const list = [];
  const add = h => { if (h && list.indexOf(h) < 0) list.push(h); };
  add(NODE_HOST);
  add('host.docker.internal');
  add('172.17.0.1');
  add('172.18.0.1');
  add('172.19.0.1');
  add('10.0.2.2');
  try {
    const rows = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    for (const row of rows) {
      const p = row.split('\t');
      if (p[1] === '00000000' && p[2] && p[2] !== '00000000') {
        const hex = p[2];
        const ip = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)]
          .map(x => parseInt(x, 16)).join('.');
        add(ip);
        break;
      }
    }
  } catch (e) {}
  return list;
}

let _bestHost = null;

function httpGet(host, port, pathname, timeout) {
  return new Promise(function (resolve) {
    const req = http.request({
      host, port, path: pathname, method: 'GET', timeout: timeout || 2500
    }, function (r) {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}

// ---------- Core /info ----------
function parseCoreInfo(body) {
  if (!body) return null;
  try {
    const match = String(body).match(/\{[\s\S]*\}/);
    if (!match) return null;
    const j = JSON.parse(match[0]);
    const info = j.info || j;
    if (!info || typeof info !== 'object') return null;
    const ledger = info.ledger || {};
    const peers = info.peers || {};
    const qset = (info.quorum && info.quorum.qset) || {};
    const stateStr = String(info.state || '');
    const low = stateStr.toLowerCase();
    let sync = 'unknown';
    if (low.includes('synced')) sync = 'synced';
    else if (/catch|join|boot|wait/.test(low)) sync = 'catching';
    else if (stateStr) sync = 'other';

    return {
      state: stateStr || 'unknown',
      sync,
      network: info.network || null,
      build: info.build || null,
      protocol: info.protocol_version != null ? info.protocol_version : null,
      ledger: ledger.num != null ? Number(ledger.num) : null,
      ledgerAge: ledger.age != null ? Number(ledger.age) : null,
      peersAuth: peers.authenticated_count != null ? Number(peers.authenticated_count) : null,
      peersPending: peers.pending_count != null ? Number(peers.pending_count) : null,
      quorumPhase: qset.phase || null,
      quorumAgree: qset.agree != null ? Number(qset.agree) : null,
      source: null
    };
  } catch (e) {
    return null;
  }
}

async function fetchCoreInfo() {
  const hosts = _bestHost
    ? [_bestHost].concat(candidateHosts().filter(h => h !== _bestHost))
    : candidateHosts();

  for (const host of hosts) {
    for (const port of CORE_PORTS_TRY) {
      const r = await httpGet(host, port, '/info', 2500);
      if (r && r.status === 200 && r.body) {
        const info = parseCoreInfo(r.body);
        if (info) {
          if (_bestHost !== host) {
            _bestHost = host;
            log('core host=' + host + ':' + port);
          }
          info.source = host + ':' + port;
          return info;
        }
      }
    }
  }
  return null;
}

async function checkPorts() {
  const hosts = _bestHost
    ? [_bestHost].concat(candidateHosts().filter(h => h !== _bestHost))
    : candidateHosts();
  let open = [];
  let usedHost = null;
  for (const host of hosts) {
    const got = [];
    await Promise.all(NODE_PORTS.map(async p => {
      if (await probeTcp(host, p, 1000)) got.push(p);
    }));
    if (got.length > open.length) {
      open = got;
      usedHost = host;
      if (got.length === NODE_PORTS.length) break;
    }
  }
  if (usedHost && !_bestHost) _bestHost = usedHost;
  return open.sort((a, b) => a - b);
}

// ---------- collect ----------
async function collectOnce() {
  const [core, ports] = await Promise.all([fetchCoreInfo(), checkPorts()]);
  const portsOk = ports.length;
  const coreOk = !!(core && core.sync !== 'unknown');

  // reachable: core OK or enough ports
  let reachable = coreOk || portsOk >= 2;
  if (!coreOk && portsOk === 0) reachable = false;

  let level = 'ok';
  let reason = '';

  if (!reachable) {
    level = 'critical';
    reason = 'Node không phản hồi (Core API + cổng đóng)';
  } else if (!coreOk && portsOk > 0) {
    level = 'soft';
    reason = 'Cổng còn mở nhưng chưa đọc được Core /info';
  } else if (core && core.sync === 'catching') {
    level = 'soft';
    reason = 'Node đang bắt kịp đồng bộ';
  } else if (core && core.ledgerAge != null && core.ledgerAge > 300) {
    // > 5 phút mới coi là vấn đề thật (trước đây 30s gây spam)
    level = 'warning';
    reason = 'Ledger Age cao (' + fmtAge(core.ledgerAge) + ')';
  } else if (core && core.peersAuth != null && core.peersAuth < 2) {
    level = 'soft';
    reason = 'Peers rất thấp (' + core.peersAuth + ')';
  } else if (core && core.sync === 'synced') {
    level = 'ok';
    reason = 'Node hoạt động bình thường';
  } else {
    level = 'ok';
    reason = 'Node đang phản hồi';
  }

  // ledger stalled (history)
  if (core && core.ledger != null && state.lastLedger != null && state.lastLedgerAt) {
    const elapsed = Date.now() - state.lastLedgerAt;
    if (core.ledger === state.lastLedger && elapsed > 10 * 60 * 1000 && core.sync === 'synced') {
      level = level === 'ok' ? 'warning' : level;
      reason = 'Ledger không tăng trong ' + Math.round(elapsed / 60000) + ' phút';
    }
  }

  return {
    version: VERSION,
    label: NODE_LABEL,
    reachable,
    level,
    reason,
    core,
    ports,
    portsOk,
    coreOk,
    ts: Date.now(),
    time: nowStr()
  };
}

// Collect with anti-false-offline
async function collectStatus() {
  let st = await collectOnce();
  if (!st.reachable) {
    state.offlineStreak = (state.offlineStreak || 0) + 1;
    state.onlineStreak = 0;
    // chưa đủ số lần → hạ mức xuống soft thay vì critical
    if (state.offlineStreak < OFFLINE_CONFIRM) {
      st.level = 'soft';
      st.reason = 'Đang xác nhận mất kết nối (' + state.offlineStreak + '/' + OFFLINE_CONFIRM + ')';
      log('offline streak ' + state.offlineStreak, 'warn');
    }
  } else {
    if (state.offlineStreak > 0) log('node reachable again after streak=' + state.offlineStreak);
    state.offlineStreak = 0;
    state.onlineStreak = (state.onlineStreak || 0) + 1;
  }

  if (st.core && st.core.ledger != null) {
    if (state.lastLedger !== st.core.ledger) {
      state.lastLedger = st.core.ledger;
      state.lastLedgerAt = Date.now();
    }
  }

  saveJSON(STATE_F, state);
  return st;
}

// ---------- history ----------
function appendHistory(st) {
  try {
    const day = dayVN();
    const f = path.join(DIR_HIST, day + '.jsonl');
    const row = {
      t: nowISO(),
      level: st.level,
      reachable: st.reachable,
      sync: st.core ? st.core.sync : null,
      state: st.core ? st.core.state : null,
      ledger: st.core ? st.core.ledger : null,
      ledgerAge: st.core ? st.core.ledgerAge : null,
      peers: st.core ? st.core.peersAuth : null,
      portsOk: st.portsOk,
      network: st.core ? st.core.network : null,
      protocol: st.core ? st.core.protocol : null
    };
    fs.appendFileSync(f, JSON.stringify(row) + '\n');
  } catch (e) {
    log('history err ' + (e && e.message), 'error');
  }
}

function readHistoryDays(days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    let key;
    try {
      key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    } catch (e) {
      key = d.toISOString().slice(0, 10);
    }
    const f = path.join(DIR_HIST, key + '.jsonl');
    try {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      lines.forEach(line => {
        try { out.push(JSON.parse(line)); } catch (e) {}
      });
    } catch (e) {}
  }
  return out;
}

function analyzeHistory(days) {
  const rows = readHistoryDays(days || 1);
  if (!rows.length) {
    return { samples: 0, text: 'Chưa đủ dữ liệu lịch sử. App cần chạy thêm vài giờ.' };
  }
  const total = rows.length;
  const offline = rows.filter(r => r.level === 'critical' || r.reachable === false).length;
  const soft = rows.filter(r => r.level === 'soft' || r.level === 'warning').length;
  const ok = total - offline - soft;
  const ledgers = rows.map(r => r.ledger).filter(x => x != null);
  const peers = rows.map(r => r.peers).filter(x => x != null);
  const minL = ledgers.length ? Math.min.apply(null, ledgers) : null;
  const maxL = ledgers.length ? Math.max.apply(null, ledgers) : null;
  const avgPeers = peers.length ? Math.round(peers.reduce((a, b) => a + b, 0) / peers.length) : null;

  const pctOk = Math.round((ok / total) * 1000) / 10;
  let verdict = '🟢 Node hoạt động ổn định.';
  if (offline > total * 0.05) verdict = '🟠 Có lúc mất kết nối — nên kiểm tra máy/mạng.';
  if (offline > total * 0.2) verdict = '🔴 Mất kết nối khá nhiều — cần kiểm tra ngay.';

  const lines = [
    '📊 <b>PHÂN TÍCH ' + (days || 1) + ' NGÀY</b>',
    '━━━━━━━━━━━━━━━━',
    '• Mẫu ghi: <b>' + total + '</b>',
    '• Ổn định: <b>' + pctOk + '%</b>',
    '• Cảnh báo nhẹ: ' + soft,
    '• Mất kết nối: ' + offline
  ];
  if (minL != null && maxL != null) {
    lines.push('• Ledger: ' + fmtLedger(minL) + ' → ' + fmtLedger(maxL));
  }
  if (avgPeers != null) lines.push('• Peers TB: ' + avgPeers);
  lines.push('');
  lines.push(verdict);
  return { samples: total, pctOk, offline, soft, minL, maxL, avgPeers, text: lines.join('\n'), verdict };
}

// ---------- AI (Gemini optional) ----------
async function aiAnalyze(st) {
  if (!GEMINI_API_KEY) {
    const hist = analyzeHistory(1);
    return hist.text + '\n\n<i>Gợi ý: thêm GEMINI_API_KEY trong cấu hình để phân tích AI sâu hơn.</i>';
  }
  const hist = analyzeHistory(1);
  const prompt =
    'Bạn là trợ lý giám sát Pi Node cho người dùng phổ thông (không chuyên kỹ thuật). ' +
    'Phân tích ngắn gọn bằng tiếng Việt (tối đa 8 dòng), kết luận rõ ràng, không jargon.\n\n' +
    'Trạng thái hiện tại:\n' + JSON.stringify({
      level: st.level, reason: st.reason, sync: st.core && st.core.sync,
      ledger: st.core && st.core.ledger, ledgerAge: st.core && st.core.ledgerAge,
      peers: st.core && st.core.peersAuth, portsOk: st.portsOk
    }) + '\n\nTóm tắt lịch sử 24h: samples=' + hist.samples +
    ' ok%=' + hist.pctOk + ' offline=' + hist.offline +
    ' ledger ' + hist.minL + '→' + hist.maxL +
    '\n\nTrả lời ngắn, có icon.';

  try {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    });
    const result = await new Promise(function (resolve) {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(GEMINI_API_KEY);
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, function (r) {
        let b = '';
        r.on('data', d => b += d);
        r.on('end', () => {
          try {
            const j = JSON.parse(b);
            const t = j.candidates && j.candidates[0] && j.candidates[0].content &&
              j.candidates[0].content.parts && j.candidates[0].content.parts[0].text;
            resolve(t || null);
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(20000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
      req.write(body);
      req.end();
    });
    if (result) return '🤖 <b>AI phân tích</b>\n' + esc(result).slice(0, 1500);
    return hist.text;
  } catch (e) {
    log('ai err ' + (e && e.message), 'error');
    return hist.text;
  }
}

// ---------- messages (simple for normal users) ----------
const LEVEL_ICON = { ok: '🟢', soft: '🟡', warning: '🟠', critical: '🔴' };
const LEVEL_TEXT = {
  ok: 'ĐANG HOẠT ĐỘNG',
  soft: 'CẦN THEO DÕI',
  warning: 'CẢNH BÁO',
  critical: 'MẤT KẾT NỐI'
};

function formatStatusSimple(st) {
  const icon = LEVEL_ICON[st.level] || '⚪';
  const core = st.core || {};
  const syncTxt = core.sync === 'synced' ? '✅ Đã đồng bộ'
    : core.sync === 'catching' ? '🔄 Đang đồng bộ'
    : st.reachable ? '⚠️ Chưa rõ' : '⛔ Không phản hồi';

  const lines = [
    icon + ' <b>PI NODE</b>' + (st.label ? ' · ' + esc(st.label) : ''),
    '━━━━━━━━━━━━━━━━',
    '• Trạng thái: <b>' + LEVEL_TEXT[st.level] + '</b>',
    '• Đồng bộ: ' + syncTxt
  ];
  if (core.ledger != null) lines.push('• Ledger: <code>' + fmtLedger(core.ledger) + '</code>');
  if (core.peersAuth != null) lines.push('• Peers: <b>' + core.peersAuth + '</b>');
  if (core.ledgerAge != null) lines.push('• Ledger Age: ' + fmtAge(core.ledgerAge));
  lines.push('');
  if (st.level === 'ok') lines.push('🟢 Node đang hoạt động bình thường.');
  else lines.push((LEVEL_ICON[st.level] || '⚪') + ' ' + esc(st.reason || ''));
  lines.push('');
  lines.push('🕐 ' + esc(st.time || nowStr()));
  lines.push('SoloHost PRO <code>v' + VERSION + '</code>');
  return lines.join('\n');
}

function formatSync(st) {
  const core = st.core || {};
  const icon = core.sync === 'synced' ? '✅' : core.sync === 'catching' ? '🟠' : '⚠️';
  const lines = [
    '🔄 <b>PI NODE SYNC</b>',
    '━━━━━━━━━━━━━━━━',
    '• Trạng thái: ' + icon + ' <b>' + esc(core.state || (st.reachable ? '—' : 'Không phản hồi')) + '</b>',
    '• Ledger: <code>' + fmtLedger(core.ledger) + '</code>',
    '• Ledger Age: ' + fmtAge(core.ledgerAge),
    '• Peers: ' + (core.peersAuth != null ? core.peersAuth : '—'),
    ''
  ];
  if (core.sync === 'synced') lines.push('🟢 Node đang đồng bộ tốt.');
  else if (core.sync === 'catching') lines.push('⏳ Đang chờ Node hoàn tất đồng bộ.');
  else lines.push('⚠️ Không đọc được trạng thái đồng bộ.');
  return lines.join('\n');
}

function formatPorts(st) {
  const lines = ['🔌 <b>NODE PORTS</b>', '━━━━━━━━━━━━━━━━'];
  NODE_PORTS.forEach(p => {
    lines.push(p + '  ' + (st.ports.indexOf(p) >= 0 ? '✅' : '❌'));
  });
  lines.push('');
  if (st.portsOk === NODE_PORTS.length) lines.push('Kết nối Node: Bình thường');
  else if (st.portsOk > 0) lines.push('⚠️ Có cổng không phản hồi.');
  else lines.push('🔴 Không có cổng nào mở.');
  return lines.join('\n');
}

function formatDiagnostic(st) {
  const core = st.core || {};
  const ok = v => v ? '✅' : '❌';
  const lines = [
    '🔎 <b>NODE DIAGNOSTIC</b>',
    '━━━━━━━━━━━━━━━━',
    'Node: <b>' + esc(st.label) + '</b>',
    '',
    'Core API       ' + ok(st.coreOk),
    'Sync           ' + ok(core.sync === 'synced') + (core.state ? '  ' + esc(core.state) : ''),
    'Ledger         ' + ok(core.ledger != null) + (core.ledger != null ? '  ' + fmtLedger(core.ledger) : ''),
    'Ledger Age     ' + (core.ledgerAge != null ? fmtAge(core.ledgerAge) : '—'),
    'Peers          ' + (core.peersAuth != null ? core.peersAuth : '—'),
    'Port 31401     ' + ok(st.ports.indexOf(31401) >= 0),
    'Port 31402     ' + ok(st.ports.indexOf(31402) >= 0),
    'Port 31403     ' + ok(st.ports.indexOf(31403) >= 0),
    'Nguồn Core     ' + esc(core.source || '—'),
    '',
    st.level === 'ok' ? '🟢 Không phát hiện vấn đề.' : (LEVEL_ICON[st.level] + ' ' + esc(st.reason))
  ];
  return lines.join('\n');
}

function formatDonate() {
  return [
    '❤️ <b>DONATE</b>',
    '━━━━━━━━━━━━━━━━',
    'Ngân hàng: <b>MB Bank</b> (Ngân hàng Quân Đội)',
    'Số tài khoản: <code>0905428801</code>',
    'Tên: <b>TRAN HUU NGHI</b>',
    '',
    'Cảm ơn bạn đã ủng hộ dự án',
    'Pi Node Telegram Controller PRO.'
  ].join('\n');
}

function formatScriptsHelp() {
  return [
    '🛠️ <b>SCRIPT BẢO TRÌ (Windows)</b>',
    '━━━━━━━━━━━━━━━━',
    'Tải và chạy bằng <b>PowerShell (Run as Admin)</b> trên máy chạy Pi Node:',
    '',
    '• CleanRAM — giải phóng RAM',
    '  <code>/scripts/CleanRAM.ps1</code>',
    '• Maintenance — dọn tạm + kiểm tra disk',
    '  <code>/scripts/Maintenance.ps1</code>',
    '• Reset-PiNode — restart container node',
    '  <code>/scripts/Reset-PiNode.ps1</code>',
    '',
    'Web UI app cũng có nút tải script.',
    '⚠️ Chỉ chạy trên máy <b>của bạn</b>, không chia sẻ máy với người lạ.'
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
  return new Promise(function (resolve) {
    if (!BOT_TOKEN) return resolve(null);
    const data = body ? JSON.stringify(body) : null;
    const opt = {
      hostname: 'api.telegram.org',
      path: '/bot' + BOT_TOKEN + '/' + method,
      method: data ? 'POST' : 'GET',
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    };
    const req = https.request(opt, function (r) {
      let b = '';
      r.on('data', d => b += d);
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
  const body = Object.assign({
    chat_id: CHAT_ID,
    text: String(text).slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, extra || {});
  return tgApi('sendMessage', body);
}

async function tgAnswerCb(id, text) {
  return tgApi('answerCallbackQuery', { callback_query_id: id, text: text || '', show_alert: false });
}

// ---------- monitor / alerts (smart) ----------
async function monitorTick() {
  try {
    const st = await collectStatus();
    appendHistory(st);

    const now = Date.now();
    const prev = state.lastLevel;

    // Chỉ alert khi đổi mức theo hướng xấu hoặc hồi phục từ critical
    const shouldAlert = (() => {
      if (prev == null) return false; // lần đầu không spam
      if (st.level === prev) return false;
      if (st.level === 'ok' && (prev === 'critical' || prev === 'warning')) return true; // hồi phục
      if (st.level === 'critical' && prev !== 'critical') return true;
      if (st.level === 'warning' && (prev === 'ok' || prev === 'soft')) return true;
      // soft không alert để tránh ồn
      return false;
    })();

    if (shouldAlert && now - (state.lastAlertAt || 0) >= ALERT_COOLDOWN * 1000) {
      const title = st.level === 'ok'
        ? '🟢 <b>Node đã ổn định trở lại</b>'
        : LEVEL_ICON[st.level] + ' <b>' + LEVEL_TEXT[st.level] + '</b>';
      await tgSend(title + '\n\n' + formatStatusSimple(st), { reply_markup: mainKeyboard() });
      state.lastAlertAt = now;
      state.alertCount = (state.alertCount || 0) + 1;
      log('alert level=' + st.level + ' reason=' + st.reason, 'warn');
    }

    state.lastLevel = st.level;

    // báo cáo định kỳ
    const hour = hourVNNow();
    const reportKey = dayVN() + '-' + hour;
    if (REPORT_HOURS.indexOf(hour) >= 0 && state.lastReportKey !== reportKey) {
      state.lastReportKey = reportKey;
      await tgSend('📋 <b>Báo cáo định kỳ</b> · ' + hour + 'h\n\n' + formatStatusSimple(st), { reply_markup: mainKeyboard() });
      log('scheduled report hour=' + hour);
    }

    saveJSON(STATE_F, state);
  } catch (e) {
    log('monitor ' + (e && e.message), 'error');
  }
}

// ---------- commands ----------
async function runCmd(cmd) {
  if (cmd === 'status' || cmd === 's') {
    const st = await collectStatus();
    return tgSend(formatStatusSimple(st), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'sync' || cmd === 'dongbo') {
    const st = await collectStatus();
    return tgSend(formatSync(st), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'ports') {
    const st = await collectStatus();
    return tgSend(formatPorts(st), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'diagnostic' || cmd === 'diag' || cmd === 'check') {
    const st = await collectStatus();
    return tgSend(formatDiagnostic(st), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'analyze' || cmd === 'ai' || cmd === 'phan_tich') {
    await tgSend('⏳ Đang phân tích lịch sử…');
    const st = await collectStatus();
    const text = await aiAnalyze(st);
    return tgSend(text, { reply_markup: mainKeyboard() });
  }
  if (cmd === 'history') {
    const hist = analyzeHistory(1);
    return tgSend(hist.text, { reply_markup: mainKeyboard() });
  }
  if (cmd === 'ledger') {
    const st = await collectStatus();
    const core = st.core || {};
    const lines = [
      '📒 <b>LEDGER</b>',
      '━━━━━━━━━━━━━━━━',
      'Hiện tại: <code>' + fmtLedger(core.ledger) + '</code>',
      'Ledger Age: ' + fmtAge(core.ledgerAge),
      '',
      core.ledgerAge != null && core.ledgerAge < 120
        ? '🟢 Đang cập nhật'
        : '⚠️ Ledger có thể chậm'
    ];
    return tgSend(lines.join('\n'), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'peers') {
    const st = await collectStatus();
    const n = st.core && st.core.peersAuth;
    const lines = [
      '👥 <b>PEERS</b>',
      '━━━━━━━━━━━━━━━━',
      'Đang kết nối: <b>' + (n != null ? n : '—') + '</b>',
      '',
      n != null && n >= 3 ? '🟢 Kết nối mạng đang hoạt động.' : '🟠 Peers thấp — theo dõi thêm.'
    ];
    return tgSend(lines.join('\n'), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'network') {
    const st = await collectStatus();
    const c = st.core || {};
    return tgSend(
      '🌐 <b>NETWORK</b>\n━━━━━━━━━━━━━━━━\n' +
      esc(c.network || '—') + '\n' +
      'Protocol: ' + (c.protocol != null ? c.protocol : '—') + '\n' +
      'Build: ' + esc(c.build || '—'),
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'donate') return tgSend(formatDonate());
  if (cmd === 'scripts' || cmd === 'script') return tgSend(formatScriptsHelp(), { reply_markup: mainKeyboard() });
  if (cmd === 'ping') {
    return tgSend('🏓 <b>pong</b>\nv' + VERSION + '\n🕐 ' + esc(nowStr()), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'report') {
    const st = await collectStatus();
    return tgSend('📋 <b>Báo cáo</b>\n\n' + formatStatusSimple(st), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'start' || cmd === 'help') {
    return tgSend(
      '<b>PI NODE CONTROLLER</b>\n' +
      '<i>SoloHost PRO v' + VERSION + '</i>\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '/status — trạng thái ngắn\n' +
      '/sync — đồng bộ\n' +
      '/ports — cổng node\n' +
      '/diagnostic — kiểm tra sâu\n' +
      '/analyze — phân tích lịch sử (+AI)\n' +
      '/ledger · /peers · /network\n' +
      '/scripts — script bảo trì Windows\n' +
      '/donate — ủng hộ dự án\n' +
      '━━━━━━━━━━━━━━━━\n' +
      'App tự giám sát 24/7, chỉ báo khi thật sự cần.',
      { reply_markup: mainKeyboard() }
    );
  }
  return null;
}

async function handleText(text) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase();
  const cmd = lower.split(/\s+/)[0].replace(/@\w+$/, '').replace(/^\//, '');
  if (raw.startsWith('/')) {
    const r = await runCmd(cmd);
    if (r) return r;
    return tgSend('Không rõ lệnh. Gõ /help', { reply_markup: mainKeyboard() });
  }
  if (/node|trạng thái|status|thế nào|ra sao/i.test(raw)) return runCmd('status');
  if (/đồng bộ|sync/i.test(raw)) return runCmd('sync');
  if (/cổng|port/i.test(raw)) return runCmd('ports');
  if (/phân tích|analyze|ai/i.test(raw)) return runCmd('analyze');
  if (/donate|ủng hộ/i.test(raw)) return runCmd('donate');
  return null;
}

let offset = 0;
async function pollTelegram() {
  if (!BOT_TOKEN) return;
  try {
    const r = await tgApi('getUpdates', {
      offset, timeout: 25,
      allowed_updates: ['message', 'callback_query']
    });
    if (!r || !r.ok || !Array.isArray(r.result)) return;
    for (const u of r.result) {
      offset = u.update_id + 1;
      if (u.callback_query) {
        const cq = u.callback_query;
        if (CHAT_ID && String(cq.message && cq.message.chat && cq.message.chat.id) !== String(CHAT_ID)) continue;
        const data = cq.data || '';
        await tgAnswerCb(cq.id);
        if (data.startsWith('cmd_')) {
          try { await runCmd(data.slice(4)); } catch (e) { log('cb ' + (e && e.message), 'error'); }
        }
        continue;
      }
      const msg = u.message;
      if (!msg || !msg.text) continue;
      if (CHAT_ID && String(msg.chat.id) !== String(CHAT_ID)) continue;
      try { await handleText(msg.text); } catch (e) { log('cmd ' + (e && e.message), 'error'); }
    }
  } catch (e) {
    log('tg ' + (e && e.message), 'error');
  }
}
async function tgLoop() {
  while (true) {
    await pollTelegram();
    await wait(400);
  }
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.ps1': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

let INDEX_HTML = '';
try { INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); } catch (e) {
  INDEX_HTML = '<h1>Pi Node Controller v' + VERSION + '</h1>';
}

const srv = http.createServer(async function (req, res) {
  const u = (req.url || '/').split('?')[0];
  try {
    if (u === '/healthz' || u === '/health') { res.end('ok'); return; }
    if (u === '/api/status') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(await collectStatus()));
      return;
    }
    if (u === '/api/history') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readHistoryDays(2).slice(-100)));
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
        version: VERSION,
        githubPro: GITHUB_PRO,
        githubSolo: GITHUB_SOLO,
        hasBot: !!BOT_TOKEN,
        hasChat: !!CHAT_ID,
        hasAI: !!GEMINI_API_KEY,
        reportHours: REPORT_HOURS,
        corePorts: CORE_PORTS_TRY,
        time: nowStr()
      }));
      return;
    }
    if (u === '/api/logs') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      try {
        const t = fs.readFileSync(LOG_F, 'utf8');
        res.end(t.slice(-8000));
      } catch (e) { res.end('(chưa có log)'); }
      return;
    }
    if (u === '/' || u === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(INDEX_HTML);
      return;
    }
    // scripts download
    if (u.startsWith('/scripts/')) {
      const name = path.basename(u);
      const f = path.join(SCRIPTS, name);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
        res.end(fs.readFileSync(f));
        return;
      }
    }
    const rel = path.normalize(u).replace(/^(\.\.[/\\])+/, '');
    const f = path.join(PUBLIC, rel);
    fs.readFile(f, function (err, data) {
      if (err) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(data);
    });
  } catch (e) {
    log('http ' + (e && e.message), 'error');
    res.statusCode = 500;
    res.end('error');
  }
});

srv.listen(PORT, '0.0.0.0', function () {
  log('SoloHost PRO v' + VERSION + ' :' + PORT);
  log('bot=' + (BOT_TOKEN ? 'yes' : 'NO') + ' chat=' + (CHAT_ID || 'NO') + ' ai=' + (GEMINI_API_KEY ? 'yes' : 'no'));
  log('corePorts=' + CORE_PORTS_TRY.join(',') + ' nodeHost=' + NODE_HOST);
});

// start loops
monitorTick();
setInterval(monitorTick, 15000);

if (BOT_TOKEN && CHAT_ID) {
  tgLoop();
  if (ALERT_ON_START) {
    setTimeout(async () => {
      try {
        const st = await collectStatus();
        await tgSend(
          '✅ <b>Controller đã online</b>\n\n' + formatStatusSimple(st),
          { reply_markup: mainKeyboard() }
        );
      } catch (e) { log('start alert ' + (e && e.message), 'error'); }
    }, 3000);
  }
} else {
  log('thiếu BOT_TOKEN/CHAT_ID — chỉ web UI', 'warn');
}
