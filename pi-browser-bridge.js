'use strict';
/**
 * Pi Browser Bridge v2.6.61-POLL-PERSIST
 * - Persist code vào /data/state/pi-browser-code.json
 * - Restart SoloHost → tự đọc lại code cũ, không tạo mới
 * - Chỉ tạo code mới khi user bấm "Đổi mã" (forceNew=true)
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const PAIR_TTL_MS = 10 * 60 * 1000;
const PERSIST_TTL_MS = 365 * 24 * 3600 * 1000; // 1 năm

function genCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

function httpRequest(urlStr, method, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { resolve(null); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'pinode-solohost-bridge/2.6.61',
      },
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
        try { resolve({ status: r.statusCode, json: JSON.parse(buf) }); }
        catch (e) { resolve({ status: r.statusCode, raw: buf }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

function readLatestStatus(label, version) {
  try {
    const latestPath = process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, 'latest.json')
      : '/data/latest.json';
    const raw = fs.readFileSync(latestPath, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      return Object.assign({}, j, { ts: Date.now(), label: label, version: version });
    }
  } catch (e) {}
  return null;
}

function persistPath() {
  const base = process.env.DATA_DIR || '/data';
  return path.join(base, 'state', 'pi-browser-code.json');
}

function loadPersisted() {
  try {
    const raw = fs.readFileSync(persistPath(), 'utf8');
    const j = JSON.parse(raw);
    if (j && j.code && /^[A-Z0-9]{8}$/.test(j.code)) {
      if (Date.now() - (j.at || 0) < PERSIST_TTL_MS) return j;
    }
  } catch (e) {}
  return null;
}

function savePersisted(code) {
  try {
    const p = persistPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ code, at: Date.now() }));
  } catch (e) {}
}

function clearPersisted() {
  try { fs.unlinkSync(persistPath()); } catch (e) {}
}

function createBridge(opts) {
  opts = opts || {};
  const relay = String(opts.relay || process.env.PI_BROWSER_RELAY || '')
    .trim().replace(/\/+$/, '');
  const label = String(opts.label || process.env.PI_BROWSER_LABEL || 'Home SoloHost').trim();
  const version = opts.version || '0.0.0';

  let code = null;
  let status = 'idle';
  let lastPushOk = false;
  let peerSeenAt = 0;
  let pairExpiresAt = 0;
  let heartbeatTimer = null;
  let lastHeartbeat = null;

  function snapshot() {
    return {
      paired: status === 'paired',
      code,
      status,
      relay,
      label,
      version,
      lastHeartbeat,
      lastPushOk,
      expiresAt: pairExpiresAt ? new Date(pairExpiresAt).toISOString() : null,
      pairedAt: peerSeenAt ? new Date(peerSeenAt).toISOString() : null,
    };
  }

  async function pushStatus() {
    if (!relay || !code) return;
    let payload = lastHeartbeat;
    if (!payload) payload = readLatestStatus(label, version);
    if (!payload) {
      payload = {
        sync: 'Initializing',
        status: 'waiting_for_phone',
        label: label,
        version: version,
        ts: Date.now(),
      };
    }
    const r = await httpRequest(relay + '/pair/' + code + '/push', 'POST', payload, 6000);
    lastPushOk = !!(r && r.status === 200);
  }

  async function checkPaired() {
    if (!relay || !code) return false;
    const r = await httpRequest(relay + '/pair/' + code + '/pull', 'GET', null, 5000);
    if (r && r.json && r.json.ok && r.json.phone_online) {
      if (status !== 'paired') {
        status = 'paired';
        peerSeenAt = Date.now();
      }
      return true;
    }
    return false;
  }

  function startHeartbeatLoop() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(async () => {
      if (status === 'idle' || !code) return;
      if (Date.now() > pairExpiresAt && status === 'waiting') {
        // Không expired khi đã persist — chỉ expired session tạm
        if (!loadPersisted()) status = 'expired';
      }
      await pushStatus();
      await checkPaired();
    }, 5000);
  }

  function stopHeartbeatLoop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function useCode(c) {
    code = c;
    status = 'waiting';
    pairExpiresAt = Date.now() + PERSIST_TTL_MS;
    peerSeenAt = 0;
    lastPushOk = false;
    await pushStatus();
    startHeartbeatLoop();
    return snapshot();
  }

  async function createPair(forceNew) {
    stopHeartbeatLoop();

    // Nếu không force new → thử dùng code đã persist
    if (!forceNew) {
      const persisted = loadPersisted();
      if (persisted) {
        return useCode(persisted.code);
      }
    }

    // Force new hoặc chưa có persist → tạo code mới
    const newCode = genCode();
    savePersisted(newCode);
    return useCode(newCode);
  }

  async function newCode() {
    // Tạo code hoàn toàn mới, xoá persist cũ
    clearPersisted();
    return createPair(true);
  }

  async function pollPair() {
    if (status === 'idle') {
      const persisted = loadPersisted();
      if (persisted) return useCode(persisted.code);
      return createPair(false);
    }
    await checkPaired();
    return snapshot();
  }

  async function disconnect() {
    stopHeartbeatLoop();
    // KHÔNG xoá persist — chỉ ngắt kết nối tạm
    // Code vẫn còn để lần sau tự kết nối lại
    code = null;
    status = 'idle';
    peerSeenAt = 0;
    lastPushOk = false;
    lastHeartbeat = null;
    return snapshot();
  }

  async function setBackend() { return snapshot(); }

  async function heartbeat(data) {
    lastHeartbeat = Object.assign({}, data || {}, {
      ts: Date.now(),
      label: label,
      version: version,
    });
    if (status === 'idle') return true;
    await pushStatus();
    await checkPaired();
    return true;
  }

  return {
    snapshot,
    createPair,
    newCode,
    pollPair,
    disconnect,
    setBackend,
    heartbeat,
    get paired() { return status === 'paired'; },
  };
}

module.exports = { createBridge };
