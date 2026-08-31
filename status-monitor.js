'use strict';

/**
 * SoloHost-allowed multi-source Pi Node status
 * Primary (always): Horizon root + Core HTTP + TCP ports + state files
 * Optional: Docker sock/exec when DOCKER_PROBE=1 and socket mounted by user
 *
 * Consensus (from cannoi monitor package):
 *   confidence = okSources / total
 *   ≥75% HEALTHY, ≥50% DEGRADED, else soft/offline knowledge
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const OptimizedPiNodeReader = require('./optimized-pi-node-reader');
const PiNodeDiscovery = require('./pi-node-discovery');
const dockerProbe = require('./docker-probe');

class PiNodeStatusMonitor {
  constructor(options) {
    options = options || {};
    this.nodeHosts = uniq([
      options.nodeHost || process.env.NODE_HOST || 'host.docker.internal',
      'host.docker.internal', '172.17.0.1', '172.18.0.1', '10.0.2.2', 'localhost', '127.0.0.1'
    ]);
    this.horizonPorts = uniq([
      options.horizonPort || parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401,
      31401, 8000
    ]);
    this.corePorts = uniq([
      parseInt(process.env.CORE_HTTP_PORT || '11626', 10) || 11626,
      11626, 11826, 31400, 11625
    ]);
    this.nodePorts = [31401, 31402, 31403];
    this.stateDir = options.stateDir || process.env.DATA_DIR || '/data';
    this.telemetrySec = parseInt(process.env.TELEMETRY_SEC || '60', 10) || 60;
    this.cache = { data: null, at: 0, ttl: options.cacheTTL || 4000 };
    this.stickyFile = path.join(this.stateDir, 'state', 'probe-sticky.json');
    this.sticky = loadJson(this.stickyFile, {});
    this.discovery = new PiNodeDiscovery({ stateDir: this.stateDir, cacheTTL: 180000 });
    this.optReader = new OptimizedPiNodeReader({ stateDir: this.stateDir });
    this.metrics = { requests: 0, failures: 0, lastMs: 0, lastSource: null };
  }

  saveSticky() {
    try {
      const d = path.dirname(this.stickyFile);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(this.stickyFile, JSON.stringify(this.sticky, null, 2));
    } catch (e) {}
  }

  tcpOpen(host, port, ms) {
    ms = ms || 700;
    return new Promise(function (resolve) {
      const s = net.connect({ host: host, port: port }, function () { s.destroy(); resolve(true); });
      s.setTimeout(ms, function () { s.destroy(); resolve(false); });
      s.on('error', function () { resolve(false); });
    });
  }

  async probeNetwork() {
    const host = this.sticky.portHost || this.nodeHosts[0];
    const map = {};
    let openCount = 0;
    const ports = this.nodePorts.concat([11626]);
    const self = this;
    await Promise.all(ports.map(async function (port) {
      let open = await self.tcpOpen(host, port, 600);
      if (!open) {
        for (let i = 0; i < 3; i++) {
          open = await self.tcpOpen(self.nodeHosts[i], port, 400);
          if (open) { self.sticky.portHost = self.nodeHosts[i]; break; }
        }
      } else self.sticky.portHost = host;
      map[String(port)] = open ? 'OPEN' : 'CLOSED';
      if (open) openCount++;
    }));
    this.saveSticky();
    return {
      ok: openCount > 0,
      ports: map,
      openCount: openCount,
      // app-facing ports only 31401-3
      app_ports: {
        '31401': map['31401'] || 'CLOSED',
        '31402': map['31402'] || 'CLOSED',
        '31403': map['31403'] || 'CLOSED'
      },
      app_open: ['31401', '31402', '31403'].filter(function (p) { return map[p] === 'OPEN'; }).length
    };
  }

  async probeCoreHttp() {
    const hosts = this.nodeHosts;
    const ports = this.corePorts;
    for (let h = 0; h < hosts.length; h++) {
      for (let p = 0; p < ports.length; p++) {
        try {
          const body = await httpGet('http://' + hosts[h] + ':' + ports[p] + '/info', 2000);
          const j = JSON.parse(body);
          const info = j.info || j;
          if (!info || (info.state == null && !(info.ledger && info.ledger.num != null))) continue;
          const o = {
            ok: true,
            source: 'Core',
            core_verified: true,
            core_host: hosts[h],
            core_port: ports[p],
            core_state: info.state != null ? String(info.state) : null,
            ledger: info.ledger && info.ledger.num != null ? Number(info.ledger.num) : null,
            ledger_age: info.ledger && info.ledger.age != null ? Number(info.ledger.age) : null,
            sync_confidence: 'high'
          };
          const st = o.core_state || '';
          if (/synced/i.test(st) && !/not\s*synced/i.test(st)) o.sync = 'Synced';
          else if (/catching/i.test(st)) o.sync = 'Catching up';
          else o.sync = st || 'Core OK';
          // peers
          try {
            const pb = await httpGet('http://' + hosts[h] + ':' + ports[p] + '/peers', 1200);
            const pj = JSON.parse(pb);
            if (pj.authenticated_peers) {
              const inn = pj.authenticated_peers.inbound;
              const out = pj.authenticated_peers.outbound;
              o.peer_in = Array.isArray(inn) ? inn.length : (inn ? Object.keys(inn).length : 0);
              o.peer_out = Array.isArray(out) ? out.length : (out ? Object.keys(out).length : 0);
            }
          } catch (e) {}
          return o;
        } catch (e) {}
      }
    }
    return { ok: false };
  }

  readFileSource() {
    try {
      const stateFile = path.join(this.stateDir, 'state', 'node-state.json');
      if (!fs.existsSync(stateFile)) return { ok: false };
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const tel = state.lastTelemetry || null;
      const age = tel && tel.ts ? Date.now() - new Date(tel.ts).getTime() : null;
      const maxAge = this.telemetrySec * 2000;
      const fresh = age != null && age <= maxAge;
      return {
        ok: !!fresh,
        fsm: state.fsm,
        failCount: state.failCount,
        lastTelemetry: tel,
        stateAge: age
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Main collect — SoloHost default sources + optional docker
   */
  async getStatus(forceFresh, opts) {
    opts = opts || {};
    const detailed = !!opts.detailed;
    const t0 = Date.now();
    if (!forceFresh && this.cache.data && Date.now() - this.cache.at < this.cache.ttl) {
      const c = Object.assign({}, this.cache.data);
      c.fromCache = true;
      return c;
    }

    this.metrics.requests++;

    // Discovery (HTTP only)
    try {
      await this.discovery.discover(false);
      const d = this.discovery.discovered;
      if (d && d.horizonHost && d.horizonPort) {
        this.optReader.setEndpoint(d.horizonHost, d.horizonPort);
      }
    } catch (e) {}

    // Parallel: Horizon optimized + Core + Network (+ optional Docker)
    const tasks = [
      this.optReader.getStatus({ fresh: true, detailed: detailed }).then(function (d) {
        return { ok: true, data: d };
      }).catch(function (e) { return { ok: false, error: e.message }; }),
      this.probeCoreHttp(),
      this.probeNetwork()
    ];
    // Docker only when operator opted in (env or /docker on) AND socket exists
    let wantDocker = false;
    try {
      wantDocker = dockerProbe.dockerAllowed();
    } catch (e) {
      const dockerOn = String(process.env.DOCKER_PROBE || '0').toLowerCase();
      wantDocker = dockerOn === '1' || dockerOn === 'true' || dockerOn === 'on' || dockerOn === 'auto';
    }
    if (wantDocker) {
      tasks.push(dockerProbe.probeDocker().catch(function (e) {
        return { available: false, error: e.message };
      }));
    }

    const results = await Promise.all(tasks);
    const hz = results[0];
    const core = results[1];
    const netw = results[2];
    const dock = wantDocker ? (results[3] || { available: false }) : { available: false, skipped: true };

    const files = this.readFileSource();

    // Build primary telemetry maximizing Horizon fields
    let primary = {
      source: 'none',
      sync: 'Unknown',
      ledger: null,
      core_verified: false,
      sync_confidence: 'low',
      level: 'soft',
      sources: {
        horizon: !!hz.ok,
        core: !!core.ok,
        files: !!files.ok,
        network: !!netw.ok,
        docker: !!(dock.available && (dock.docker_sock || dock.core_from_exec))
      },
      source_latency: {},
      verification: {}
    };

    if (hz.ok && hz.data) {
      Object.assign(primary, hz.data);
      primary.source = 'Horizon';
      primary.sources.horizon = true;
      if (hz.data.responseTime != null) primary.source_latency.horizon = hz.data.responseTime;
    }
    if (core.ok) {
      primary.core_verified = true;
      primary.core_state = core.core_state;
      primary.sync = core.sync || primary.sync;
      primary.sync_confidence = 'high';
      if (core.ledger != null) primary.ledger = core.ledger;
      if (core.ledger_age != null) primary.ledger_age = core.ledger_age;
      if (core.peer_in != null) primary.peer_in = core.peer_in;
      if (core.peer_out != null) primary.peer_out = core.peer_out;
      primary.source = hz.ok ? 'Core+Horizon' : 'Core';
      primary.sources.core = true;
    } else if (hz.ok) {
      primary.core_verified = false;
      primary.sync = (primary.sync || 'Horizon OK') + ' · Core n/a';
      primary.sync_confidence = primary.sync_confidence || 'medium';
    }

    // Network ports
    primary.ports = netw.app_ports || netw.ports || {};
    primary.ports_open = netw.app_open != null ? netw.app_open : netw.openCount;
    primary.ports_all_open = primary.ports_open >= 3;
    primary.network_probe = netw.ports;

    // Optional docker enrichment
    if (dock && dock.available) {
      primary.docker_probe = true;
      primary.docker_sock = !!dock.docker_sock;
      if (dock.docker) primary.docker = dock.docker;
      if (dock.pi_container) primary.container = dock.pi_container;
      if (dock.core_from_exec) {
        const ce = dock.core_from_exec;
        primary.core_verified = true;
        primary.core_state = ce.core_state || primary.core_state;
        primary.sync = ce.sync || primary.sync;
        primary.sync_confidence = 'high';
        if (ce.ledger != null) primary.ledger = ce.ledger;
        if (ce.ledger_age != null) primary.ledger_age = ce.ledger_age;
        primary.source = 'DockerExec+' + (hz.ok ? 'Horizon' : 'Core');
        primary.sources.docker = true;
      }
      if (dock.peers_from_exec) {
        if (dock.peers_from_exec.peer_in != null) primary.peer_in = dock.peers_from_exec.peer_in;
        if (dock.peers_from_exec.peer_out != null) primary.peer_out = dock.peers_from_exec.peer_out;
      }
      if (dock.horizon_from_exec) {
        const hzE = dock.horizon_from_exec;
        if (primary.ledger == null && hzE.ledger != null) primary.ledger = hzE.ledger;
        if (hzE.core_version && !primary.core_version) primary.core_version = hzE.core_version;
        if (hzE.horizon_version && !primary.horizon_version) primary.horizon_version = hzE.horizon_version;
        if (hzE.protocol != null && primary.protocol == null) primary.protocol = hzE.protocol;
        if (hzE.network && !primary.network) primary.network = hzE.network;
        primary.sources.docker_horizon = true;
      }
      if (Array.isArray(dock.containers) && dock.containers.length) {
        primary.docker_containers = dock.containers.length;
      }
    } else {
      primary.docker_probe = false;
      primary.docker_sock = false;
    }

    // Consensus verification (uploaded monitor model)
    const flags = [
      primary.sources.horizon,
      primary.sources.core || primary.core_verified,
      primary.sources.files || files.ok,
      primary.sources.network
    ];
    const okCount = flags.filter(Boolean).length;
    const confidence = okCount / 4;
    let consensus = 'OFFLINE';
    if (confidence >= 0.75) consensus = 'HEALTHY';
    else if (confidence >= 0.5) consensus = 'DEGRADED';
    else if (okCount >= 1) consensus = 'PARTIAL';

    // Ledger drift check
    let ledger_gap = null;
    if (core.ok && core.ledger != null && hz.ok && hz.data && hz.data.ledger != null) {
      ledger_gap = Math.abs(Number(core.ledger) - Number(hz.data.ledger));
      primary.ledger_gap = ledger_gap;
      if (ledger_gap > 50) primary.sync_confidence = 'medium';
    }

    primary.verification = {
      confidence: confidence,
      confidence_pct: Math.round(confidence * 100),
      consensus: consensus,
      ok_sources: okCount,
      total_sources: 4,
      ledger_gap: ledger_gap,
      horizon_ok: !!primary.sources.horizon,
      core_ok: !!primary.core_verified,
      files_ok: !!files.ok,
      network_ok: !!netw.ok
    };

    // FSM / level for alerts
    let level = 'ok';
    if (consensus === 'OFFLINE' || (primary.ports_open === 0 && !hz.ok)) level = 'critical';
    else if (consensus === 'DEGRADED' || consensus === 'PARTIAL') level = 'soft';
    else if (/catching|behind|slow|ingest lag|not synced/i.test(String(primary.sync || ''))) level = 'soft';
    else if (!primary.core_verified && hz.ok) level = 'soft';
    else if (consensus === 'HEALTHY') level = 'ok';
    primary.level = level;
    primary.fsm = consensus;

    if (this.discovery && this.discovery.discovered) {
      primary.discovery = {
        strategy: this.discovery.discovered.strategy,
        horizon: this.discovery.discovered.horizonHost
          ? this.discovery.discovered.horizonHost + ':' + this.discovery.discovered.horizonPort : null,
        core: this.discovery.discovered.coreOk
          ? this.discovery.discovered.coreHost + ':' + this.discovery.discovered.corePort : null,
        verified: !!this.discovery.discovered.verified
      };
    }

    primary.ts = new Date().toISOString();
    primary.responseTime = Date.now() - t0;
    this.metrics.lastMs = primary.responseTime;
    this.metrics.lastSource = primary.source;
    if (!hz.ok && !core.ok) this.metrics.failures++;

    this.cache.data = primary;
    this.cache.at = Date.now();
    return primary;
  }

  getMetrics() { return Object.assign({}, this.metrics); }
  clearCache() { this.cache.data = null; this.cache.at = 0; }
}

function httpGet(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const req = http.get(url, { timeout: timeoutMs || 3000 }, function (res) {
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

function uniq(arr) {
  const s = {}, out = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null || s[arr[i]]) continue;
    s[arr[i]] = true;
    out.push(arr[i]);
  }
  return out;
}

function loadJson(f, fb) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb || {}; }
}

module.exports = PiNodeStatusMonitor;
