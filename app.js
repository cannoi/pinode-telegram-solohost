const http = require('http');
const fs = require('fs');
const os = require('os');

// ============================================================
//  Cấu hình Môi trường Container Docker
// ============================================================
const PI_CONTAINER_ENV = (process.env.PI_CONTAINER || '').trim();
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

const PI_NAME_PATTERNS = [
  /^testnet2$/i,
  /^mainnet$/i,
  /^testnet$/i,
  /^pi-node$/i,
  /^pi_node$/i,
  /testnet/i,
  /mainnet/i,
  /stellar/i,
  /pi-node/i
];

const PI_IMAGE_PATTERNS = [
  /pi-node-docker/i,
  /pinetwork\/pi-node/i,
  /stellar-core/i
];

function sockReq(method, path, body = null) {
  return new Promise((resolve) => {
    const opts = {
      socketPath: DOCKER_SOCKET_PATH,
      path: path,
      method: method,
      headers: {}
    };

    let dataStr = '';
    if (body) {
      dataStr = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(dataStr);
    }

    const req = http.request(opts, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          body: buf.toString('utf8'),
          raw: buf
        });
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    if (dataStr) req.write(dataStr);
    req.end();
  });
}

// ============================================================
//  Chấm điểm Tự động Nhận Diện Container Pi Node
// ============================================================
function scoreContainer(c) {
  let score = 0;
  const names = (c.Names || []).map(n => n.replace(/^\//, ''));
  const image = c.Image || '';
  const isRunning = c.State === 'running';

  if (isRunning) score += 30;
  if (PI_IMAGE_PATTERNS.some(p => p.test(image))) score += 50;
  if (names.some(n => PI_NAME_PATTERNS.some(p => p.test(n)))) score += 15;

  return score;
}

function isPiContainer(c) {
  const names = (c.Names || []).map(n => n.replace(/^\//, ''));
  if (PI_CONTAINER_ENV) {
    return names.some(n => n.toLowerCase() === PI_CONTAINER_ENV.toLowerCase());
  }
  return scoreContainer(c) > 0;
}

async function dockerNode() {
  const r = await sockReq('GET', '/containers/json?all=1');
  if (!r || r.status !== 200) return null;
  let arr;
  try { arr = JSON.parse(r.body); } catch (e) { return null; }

  let candidate = null;

  if (PI_CONTAINER_ENV) {
    candidate = arr.find(c => {
      const names = (c.Names || []).map(n => n.replace(/^\//, ''));
      return names.some(n => n.toLowerCase() === PI_CONTAINER_ENV.toLowerCase());
    });
  } else {
    const scored = arr
      .map(c => ({ container: c, score: scoreContainer(c) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      candidate = scored[0].container;
    }
  }

  if (!candidate) return { found: false };

  const name = ((candidate.Names && candidate.Names[0]) || '').replace(/^\//, '');
  const m = (candidate.Image || '').match(/p(\d+)\./i);

  return {
    found: true,
    running: candidate.State === 'running',
    id: candidate.Id,
    name: name,
    image: candidate.Image || '',
    proto: m ? ('v' + m[1]) : null,
    status: candidate.Status || candidate.State || ''
  };
}

// ============================================================
//  Lấy Chi Tiết Sync Từ Exec Command Trong Docker Container
// ============================================================
async function dockerSyncFull(id) {
  try {
    const ex = await sockReq('POST', '/containers/' + id + '/exec', {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ['sh', '-c', 'stellar-core http-command info 2>/dev/null || curl -s http://127.0.0.1:11626/info 2>/dev/null']
    });
    if (!ex || ex.status >= 400) return null;

    let execId;
    try { execId = JSON.parse(ex.body).Id; } catch (e) { return null; }

    const out = await sockReq('POST', '/exec/' + execId + '/start', { Detach: false, Tty: false });
    if (!out || !out.raw) return null;

    // Bóc tách Frame Header Docker Stream (Standard 8-byte Binary Frame)
    const buf = out.raw;
    let text = '';
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      i += 8;
      if (size <= 0 || i + size > buf.length) break;
      text += buf.slice(i, i + size).toString('utf8');
      i += size;
    }
    if (!text) text = buf.toString('utf8');

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const j = JSON.parse(match[0]);
    const info = j.info || j;
    if (!info) return null;

    // Chỉ giữ lại dữ liệu hữu ích, loại bỏ dữ liệu rác
    return {
      state: info.state || 'unknown',
      network: info.network || null,
      build: info.build || null,
      protocol: info.protocol_version || null,
      ledger: info.ledger ? {
        num: info.ledger.num,
        age: info.ledger.age,
        version: info.ledger.version
      } : null,
      peers: info.peers ? {
        authenticated: info.peers.authenticated_count || 0,
        pending: info.peers.pending_count || 0
      } : null,
      quorum: info.quorum && info.quorum.qset ? {
        phase: info.quorum.qset.phase,
        agree: info.quorum.qset.agree,
        missing: info.quorum.qset.missing,
        lag_ms: info.quorum.qset.lag_ms
      } : null,
      startedOn: info.startedOn || null,
      rawState: String(info.state || '').toLowerCase()
    };
  } catch (e) {
    console.error('[dockerSyncFull]', e.message);
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

// Helpers đọc tài nguyên môi trường Docker Container
async function localOpen() { return { 31401: true, 31402: true, 31403: true }; }
async function hostSync() { return null; }
function hostRes() { return { cpu: os.loadavg ? os.loadavg()[0] : 0, memFree: os.freemem(), memTotal: os.totalmem() }; }
function diskInfo() { return { free: 0, total: 0 }; }
async function dockerInfo() {
  const r = await sockReq('GET', '/info');
  if (r && r.status === 200) {
    try { return JSON.parse(r.body); } catch(e){}
  }
  return null;
}
function calcSeverity(st) { return (st.node && st.node.sync === 'synced') ? 'OK' : 'WARNING'; }

// ============================================================
//  Hàm Thu Thập Trạng Thái
// ============================================================
async function collectStatus() {
  const lo = await localOpen();
  const dn = await dockerNode();
  let syncFull = null;
  let sync = 'unknown';

  if (dn && dn.found && dn.running && dn.id) {
    syncFull = await dockerSyncFull(dn.id);
    sync = parseSyncFromFull(syncFull);
  }

  if (sync === 'unknown') {
    const hs = await hostSync();
    if (hs) sync = hs;
  }

  const res = hostRes();
  const disk = diskInfo();
  const dinfo = await dockerInfo();

  const node = {
    found: !!(dn && dn.found),
    running: !!(dn && dn.running),
    name: dn ? dn.name : null,
    image: dn ? dn.image : null,
    proto: dn ? dn.proto : null,
    status: dn ? dn.status : null,
    localOpen: lo,
    sync: sync,
    detail: syncFull ? {
      state: syncFull.state,
      network: syncFull.network,
      build: syncFull.build,
      protocol: syncFull.protocol,
      ledger: syncFull.ledger,
      peers: syncFull.peers,
      quorum: syncFull.quorum,
      startedOn: syncFull.startedOn
    } : null
  };

  const st = { node, res, disk, docker: dinfo, ts: Date.now() };
  st.severity = calcSeverity(st);
  return st;
}

module.exports = {
  dockerNode,
  dockerSyncFull,
  parseSyncFromFull,
  collectStatus
};

