'use strict';
const dataFrame = require('./data-frame');

/**
 * Optional Docker sources for Pi Node status
 * - Docker Engine API via /var/run/docker.sock (if mounted/readable)
 * - docker CLI (if in PATH)
 * - docker exec into candidate containers → Core /info, Horizon, node-status
 *
 * Safe when socket is absent: all methods return null quickly.
 *
 * [2.6.59-fix] dockerAllowed() now prioritizes user preference (SoloHost UI)
 * OVER DOCKER_PROBE env. This lets the UI consent be honored even when
 * docker-compose.yml still has DOCKER_PROBE=0 (the sandbox default).
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
  // [2.6.59-fix] User preference from SoloHost UI has HIGHER priority than env.
  const pref = readUserPref();

  // 1) Explicit user opt-IN wins → only require the socket to be reachable.
  if (pref && pref.enabled === true && pref.consent === true) {
    try { return fs.existsSync(SOCK); } catch (e) { return false; }
  }

  // 2) Explicit user opt-OUT wins over env=1 (respect the "Disable" button).
  if (pref && pref.enabled === false && pref.consent === false) {
    return false;
  }

  // 3) Fall back to env behavior.
  if (ENABLED === '0' || ENABLED === 'false' || ENABLED === 'off') return false;
  if (ENABLED === '1' || ENABLED === 'true' || ENABLED === 'on') {
    try { return fs.existsSync(SOCK); } catch (e) { return false; }
  }
  if (ENABLED === 'auto') {
    try { return fs.existsSync(SOCK); } catch (e) { return false; }
  }
  return false;
}

/** Structured debug snapshot — explains WHY docker is allowed/blocked. */
function dockerAllowedInfo() {
  const pref = readUserPref();
  let sockExists = false;
  let sockReadable = false;
  try { sockExists = fs.existsSync(SOCK); } catch (e) {}
  try { if (sockExists) fs.accessSync(SOCK, fs.constants.R_OK); sockReadable = sockExists; } catch (e) { sockReadable = false; }
  return {
    sock: SOCK,
    sock_exists: sockExists,
    sock_readable: sockReadable,
    env_docker_probe: process.env.DOCKER_PROBE != null ? String(process.env.DOCKER_PROBE) : null,
    env_enabled_normalized: ENABLED,
    user_pref: pref || null,
    allowed: dockerAllowed()
  };
}

