// ============================================================
//  Pi Node Telegram Controller — SoloHost Edition PRO v2.2.0
//  Giờ VN · tin nhắn rõ · web UI chuyên nghiệp
// ============================================================
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '2.3.0-solohost-pro';
const DATA = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_HOST = process.env.NODE_HOST || 'host.docker.internal';
const REQUIRED = [31401, 31402, 31403];
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const ALERT_ON_START = String(process.env.ALERT_ON_START || 'true').toLowerCase() !== 'false';
const _rhRaw = String(process.env.REPORT_HOURS || '').trim();
const REPORT_HOURS = (() => {
  const arr = (_rhRaw || '7,19').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 0 && n <= 23);
  return arr.length ? arr : [7, 19];
})();
const ALERT_COOLDOWN = Math.max(30, parseInt(process.env.ALERT_COOLDOWN_SEC || '60', 10) || 60);
const SOCK = '/var/run/docker.sock';
const GITHUB_PRO = 'https://github.com/cannoi/pinode-telegram-controller';
const DONATE_URL = 'https://github.com/cannoi/pinode-telegram-controller#donate';

const STATE_F = path.join(DATA, 'state.json');
const HIST_F = path.join(DATA, 'history.json');
const MAX_HIST = 80;

function loadJSON(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; }
}
function saveJSON(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, f);
  } catch (e) {}
}

let state = loadJSON(STATE_F, {
  lastRunning: null, lastSeverity: 'ok', lastAlertAt: 0,
  lastReportHour: -1, alertCount: 0, pendingReset: null
});
let history = loadJSON(HIST_F, []);

function pushHist(ev) {
  history.unshift(Object.assign({ t: Date.now() }, ev));
  if (history.length > MAX_HIST) history = history.slice(0, MAX_HIST);
  saveJSON(HIST_F, history);
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Giờ Việt Nam cố định (không phụ thuộc TZ container)
function nowStr() {
  try {
    return new Date().toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (e) {
    return new Date().toISOString();
  }
}

function probe(host, port, timeout) {
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

// Danh sách host thử dò cổng node trên máy thật (SoloHost / Docker Desktop / Linux)
function candidateHosts() {
  const list = [];
  const add = h => { if (h && list.indexOf(h) < 0) list.push(h); };
  add(NODE_HOST);
  add('host.docker.internal');
  add('172.17.0.1');   // docker0 mặc định
  add('172.18.0.1');
  add('172.19.0.1');
  add('172.20.0.1');
  add('10.0.2.2');     // một số VM
  // gateway từ /proc/net/route
  try {
    const rows = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    for (const row of rows) {
      const p = row.split('\t');
      if (p[1] === '00000000' && p[2] && p[2] !== '00000000') {
        const hex = p[2];
        const ip = [hex.slice(6,8), hex.slice(4,6), hex.slice(2,4), hex.slice(0,2)]
          .map(x => parseInt(x, 16)).join('.');
        add(ip);
        break;
      }
    }
  } catch (e) {}
  return list;
}

let _probeHost = null; // host đang dùng tốt nhất
async function localOpen() {
  const hosts = _probeHost ? [_probeHost].concat(candidateHosts().filter(h => h !== _probeHost)) : candidateHosts();
  for (const host of hosts) {
    const open = [];
    await Promise.all(REQUIRED.map(async p => { if (await probe(host, p, 1000)) open.push(p); }));
    if (open.length > 0) {
      if (_probeHost !== host) {
        _probeHost = host;
        console.log('[probe] dùng host=' + host + ' ports=' + open.join(','));
      }
      return open.sort((a, b) => a - b);
    }
  }
  return [];
}

function _readStat() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (p[3] || 0) + (p[4] || 0);
    const total = p.reduce((a, b) => a + (b || 0), 0);
    return { idle, total };
  } catch (e) { return null; }
}
let _cpuPct = null;
async function _cpuSampler() {
  let prev = _readStat();
  while (true) {
    await wait(2000);
    const cur = _readStat();
    if (prev && cur) {
      const dt = cur.total - prev.total, di = cur.idle - prev.idle;
      if (dt > 0) _cpuPct = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
    }
    prev = cur;
  }
}
function hostRes() {
  let ram = null, up = null, memGB = null;
  try {
    const s = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    up = (d > 0 ? d + ' ngày ' : '') + h + ' giờ ' + m + ' phút';
  } catch (e) {}
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = k => { const m = mi.match(new RegExp(k + ':\\s+(\\d+)')); return m ? parseInt(m[1], 10) : 0; };
    const tot = g('MemTotal'), av = g('MemAvailable');
    if (tot) { ram = Math.round((1 - av / tot) * 100); memGB = +(tot / 1048576).toFixed(1); }
  } catch (e) {}
  return { cpu: _cpuPct, ram, uptime: up, memGB, cores: (os.cpus() || []).length };
}

