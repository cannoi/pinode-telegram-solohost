'use strict';
/**
 * Pi Browser Bridge v2.6.61-POLL — HTTP polling qua Cloudflare relay
 * - Push status lên relay mỗi 5 giây (không đợi paired).
 * - Detect phone online qua endpoint /pull (phone_online).
 * - Không cần WebRTC, không cần lib native.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const PAIR_TTL_MS = 10 * 60 * 1000;

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

function createBridge(opts) {
  opts = opts || {};
  const relay = String(opts.relay || process.env.PI_BROWSER_RELAY || '')
    .trim().replace(/\/+$/, '');
  const label = String(opts.label || process.env.PI_BROWSER_LABEL || 'Home SoloHost').trim();
  const version = opts.version || '0.0.0';

  let code = null;
  let status = 'idle';        // idle | waiting | paired | expired
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
    // Nếu chưa có heartbeat thật → gửi placeholder để relay biết host đang sống
    const payload = lastHeartbeat || {
      sync: 'Initializing',
      status: 'waiting_for_phone',
      label: label,
      version: version,
      ts: Date.now(),
    };
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
        status = 'expired';
        return;
      }
      await pushStatus();     // ← luôn push (kể cả chưa paired)
      await checkPaired();
    }, 5000);
  }

  function stopHeartbeatLoop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function createPair() {
    stopHeartbeatLoop();
    code = genCode();
    status = 'waiting';
    pairExpiresAt = Date.now() + PAIR_TTL_MS;
    peerSeenAt = 0;
    lastPushOk = false;
    await pushStatus();       // ← push NGAY khi tạo code
    startHeartbeatLoop();
    return snapshot();
  }

  async function pollPair() {
    if (status === 'idle') return createPair();
    if (Date.now() > pairExpiresAt && status === 'waiting') status = 'expired';
    await checkPaired();
    return snapshot();
  }

  async function disconnect() {
    stopHeartbeatLoop();
    code = null;
    status = 'idle';
    peerSeenAt = 0;
    lastPushOk = false;
    lastHeartbeat = null;
    return snapshot();
  }

  async function setBackend() {
    return snapshot();
  }

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
    pollPair,
    disconnect,
    setBackend,
    heartbeat,
    get paired() { return status === 'paired'; },
  };
}

module.exports = { createBridge };
