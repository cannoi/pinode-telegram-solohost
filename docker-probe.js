'use strict';
const dataFrame = require('./data-frame');

/**
 * Optional Docker sources for Pi Node status
 * - Docker Engine API via /var/run/docker.sock (if mounted/readable)
 * - docker CLI (if in PATH)
 * - docker exec into candidate containers → Core /info, Horizon, node-status
 *
 * Safe when socket is absent: all methods return null quickly.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const ENABLED = String(process.env.DOCKER_PROBE || 'auto').toLowerCase(); // auto|1|0

function readUserPref() {
  try {
    const f = path.join(process.env.DATA_DIR || '/data', 'state', 'docker-pref.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j;
  } catch (e) { return null; }
}

function dockerAllowed() {
  // Explicit off via env always wins
  if (ENABLED === '0' || ENABLED === 'false' || ENABLED === 'off') return false;
  // Explicit on via env
  if (ENABLED === '1' || ENABLED === 'true' || ENABLED === 'on') {
    try { return fs.existsSync(SOCK); } catch (e) { return false; }
  }
  // User preference from chat (/docker on) — only if socket already mounted by operator
  const pref = readUserPref();
  if (pref && pref.enabled === false) return false;
  if (pref && pref.enabled === true) {
    try { return fs.existsSync(SOCK); } catch (e) { return false; }
  }
  // auto: use sock only if present (never force)
  if (ENABLED === 'auto') {
    try { return fs.existsSync(SOCK); } catch (e) { return false; }
  }
  return false;
}

function dockerApi(path, timeoutMs) {
  timeoutMs = timeoutMs || 2500;
  return new Promise(function (resolve, reject) {
    if (!dockerAllowed()) return reject(new Error('docker disabled'));
    const req = http.request({
      socketPath: SOCK,
      path: path,
      method: 'GET',
      timeout: timeoutMs
    }, function (res) {
      let b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(b)); } catch (e) { resolve(b); }
        } else reject(new Error('docker API ' + res.statusCode));
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} reject(new Error('timeout')); });
    req.end();
  });
}

function dockerApiPost(path, body, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  return new Promise(function (resolve, reject) {
    if (!dockerAllowed()) return reject(new Error('docker disabled'));
    const data = typeof body === 'string' ? body : JSON.stringify(body || {});
    const req = http.request({
      socketPath: SOCK,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: timeoutMs
    }, function (res) {
      let b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function runCmd(bin, args, timeoutMs) {
  timeoutMs = timeoutMs || 6000;
  return new Promise(function (resolve, reject) {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, function (err, stdout, stderr) {
      if (err) return reject(err);
      resolve(String(stdout || ''));
    });
  });
}

function scoreContainer(c) {
  const name = (c.Names && c.Names[0]) ? c.Names[0] : (c.Name || '');
  const image = c.Image || '';
  const ports = JSON.stringify(c.Ports || []);
  let score = 0;
  if (/testnet|mainnet|pi-node|stellar|horizon/i.test(name)) score += 5;
  if (/pi-node|stellar|horizon/i.test(image)) score += 4;
  if (/8000|31401|11626|11826/i.test(ports)) score += 3;
  if (/Up|running/i.test(c.Status || c.State || '')) score += 1;
  return score;
}

async function listContainers() {
  // Prefer API
  try {
    const list = await dockerApi('/containers/json?all=1');
    if (Array.isArray(list)) return list.map(function (c) {
      return {
        id: c.Id,
        name: (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports,
        score: scoreContainer(c)
      };
    });
  } catch (e) {}
  // CLI fallback
  try {
    const out = await runCmd('docker', ['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
    return out.split('\n').filter(Boolean).map(function (line) {
      const p = line.split('\t');
      const c = { id: p[0], name: p[1], image: p[2], status: p[3], ports: p[4], state: /Up/i.test(p[3] || '') ? 'running' : 'exited' };
      c.score = scoreContainer({ Names: ['/' + c.name], Image: c.image, Ports: c.ports, Status: c.status });
      return c;
    });
  } catch (e) {
    return [];
  }
}

async function execIn(container, cmdArr) {
  // docker exec via CLI (most reliable across engines)
  try {
    const args = ['exec', container].concat(cmdArr);
    const out = await runCmd('docker', args, 8000);
    return out;
  } catch (e) {
    return null;
  }
}

async function execHttpLocal(container, urlPath, port) {
  // curl or wget inside container to localhost core/horizon
  const url = 'http://127.0.0.1:' + port + urlPath;
  let out = await execIn(container, ['curl', '-sS', '-m', '3', url]);
  if (!out) out = await execIn(container, ['wget', '-qO-', url]);
  return out;
}

/**
 * Full docker-enriched snapshot
 */
