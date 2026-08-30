'use strict';

/**
 * SoloHost install: compose without external docker.sock (validation OK).
 * On start: overwrite host docker-compose.yml via ./:/solohost-config mount.
 * Then best-effort recreate container so sock mounts without manual UI restart.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const http = require('http');

const ENABLED = String(process.env.AUTO_DOCKER_SOCK || '1').toLowerCase();
const CONFIG_DIR = process.env.SOLOHOST_CONFIG_DIR || '/solohost-config';
const TARGET = path.join(CONFIG_DIR, 'docker-compose.yml');
const DATA = process.env.DATA_DIR || '/data';
const MARKER = path.join(DATA, 'state', 'auto-compose.json');
const IMAGE = process.env.AUTO_COMPOSE_IMAGE || 'ghcr.io/cannoi/pinode-telegram-solohost:v2.6.21';
const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';

function log(msg) {
  try { console.log('[auto-compose] ' + msg); } catch (e) {}
}

function composeWithSock() {
  return [
    'services:',
    '  agent:',
    '    image: ' + IMAGE,
    '    labels:',
    '      pi.ui.primary: "true"',
    '    ports:',
    '      - "127.0.0.1:18780:8080"',
    '    environment:',
    '      - BOT_TOKEN=${BOT_TOKEN}',
    '      - CHAT_ID=${CHAT_ID}',
    '      - GEMINI_API_KEY=${GEMINI_API_KEY}',
    '      - NODE_HOST=host.docker.internal',
    '      - HORIZON_PORT=31401',
    '      - CORE_HTTP_PORT=11626',
    '      - DOCKER_PROBE=1',
    '      - AUTO_DOCKER_SOCK=1',
    '      - TELEMETRY_SEC=60',
    '      - TZ=Asia/Ho_Chi_Minh',
    '    volumes:',
    '      - ./data:/data',
    '      - ./:/solohost-config:rw',
    '      - /var/run/docker.sock:/var/run/docker.sock:ro',
    '    restart: unless-stopped',
    ''
  ].join('\n');
}

function writeMarker(obj) {
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify(obj, null, 2));
  } catch (e) {}
}

function runCmd(bin, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    execFile(bin, args, { timeout: timeoutMs || 20000, maxBuffer: 2 * 1024 * 1024 }, function (err, stdout, stderr) {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(String(stdout || ''));
    });
  });
}

function hasSock() {
  try { return fs.existsSync(SOCK); } catch (e) { return false; }
}

function selfContainerId() {
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const m = cgroup.match(/([0-9a-f]{12,64})/);
    if (m) return m[1];
  } catch (e) {}
  try {
    const hostname = fs.readFileSync('/etc/hostname', 'utf8').trim();
    if (hostname && hostname.length >= 12) return hostname;
  } catch (e) {}
  return null;
}

/** Docker Engine API over unix socket */
function dockerApi(method, apiPath, timeoutMs) {
  return new Promise(function (resolve, reject) {
    if (!hasSock()) return reject(new Error('no sock'));
    const req = http.request({
      socketPath: SOCK,
      path: apiPath,
      method: method || 'GET',
      timeout: timeoutMs || 15000
    }, function (res) {
      let b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    req.on('timeout', function () {
      try { req.destroy(); } catch (e) {}
      reject(new Error('timeout'));
    });
    req.end();
  });
}

/**
 * Recreate stack from updated compose so docker.sock volume applies.
 * Works when sock is already mounted (2nd boot) or docker CLI can reach engine.
 */
async function tryRecreateContainer() {
  const attempts = [];

  // 1) docker compose up --force-recreate (preferred)
  try {
    await runCmd('docker', [
      'compose', '-f', TARGET, 'up', '-d', '--force-recreate', '--remove-orphans'
    ], 60000);
    attempts.push({ method: 'compose-up', ok: true });
    log('recreate OK via docker compose up --force-recreate');
    return { ok: true, method: 'compose-up', attempts: attempts };
  } catch (e) {
    attempts.push({ method: 'compose-up', ok: false, error: String(e.message || e) });
  }

  // 2) docker restart self
  const cid = selfContainerId();
  if (cid) {
    try {
      await runCmd('docker', ['restart', cid], 30000);
      attempts.push({ method: 'docker-restart', ok: true, id: cid });
      log('recreate OK via docker restart ' + cid);
      return { ok: true, method: 'docker-restart', attempts: attempts };
    } catch (e) {
      attempts.push({ method: 'docker-restart', ok: false, error: String(e.message || e) });
    }

    // 3) Engine API restart
    try {
      const r = await dockerApi('POST', '/containers/' + cid + '/restart?t=5', 20000);
      if (r.status >= 200 && r.status < 300) {
        attempts.push({ method: 'api-restart', ok: true, id: cid });
        log('recreate OK via Docker API restart');
        return { ok: true, method: 'api-restart', attempts: attempts };
      }
      attempts.push({ method: 'api-restart', ok: false, status: r.status });
    } catch (e) {
      attempts.push({ method: 'api-restart', ok: false, error: String(e.message || e) });
    }
  }

  // 4) Host-side helper scripts (Windows / Linux) for manual or Task Scheduler
  try {
    writeHostHelpers();
    attempts.push({ method: 'host-helpers', ok: true });
  } catch (e) {
    attempts.push({ method: 'host-helpers', ok: false });
  }

  log('recreate not possible yet (no docker.sock on this run)');
  return { ok: false, attempts: attempts };
}

function writeHostHelpers() {
  const dir = CONFIG_DIR;
  if (!fs.existsSync(dir)) return;

  const ps1 = [
    '# Auto-generated by Pi Node Telegram Controller — run once if app cannot self-restart',
    '$ErrorActionPreference = "Continue"',
    'Set-Location -LiteralPath $PSScriptRoot',
    'docker compose -f docker-compose.yml up -d --force-recreate --remove-orphans',
    'Write-Host "Done. Check SoloHost app status."',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'APPLY_DOCKER_SOCK.ps1'), ps1, 'utf8');

  const bat = [
    '@echo off',
    'cd /d "%~dp0"',
    'docker compose -f docker-compose.yml up -d --force-recreate --remove-orphans',
    'echo Done.',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'APPLY_DOCKER_SOCK.bat'), bat, 'utf8');
}

