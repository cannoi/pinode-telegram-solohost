'use strict';

/**
 * SoloHost-safe adaptive discovery (runs INSIDE Controller container)
 * - Finds Horizon + Core independently (does not stop when only Horizon works)
 * - No docker.sock / machine-specific container names
 * - Sticky + multi-host + port pairs + sweep
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

class PiNodeDiscovery {
  constructor(options) {
    options = options || {};
    this.stateDir = options.stateDir || process.env.DATA_DIR || '/data';
    this.cacheFile = path.join(this.stateDir, 'state', 'discovery.json');
    this.cacheTTL = options.cacheTTL || 180000; // 3 min
    this.discovered = loadJson(this.cacheFile, null);
    this.log = [];
  }

  note(msg) {
    this.log.push({ t: Date.now(), msg: String(msg).slice(0, 200) });
    if (this.log.length > 100) this.log.shift();
  }

  hosts() {
    return uniq([
      process.env.NODE_HOST || 'host.docker.internal',
      'host.docker.internal',
      '172.17.0.1',
      '172.18.0.1',
      '172.19.0.1',
      '10.0.2.2',
      'localhost',
      '127.0.0.1'
    ]);
  }

  horizonPorts() {
    return uniq([
      parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401,
      31401, 8000, 31400, 3000
    ]);
  }

  corePorts() {
    return uniq([
      parseInt(process.env.CORE_HTTP_PORT || process.env.CORE_RPC_PORT || '11626', 10) || 11626,
      11626, 11826, 31400, 11625, 11627, 8001
    ]);
  }

  async discover(force) {
    if (!force && this.discovered && this.discovered.verified &&
        this.discovered.at && Date.now() - this.discovered.at < this.cacheTTL) {
      // If Core still missing, occasionally re-probe Core only
      if (!this.discovered.coreOk && Date.now() - this.discovered.at > 60000) {
        await this.refineCore(this.discovered);
        this.discovered.at = Date.now();
        saveJson(this.cacheFile, this.discovered);
      }
      return this.discovered;
    }

    this.log = [];
    this.note('discovery start (adaptive)');

    const result = {
      strategy: 'adaptive',
      verified: false,
      horizonHost: null,
      horizonPort: null,
      coreHost: null,
      corePort: null,
      horizonOk: false,
      coreOk: false,
      network_kind: null,
      at: Date.now()
    };

    // Phase 1: sticky endpoints first (fast)
    if (this.discovered && this.discovered.horizonHost) {
      const hz = await this.verifyHorizon(this.discovered.horizonHost, this.discovered.horizonPort);
      if (hz) {
        result.horizonHost = this.discovered.horizonHost;
        result.horizonPort = this.discovered.horizonPort;
        result.horizonOk = true;
        result.network_kind = hz.network_kind;
        result.strategy = 'sticky+adaptive';
        this.note('horizon sticky ok ' + result.horizonHost + ':' + result.horizonPort);
      }
      if (this.discovered.coreHost && this.discovered.corePort) {
        if (await this.verifyCore(this.discovered.coreHost, this.discovered.corePort)) {
          result.coreHost = this.discovered.coreHost;
          result.corePort = this.discovered.corePort;
          result.coreOk = true;
          this.note('core sticky ok ' + result.coreHost + ':' + result.corePort);
        }
      }
    }

    // Phase 2: find Horizon if missing (parallel candidates, race)
    if (!result.horizonOk) {
      const hzHit = await this.findHorizon();
      if (hzHit) {
        result.horizonHost = hzHit.host;
        result.horizonPort = hzHit.port;
        result.horizonOk = true;
        result.network_kind = hzHit.network_kind;
        result.strategy = hzHit.via || 'horizon-scan';
        this.note('horizon found ' + hzHit.host + ':' + hzHit.port + ' via ' + result.strategy);
      }
    }

    // Phase 3: ALWAYS try to find Core (even if Horizon already ok)
    // This fixes early-stop on environment_vars with coreOk:false
    if (!result.coreOk) {
      const coreHit = await this.findCore(result.horizonHost);
      if (coreHit) {
        result.coreHost = coreHit.host;
        result.corePort = coreHit.port;
        result.coreOk = true;
        this.note('core found ' + coreHit.host + ':' + coreHit.port);
      } else {
        this.note('core not reachable (will label Horizon-only)');
      }
    }

    result.verified = !!(result.horizonOk || result.coreOk);
    result.at = Date.now();
    this.discovered = result;
    saveJson(this.cacheFile, result);
    this.note(result.verified
      ? ('done horizon=' + result.horizonOk + ' core=' + result.coreOk)
      : 'done — no sources');
    return result;
  }

  async refineCore(result) {
    if (!result || result.coreOk) return result;
    this.note('refine core probe');
    const coreHit = await this.findCore(result.horizonHost);
    if (coreHit) {
      result.coreHost = coreHit.host;
      result.corePort = coreHit.port;
      result.coreOk = true;
      this.note('core refined ' + coreHit.host + ':' + coreHit.port);
    }
    return result;
  }

  async findHorizon() {
    const hosts = this.hosts();
    const ports = this.horizonPorts();
    // Prefer env host/port first by ordering
    const urls = [];
    for (let h = 0; h < hosts.length; h++) {
      for (let p = 0; p < ports.length; p++) {
        urls.push({ host: hosts[h], port: ports[p] });
      }
    }
    // Sweep 31401-31410 on primary host
    const primary = hosts[0];
    for (let p = 31401; p <= 31410; p++) {
      urls.push({ host: primary, port: p });
    }

    // Parallel batches of 6
    for (let i = 0; i < urls.length; i += 6) {
      const batch = urls.slice(i, i + 6);
      const found = await raceFirst(batch.map((u) => {
        return this.verifyHorizon(u.host, u.port).then(function (hz) {
          if (!hz) return null;
          return { host: u.host, port: u.port, network_kind: hz.network_kind, via: 'scan' };
        });
      }));
      if (found) return found;
    }
    return null;
  }

  async findCore(preferHost) {
    const hosts = uniq([preferHost].concat(this.hosts()).filter(Boolean));
    const ports = this.corePorts();
    const urls = [];
    for (let h = 0; h < hosts.length; h++) {
      for (let p = 0; p < ports.length; p++) {
        urls.push({ host: hosts[h], port: ports[p] });
      }
    }
    for (let i = 0; i < urls.length; i += 6) {
      const batch = urls.slice(i, i + 6);
      const found = await raceFirst(batch.map((u) => {
        return this.verifyCore(u.host, u.port).then(function (ok) {
          if (!ok) return null;
          return { host: u.host, port: u.port };
        });
      }));
      if (found) return found;
    }
    return null;
  }

  async verifyHorizon(host, port) {
    if (!host || !port) return null;
    try {
      const body = await httpGet('http://' + host + ':' + port + '/', 1500);
      const j = JSON.parse(body);
      if (j.core_latest_ledger == null && j.history_latest_ledger == null &&
          j.ingest_latest_ledger == null && !j.network_passphrase) {
        return null;
      }
      let network_kind = null;
      if (j.network_passphrase) {
        const n = String(j.network_passphrase).toLowerCase();
        if (/test/.test(n)) network_kind = 'testnet';
        else if (/public|main/.test(n)) network_kind = 'mainnet';
        else network_kind = 'custom';
      }
      return { network_kind: network_kind, sample: j };
    } catch (e) {
      return null;
    }
  }

  async verifyCore(host, port) {
    if (!host || !port) return false;
    try {
      const body = await httpGet('http://' + host + ':' + port + '/info', 1300);
      const j = JSON.parse(body);
      const info = j.info || j;
      return !!(info && (info.state != null || (info.ledger && info.ledger.num != null)));
    } catch (e) {
      return false;
    }
  }

  getReport() {
    return { discovered: this.discovered, log: this.log.slice(-40) };
  }
}

function httpGet(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const req = http.get(url, { timeout: timeoutMs || 2000 }, function (res) {
      let b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        if (res.statusCode === 200) resolve(b);
        else reject(new Error('HTTP ' + res.statusCode));
      });
    });
    req.on('error', reject);
    req.on('timeout', function () {
      try { req.destroy(); } catch (e) {}
      reject(new Error('timeout'));
    });
  });
}

function raceFirst(promises) {
  return new Promise(function (resolve) {
    let left = promises.length;
    if (!left) return resolve(null);
    let done = false;
    promises.forEach(function (p) {
      Promise.resolve(p).then(function (v) {
        if (!done && v) {
          done = true;
          resolve(v);
        } else {
          left--;
          if (!done && left <= 0) resolve(null);
        }
      }).catch(function () {
        left--;
        if (!done && left <= 0) resolve(null);
      });
    });
  });
}

function uniq(arr) {
  const s = {};
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null || s[String(v)]) continue;
    s[String(v)] = true;
    out.push(v);
  }
  return out;
}

function loadJson(f, fb) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; }
}
function saveJson(f, obj) {
  try {
    const d = path.dirname(f);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  } catch (e) {}
}

module.exports = PiNodeDiscovery;
