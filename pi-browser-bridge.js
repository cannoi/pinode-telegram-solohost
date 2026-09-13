'use strict';
/**
 * Pi Browser pairing (one-time 8-char code).
 * Pi Browser → HTTPS backend → this SoloHost agent.
 * No wallet passphrase. Credentials live in /data/state/agent-state.json
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');

function normOrigin(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

function saveState(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) {}
}

function httpJson(method, urlStr, body, headers, timeoutMs) {
  timeoutMs = timeoutMs || 12000;
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: method,
      headers: Object.assign({
        Accept: 'application/json',
        'User-Agent': 'PiNodeSoloHost-Agent'
      }, headers || {}, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      timeout: timeoutMs
    }, function (res) {
      let b = '';
      res.on('data', function (c) { if (b.length < 200000) b += c; });
      res.on('end', function () {
        let j = null;
        try { j = JSON.parse(b); } catch (e) { j = { raw: b.slice(0, 400) }; }
        resolve({ status: res.statusCode, json: j, text: b });
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function createBridge(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || process.env.DATA_DIR || '/data';
  const stateFile = opts.stateFile || path.join(dataDir, 'state', 'agent-state.json');
  const hostCopy = path.join(process.env.SOLOHOST_CONFIG_DIR || '/solohost-config', '.pnc-data', 'agent-state.json');
  let backend = normOrigin(opts.backend || process.env.PI_BROWSER_BACKEND || '');
  const label = opts.label || process.env.PI_BROWSER_LABEL || (os.hostname() + ' SoloHost');
  let st = loadState(stateFile);
  if (!st.token && fs.existsSync(hostCopy)) st = Object.assign(st, loadState(hostCopy));
  let pending = null; // { code, expiresAt, sessionId }
  let lastError = null;
  let lastBeat = 0;

  function persist() {
    saveState(stateFile, st);
    try { saveState(hostCopy, st); } catch (e) {}
  }

  function snapshot() {
    const now = Date.now();
    const exp = pending && pending.expiresAt ? pending.expiresAt : 0;
    const expired = pending && exp && now > exp;
    return {
      backend: backend || null,
      label: label,
      paired: !!(st.token && st.nodeId),
      status: st.token ? 'paired' : (expired ? 'expired' : (pending ? 'pending' : 'idle')),
      code: (!st.token && pending && !expired) ? pending.code : null,
      deepLink: (!st.token && pending && !expired) ? ('pinode://pair?c=' + pending.code) : null,
      expiresAt: pending && !st.token ? pending.expiresAt : null,
      expiresIn: pending && !st.token && exp > now ? Math.round((exp - now) / 1000) : 0,
      nodeId: st.nodeId || null,
      lastBeat: lastBeat || st.lastBeat || null,
      error: lastError,
      labelStored: st.label || label
    };
  }

  async function tryCreateOnBackend(code) {
    if (!backend) throw new Error('pair create failed: set PI_BROWSER_BACKEND (origin, no trailing slash)');
    const body = {
      code: code,
      label: label,
      hostname: os.hostname(),
      version: opts.version || process.env.VERSION || 'solohost',
      kind: 'solohost-agent'
    };
    const paths = [
      '/api/solohost/pair',
      '/api/v1/pair/create',
      '/api/pair/create',
      '/api/agent/pair'
    ];
    let last = null;
    for (let i = 0; i < paths.length; i++) {
      try {
        const r = await httpJson('POST', backend + paths[i], body);
        last = r;
        if (r.status >= 200 && r.status < 300 && r.json && (r.json.code || r.json.ok !== false)) {
          return {
            code: String(r.json.code || code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8),
            sessionId: r.json.sessionId || r.json.pairId || r.json.id || null,
            expiresAt: r.json.expiresAt ? Date.parse(r.json.expiresAt) : (Date.now() + 10 * 60 * 1000),
            path: paths[i]
          };
        }
      } catch (e) { last = { error: e.message }; }
    }
    const hint = last && last.json && (last.json.error || last.json.message);
    throw new Error('pair create failed' + (hint ? (': ' + hint) : (last && last.status ? (' HTTP ' + last.status) : '')) + ' — check --backend origin');
  }

  async function createPair() {
    lastError = null;
    const code = newCode();
    try {
      const remote = await tryCreateOnBackend(code);
      pending = { code: remote.code || code, expiresAt: remote.expiresAt, sessionId: remote.sessionId, path: remote.path };
    } catch (e) {
      // Local code still shown so operator can retry after fixing backend.
      lastError = e.message;
      pending = { code: code, expiresAt: Date.now() + 10 * 60 * 1000, sessionId: null, localOnly: true };
    }
    return snapshot();
  }

  async function pollPair() {
    if (st.token) return snapshot();
    if (!pending || !pending.code || !backend) return snapshot();
    if (Date.now() > pending.expiresAt) return snapshot();
    const paths = [
      '/api/solohost/pair/' + pending.code,
      '/api/v1/pair/status?code=' + encodeURIComponent(pending.code),
      '/api/pair/status?code=' + encodeURIComponent(pending.code)
    ];
    for (let i = 0; i < paths.length; i++) {
      try {
        const r = await httpJson('GET', backend + paths[i]);
        const j = r.json || {};
        const status = String(j.status || j.state || '').toLowerCase();
        if (r.status >= 200 && r.status < 300 && (status === 'paired' || j.token || j.credential)) {
          st.token = j.token || (j.credential && j.credential.token) || j.accessToken;
          st.nodeId = j.nodeId || j.id || pending.sessionId || pending.code;
          st.label = label;
          st.pairedAt = new Date().toISOString();
          persist();
          pending = null;
          lastError = null;
          return snapshot();
        }
      } catch (e) {}
    }
    return snapshot();
  }

  async function heartbeat(telemetry) {
    if (!st.token || !backend) return { ok: false };
    const body = { nodeId: st.nodeId, label: label, telemetry: telemetry || {}, ts: new Date().toISOString() };
    const headers = { Authorization: 'Bearer ' + st.token };
    const paths = ['/api/solohost/heartbeat', '/api/v1/agent/heartbeat', '/api/agent/heartbeat'];
    for (let i = 0; i < paths.length; i++) {
      try {
        const r = await httpJson('POST', backend + paths[i], body, headers);
        if (r.status >= 200 && r.status < 300) {
          lastBeat = Date.now();
          st.lastBeat = lastBeat;
          persist();
          return { ok: true };
        }
        if (r.status === 401 || r.status === 403) {
          st.token = null; st.nodeId = null; persist();
          return { ok: false, revoked: true };
        }
      } catch (e) {}
    }
    return { ok: false };
  }

  async function disconnect() {
    if (backend && st.token) {
      try {
        await httpJson('POST', backend + '/api/solohost/disconnect', { nodeId: st.nodeId }, { Authorization: 'Bearer ' + st.token });
      } catch (e) {}
    }
    st = {};
    pending = null;
    lastError = null;
    persist();
    return snapshot();
  }

  function setBackend(url) {
    backend = normOrigin(url);
    return snapshot();
  }

  return {
    snapshot: snapshot,
    createPair: createPair,
    pollPair: pollPair,
    heartbeat: heartbeat,
    disconnect: disconnect,
    setBackend: setBackend,
    stateFile: stateFile
  };
}

module.exports = { createBridge: createBridge, normOrigin: normOrigin };