/**
 * Main entry — called from loader.js before app starts
 */
async function runAsync() {
  if (ENABLED === '0' || ENABLED === 'false' || ENABLED === 'off') {
    log('disabled by AUTO_DOCKER_SOCK');
    return { ok: false, reason: 'disabled' };
  }

  if (!fs.existsSync(CONFIG_DIR)) {
    log('no ' + CONFIG_DIR + ' mount — skip');
    return { ok: false, reason: 'no_mount' };
  }

  let current = '';
  try { current = fs.readFileSync(TARGET, 'utf8'); } catch (e) { current = ''; }

  const already = /docker\.sock/i.test(current) && /DOCKER_PROBE=1/.test(current);
  let action = 'skip_already';

  if (!already) {
    try {
      fs.writeFileSync(TARGET, composeWithSock(), 'utf8');
      action = 'overwritten';
      log('wrote docker.sock compose → ' + TARGET);
    } catch (e) {
      log('write failed: ' + (e && e.message));
      writeMarker({ at: new Date().toISOString(), action: 'error', error: String(e && e.message) });
      return { ok: false, reason: e.message };
    }
  } else {
    log('compose already has docker.sock');
  }

  // Always try recreate on first overwrite; on skip_already only if sock missing
  const needRecreate = action === 'overwritten' || (already && !hasSock());
  let recreate = { ok: false };
  if (needRecreate) {
    log('attempting container recreate to load docker.sock…');
    recreate = await tryRecreateContainer();
  }

  // If we recreated successfully, this process will die shortly — mark and exit
  if (recreate.ok) {
    writeMarker({
      at: new Date().toISOString(),
      action: action,
      recreate: recreate,
      note: 'container recreate requested'
    });
    log('exiting so new container can take over');
    setTimeout(function () { process.exit(0); }, 800);
    return { ok: true, action: action, recreate: recreate, exiting: true };
  }

  // No sock this run: helpers written; app continues; one more restart from host may be needed
  writeMarker({
    at: new Date().toISOString(),
    action: action,
    recreate: recreate,
    sock_now: hasSock(),
    note: action === 'overwritten'
      ? 'Compose updated. If Docker sock still missing after boot, run APPLY_DOCKER_SOCK.bat once or Restart app in SoloHost.'
      : 'ready'
  });

  // Flag for Telegram one-shot hint
  try {
    fs.writeFileSync(
      path.join(DATA, 'state', 'pending-sock-restart.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        need_ui_restart: action === 'overwritten' && !hasSock()
      })
    );
  } catch (e) {}

  return { ok: true, action: action, recreate: recreate, sock: hasSock() };
}

function run() {
  // sync wrapper for loader: fire async path
  return runAsync().catch(function (e) {
    log('run error: ' + (e && e.message));
    return { ok: false, reason: e.message };
  });
}

module.exports = { run: run, runAsync: runAsync };
