'use strict';

/**
 * Pi Browser Bridge v2.6.61-POLL
 *
 * - HTTP polling qua Cloudflare Worker relay.
 * - Không cần WebRTC.
 * - Không cần WebSocket cho monitoring hiện tại.
 * - Không cần native WebRTC library.
 * - Giữ nguyên interface cũ để app.js không phải sửa.
 *
 * Flow:
 *
 * SoloHost
 *    │
 *    ├── POST /pair/<code>/push
 *    │
 *    ├── POST /pair/<code>/heartbeat
 *    │
 *    └── GET  /pair/<code>/pull
 *                     │
 *                     ▼
 *              Cloudflare Worker
 *                     ▲
 *                     │
 *              POST /phone_ack
 *                     ▲
 *                     │
 *                 Pi Browser
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

// Pairing chỉ chờ tối đa 10 phút.
// Sau khi đã paired thì không dùng TTL này để unpair.
const PAIR_TTL_MS = 10 * 60 * 1000;

// Relay request timeout.
const REQUEST_TIMEOUT_MS = 8000;

// Host gửi status định kỳ.
const HEARTBEAT_INTERVAL_MS = 5000;


// ==================================================
// PAIR CODE
// ==================================================

function genCode() {
  let out = '';

  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_CHARS[
      Math.floor(Math.random() * CODE_CHARS.length)
    ];
  }

  return out;
}


// ==================================================
// HTTP REQUEST
// ==================================================

function httpRequest(urlStr, method, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;

    try {
      u = new URL(urlStr);
    } catch (e) {
      resolve(null);
      return;
    }

    const lib =
      u.protocol === 'https:'
        ? https
        : http;

    const data =
      body == null
        ? null
        : JSON.stringify(body);

    const opts = {
      hostname: u.hostname,

      port:
        u.port ||
        (u.protocol === 'https:' ? 443 : 80),

      path:
        u.pathname +
        u.search,

      method: method || 'GET',

      headers: {
        'Accept': 'application/json',
        'User-Agent':
          'pinode-solohost-bridge/2.6.61',
      },

      timeout:
        timeoutMs ||
        REQUEST_TIMEOUT_MS,
    };

    if (data) {
      opts.headers['Content-Type'] =
        'application/json';

      opts.headers['Content-Length'] =
        Buffer.byteLength(data);
    }

    const req = lib.request(
      opts,
      (r) => {
        let buf = '';

        r.on('data', (d) => {
          buf += d;
        });

        r.on('end', () => {
          try {
            resolve({
              status: r.statusCode,
              json: JSON.parse(buf),
            });
          } catch (e) {
            resolve({
              status: r.statusCode,
              raw: buf,
            });
          }
        });
      }
    );

    req.on('error', () => {
      resolve(null);
    });

    req.on('timeout', () => {
      try {
        req.destroy();
      } catch (e) {}

      resolve(null);
    });

    if (data) {
      req.write(data);
    }

    req.end();
  });
}


// ==================================================
// BRIDGE
// ==================================================

function createBridge(opts) {
  opts = opts || {};

  let relay = String(
    opts.relay ||
    process.env.PI_BROWSER_RELAY ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');

  const label = String(
    opts.label ||
    process.env.PI_BROWSER_LABEL ||
    'Home SoloHost'
  ).trim();

  const version =
    opts.version ||
    '0.0.0';


  // ------------------------------------------------
  // Runtime state
  // ------------------------------------------------

  let code = null;

  // idle | waiting | paired | expired
  let status = 'idle';

  let lastPushAt = 0;
  let lastPushOk = false;

  // Lần cuối Pi Browser được Worker xác nhận online.
  let peerSeenAt = 0;

  let pairExpiresAt = 0;

  let heartbeatTimer = null;

  let lastHeartbeat = null;

  let lastError = null;


  // ==================================================
  // SNAPSHOT
  // ==================================================

  function snapshot() {
    const now = Date.now();

    const expiresIn =
      pairExpiresAt > now
        ? Math.round(
            (pairExpiresAt - now) / 1000
          )
        : 0;

    return {
      paired: status === 'paired',

      code,

      status,

      relay,

      label,

      version,

      lastHeartbeat,

      lastPushAt,

      lastPushOk,

      lastError,

      expiresAt:
        pairExpiresAt
          ? new Date(pairExpiresAt).toISOString()
          : null,

      expiresIn,

      pairedAt:
        peerSeenAt
          ? new Date(peerSeenAt).toISOString()
          : null,
    };
  }


  // ==================================================
  // PUSH NODE STATUS
  // ==================================================

  async function pushStatus() {
    if (
      !relay ||
      !code ||
      !lastHeartbeat
    ) {
      return false;
    }

    const url =
      relay +
      '/pair/' +
      code +
      '/push';

    const r = await httpRequest(
      url,
      'POST',
      lastHeartbeat,
      6000
    );

    lastPushAt = Date.now();

    lastPushOk =
      !!(
        r &&
        r.status >= 200 &&
        r.status < 300 &&
        r.json &&
        r.json.ok === true
      );

    if (!lastPushOk && r) {
      lastError =
        'Relay push failed';
    }

    if (lastPushOk) {
      lastError = null;
    }

    return lastPushOk;
  }


  // ==================================================
  // CHECK PHONE PAIRING
  // ==================================================

  async function checkPaired() {
    if (!relay || !code) {
      return false;
    }

    const url =
      relay +
      '/pair/' +
      code +
      '/pull';

    const r = await httpRequest(
      url,
      'GET',
      null,
      5000
    );

    if (
      !r ||
      r.status !== 200 ||
      !r.json ||
      r.json.ok !== true
    ) {
      return false;
    }

    /*
     * QUAN TRỌNG:
     *
     * Không dùng host_online để xác định
     * điện thoại đã pair.
     *
     * Worker hiện trả:
     *
     *   phone_online: true
     *
     * sau khi Pi Browser gọi:
     *
     *   POST /pair/<code>/phone_ack
     */

    if (r.json.phone_online === true) {
      if (status !== 'paired') {
        status = 'paired';
        peerSeenAt = Date.now();
      } else {
        // Phone vẫn đang hoạt động.
        peerSeenAt = Date.now();
      }

      return true;
    }

    return false;
  }


  // ==================================================
  // BACKWARD COMPATIBILITY
  // ==================================================

  /*
   * Giữ tên cũ nếu app.js hiện tại đang gọi
   * pullPeerSignal().
   *
   * Không dùng để quyết định paired.
   */
  async function pullPeerSignal() {
    if (!relay || !code) {
      return null;
    }

    const url =
      relay +
      '/pair/' +
      code +
      '/pull';

    const r = await httpRequest(
      url,
      'GET',
      null,
      6000
    );

    if (
      r &&
      r.status === 200 &&
      r.json &&
      r.json.ok === true
    ) {
      return r.json;
    }

    return null;
  }


  // ==================================================
  // HEARTBEAT LOOP
  // ==================================================

  function startHeartbeatLoop() {
    if (heartbeatTimer) {
      return;
    }

    heartbeatTimer = setInterval(
      async () => {

        if (
          status === 'idle' ||
          !code
        ) {
          return;
        }

        /*
         * Chỉ pair đang chờ mới hết hạn.
         *
         * Nếu đã paired thì không được tự chuyển
         * sang expired chỉ vì quá 10 phút.
         */
        if (
          status === 'waiting' &&
          Date.now() > pairExpiresAt
        ) {
          status = 'expired';
          return;
        }

        // Push status hiện tại.
        if (lastHeartbeat) {
          await pushStatus();
        }

        /*
         * Kiểm tra Pi Browser.
         *
         * Nếu phone đang online:
         *   status = paired
         *
         * Nếu phone tạm offline:
         *   KHÔNG unpair.
         */
        if (
          status === 'waiting' ||
          status === 'paired'
        ) {
          await checkPaired();
        }

      },
      HEARTBEAT_INTERVAL_MS
    );
  }


  // ==================================================
  // STOP HEARTBEAT
  // ==================================================

  function stopHeartbeatLoop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }


  // ==================================================
  // CREATE PAIR
  // ==================================================

  async function createPair() {
    stopHeartbeatLoop();

    code = genCode();

    status = 'waiting';

    pairExpiresAt =
      Date.now() +
      PAIR_TTL_MS;

    peerSeenAt = 0;

    lastPushAt = 0;

    lastPushOk = false;

    lastError = null;

    startHeartbeatLoop();

    /*
     * Nếu app đã có telemetry thì push ngay.
     * Nếu chưa có thì heartbeat() sẽ push sau.
     */
    if (lastHeartbeat) {
      await pushStatus();
    }

    return snapshot();
  }


  // ==================================================
  // POLL PAIR
  // ==================================================

  async function pollPair() {

    // Chưa có pairing → tạo code.
    if (status === 'idle') {
      return createPair();
    }

    /*
     * Chỉ waiting mới hết hạn.
     */
    if (
      status === 'waiting' &&
      Date.now() > pairExpiresAt
    ) {
      status = 'expired';

      return snapshot();
    }

    /*
     * Kiểm tra phone_online từ Worker.
     */
    await checkPaired();

    return snapshot();
  }


  // ==================================================
  // DISCONNECT
  // ==================================================

  async function disconnect() {
    stopHeartbeatLoop();

    code = null;

    status = 'idle';

    peerSeenAt = 0;

    pairExpiresAt = 0;

    lastPushAt = 0;

    lastPushOk = false;

    lastHeartbeat = null;

    lastError = null;

    return snapshot();
  }


  // ==================================================
  // SET BACKEND
  // ==================================================

  /*
   * app.js cũ có thể vẫn gọi setBackend().
   *
   * Giữ interface để tránh breaking change.
   *
   * Nếu truyền URL hợp lệ thì dùng URL đó
   * như relay.
   */
  async function setBackend(url) {
    if (url) {
      const nextRelay = String(url)
        .trim()
        .replace(/\/+$/, '');

      if (
        nextRelay.startsWith('https://') ||
        nextRelay.startsWith('http://')
      ) {
        relay = nextRelay;
      }
    }

    return snapshot();
  }


  // ==================================================
  // NODE HEARTBEAT
  // ==================================================

  async function heartbeat(data) {

    lastHeartbeat = Object.assign(
      {},
      data || {},
      {
        ts: Date.now(),
        label,
        version,
      }
    );

    /*
     * Chưa tạo pair.
     *
     * Vẫn giữ telemetry local trong memory,
     * nhưng chưa gửi relay.
     */
    if (status === 'idle') {
      return true;
    }

    /*
     * Pair đang waiting/paired:
     * gửi status lên Worker.
     */
    await pushStatus();

    /*
     * Sau khi push, kiểm tra Pi Browser.
     */
    await checkPaired();

    return true;
  }


  // ==================================================
  // LEGACY DETECT FUNCTION
  // ==================================================

  /*
   * Giữ _detectPaired() để app.js cũ không lỗi.
   *
   * Logic mới:
   *   phone_online === true
   */
  async function detectPaired() {
    return checkPaired();
  }


  // ==================================================
  // PUBLIC API
  // ==================================================

  return {
    snapshot,

    createPair,

    pollPair,

    disconnect,

    setBackend,

    heartbeat,

    get paired() {
      return status === 'paired';
    },

    _detectPaired: detectPaired,
  };
}


module.exports = {
  createBridge
};
