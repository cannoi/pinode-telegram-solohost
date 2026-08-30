'use strict';

/**
 * SoloHost-safe Pi Node discovery (from universal discovery concepts)
 * - No docker.sock / docker CLI required
 * - Auto-find Horizon + Core ports on host.docker.internal / bridge IPs
 * - Sticky verified endpoints
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

class PiNodeDiscovery {
  constructor(options) {
    options = options || {};
    this.stateDir = options.stateDir || process.env.DATA_DIR || '/data';
    this.cacheFile = path.join(this.stateDir, 'state', 'discovery.json');
    this.cacheTTL = options.cacheTTL || 300000; // 5 min
    this.discovered = loadJson(this.cacheFile, null);
    this.log = [];
  }

  note(msg) {
    this.log.push({ t: Date.now(), msg: String(msg) });
    if (this.log.length > 80) this.log.shift();
  }

  async discover(force) {
    if (!force && this.discovered && this.discovered.verified &&
        this.discovered.at && Date.now() - this.discovered.at < this.cacheTTL) {
      return this.discovered;
    }
    this.log = [];
    this.note('discovery start');

    const strategies = [
      () => this.byEnv(),
      () => this.bySticky(),
      () => this.byHostDockerInternal(),
      () => this.byBridgeHosts(),
      () => this.byPortSweep()
    ];

    for (let i = 0; i < strategies.length; i++) {
      try {
        const r = await strategies[i]();
        if (r && r.verified) {
          r.at = Date.now();
          this.discovered = r;
          saveJson(this.cacheFile, r);
          this.note('success ' + r.strategy);
          return r;
        }
      } catch (e) {
        this.note('strategy err: ' + (e && e.message));
      }
    }

    // Best effort unverified
    const best = this.discovered && this.discovered.horizonHost ? this.discovered : {
      strategy: 'none',
      verified: false,
      horizonHost: process.env.NODE_HOST || 'host.docker.internal',
      horizonPort: parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401,
      coreHost: process.env.NODE_HOST || 'host.docker.internal',
      corePort: parseInt(process.env.CORE_HTTP_PORT || '11626', 10) || 11626,
      at: Date.now()
    };
    this.discovered = best;
    this.note('fallback unverified');
    return best;
  }

  async byEnv() {
    const hh = process.env.NODE_HOST || process.env.HORIZON_HOST;
    const hp = parseInt(process.env.HORIZON_PORT || '', 10);
    const cp = parseInt(process.env.CORE_HTTP_PORT || process.env.CORE_RPC_PORT || '', 10);
    if (!hh && !hp && !cp) return null;
    const host = hh || 'host.docker.internal';
    const horizonPort = hp || 31401;
    const corePort = cp || 11626;
    const v = await this.verify(host, horizonPort, host, corePort);
    if (v.horizonOk || v.coreOk) {
      return {
        strategy: 'environment_vars',
        verified: true,
        horizonHost: host,
        horizonPort: horizonPort,
        coreHost: host,
        corePort: corePort,
        horizonOk: v.horizonOk,
        coreOk: v.coreOk,
        network_kind: v.network_kind
      };
    }
    return null;
  }

  async bySticky() {
    const s = this.discovered;
    if (!s || !s.horizonHost) return null;
    const v = await this.verify(s.horizonHost, s.horizonPort, s.coreHost || s.horizonHost, s.corePort);
    if (v.horizonOk || v.coreOk) {
      return Object.assign({}, s, {
        strategy: 'sticky',
        verified: true,
        horizonOk: v.horizonOk,
        coreOk: v.coreOk,
        network_kind: v.network_kind || s.network_kind
      });
    }
    return null;
  }

  async byHostDockerInternal() {
    const host = 'host.docker.internal';
    const pairs = [
      [31401, 11626], [31401, 11826], [31401, 31400],
      [8000, 11626], [8000, 11826],
      [31401, null], [8000, null]
    ];
    for (let i = 0; i < pairs.length; i++) {
      const hp = pairs[i][0];
      const cp = pairs[i][1];
      const v = await this.verify(host, hp, host, cp);
      if (v.horizonOk || v.coreOk) {
        return {
          strategy: 'host_docker_internal',
          verified: true,
          horizonHost: host,
          horizonPort: hp,
          coreHost: host,
          corePort: cp || 11626,
          horizonOk: v.horizonOk,
          coreOk: v.coreOk,
          network_kind: v.network_kind
        };
      }
    }
    return null;
  }

  async byBridgeHosts() {
    const hosts = ['172.17.0.1', '172.18.0.1', '10.0.2.2', 'localhost', '127.0.0.1'];
    const hPorts = [31401, 8000];
    const cPorts = [11626, 11826, 31400];
    for (let hi = 0; hi < hosts.length; hi++) {
      for (let pi = 0; pi < hPorts.length; pi++) {
        const v = await this.verify(hosts[hi], hPorts[pi], hosts[hi], cPorts[0]);
        if (v.horizonOk) {
          // try find core on same host
          let corePort = cPorts[0];
          let coreOk = v.coreOk;
          for (let ci = 0; ci < cPorts.length && !coreOk; ci++) {
            const cv = await this.verifyCore(hosts[hi], cPorts[ci]);
            if (cv) { corePort = cPorts[ci]; coreOk = true; }
          }
          return {
            strategy: 'bridge_hosts',
            verified: true,
            horizonHost: hosts[hi],
            horizonPort: hPorts[pi],
            coreHost: hosts[hi],
            corePort: corePort,
            horizonOk: true,
            coreOk: coreOk,
            network_kind: v.network_kind
          };
        }
      }
    }
    return null;
  }

  async byPortSweep() {
    // Scan common host-mapped Horizon range on host.docker.internal
    const host = 'host.docker.internal';
    for (let p = 31401; p <= 31410; p++) {
      const hz = await this.verifyHorizon(host, p);
      if (hz) {
        let corePort = 11626;
        let coreOk = false;
        const cands = [11626, 11826, 31400, p + 25];
        for (let i = 0; i < cands.length; i++) {
          if (await this.verifyCore(host, cands[i])) {
            corePort = cands[i];
            coreOk = true;
            break;
          }
        }
        return {
          strategy: 'port_sweep',
          verified: true,
          horizonHost: host,
          horizonPort: p,
          coreHost: host,
          corePort: corePort,
          horizonOk: true,
          coreOk: coreOk,
          network_kind: hz.network_kind
        };
      }
    }
    return null;
  }

  async verify(horizonHost, horizonPort, coreHost, corePort) {
    const out = { horizonOk: false, coreOk: false, network_kind: null };
    if (horizonHost && horizonPort) {
      const hz = await this.verifyHorizon(horizonHost, horizonPort);
      if (hz) {
        out.horizonOk = true;
        out.network_kind = hz.network_kind;
      }
    }
    if (coreHost && corePort) {
      out.coreOk = !!(await this.verifyCore(coreHost, corePort));
    }
    return out;
  }

  async verifyHorizon(host, port) {
    try {
      const body = await httpGet('http://' + host + ':' + port + '/', 1600);
      const j = JSON.parse(body);
      if (j.core_latest_ledger == null && j.history_latest_ledger == null && !j.network_passphrase) {
        return null;
      }
      let network_kind = null;
      if (j.network_passphrase) {
        const n = String(j.network_passphrase).toLowerCase();
        if (/test/.test(n)) network_kind = 'testnet';
        else if (/public|main/.test(n)) network_kind = 'mainnet';
        else network_kind = 'custom';
      }
      return { network_kind: network_kind };
    } catch (e) {
      return null;
    }
  }

  async verifyCore(host, port) {
    try {
      const body = await httpGet('http://' + host + ':' + port + '/info', 1400);
      const j = JSON.parse(body);
      const info = j.info || j;
      return !!(info && (info.state != null || (info.ledger && info.ledger.num != null)));
    } catch (e) {
      return false;
    }
  }

  getReport() {
    return {
      discovered: this.discovered,
      log: this.log.slice(-30)
    };
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
    req.on('timeout', function () { try { req.destroy(); } catch (e) {} reject(new Error('timeout')); });
  });
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
