'use strict';
/**
 * Pi Browser Bridge v2.6.61-POLL
 * - HTTP polling qua Cloudflare Worker relay.
 * - Không cần WebRTC, không cần ws, không cần lib native.
 * - Giữ nguyên interface cũ để app.js không phải sửa.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const PAIR_TTL_MS = 10 * 60 * 1000;

function genCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++)
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
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
  const relay = String(
    opts.relay || process.env.PI_BROWSER_RELAY || ''
  ).trim().replace(/\/+$/, '');
  const label = String(opts.label || process.env.PI_BROWSER_LABEL || 'Home SoloHost').trim();
  const version = opts.version || '0.0.0';

  let code = null;
  let status = 'idle';      // idle | waiting | paired | expired
  let lastPushAt = 0;
  let lastPushOk = false;
  let peerSeenAt = 0;       // lần cuối phone pull thành công
  let pairExpiresAt = 0;
  let heartbeatTimer = null;
  let lastHeartbeat = null;

  function snapshot() {
    return {
      paired: status === 'paired',
      code, status, relay, label, version,
      lastHeartbeat,
      lastPushOk,
      expiresAt: pairExpiresAt ? new Date(pairExpiresAt).toISOString() : null,
      pairedAt: peerSeenAt ? new Date(peerSeenAt).toISOString() : null,
    };
  }

  async function pushStatus() {
    if (!relay || !code || !lastHeartbeat) return;
    const url = relay + '/pair/' + code + '/push';
    const r = await httpRequest(url, 'POST', lastHeartbeat, 6000);
    lastPushAt = Date.now();
    lastPushOk = !!(r && r.status === 200);
  }

  async function pullPeerSignal() {
    if (!relay || !code) return null;
    const url = relay + '/pair/' + code + '/pull';
    const r = await httpRequest(url, 'GET', null, 6000);
    if (r && r.status === 200 && r.json && r.json.ok) {
      // Nếu phone vừa pull → đánh dấu paired
      // (không chắc chắn phone đã pull, nhưng nếu có host_online true → phone có thể thấy)
      return r.json;
    }
    return null;
  }

  function startHeartbeatLoop() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(async () => {
      if (status === 'idle' || !code) return;
      if (Date.now() > pairExpiresAt) {
        status = 'expired';
        return;
      }
      // Push status mỗi 5 giây nếu có data
      if (lastHeartbeat) await pushStatus();
    }, 5000);
  }

  function stopHeartbeatLoop() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  async function createPair() {
    stopHeartbeatLoop();
    code = genCode();
    status = 'waiting';
    pairExpiresAt = Date.now() + PAIR_TTL_MS;
    peerSeenAt = 0;
    lastPushOk = false;
    startHeartbeatLoop();
    // Push ngay 1 lần để test relay reachable
    if (lastHeartbeat) await pushStatus();
    return snapshot();
  }

  async function pollPair() {
    if (status === 'idle') {
      // chưa có code → tự tạo
      return createPair();
    }
    if (Date.now() > pairExpiresAt && status === 'waiting') {
      status = 'expired';
    }
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
    lastHeartbeat = Object.assign({}, data || {}, { ts: Date.now(), label, version });
    if (status === 'idle') return true;
    await pushStatus();
    // Đồng thời kiểm tra phone có đang online không (pull chính code này)
    try {
      const peer = await pullPeerSignal();
      if (peer && peer.host_online) {
        // host_online=true là của chính mình; để phát hiện phone, ta dùng trick:
        // phone khi pull sẽ tự ghi 'phone_last_seen' qua endpoint pull
        // (ở đây chỉ kiểm tra đơn giản: nếu có data trả về → coi như có người pull)
      }
    } catch (e) {}
    return true;
  }

  // Trạng thái paired: coi là paired nếu host push thành công VÀ có dấu hiệu phone đã pull.
  // Để phát hiện phone pull, thêm endpoint riêng hoặc dùng age_s.
  async function detectPaired() {
    if (!relay || !code) return false;
    const url = relay + '/pair/' + code + '/pull';
    const r = await httpRequest(url, 'GET', null, 5000);
    if (r && r.json && r.json.ok) {
      // Nếu status_at có và vừa được push trong 30s → khả năng cao có người xem
      return r.json.host_online === true;
    }
    return false;
  }

  return {
    snapshot,
    createPair,
    pollPair,
    disconnect,
    setBackend,
    heartbeat,
    get paired() { return status === 'paired'; },
    _detectPaired: detectPaired,
  };
}

module.exports = { createBridge };
