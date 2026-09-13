'use strict';
/**
 * Pi Browser Bridge v2.6.61-HISTORY-LOG
 * - Log mọi hoạt động ra console (xem qua docker logs)
 * - Prefix [bridge] để dễ grep
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const PERSIST_TTL_MS = 365 * 24 * 3600 * 1000;
const HISTORY_PUSH_MS = 5 * 60 * 1000;

// ============ LOGGING ============
function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const e = extra != null ? ' | ' + (typeof extra === 'object' ? JSON.stringify(extra).slice(0, 300) : String(extra).slice(0, 300)) : '';
  console.log('[' + ts + '] [bridge][' + level + '] ' + msg + e);
}

// ============ HELPERS ============
function genCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

function httpRequest(urlStr, method, body, timeoutMs) {
  return new Promise((resolve) => {
    const startAt = Date.now();
    let u;
    try { u = new URL(urlStr); } catch (e) {
      log('error', 'bad url', { url: urlStr, err: String(e && e.message) });
      resolve(null);
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'pinode-solohost-bridge/2.6.61' },
      timeout: timeoutMs || 8000,
    };
    if (data) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = lib.request(opts, (r) => {
      let buf = '';
      r.on('data', (d) => buf += d);
      r.on('end', () => {
        const ms = Date.now() - startAt;
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (e) {}
        if (r.statusCode >= 400) {
          log('warn', 'HTTP ' + r.statusCode + ' ' + method + ' ' + u.pathname, { ms, body: String(buf).slice(0, 200) });
        } else {
          log('debug', 'HTTP ' + r.statusCode + ' ' + method + ' ' + u.pathname, { ms, size: buf.length });
        }
        resolve({ status: r.statusCode, json: parsed, raw: buf });
      });
    });
    req.on('error', (e) => {
      log('error', 'request error ' + method + ' ' + u.hostname + u.pathname, { err: String(e && e.message) });
      resolve(null);
    });
    req.on('timeout', () => {
      log('warn', 'request timeout ' + method + ' ' + u.pathname, { after_ms: timeoutMs });
      try { req.destroy(); } catch (e) {}
      resolve(null);
    });
    if (data) req.write(data);
    req.end();
  });
}

function readLatestStatus(label, version) {
  const p = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'latest.json') : '/data/latest.json';
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && typeof j === 'object') return Object.assign({}, j, { ts: Date.now(), label, version });
  } catch (e) {
    log('debug', 'latest.json read fail', { path: p, err: String(e && e.message) });
  }
  return null;
}

function persistPath() {
  const base = process.env.DATA_DIR || '/data';
  return path.join(base, 'state', 'pi-browser-code.json');
}

function loadPersisted() {
  try {
    const j = JSON.parse(fs.readFileSync(persistPath(), 'utf8'));
    if (j && j.code && /^[A-Z0-9]{8}$/.test(j.code) && (Date.now() - (j.at || 0)) < PERSIST_TTL_MS) return j;
  } catch (e) {}
  return null;
}

function savePersisted(code) {
  try {
    const p = persistPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ code, at: Date.now() }));
    log('info', 'persisted code', { code });
  } catch (e) {
    log('error', 'persist write fail', { err: String(e && e.message) });
  }
}

function clearPersisted() {
  try { fs.unlinkSync(persistPath()); log('info', 'persist cleared'); } catch (e) {}
}

// ============ HISTORY ============
function dayVN(date) {
  try { return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
  catch (e) { return date.toISOString().slice(0, 10); }
}

function historyDir() {
  return process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'history') : '/data/history';
}

function readHistoryRows(hours) {
  const baseDir = historyDir();
  const cutoff = Date.now() - hours * 3600 * 1000;
  const daysBack = Math.ceil(hours / 24) + 1;
  const rows = [];
  let filesFound = 0;
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const key = dayVN(d);
    const fp = path.join(baseDir, key + '.ndjson');
    try {
      const content = fs.readFileSync(fp, 'utf8');
      filesFound++;
      content.trim().split('\n').filter(Boolean).forEach((line) => {
        try {
          const r = JSON.parse(line);
          const ts = Date.parse(r.ts) || 0;
          if (ts >= cutoff) { r._tsMs = ts; rows.push(r); }
        } catch (e) {}
      });
    } catch (e) {}
  }
  log('debug', 'readHistory ' + hours + 'h', { files: filesFound, rows: rows.length, dir: baseDir });
  rows.sort((a, b) => a._tsMs - b._tsMs);
  return rows;
}

function agg(rows, key) {
  const vals = rows.map(r => r[key]).filter(v => v != null && isFinite(Number(v))).map(Number);
  if (!vals.length) return null;
  const sorted = vals.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const med = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2 * 10) / 10;
  return {
    n: vals.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(vals.reduce((s, x) => s + x, 0) / vals.length * 10) / 10,
    median: med,
  };
}

function distribution(rows, key) {
  const buckets = {}; let total = 0;
  rows.forEach(r => {
    const v = r[key]; if (v == null) return;
    total++; const k = String(v); buckets[k] = (buckets[k] || 0) + 1;
  });
  const out = {};
  Object.keys(buckets).forEach(k => {
    out[k] = { count: buckets[k], pct: Math.round(buckets[k] / Math.max(1, total) * 1000) / 10 };
  });
  return { total, states: out };
}

function buildHistoryBundle() {
  try {
    const w24 = readHistoryRows(24);
    const w3d = readHistoryRows(72);
    const w7d = readHistoryRows(168);

    function summary(rows) {
      if (!rows.length) return { samples: 0 };
      const levels = { ok: 0, warning: 0, critical: 0 };
      rows.forEach(r => {
        if (r.level === 'critical') levels.critical++;
        else if (r.level === 'warning') levels.warning++;
        else levels.ok++;
      });
      return {
        samples: rows.length,
        first_ts: rows[0].ts,
        last_ts: rows[rows.length - 1].ts,
        ram: agg(rows, 'ram'),
        cpu: agg(rows, 'cpu'),
        temp: agg(rows, 'temp'),
        disk: agg(rows, 'disk'),
        ledger_age: agg(rows, 'ledger_age'),
        peer_in: agg(rows, 'peer_in'),
        peer_out: agg(rows, 'peer_out'),
        health: agg(rows, 'health'),
        sync_states: distribution(rows, 'sync').states,
        levels,
      };
    }

    const bundle = {
      generated_at: Date.now(),
      windows: {
        '24h': summary(w24),
        '3d':  summary(w3d),
        '7d':  summary(w7d),
      },
      label: 'Home SoloHost',
      version: '2.6.61-solohost',
    };
    log('info', 'history bundle built', {
      h24: bundle.windows['24h'].samples,
      d3: bundle.windows['3d'].samples,
      d7: bundle.windows['7d'].samples,
    });
    return bundle;
  } catch (e) {
    log('error', 'buildHistoryBundle fail', { err: String(e && e.message) });
    return { generated_at: Date.now(), error: String(e && e.message), windows: {} };
  }
}

// ============ BRIDGE ============
function createBridge(opts) {
  opts = opts || {};
  const relay = String(opts.relay || process.env.PI_BROWSER_RELAY || '').trim().replace(/\/+$/, '');
  const label = String(opts.label || process.env.PI_BROWSER_LABEL || 'Home SoloHost').trim();
  const version = opts.version || '0.0.0';

  log('info', 'createBridge init', { relay, label, version });

  if (!relay) {
    log('error', 'PI_BROWSER_RELAY missing — bridge disabled');
  }

  let code = null;
  let status = 'idle';
  let lastPushOk = false;
  let peerSeenAt = 0;
  let heartbeatTimer = null;
  let historyTimer = null;
  let lastHeartbeat = null;

  function snapshot() {
    return { paired: status === 'paired', code, status, relay, label, version, lastHeartbeat, lastPushOk,
      pairedAt: peerSeenAt ? new Date(peerSeenAt).toISOString() : null };
  }

  async function pushStatus() {
    if (!relay || !code) return;
    let payload = lastHeartbeat || readLatestStatus(label, version) || {
      sync: 'Initializing', status: 'waiting_for_phone', label, version, ts: Date.now(),
    };
    const r = await httpRequest(relay + '/pair/' + code + '/push', 'POST', payload, 6000);
    lastPushOk = !!(r && r.status === 200);
    if (!lastPushOk) log('warn', 'push status failed', { code });
  }

  async function pushHistory() {
    if (!relay || !code) return;
    log('info', 'pushHistory start', { code });
    const bundle = buildHistoryBundle();
    const r = await httpRequest(relay + '/pair/' + code + '/push_history', 'POST', bundle, 15000);
    if (r && r.status === 200) {
      log('info', 'pushHistory OK');
    } else {
      log('warn', 'pushHistory failed', { status: r && r.status, hasJson: !!(r && r.json) });
    }
  }

  async function checkPaired() {
    if (!relay || !code) return false;
    const r = await httpRequest(relay + '/pair/' + code + '/pull', 'GET', null, 5000);
    if (r && r.json && r.json.ok && r.json.phone_online) {
      if (status !== 'paired') {
        status = 'paired'; peerSeenAt = Date.now();
        log('info', 'paired with phone', { code });
      }
      return true;
    }
    return false;
  }

  function startLoops() {
    if (heartbeatTimer) return;
    log('info', 'startLoops', { code });
    heartbeatTimer = setInterval(async () => {
      if (status === 'idle' || !code) return;
      await pushStatus();
      await checkPaired();
    }, 5000);
    historyTimer = setInterval(async () => {
      if (status === 'idle' || !code) return;
      await pushHistory();
    }, HISTORY_PUSH_MS);
  }

  function stopLoops() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; log('info', 'stopped heartbeat'); }
    if (historyTimer) { clearInterval(historyTimer); historyTimer = null; log('info', 'stopped history'); }
  }

  async function useCode(c) {
    log('info', 'useCode', { code: c });
    code = c; status = 'waiting'; peerSeenAt = 0; lastPushOk = false;
    await pushStatus();
    await pushHistory();
    startLoops();
    return snapshot();
  }

  async function createPair(forceNew) {
    stopLoops();
    if (!forceNew) {
      const p = loadPersisted();
      if (p) { log('info', 'reusing persisted code', { code: p.code }); return useCode(p.code); }
    }
    const nc = genCode();
    log('info', 'generating new code', { code: nc });
    savePersisted(nc);
    return useCode(nc);
  }

  async function newCode() { clearPersisted(); return createPair(true); }

  async function pollPair() {
    if (status === 'idle') {
      const p = loadPersisted();
      if (p) return useCode(p.code);
      return createPair(false);
    }
    await checkPaired();
    return snapshot();
  }

  async function disconnect() {
    log('info', 'disconnect called');
    stopLoops();
    code = null; status = 'idle'; peerSeenAt = 0; lastPushOk = false; lastHeartbeat = null;
    return snapshot();
  }

  async function setBackend() { return snapshot(); }

  async function heartbeat(data) {
    lastHeartbeat = Object.assign({}, data || {}, { ts: Date.now(), label, version });
    if (status === 'idle') return true;
    await pushStatus();
    await checkPaired();
    return true;
  }

  return { snapshot, createPair, newCode, pollPair, disconnect, setBackend, heartbeat,
    get paired() { return status === 'paired'; } };
}

module.exports = { createBridge };