function dockerApi(p, timeoutMs) {
  timeoutMs = timeoutMs || 2500;
  return new Promise(function (resolve, reject) {
    if (!dockerAllowed()) return reject(new Error('docker disabled'));
    const req = http.request({
      socketPath: SOCK,
      path: p,
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
  try {
    const args = ['exec', container].concat(cmdArr);
    const out = await runCmd('docker', args, 8000);
    return out;
  } catch (e) {
    return null;
  }
}

async function execHttpLocal(container, urlPath, port) {
  const url = 'http://127.0.0.1:' + port + urlPath;
  let out = await execIn(container, ['curl', '-sS', '-m', '3', url]);
  if (!out) out = await execIn(container, ['wget', '-qO-', url]);
  return out;
}

async function probeDocker() {
  const info = dockerAllowedInfo();
  if (!dockerAllowed()) {
    return {
      available: false,
      reason: 'docker_not_allowed',
      debug: info
    };
  }

  const result = {
    available: true,
    docker_sock: false,
    containers: [],
    pi_container: null,
    docker: null,
    core_from_exec: null,
    horizon_from_exec: null,
    peers_from_exec: null,
    debug: info
  };

  try {
    fs.accessSync(SOCK, fs.constants.R_OK);
    result.docker_sock = true;
  } catch (e) {
    result.docker_sock = false;
    result.sock_error = String(e && e.message);
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

  const corePorts = [11626, 11826, 11625];
  for (let i = 0; i < corePorts.length; i++) {
    const body = await execHttpLocal(pick.name, '/info', corePorts[i]);
    if (body) {
      try {
        const j = JSON.parse(body);
        const info2 = j.info || j;
        result.core_from_exec = {
          source: 'docker-exec-core',
          core_verified: true,
          core_port: corePorts[i],
          core_state: info2.state != null ? String(info2.state) : null,
          ledger: info2.ledger && info2.ledger.num != null ? Number(info2.ledger.num) : null,
          ledger_age: info2.ledger && info2.ledger.age != null ? Number(info2.ledger.age) : null,
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

  if (pick.id && result.docker_sock) {
    try {
      const ins = await dockerApi('/containers/' + pick.id + '/json', 2500);
      if (ins && ins.State) {
        const st = ins.State;
        result.container_health = st.Health && st.Health.Status ? String(st.Health.Status) : (st.Running ? 'running' : 'stopped');
        if (st.RestartCount != null && isFinite(Number(st.RestartCount))) result.restart_count = Number(st.RestartCount);
        if (st.OOMKilled === true) result.oom = true;
        if (st.Pid != null && Number(st.Pid) > 0) result.pid = Number(st.Pid);
      }
    } catch (e) {}
    try {
      const stats = await dockerApi('/containers/' + pick.id + '/stats?stream=false', 3500);
      if (stats) {
        const cpu = stats.cpu_stats || {};
        const pre = stats.precpu_stats || {};
        const cpuDelta = (cpu.cpu_usage && pre.cpu_usage) ? (cpu.cpu_usage.total_usage - pre.cpu_usage.total_usage) : null;
        const sysDelta = (cpu.system_cpu_usage != null && pre.system_cpu_usage != null) ? (cpu.system_cpu_usage - pre.system_cpu_usage) : null;
        const ncpu = (cpu.online_cpus || (cpu.cpu_usage && cpu.cpu_usage.percpu_usage && cpu.cpu_usage.percpu_usage.length) || 0);
        if (cpuDelta != null && sysDelta > 0 && ncpu > 0) {
          const coresUsed = cpuDelta / sysDelta * ncpu;
          if (isFinite(coresUsed) && coresUsed > 0) {
            result.container_cpus = ncpu;
            result.container_cpu_cores = Math.round(coresUsed * 100) / 100;
            result.container_cpu_docker = Math.round(coresUsed * 1000) / 10;
            const hostPct = coresUsed / ncpu * 100;
            if (hostPct > 0) result.container_cpu = Math.round(hostPct * 10) / 10;
          }
        }
        const mem = stats.memory_stats || {};
        if (mem.usage && mem.limit && mem.limit > 0) {
          const rp = mem.usage / mem.limit * 100;
          if (isFinite(rp) && rp > 0) result.container_ram = Math.round(rp * 10) / 10;
          result.container_ram_mb = Math.round(mem.usage / 1048576);
          result.container_ram_limit_mb = Math.round(mem.limit / 1048576);
        }
        const bio = stats.blkio_stats && stats.blkio_stats.io_service_bytes_recursive;
        if (Array.isArray(bio) && bio.length) {
          let rd = 0, wr = 0;
          bio.forEach(function (x) {
            if (/read/i.test(x.op || '')) rd += Number(x.value) || 0;
            if (/write/i.test(x.op || '')) wr += Number(x.value) || 0;
          });
          if (rd || wr) result.blkio = { read: rd || null, write: wr || null };
        }
        const nets = stats.networks;
        if (nets && typeof nets === 'object') {
          let rx = 0, tx = 0;
          Object.keys(nets).forEach(function (k) {
            rx += Number(nets[k].rx_bytes) || 0;
            tx += Number(nets[k].tx_bytes) || 0;
          });
          if (rx || tx) result.net_io = { rx: rx || null, tx: tx || null };
        }
      }
    } catch (e) {}
  }

  return result;
}

module.exports = {
  dockerAllowed: dockerAllowed,
  dockerAllowedInfo: dockerAllowedInfo,
  probeDocker: probeDocker,
  listContainers: listContainers
};