async function probeDocker() {
  if (!dockerAllowed()) {
    return { available: false, reason: 'no docker sock/cli or DOCKER_PROBE=0' };
  }

  const result = {
    available: true,
    docker_sock: false,
    containers: [],
    pi_container: null,
    docker: null,
    core_from_exec: null,
    horizon_from_exec: null,
    peers_from_exec: null
  };

  try {
    fs.accessSync(SOCK, fs.constants.R_OK);
    result.docker_sock = true;
  } catch (e) {
    result.docker_sock = false;
  }

  let containers = [];
  try {
    containers = await listContainers();
  } catch (e) {
    result.error = e.message;
    return result;
  }

  containers.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  result.containers = containers.slice(0, 12).map(function (c) {
    return { name: c.name, state: c.state || c.status, image: c.image, score: c.score };
  });

  const cand = containers.filter(function (c) {
    return (c.score || 0) >= 3 && /running|Up/i.test(String(c.state || c.status || ''));
  });
  const pick = cand[0] || containers.find(function (c) {
    return /testnet|mainnet|pi-node/i.test(c.name || '') && /Up|running/i.test(String(c.status || c.state || ''));
  });

  if (!pick) {
    result.docker = containers.some(function (c) { return /Up|running/i.test(String(c.status || c.state || '')); })
      ? 'up' : 'unknown';
    return result;
  }

  result.pi_container = pick.name;
  result.docker = /Up|running/i.test(String(pick.status || pick.state || '')) ? 'RUNNING' : 'STOPPED';

  // Exec Core /info on common ports inside container
  const corePorts = [11626, 11826, 11625];
  for (let i = 0; i < corePorts.length; i++) {
    const body = await execHttpLocal(pick.name, '/info', corePorts[i]);
    if (body) {
      try {
        const j = JSON.parse(body);
        const info = j.info || j;
        result.core_from_exec = {
          source: 'docker-exec-core',
          core_verified: true,
          core_port: corePorts[i],
          core_state: info.state != null ? String(info.state) : null,
          ledger: info.ledger && info.ledger.num != null ? Number(info.ledger.num) : null,
          ledger_age: info.ledger && info.ledger.age != null ? Number(info.ledger.age) : null,
          sync: null
        };
        const st = result.core_from_exec.core_state || '';
        if (/synced/i.test(st) && !/not\s*synced/i.test(st)) result.core_from_exec.sync = 'Synced';
        else if (/catching/i.test(st)) result.core_from_exec.sync = 'Catching up';
        else result.core_from_exec.sync = st || 'Core OK';
        break;
      } catch (e) {}
    }
  }

  // Exec peers
  if (result.core_from_exec && result.core_from_exec.core_port) {
    const pb = await execHttpLocal(pick.name, '/peers', result.core_from_exec.core_port);
    if (pb) {
      try {
        const pj = JSON.parse(pb);
        if (pj.authenticated_peers) {
          const inn = pj.authenticated_peers.inbound;
          const out = pj.authenticated_peers.outbound;
          result.peers_from_exec = dataFrame.applyPeerRule({
            peer_in: Array.isArray(inn) ? inn.length : (inn ? Object.keys(inn).length : 0),
            peer_out: Array.isArray(out) ? out.length : (out ? Object.keys(out).length : 0)
          });
        }
      } catch (e) {}
    }
  }

  // Exec Horizon root inside container (port 8000 typical)
  const hzBody = await execHttpLocal(pick.name, '/', 8000);
  if (hzBody) {
    try {
      const j = JSON.parse(hzBody);
      if (j.core_latest_ledger != null || j.network_passphrase) {
        result.horizon_from_exec = {
          source: 'docker-exec-horizon',
          ledger: j.history_latest_ledger || j.core_latest_ledger || j.ingest_latest_ledger,
          core_ledger: j.core_latest_ledger,
          ingest_ledger: j.ingest_latest_ledger,
          network: j.network_passphrase,
          horizon_version: j.horizon_version,
          core_version: j.core_version,
          protocol: j.current_protocol_version
        };
      }
    } catch (e) {}
  }

  return result;
}

module.exports = {
  dockerAllowed: dockerAllowed,
  probeDocker: probeDocker,
  listContainers: listContainers
};