function diskInfo() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('df -k /data 2>/dev/null || df -k /', { encoding: 'utf8', timeout: 3000 });
    const lines = out.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].split(/\s+/);
    const totalK = parseInt(parts[1], 10), usedK = parseInt(parts[2], 10), availK = parseInt(parts[3], 10);
    const pct = parseInt(String(parts[4]).replace('%', ''), 10);
    return {
      totalGB: +(totalK / 1048576).toFixed(1),
      usedGB: +(usedK / 1048576).toFixed(1),
      availGB: +(availK / 1048576).toFixed(1),
      pct: isNaN(pct) ? Math.round(usedK / totalK * 100) : pct
    };
  } catch (e) { return null; }
}

function sockReq(method, pathname, body) {
  return new Promise(function (resolve) {
    let has = false;
    try { has = fs.existsSync(SOCK); } catch (e) {}
    if (!has) return resolve(null);
    const data = body != null ? JSON.stringify(body) : null;
    const opt = {
      socketPath: SOCK, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    };
    const req = http.request(opt, function (r) {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

async function dockerNode() {
  const r = await sockReq('GET', '/containers/json?all=1');
  if (!r || r.status !== 200) return null;
  let arr;
  try { arr = JSON.parse(r.body); } catch (e) { return null; }

  const PI_CONTAINER_ENV = (process.env.PI_CONTAINER || '').trim();

  // Chấm điểm container để tự chọn đúng testnet2 / mainnet
  function scoreContainer(c) {
    let score = 0;
    const names = (c.Names || []).map(n => String(n).replace(/^\//, ''));
    const nameJoined = names.join(' ').toLowerCase();
    const image = String(c.Image || '').toLowerCase();
    const running = c.State === 'running';

    if (PI_CONTAINER_ENV) {
      if (names.some(n => n.toLowerCase() === PI_CONTAINER_ENV.toLowerCase())) score += 1000;
      else return -1; // override: bỏ container không khớp
    }

    if (running) score += 30;
    if (/pi-node-docker|pinetwork\/pi-node|stellar-core/.test(image)) score += 50;
    if (/^testnet2$|^mainnet$|^testnet$|^pi-node$|^pi_node$/.test(nameJoined)) score += 25;
    else if (/testnet|mainnet|pi-node|stellar/.test(nameJoined)) score += 15;
    if (/pi\.network|pinetwork/.test(image)) score += 10;
    return score;
  }

  const ranked = arr
    .map(c => ({ c, score: scoreContainer(c) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return { found: false };

  const best = ranked[0].c;
  const name = ((best.Names && best.Names[0]) || '').replace(/^\//, '');
  const m = (best.Image || '').match(/p(\d+)\./i);
  console.log('[dockerNode] chọn ' + name + ' score=' + ranked[0].score + (ranked.length > 1 ? ' (trong ' + ranked.length + ' ứng viên)' : ''));
  return {
    found: true,
    running: best.State === 'running',
    id: best.Id,
    name: name,
    image: best.Image || '',
    proto: m ? ('v' + m[1]) : null,
    status: best.Status || best.State || '',
    score: ranked[0].score
  };
}

// Giải mã Docker multiplexed stream (stdout/stderr frames)
function decodeDockerStream(raw) {
  if (!raw) return '';
  try {
    const buf = Buffer.from(raw, 'binary');
    // Nếu không có header 8-byte chuẩn, trả raw text
    if (buf.length < 8) return raw.toString ? raw.toString('utf8') : String(raw);
    let out = '';
    let i = 0;
    let frames = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      i += 8;
      if (size <= 0 || i + size > buf.length) break;
      out += buf.slice(i, i + size).toString('utf8');
      i += size;
      frames++;
    }
    if (frames > 0 && out) return out;
  } catch (e) {}
  return typeof raw === 'string' ? raw : String(raw);
}

// Lấy stellar-core info đầy đủ qua docker exec
// Thứ tự: stellar-core http-command info → fallback curl 127.0.0.1:11626/info
async function dockerSyncFull(id) {
  try {
    const cmd = 'stellar-core http-command info 2>/dev/null || curl -s http://127.0.0.1:11626/info 2>/dev/null || wget -qO- http://127.0.0.1:11626/info 2>/dev/null';
    const ex = await sockReq('POST', '/containers/' + id + '/exec', {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ['sh', '-c', cmd]
    });
    if (!ex || ex.status >= 400) return null;
    let execId;
    try { execId = JSON.parse(ex.body).Id; } catch (e) { return null; }
    const out = await sockReq('POST', '/exec/' + execId + '/start', { Detach: false, Tty: false });
    if (!out || out.body == null) return null;

    const text = decodeDockerStream(out.body);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let j;
    try { j = JSON.parse(match[0]); } catch (e) { return null; }
    const info = j.info || j;
    if (!info || typeof info !== 'object') return null;

    const ledger = info.ledger || {};
    const peers = info.peers || {};
    const qset = (info.quorum && info.quorum.qset) || {};

    // Chỉ giữ trường hữu ích cho người dùng / Controller
    return {
      state: info.state || 'unknown',
      network: info.network || null,
      build: info.build || null,
      protocol: info.protocol_version || null,
      ledger: {
        num: ledger.num != null ? ledger.num : null,
        age: ledger.age != null ? ledger.age : null
      },
      peers: {
        authenticated: peers.authenticated_count != null ? peers.authenticated_count : 0,
        pending: peers.pending_count != null ? peers.pending_count : 0
      },
      quorum: {
        phase: qset.phase || null,
        agree: qset.agree != null ? qset.agree : null,
        missing: qset.missing != null ? qset.missing : null
      },
      startedOn: info.startedOn || null,
      rawState: String(info.state || '').toLowerCase()
    };
  } catch (e) {
    console.log('[dockerSyncFull] ' + (e && e.message));
    return null;
  }
}

function parseSyncFromFull(full) {
  if (!full) return 'unknown';
  const s = (full.rawState || full.state || '').toLowerCase();
  if (s.includes('synced')) return 'synced';
  if (s.includes('catch') || s.includes('join') || s.includes('boot') || s.includes('waiting')) return 'catching';
  if (s) return 'running-unknownsync';
  return 'unknown';
}

// Giữ tương thích gọi cũ
async function dockerSync(id) {
  const full = await dockerSyncFull(id);
  return parseSyncFromFull(full);
}

function parseSyncText(t) {
  if (!t) return 'unknown';
  if (/Synced!?/i.test(t)) return 'synced';
  if (/Catching up|catchup|Joining SCP|Booting|Waiting/i.test(t)) return 'catching';
  try {
    const j = JSON.parse(t.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1'));
    const state = (j && (j.state || (j.info && j.info.state))) || '';
    const s = String(state).toLowerCase();
    if (s.includes('synced')) return 'synced';
    if (s.includes('catch') || s.includes('join') || s.includes('boot')) return 'catching';
    if (s) return 'running-unknownsync';
  } catch (e) {}
  if (/"state"/.test(t) || /"build"/.test(t)) return 'running-unknownsync';
  return 'unknown';
}

// Dò HTTP info trên host (cổng stellar-core 11626 nếu publish)
function httpGet(host, port, pathName, timeout) {
  return new Promise(function (resolve) {
    const req = http.request({ host: host, port: port, path: pathName, method: 'GET', timeout: timeout || 2000 }, function (r) {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}

async function hostSync() {
  const hosts = _probeHost ? [_probeHost].concat(candidateHosts().filter(h => h !== _probeHost)) : candidateHosts();
  for (const host of hosts) {
    const r = await httpGet(host, 11626, '/info', 2000);
    if (r && r.status === 200 && r.body) {
      const s = parseSyncText(r.body);
      if (s !== 'unknown') {
        console.log('[sync] host=' + host + ':11626 → ' + s);
        return s;
      }
    }
  }
  return null;
}

async function dockerLogs(id, tail) {
  const r = await sockReq('GET', '/containers/' + id + '/logs?stdout=1&stderr=1&tail=' + (tail || 40) + '&timestamps=0');
  if (!r || r.status !== 200) return null;
  const text = decodeDockerStream(r.body || '');
  return text.split('\n').filter(Boolean).slice(-40).join('\n');
}

async function dockerRestart(id) {
  const r = await sockReq('POST', '/containers/' + id + '/restart?t=15');
  return r && r.status >= 200 && r.status < 300;
}

async function dockerInfo() {
  const r = await sockReq('GET', '/info');
  if (!r || r.status !== 200) return null;
  try {
    const j = JSON.parse(r.body);
    return {
      os: j.OperatingSystem || '',
      ncpu: j.NCPU || null,
      memGB: j.MemTotal ? +(j.MemTotal / 1073741824).toFixed(1) : null,
      isDesktop: /Docker Desktop/i.test(j.OperatingSystem || '')
    };
  } catch (e) { return null; }
}

function calcSeverity(st) {
  const n = st.node;
  if (!n.running && n.localOpen.length === 0) return 'critical';
  if (!n.running) return 'warning';
  if (n.localOpen.length < REQUIRED.length) return 'warning';
  if (n.sync === 'catching') return 'soft';
  if (n.sync === 'down' || n.sync === 'unknown') return 'warning';
  // Dùng chi tiết stellar-core nếu có
  if (n.detail) {
    if (n.detail.ledger && n.detail.ledger.age != null && n.detail.ledger.age > 30) return 'warning';
    if (n.detail.peers && n.detail.peers.authenticated < 4) return 'soft';
  }
  if (st.res.ram != null && st.res.ram >= 92) return 'warning';
  if (st.disk && st.disk.pct >= 92) return 'warning';
  if (st.res.cpu != null && st.res.cpu >= 95) return 'soft';
  return 'ok';
}
const SEV_ICON = { ok: '🟢', soft: '🟡', warning: '🟠', critical: '🔴' };
const SEV_LABEL = { ok: 'Ổn định', soft: 'Nhẹ', warning: 'Cảnh báo', critical: 'Nghiêm trọng' };

async function collectStatus() {
  const lo = await localOpen();
  const dn = await dockerNode();
  const res = hostRes();
  const disk = diskInfo();
  const info = await dockerInfo();

  let running, docker, proto, dockerAccess, nodeName, nodeImage, nodeStatus, sync, detail, nodeId;
  detail = null;
  nodeId = null;

  if (dn) {
    dockerAccess = true;
    docker = dn.found ? (dn.running ? 'up' : 'down') : 'notfound';
    running = !!(dn.found && dn.running);
    proto = running ? (dn.proto || null) : null;
    nodeName = dn.name || null;
    nodeImage = dn.image || null;
    nodeStatus = dn.status || null;
    nodeId = dn.found ? dn.id : null;
    if (running && dn.id) {
      const full = await dockerSyncFull(dn.id);
      detail = full;
      sync = parseSyncFromFull(full);
      // Bonus điểm: đã lấy được info hợp lệ (log)
      if (full && full.state) console.log('[sync] ' + nodeName + ' → ' + full.state + ' ledger=' + (full.ledger && full.ledger.num));
    } else {
      sync = running ? 'unknown' : 'down';
    }
  } else {
    dockerAccess = false;
    running = lo.length > 0;
    docker = running ? 'up' : 'down';
    proto = null;
    nodeName = nodeImage = nodeStatus = null;
    if (running) {
      const hs = await hostSync();
      sync = hs || 'unknown';
    } else {
      sync = 'down';
    }
  }

  // Available % ước lượng từ peers authenticated (thực tế hiển thị cho user)
  let availablePct = null;
  if (detail && detail.peers) {
    const auth = detail.peers.authenticated || 0;
    // Heuristic: >= 8 peers ≈ rất tốt; công thức nhẹ nhàng
    availablePct = Math.min(99.9, Math.round((Math.min(auth, 20) / 20 * 40 + (detail.rawState && detail.rawState.includes('synced') ? 55 : 30) + (lo.length / REQUIRED.length) * 5) * 100) / 100);
  }

  const st = {
    version: VERSION,
    linked: !!(BOT_TOKEN && CHAT_ID),
    probeHost: _probeHost || NODE_HOST,
    node: {
      running, docker, proto, sync, localOpen: lo, required: REQUIRED,
      dockerAccess, name: nodeName, image: nodeImage, status: nodeStatus,
      id: nodeId,
      detail: detail ? {
        state: detail.state,
        network: detail.network,
        build: detail.build,
        ledger: detail.ledger,
        peers: detail.peers,
        quorum: detail.quorum,
        availablePct: availablePct
      } : null
    },
    res: {
      cpu: res.cpu, ram: res.ram, uptime: res.uptime,
      memGB: (info && info.memGB) || res.memGB,
      cores: (info && info.ncpu) || res.cores,
      env: info ? (info.isDesktop ? 'docker-desktop' : 'host') : 'container'
    },
    disk,
    ts: Date.now()
  };
  st.severity = calcSeverity(st);
  return st;
}

// ---------- Tin nhắn Telegram đẹp, rõ ----------
function syncLabel(s) {
  const m = {
    synced: '✅ Đã đồng bộ (Synced)',
    catching: '🔄 Đang bắt kịp (Catching up)',
    down: '⛔ Node tắt',
    'running-unknownsync': '⚠️ Chạy — chưa rõ sync',
    unknown: '❓ Không rõ'
  };
  return m[s] || m.unknown;
}

function formatStatus(st, opts) {
  opts = opts || {};
  const n = st.node;
  const sev = st.severity || 'ok';
  const icon = SEV_ICON[sev] || '⚪';
  const ports = n.required.map(p =>
    (n.localOpen.includes(p) ? '✅' : '❌') + ' <code>' + p + '</code>'
  ).join('   ');
  
  // Chi tiết stellar-core (chỉ field hữu ích)
  let detailBlock = '';
  if (n.detail) {
    const d = n.detail;
    const rows = [];
    if (d.availablePct != null) rows.push('• Available: <b>' + d.availablePct + '%</b>');
    if (d.state) rows.push('• Sync: <b>' + esc(d.state) + '</b>');
    if (d.ledger && d.ledger.num != null) rows.push('• Ledger: <code>' + Number(d.ledger.num).toLocaleString('en-US') + '</code>');
    if (d.ledger && d.ledger.age != null) rows.push('• Ledger Age: <b>' + d.ledger.age + 's</b>');
    if (d.peers) rows.push('• Peers: <b>' + (d.peers.authenticated || 0) + '</b>  ·  Pending: ' + (d.peers.pending || 0));
    if (d.quorum && d.quorum.phase) rows.push('• Quorum: <b>' + esc(d.quorum.phase) + '</b>  ·  Agree: ' + (d.quorum.agree != null ? d.quorum.agree : '—') + '  ·  Missing: ' + (d.quorum.missing != null ? d.quorum.missing : '—'));
    if (d.network) rows.push('• Network: <b>' + esc(d.network) + '</b>');
    if (d.build) rows.push('• Build: <code>' + esc(d.build) + '</code>');
    if (rows.length) detailBlock = '\n' + rows.join('\n') + '\n';
  }

  const cpu = st.res.cpu != null ? st.res.cpu + '%' : '—';
  const ram = st.res.ram != null ? st.res.ram + '%' : '—';

  const lines = [
    `${icon} <b>PI NODE STATUS</b>`,
    `━━━━━━━━━━━━━━━━`,
    `• Trạng thái: <b>${n.running ? 'ONLINE' : 'OFFLINE'}</b>`,
    `• Mức độ: <b>${SEV_LABEL[sev]}</b>`,
    `• Docker: ${esc(n.docker)}${n.proto ? ' · ' + esc(n.proto) : ''}${n.name ? '\n• Container: <code>' + esc(n.name) + '</code>' : ''}`,
    `• Đồng bộ: <b>${esc(syncLabel(n.sync))}</b>`,
    `• Cổng: ${ports}`,
    `• CPU: <b>${cpu}</b>  ·  RAM: <b>${ram}</b>`,
    `• Uptime: ${esc(st.res.uptime || '—')}`
  ];
  if (st.disk) {
    lines.push(`• Disk: ${st.disk.usedGB}/${st.disk.totalGB} GB (<b>${st.disk.pct}%</b>)`);
  }
  lines.push(`• Docker sock: ${n.dockerAccess ? 'có' : 'không (suy từ cổng)'}`);
  if (st.probeHost) lines.push(`• Probe host: <code>${esc(st.probeHost)}</code>`);
  lines.push(`━━━━━━━━━━━━━━━━`);
  lines.push(`🕐 ${esc(nowStr())}`);
  lines.push(`📦 SoloHost PRO <code>v${esc(st.version)}</code>`);
  if (opts.withLink !== false) {
    lines.push('');
    lines.push(`💻 <b>Bản Windows PRO</b> (đầy đủ hơn):`);
    lines.push(GITHUB_PRO);
  }
  return lines.join('\n');
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
        { text: '🐳 Docker', callback_data: 'cmd_docker' },
        { text: '📋 Report', callback_data: 'cmd_report' },
        { text: '🔄 Reset', callback_data: 'cmd_reset' }
      ],
      [
        { text: '💻 Tải Windows PRO', url: GITHUB_PRO },
        { text: '☕ Donate', url: DONATE_URL }
      ]
    ]
  };
}

// ---------- Telegram API ----------
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
    text: text.slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, extra || {});
  return tgApi('sendMessage', body);
}

async function tgEdit(chatId, messageId, text, extra) {
  const body = Object.assign({
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, extra || {});
  return tgApi('editMessageText', body);
}

async function tgAnswerCb(id, text) {
  return tgApi('answerCallbackQuery', { callback_query_id: id, text: text || '', show_alert: false });
}

// ---------- monitor ----------
function hourVNNow() {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh', hour: 'numeric', hour12: false
    }).formatToParts(new Date());
    const h = parts.find(x => x.type === 'hour');
    return h ? parseInt(h.value, 10) % 24 : ((new Date().getUTCHours() + 7) % 24);
  } catch (e) {
    return (new Date().getUTCHours() + 7) % 24;
  }
}

async function monitorTick() {
  try {
    const st = await collectStatus();
    const up = !!st.node.running;
    const sev = st.severity;
    const now = Date.now();

    // Khởi tạo lần đầu: ghi nhận trạng thái, không spam alert
    if (state.lastRunning === null) {
      state.lastRunning = up;
      state.lastSeverity = sev;
      console.log('[monitor] init running=' + up + ' sev=' + sev + ' ports=' + (st.node.localOpen || []).join(','));
      saveJSON(STATE_F, state);
      return;
    }

    // Cảnh báo khi đổi ONLINE/OFFLINE
    if (state.lastRunning !== up) {
      if (now - (state.lastAlertAt || 0) >= ALERT_COOLDOWN * 1000) {
        if (up) {
          await tgSend('🟢 <b>Node đã ONLINE trở lại</b>\n\n' + formatStatus(st), { reply_markup: mainKeyboard() });
          pushHist({ type: 'online', severity: sev });
        } else {
          await tgSend('🔴 <b>Node OFFLINE / cổng đóng</b>\n\n' + formatStatus(st) +
            '\n\n⚠️ Kiểm tra Docker / Pi Desktop và mở port 31401–31403.', { reply_markup: mainKeyboard() });
          pushHist({ type: 'offline', severity: 'critical' });
        }
        state.lastAlertAt = now;
        state.alertCount = (state.alertCount || 0) + 1;
      }
    }

    // Leo thang mức cảnh báo (ok → warning/critical) khi node vẫn coi là up nhưng cổng thiếu / tài nguyên cao
    if (state.lastSeverity === 'ok' && (sev === 'warning' || sev === 'critical')) {
      if (now - (state.lastAlertAt || 0) >= ALERT_COOLDOWN * 1000) {
        await tgSend(SEV_ICON[sev] + ' <b>Cảnh báo: ' + SEV_LABEL[sev] + '</b>\n\n' + formatStatus(st), { reply_markup: mainKeyboard() });
        state.lastAlertAt = now;
        pushHist({ type: 'severity', severity: sev });
      }
    }

    state.lastRunning = up;
    state.lastSeverity = sev;

    // Báo cáo định kỳ theo giờ Việt Nam (mặc định 7h và 19h)
    const hourVN = hourVNNow();
    const dayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); // YYYY-MM-DD
    const reportKey = dayKey + '-' + hourVN;
    if (REPORT_HOURS.includes(hourVN) && state.lastReportKey !== reportKey) {
      state.lastReportKey = reportKey;
      state.lastReportHour = hourVN;
      await tgSend('📋 <b>Báo cáo định kỳ</b> · ' + hourVN + 'h\n\n' + formatStatus(st, { withLink: true }), { reply_markup: mainKeyboard() });
      pushHist({ type: 'report', severity: sev });
      console.log('[monitor] báo cáo định kỳ giờ=' + hourVN);
    }

    if (state.pendingReset && now > state.pendingReset.until) state.pendingReset = null;
    saveJSON(STATE_F, state);
  } catch (e) {
    console.log('[monitor] ' + (e && e.message));
  }
}

// ---------- commands ----------
async function sendHelp(withKb) {
  const text =
    '<b>PI NODE TELEGRAM CONTROLLER</b>\n' +
    '<i>SoloHost Edition PRO</i>\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '<b>Lệnh nhanh:</b>\n' +
    '/status — trạng thái đầy đủ\n' +
    '/monitor — quét + mức cảnh báo\n' +
    '/ports — cổng 31401–3\n/sync — trạng thái đồng bộ\n' +
    '/docker — container node\n' +
    '/disk — dung lượng ổ\n' +
    '/logs — log container\n' +
    '/reset — restart node (cần xác nhận)\n' +
    '/report — báo cáo ngay\n' +
    '/history — lịch sử sự cố\n' +
    '/ping — kiểm tra bot\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '💬 Chat tự nhiên: <i>“node thế nào”</i>, <i>“cổng mở chưa”</i>\n\n' +
    '💻 <b>Bản Windows PRO</b> (CleanRAM, screenshot, AI…):\n' +
    GITHUB_PRO;
  return tgSend(text, withKb !== false ? { reply_markup: mainKeyboard() } : {});
}

async function handleReset() {
  const dn = await dockerNode();
  if (!dn || !dn.found) {
    return tgSend(
      '⚠️ <b>Không thể reset</b>\n\n' +
      'Chưa mount docker.sock hoặc không thấy container node.\n' +
      'Trên máy tin cậy: bỏ comment dòng sock trong docker-compose.yml.'
    );
  }
  state.pendingReset = { id: dn.id, name: dn.name, until: Date.now() + 60000 };
  saveJSON(STATE_F, state);
  return tgSend(
    `⚠️ <b>Xác nhận RESET node</b>\n` +
    `Container: <code>${esc(dn.name)}</code>\n\n` +
    `Gửi <b>/yes</b> trong 60 giây để restart.\nBỏ qua nếu không muốn.`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Xác nhận /yes', callback_data: 'cmd_yes' },
          { text: '❌ Hủy', callback_data: 'cmd_cancel' }
        ]]
      }
    }
  );
}

async function handleResetConfirm() {
  if (!state.pendingReset || Date.now() > state.pendingReset.until) {
    state.pendingReset = null;
    saveJSON(STATE_F, state);
    return tgSend('Không có yêu cầu reset đang chờ (hoặc đã hết hạn). Gõ /reset trước.');
  }
  const { id, name } = state.pendingReset;
  state.pendingReset = null;
  saveJSON(STATE_F, state);
  await tgSend('⏳ Đang restart <code>' + esc(name) + '</code>…');
  const ok = await dockerRestart(id);
  pushHist({ type: 'reset', severity: ok ? 'ok' : 'warning', name });
  if (ok) {
    await wait(4000);
    const st = await collectStatus();
    return tgSend('✅ Đã gửi lệnh restart.\n\n' + formatStatus(st), { reply_markup: mainKeyboard() });
  }
  return tgSend('❌ Restart thất bại. Kiểm tra quyền docker.sock.');
}

async function runCmd(cmd) {
  if (cmd === 'status' || cmd === 's') {
    const st = await collectStatus();
    return tgSend(formatStatus(st, { withLink: true }), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'monitor' || cmd === 'm') {
    const st = await collectStatus();
    return tgSend('🔍 <b>Monitor</b>\n\n' + formatStatus(st) +
      `\n\nMức: <b>${SEV_LABEL[st.severity]}</b> · Alert đã gửi: ${state.alertCount || 0}`,
      { reply_markup: mainKeyboard() });
  }
  if (cmd === 'ports') {
    const lo = await localOpen();
    return tgSend(
      '<b>Cổng node 31401–31403</b>\n━━━━━━━━━━━━━━━━\n' +
      REQUIRED.map(p => (lo.includes(p) ? '✅' : '❌') + '  <code>' + p + '</code>').join('\n') +
      (lo.length === 0 ? '\n\n⚠️ Không thấy cổng nào mở trên host.' : ''),
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'sync' || cmd === 'dongbo') {
    const st = await collectStatus();
    const n = st.node;
    return tgSend(
      '<b>Đồng bộ Pi Node</b>\n━━━━━━━━━━━━━━━━\n' +
      '• Trạng thái: <b>' + esc(syncLabel(n.sync)) + '</b>\n' +
      '• Node: ' + (n.running ? 'ONLINE' : 'OFFLINE') + '\n' +
      '• Nguồn: ' + (n.dockerAccess ? 'docker exec' : 'host :11626 / suy đoán') + '\n' +
      '' + detailBlock + '🕐 ' + esc(nowStr()),
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'docker') {
    const dn = await dockerNode();
    if (!dn) {
      return tgSend('Docker sock <b>không</b> được mount.\nTrạng thái đang suy từ cổng nội bộ.', { reply_markup: mainKeyboard() });
    }
    if (!dn.found) return tgSend('Không tìm thấy container Pi Node.', { reply_markup: mainKeyboard() });
    return tgSend(
      `<b>Docker node</b>\n━━━━━━━━━━━━━━━━\n` +
      `• Tên: <code>${esc(dn.name)}</code>\n` +
      `• State: <b>${dn.running ? 'running' : 'stopped'}</b>\n` +
      `• Status: ${esc(dn.status)}\n` +
      `• Proto: ${esc(dn.proto || '—')}\n` +
      `• Image: <code>${esc(dn.image)}</code>`,
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'disk') {
    const d = diskInfo();
    if (!d) return tgSend('Không đọc được disk.');
    return tgSend(
      `<b>Disk</b>\n━━━━━━━━━━━━━━━━\n` +
      `• Đã dùng: <b>${d.usedGB}</b> / ${d.totalGB} GB (<b>${d.pct}%</b>)\n` +
      `• Còn trống: ${d.availGB} GB`,
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'logs') {
    const dn = await dockerNode();
    if (!dn || !dn.found) return tgSend('Không có docker sock hoặc không thấy container.');
    const logs = await dockerLogs(dn.id, 35);
    if (!logs) return tgSend('Không lấy được logs.');
    const clipped = logs.length > 3500 ? logs.slice(-3500) : logs;
    return tgSend('<b>Logs gần nhất</b>\n<pre>' + esc(clipped) + '</pre>');
  }
  if (cmd === 'reset') return handleReset();
  if (cmd === 'yes' || cmd === 'confirm') return handleResetConfirm();
  if (cmd === 'cancel') {
    state.pendingReset = null;
    saveJSON(STATE_F, state);
    return tgSend('Đã hủy reset.', { reply_markup: mainKeyboard() });
  }
  if (cmd === 'report') {
    const st = await collectStatus();
    return tgSend('📋 <b>Báo cáo</b>\n\n' + formatStatus(st, { withLink: true }), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'history') {
    if (!history.length) return tgSend('Chưa có sự kiện.', { reply_markup: mainKeyboard() });
    const lines = history.slice(0, 12).map(h => {
      let t;
      try {
        t = new Date(h.t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
      } catch (e) { t = new Date(h.t).toISOString(); }
      return `• ${esc(t)} — <b>${esc(h.type)}</b> (${esc(h.severity || '')})`;
    });
    return tgSend('<b>Lịch sử gần đây</b>\n━━━━━━━━━━━━━━━━\n' + lines.join('\n'), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'ping') {
    return tgSend('🏓 <b>pong</b>\nSoloHost PRO <code>v' + VERSION + '</code>\n' + detailBlock + '🕐 ' + esc(nowStr()), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'start' || cmd === 'help') return sendHelp(true);
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

  // ngôn ngữ tự nhiên
  if (/node|trạng thái|status|thế nào|ra sao|online|offline/i.test(raw)) return runCmd('status');
  if (/cổng|port/i.test(raw)) return runCmd('ports');
  if (/reset|khởi động lại|restart/i.test(raw)) return runCmd('reset');
  if (/giúp|help|lệnh/i.test(raw)) return runCmd('help');
  return null;
}

// ---------- long poll (message + callback) ----------
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
          const c = data.slice(4);
          try { await runCmd(c); } catch (e) { console.log('[cb] ' + (e && e.message)); }
        }
        continue;
      }

      const msg = u.message;
      if (!msg || !msg.text) continue;
      if (CHAT_ID && String(msg.chat.id) !== String(CHAT_ID)) continue;
      try { await handleText(msg.text); } catch (e) {
        console.log('[cmd] ' + (e && e.message));
      }
    }
  } catch (e) {
    console.log('[tg] ' + (e && e.message));
  }
}
async function tgLoop() {
  while (true) {
    await pollTelegram();
    await wait(300);
  }
}

// ---------- HTTP + UI ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon'
};

let INDEX_HTML = '';
try { INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); } catch (e) {
  INDEX_HTML = '<h1>Pi Node Controller</h1>';
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
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(history.slice(0, 30)));
      return;
    }
    if (u === '/api/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        version: VERSION,
        githubPro: GITHUB_PRO,
        donateUrl: DONATE_URL,
        hasBot: !!BOT_TOKEN,
        hasChat: !!CHAT_ID,
        reportHours: REPORT_HOURS,
        alertCooldown: ALERT_COOLDOWN,
        time: nowStr()
      }));
      return;
    }
    if (u === '/' || u === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(INDEX_HTML);
      return;
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
    res.statusCode = 500;
    res.end('error');
  }
});

srv.listen(PORT, '0.0.0.0', function () {
  console.log('[pinode-tg] SoloHost PRO v' + VERSION + ' :' + PORT);
  console.log('[pinode-tg] bot=' + (BOT_TOKEN ? 'yes' : 'NO') + ' chat=' + (CHAT_ID || 'NO'));
  console.log('[pinode-tg] time=' + nowStr());
});

_cpuSampler();
monitorTick();
setInterval(monitorTick, 12000);

if (BOT_TOKEN && CHAT_ID) {
  tgLoop();
  if (ALERT_ON_START) {
    setTimeout(async () => {
      const st = await collectStatus();
      await tgSend(
        '✅ <b>Controller SoloHost PRO đã online</b>\n\n' + formatStatus(st, { withLink: true }),
        { reply_markup: mainKeyboard() }
      );
    }, 2500);
  }
} else {
  console.log('[pinode-tg] thiếu BOT_TOKEN/CHAT_ID — chỉ web UI');
}
