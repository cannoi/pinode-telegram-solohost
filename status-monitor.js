'use strict';

const PiNodeDiscovery = require('./pi-node-discovery');
const OptimizedPiNodeReader = require('./optimized-pi-node-reader');

/**
 * Pi Node multi-source status — optimized for SoloHost
 *
 * Speed:
 *  - Parallel Horizon + Core + Port probes (Promise.all)
 *  - Sticky last-good URLs (skip full host matrix most of the time)
 *  - Short timeouts; one retry only on sticky miss
 *
 * Accuracy:
 *  - Core /info state = authoritative sync (Pi Desktop compatible)
 *  - Horizon alone = "Horizon live · Core n/a" (never fake Core Synced)
 *  - Network-agnostic (testnet / mainnet / any container name)
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

class PiNodeStatusMonitor {
  constructor(options) {
    options = options || {};
    this.nodeHosts = uniq([
      options.nodeHost || process.env.NODE_HOST || 'host.docker.internal',
      'host.docker.internal',
      '172.17.0.1',
      '172.18.0.1',
      '10.0.2.2',
      'localhost',
      '127.0.0.1'
    ]);
    this.horizonPorts = uniq([
      options.horizonPort || parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401,
      31401,
      8000
    ]);
    this.corePorts = uniq([
      parseInt(process.env.CORE_HTTP_PORT || process.env.CORE_RPC_PORT || '11626', 10) || 11626,
      11826,
      11626,
      31400,
      11625
    ]);
    this.nodePorts = options.nodePorts || [31401, 31402, 31403];
    this.stateDir = options.stateDir || process.env.DATA_DIR || '/data';
    this.stickyFile = path.join(this.stateDir, 'state', 'probe-sticky.json');
    this.stateFile = path.join(this.stateDir, 'state', 'node-state.json');
    this.cache = { data: null, at: 0, ttl: options.cacheTTL || 4000 };
    this.sticky = loadJson(this.stickyFile, {});
    this.metrics = { requests: 0, failures: 0, lastSource: null, lastMs: 0 };
    this.discovery = new PiNodeDiscovery({ stateDir: this.stateDir, cacheTTL: 300000 });
    this.optReader = new OptimizedPiNodeReader({ stateDir: this.stateDir });
  }

  /* ---------- low-level I/O ---------- */

  httpGet(url, timeoutMs) {
    timeoutMs = timeoutMs || 2000;
    return new Promise(function (resolve, reject) {
      const req = http.get(url, { timeout: timeoutMs }, function (res) {
        let body = '';
        res.on('data', function (c) { body += c; });
        res.on('end', function () {
          if (res.statusCode === 200) resolve(body);
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

  tcpOpen(host, port, timeoutMs) {
    timeoutMs = timeoutMs || 800;
    return new Promise(function (resolve) {
      const s = net.connect({ host: host, port: port }, function () {
        s.destroy();
        resolve(true);
      });
      s.setTimeout(timeoutMs, function () { s.destroy(); resolve(false); });
      s.on('error', function () { resolve(false); });
    });
  }

  /** Race many URLs; first valid JSON wins */
  async raceHttp(urls, timeoutMs, validateFn) {
    if (!urls.length) return null;
    const self = this;
    return new Promise(function (resolve) {
      let pending = urls.length;
      let done = false;
      urls.forEach(function (url) {
        self.httpGet(url, timeoutMs).then(function (body) {
          if (done) return;
          try {
            const j = JSON.parse(body);
            if (validateFn && !validateFn(j)) throw new Error('invalid');
            done = true;
            resolve({ url: url, json: j, body: body });
          } catch (e) {
            pending--;
            if (pending <= 0 && !done) resolve(null);
          }
        }).catch(function () {
          pending--;
          if (pending <= 0 && !done) resolve(null);
        });
      });
    });
  }

  horizonUrlList() {
    const list = [];
    if (this.sticky.horizonUrl) list.push(this.sticky.horizonUrl);
    const d = this.discovery && this.discovery.discovered;
    if (d && d.horizonHost && d.horizonPort) {
      list.push('http://' + d.horizonHost + ':' + d.horizonPort + '/');
    }
    for (let h = 0; h < this.nodeHosts.length; h++) {
      for (let p = 0; p < this.horizonPorts.length; p++) {
        list.push('http://' + this.nodeHosts[h] + ':' + this.horizonPorts[p] + '/');
      }
    }
    return uniq(list);
  }

  coreUrlList() {
    const list = [];
    if (this.sticky.coreUrl) list.push(this.sticky.coreUrl);
    const d = this.discovery && this.discovery.discovered;
    if (d && d.coreHost && d.corePort) {
      list.push('http://' + d.coreHost + ':' + d.corePort + '/info');
    }
    for (let h = 0; h < this.nodeHosts.length; h++) {
      for (let p = 0; p < this.corePorts.length; p++) {
        list.push('http://' + this.nodeHosts[h] + ':' + this.corePorts[p] + '/info');
      }
    }
    return uniq(list);
  }

  saveSticky() {
    try {
      const dir = path.dirname(this.stickyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stickyFile, JSON.stringify(this.sticky, null, 2));
    } catch (e) {}
  }

  /* ---------- parsers ---------- */

  parseHorizon(j) {
    function pick() {
      for (let i = 0; i < arguments.length; i++) {
        if (j[arguments[i]] != null && j[arguments[i]] !== '') return j[arguments[i]];
      }
      return null;
    }
    let ledger = Number(pick('core_latest_ledger', 'history_latest_ledger', 'ingest_latest_ledger'));
    if (!isFinite(ledger) || !ledger) {
      const keys = Object.keys(j);
      for (let i = 0; i < keys.length; i++) {
        if (/ledger/i.test(keys[i]) && typeof j[keys[i]] === 'number' && j[keys[i]] > 1000) {
          ledger = j[keys[i]];
          break;
        }
      }
    }
    if (!ledger) return null;

    let ledger_age = null;
    const closedAt = pick('history_latest_ledger_closed_at', 'core_latest_ledger_closed_at', 'closed_at');
    if (closedAt) {
      const ts = new Date(closedAt).getTime();
      if (isFinite(ts)) ledger_age = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    }
    const coreL = Number(pick('core_latest_ledger'));
    const ingestL = Number(pick('ingest_latest_ledger'));
    let ingest_lag = null;
    if (isFinite(coreL) && isFinite(ingestL)) ingest_lag = Math.max(0, coreL - ingestL);

    let sync = 'Horizon OK';
    let conf = 'low';
    if (ledger_age != null) {
      if (ledger_age <= 35) { sync = 'Horizon live'; conf = 'medium'; }
      else if (ledger_age <= 120) { sync = 'Horizon slow'; conf = 'medium'; }
      else if (ledger_age <= 300) { sync = 'Horizon behind'; conf = 'low'; }
      else { sync = 'Horizon catching up (~' + Math.round(ledger_age / 60) + 'm)'; conf = 'low'; }
    }
    if (ingest_lag != null && ingest_lag > 10) {
      sync = 'Horizon ingest lag · ' + ingest_lag;
      conf = 'low';
    }

    const network = pick('network_passphrase', 'network');
    let network_kind = null;
    if (network) {
      const n = String(network).toLowerCase();
      if (/test/i.test(n)) network_kind = 'testnet';
      else if (/public|main/i.test(n)) network_kind = 'mainnet';
      else network_kind = 'custom';
    }

    return {
      source: 'Horizon',
      sync: sync,
      sync_confidence: conf,
      core_verified: false,
      ledger: ledger,
      ledger_age: ledger_age,
      ingest_lag: ingest_lag,
      horizon_version: pick('horizon_version'),
      core_version: pick('core_version'),
      protocol: pick('current_protocol_version', 'core_supported_protocol_version'),
      network: network,
      network_kind: network_kind,
      confidence: conf
    };
  }

  parseCore(j) {
    const info = j.info || j;
    const o = { source: 'Core', core_verified: true, sync_confidence: 'high', confidence: 'high' };
    const stateRaw = info.state != null ? String(info.state)
      : (info.state_details != null ? String(info.state_details) : null);
    if (info.ledger) {
      if (info.ledger.num != null) o.ledger = Number(info.ledger.num);
      if (info.ledger.age != null) o.ledger_age = Number(info.ledger.age);
    }
    if (stateRaw) {
      o.core_state = stateRaw;
      if (/synced/i.test(stateRaw) && !/not\s*synced|unsynced/i.test(stateRaw)) o.sync = 'Synced';
      else if (/catching\s*up/i.test(stateRaw)) o.sync = 'Catching up';
      else o.sync = stateRaw.length > 48 ? stateRaw.slice(0, 48) : stateRaw;
    }
    return o;
  }

  isHorizonJson(j) {
    if (!j || typeof j !== 'object') return false;
    return j.core_latest_ledger != null || j.history_latest_ledger != null ||
      j.horizon_version != null || j.network_passphrase != null;
  }

  isCoreJson(j) {
    if (!j || typeof j !== 'object') return false;
    const info = j.info || j;
    return info.state != null || (info.ledger && info.ledger.num != null);
  }

  /* ---------- parallel fetchers ---------- */

  async fetchHorizonFast() {
    // 1) sticky only (fast path)
    if (this.sticky.horizonUrl) {
      try {
        const body = await this.httpGet(this.sticky.horizonUrl, 1800);
        const j = JSON.parse(body);
        const data = this.parseHorizon(j);
        if (data) {
          data.probe_url = this.sticky.horizonUrl;
          return { ok: true, data: data };
        }
      } catch (e) {
        this.sticky.horizonUrl = null;
      }
    }
    // 2) race all candidates
    const hit = await this.raceHttp(this.horizonUrlList(), 2200, this.isHorizonJson.bind(this));
    if (!hit) return { ok: false, error: 'Horizon unreachable' };
    const data = this.parseHorizon(hit.json);
    if (!data) return { ok: false, error: 'Horizon parse failed' };
    data.probe_url = hit.url;
    this.sticky.horizonUrl = hit.url;
    this.saveSticky();
    return { ok: true, data: data };
  }

  async fetchCoreFast() {
    if (this.sticky.coreUrl) {
      try {
        const body = await this.httpGet(this.sticky.coreUrl, 1800);
        const j = JSON.parse(body);
        if (this.isCoreJson(j)) {
          const data = this.parseCore(j);
          data.probe_url = this.sticky.coreUrl;
          // peers best-effort (do not block)
          this.fetchPeers(this.sticky.coreUrl).then(function (peers) {
            if (peers) Object.assign(data, peers);
          }).catch(function () {});
          const peers = await Promise.race([
            this.fetchPeers(this.sticky.coreUrl),
            sleep(600).then(function () { return null; })
          ]);
          if (peers) Object.assign(data, peers);
          return { ok: true, data: data };
        }
      } catch (e) {
        this.sticky.coreUrl = null;
      }
    }
    const hit = await this.raceHttp(this.coreUrlList(), 2000, this.isCoreJson.bind(this));
    if (!hit) return { ok: false, error: 'Core unreachable' };
    const data = this.parseCore(hit.json);
    data.probe_url = hit.url;
    this.sticky.coreUrl = hit.url;
    this.saveSticky();
    const peers = await Promise.race([
      this.fetchPeers(hit.url),
      sleep(700).then(function () { return null; })
    ]);
    if (peers) Object.assign(data, peers);
    return { ok: true, data: data };
  }

  async fetchPeers(infoUrl) {
    try {
      const url = String(infoUrl).replace(/\/info\/?$/, '/peers');
      const body = await this.httpGet(url, 1200);
      const pj = JSON.parse(body);
      if (!pj.authenticated_peers) return null;
      const inn = pj.authenticated_peers.inbound;
      const out = pj.authenticated_peers.outbound;
      return {
        peer_in: Array.isArray(inn) ? inn.length : (inn ? Object.keys(inn).length : 0),
        peer_out: Array.isArray(out) ? out.length : (out ? Object.keys(out).length : 0)
      };
    } catch (e) {
      return null;
    }
  }

  async probePortsFast() {
    const host = (this.sticky.portHost) || this.nodeHosts[0] || 'host.docker.internal';
    const map = {};
    let openCount = 0;
    const self = this;
    await Promise.all(this.nodePorts.map(async function (port) {
      let open = await self.tcpOpen(host, port, 700);
      if (!open) {
        // one alternate host only
        for (let i = 0; i < Math.min(3, self.nodeHosts.length); i++) {
          if (self.nodeHosts[i] === host) continue;
          open = await self.tcpOpen(self.nodeHosts[i], port, 500);
          if (open) {
            self.sticky.portHost = self.nodeHosts[i];
            break;
          }
        }
      } else {
        self.sticky.portHost = host;
      }
      map[String(port)] = open ? 'OPEN' : 'CLOSED';
      if (open) openCount++;
    }));
    this.saveSticky();
    return { ports: map, openCount: openCount };
  }

  readStateFallback() {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      const snap = parsed.lastTelemetry || parsed.telemetry || null;
      if (!snap || (snap.ledger == null && !snap.sync)) return null;
      return {
        source: 'State',
        sync: snap.sync || 'Unknown',
        ledger: snap.ledger,
        ledger_age: snap.ledger_age,
        core_verified: false,
        sync_confidence: 'low',
        confidence: 'low',
        peer_in: snap.peer_in,
        peer_out: snap.peer_out,
        ports: snap.ports,
        level: snap.level || 'soft'
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * MAIN — parallel Horizon + Core + Ports, then merge
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

    // Discover host/port (sticky), then OPTIMIZED Horizon root (single request)
    try {
      await this.discovery.discover(false);
      const d = this.discovery.discovered;
      if (d && d.horizonHost && d.horizonPort) {
        this.optReader.setEndpoint(d.horizonHost, d.horizonPort);
        if (d.horizonHost) this.sticky.portHost = d.horizonHost;
      }
    } catch (e) {}

    let hz = { ok: false };
    let core = { ok: false };
    let portSnap = { ports: {}, openCount: 0 };

    // PRIMARY: optimized Horizon root (+ optional ledger details)
    try {
      const data = await this.optReader.getStatus({ fresh: true, detailed: detailed });
      hz = { ok: true, data: data };
      if (data.probe_url) {
        this.sticky.horizonUrl = data.probe_url;
        this.saveSticky();
      }
    } catch (e) {
      hz = { ok: false, error: e.message };
      // fallback to race path
      try {
        const r = await this.fetchHorizonFast();
        hz = r.ok ? r : { ok: false, error: r.error || e.message };
      } catch (e2) {
        hz = { ok: false, error: e.message };
      }
    }

    // SECONDARY parallel: Core + Ports (do not block on Core)
    const pair = await Promise.all([
      this.fetchCoreFast().catch(function (e) { return { ok: false, error: e.message }; }),
      this.probePortsFast().catch(function () { return { ports: {}, openCount: 0 }; })
    ]);
    core = pair[0];
    portSnap = pair[1];

    let primary = null;
    let fallbackUsed = false;
    const sources_trace = [
      { source: 'horizon', status: hz.ok ? 'success' : 'failed', error: hz.error },
      { source: 'core', status: core.ok ? 'success' : 'failed', error: core.error }
    ];

    if (core.ok && hz.ok) {
      primary = Object.assign({}, hz.data, core.data);
      primary.source = 'Core+Horizon';
      primary.core_verified = true;
      primary.sync = core.data.sync || core.data.core_state || hz.data.sync;
      primary.sync_confidence = 'high';
      if (core.data.ledger != null) primary.ledger = core.data.ledger;
      if (core.data.ledger_age != null) primary.ledger_age = core.data.ledger_age;
      if (core.data.core_state) primary.core_state = core.data.core_state;
      // Cross-check: large ledger gap between Core and Horizon => lower confidence
      if (core.data.ledger != null && hz.data.ledger != null) {
        const gap = Math.abs(Number(core.data.ledger) - Number(hz.data.ledger));
        primary.ledger_gap = gap;
        if (gap > 50) {
          primary.sync_confidence = 'medium';
          primary.cross_check = 'ledger_gap_' + gap;
        }
      }
      // Core Catching up always wins over Horizon "live"
      if (core.data.sync && /catching|joining/i.test(String(core.data.sync))) {
        primary.sync = core.data.sync;
        primary.level_hint = 'soft';
      }
    } else if (core.ok) {
      primary = Object.assign({}, core.data);
      primary.core_verified = true;
    } else if (hz.ok) {
      primary = Object.assign({}, hz.data);
      primary.core_verified = false;
      primary.sync = (primary.sync || 'Horizon OK') + ' · Core n/a';
      primary.sync_confidence = 'low';
      fallbackUsed = true;
    } else {
      primary = this.readStateFallback();
      fallbackUsed = true;
      sources_trace.push({ source: 'state-file', status: primary ? 'success' : 'failed' });
      if (!primary) {
        primary = {
          source: 'none',
          sync: 'Unknown',
          ledger: null,
          core_verified: false,
          sync_confidence: 'low',
          confidence: 'low'
        };
      }
    }

    primary.ports = portSnap.ports || {};
    primary.ports_open = portSnap.openCount || 0;
    primary.ports_all_open = (portSnap.openCount || 0) >= 3;
    primary.sources_trace = sources_trace;
    primary.fallbackUsed = fallbackUsed;
    primary.ts = new Date().toISOString();
    primary.responseTime = Date.now() - t0;

    const syncStr = String(primary.sync || '');
    let level = 'ok';
    if ((portSnap.openCount || 0) === 0 && !hz.ok && !core.ok) level = 'critical';
    else if ((portSnap.openCount || 0) === 0) level = 'warning';
    else if (/not synced|unsynced|error|fail/i.test(syncStr)) level = 'warning';
    else if (/catching|joining|behind|slow|ingest lag/i.test(syncStr)) level = 'soft';
    else if (!primary.core_verified) level = 'soft';
    else level = 'ok';
    primary.level = level;

    this.metrics.requests++;
    this.metrics.lastMs = primary.responseTime;
    this.metrics.lastSource = primary.source;
    if (!hz.ok && !core.ok) this.metrics.failures++;

    if (this.discovery && this.discovery.discovered) {
      primary.discovery = {
        strategy: this.discovery.discovered.strategy,
        horizon: this.discovery.discovered.horizonHost
          ? (this.discovery.discovered.horizonHost + ':' + this.discovery.discovered.horizonPort)
          : null,
        core: this.discovery.discovered.coreOk
          ? (this.discovery.discovered.coreHost + ':' + this.discovery.discovered.corePort)
          : null,
        verified: !!this.discovery.discovered.verified
      };
      if (!primary.network_kind && this.discovery.discovered.network_kind) {
        primary.network_kind = this.discovery.discovered.network_kind;
      }
    }

    this.cache.data = primary;
    this.cache.at = Date.now();
    return primary;
  }

  getMetrics() {
    return Object.assign({}, this.metrics);
  }

  clearCache() {
    this.cache.data = null;
    this.cache.at = 0;
  }
}

function uniq(arr) {
  const s = {};
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null || s[v]) continue;
    s[v] = true;
    out.push(v);
  }
  return out;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback || {};
  }
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

module.exports = PiNodeStatusMonitor;
