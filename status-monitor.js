'use strict';

/**
 * Multi-source Pi Node status (SoloHost)
 * Priority: Horizon → Core HTTP/RPC → state file → ports
 * Network-agnostic (testnet / mainnet / any container name)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

class PiNodeStatusMonitor {
  constructor(options) {
    options = options || {};
    this.nodeHosts = options.nodeHosts || [
      options.nodeHost || process.env.NODE_HOST || 'host.docker.internal',
      'host.docker.internal',
      '172.17.0.1',
      '172.18.0.1',
      '10.0.2.2',
      'localhost'
    ];
    this.horizonPorts = options.horizonPorts || [
      options.horizonPort || parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401,
      31401,
      8000
    ];
    // dedupe
    this.horizonPorts = this.horizonPorts.filter(function (p, i, a) { return a.indexOf(p) === i; });
    // Stellar Core HTTP_PORT is often 11626; some setups use 11826 / 31400
    this.corePorts = options.corePorts || [
      parseInt(process.env.CORE_RPC_PORT || process.env.CORE_HTTP_PORT || '11626', 10) || 11626,
      11826,
      11626,
      31400,
      11625,
      11627
    ];
    this.nodePorts = options.nodePorts || [31401, 31402, 31403];
    this.stateDir = options.stateDir || process.env.DATA_DIR || '/data';
    this.stateFile = path.join(this.stateDir, 'state', 'node-state.json');
    this.cache = { data: null, timestamp: 0, ttl: options.cacheTTL || 5000 };
    this.metrics = { requests: 0, failures: 0, avgResponseTime: 0, lastSource: null };
    this.retryConfig = { maxRetries: 2, baseDelay: 120, maxDelay: 2000, backoffMultiplier: 2 };
  }

  async httpGet(url, timeout) {
    timeout = timeout || 4000;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error('HTTP timeout (' + timeout + 'ms): ' + url));
      }, timeout);
      const req = http.get(url, function (res) {
        clearTimeout(timer);
        let data = '';
        res.on('data', function (c) { data += c; });
        res.on('end', function () {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error('HTTP ' + res.statusCode + ': ' + url));
        });
      });
      req.on('error', function (err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async tryUrls(paths, timeout) {
    const hosts = this.nodeHosts;
    const self = this;
    for (let i = 0; i < hosts.length; i++) {
      for (let j = 0; j < paths.length; j++) {
        const url = 'http://' + hosts[i] + paths[j];
        try {
          const body = await self.httpGet(url, timeout);
          return { url: url, host: hosts[i], body: body };
        } catch (e) {}
      }
    }
    return null;
  }

  updateMetrics(source, responseTime, success) {
    this.metrics.requests++;
    if (!success) this.metrics.failures++;
    this.metrics.avgResponseTime = (this.metrics.avgResponseTime * 0.7) + (responseTime * 0.3);
    this.metrics.lastSource = source;
  }

  parseHorizonRoot(j) {
    function pick() {
      for (let i = 0; i < arguments.length; i++) {
        const k = arguments[i];
        if (j[k] != null && j[k] !== '') return j[k];
      }
      return null;
    }
    let ledger = Number(pick('core_latest_ledger', 'history_latest_ledger', 'ingest_latest_ledger'));
    if (!isFinite(ledger) || !ledger) {
      for (const k of Object.keys(j)) {
        if (/ledger/i.test(k) && typeof j[k] === 'number' && j[k] > 1000) {
          ledger = j[k];
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

    // Horizon-only labels — never claim Core "Synced"
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

  parseCoreInfo(j) {
    const info = j.info || j;
    const o = {
      source: 'Core',
      core_verified: true,
      sync_confidence: 'high',
      confidence: 'high'
    };
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

  async fetchFromHorizon() {
    const start = Date.now();
    const paths = [];
    for (let i = 0; i < this.horizonPorts.length; i++) paths.push(':' + this.horizonPorts[i] + '/');
    try {
      const hit = await this.tryUrls(paths, 4500);
      if (!hit) throw new Error('Horizon unreachable');
      const parsed = JSON.parse(hit.body);
      const data = this.parseHorizonRoot(parsed);
      if (!data) throw new Error('Horizon JSON missing ledger fields');
      data.probe_url = hit.url;
      const ms = Date.now() - start;
      this.updateMetrics('horizon', ms, true);
      return { source: 'horizon', status: 'success', responseTime: ms, data: data };
    } catch (err) {
      this.updateMetrics('horizon', 0, false);
      return { source: 'horizon', status: 'failed', error: err.message };
    }
  }

  async fetchFromCore() {
    const start = Date.now();
    const paths = [];
    for (let i = 0; i < this.corePorts.length; i++) {
      paths.push(':' + this.corePorts[i] + '/info');
    }
    try {
      const hit = await this.tryUrls(paths, 3500);
      if (!hit) throw new Error('Core HTTP unreachable');
      const parsed = JSON.parse(hit.body);
      const data = this.parseCoreInfo(parsed);
      data.probe_url = hit.url;
      // peers optional
      try {
        const peersUrl = hit.url.replace(/\/info$/, '/peers');
        const pb = await this.httpGet(peersUrl, 2000);
        const pj = JSON.parse(pb);
        if (pj.authenticated_peers) {
          const inn = pj.authenticated_peers.inbound;
          const out = pj.authenticated_peers.outbound;
          data.peer_in = Array.isArray(inn) ? inn.length : (inn ? Object.keys(inn).length : 0);
          data.peer_out = Array.isArray(out) ? out.length : (out ? Object.keys(out).length : 0);
        }
      } catch (e) {}
      const ms = Date.now() - start;
      this.updateMetrics('core', ms, true);
      return { source: 'core', status: 'success', responseTime: ms, data: data };
    } catch (err) {
      this.updateMetrics('core', 0, false);
      return { source: 'core', status: 'failed', error: err.message };
    }
  }

  async fetchFromStateFile() {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      const snap = parsed.lastTelemetry || parsed.telemetry || parsed;
      if (!snap || (snap.ledger == null && !snap.sync)) {
        return { source: 'state-file', status: 'failed', error: 'empty state' };
      }
      return {
        source: 'state-file',
        status: 'success',
        cached: true,
        data: {
          source: 'State',
          sync: snap.sync || 'Unknown',
          ledger: snap.ledger != null ? snap.ledger : snap.lastLedger,
          ledger_age: snap.ledger_age,
          core_verified: !!snap.core_verified,
          sync_confidence: 'low',
          confidence: 'low',
          peer_in: snap.peer_in,
          peer_out: snap.peer_out,
          ports: snap.ports
        }
      };
    } catch (err) {
      return { source: 'state-file', status: 'failed', error: err.message };
    }
  }

  async probePorts() {
    const net = require('net');
    const hosts = this.nodeHosts.slice(0, 3);
    const ports = this.nodePorts;
    const map = {};
    let openCount = 0;
    for (let pi = 0; pi < ports.length; pi++) {
      const port = ports[pi];
      let open = false;
      for (let hi = 0; hi < hosts.length && !open; hi++) {
        open = await new Promise(function (resolve) {
          const s = net.connect({ host: hosts[hi], port: port }, function () {
            s.destroy();
            resolve(true);
          });
          s.setTimeout(1200, function () { s.destroy(); resolve(false); });
          s.on('error', function () { resolve(false); });
        });
      }
      map[String(port)] = open ? 'OPEN' : 'CLOSED';
      if (open) openCount++;
    }
    return { ports: map, openCount: openCount };
  }

  async retryFetch(fetchFn, attempt) {
    attempt = attempt || 0;
    const res = await fetchFn.call(this);
    if (res.status === 'success') return res;
    if (attempt < this.retryConfig.maxRetries) {
      const delay = Math.min(
        this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt),
        this.retryConfig.maxDelay
      );
      await new Promise(function (r) { setTimeout(r, delay); });
      return this.retryFetch(fetchFn, attempt + 1);
    }
    return res;
  }

  /**
   * Main entry — returns normalized telemetry-shaped object
   */
  async getStatus(forceFresh) {
    if (!forceFresh && this.cache.data && Date.now() - this.cache.timestamp < this.cache.ttl) {
      const c = Object.assign({}, this.cache.data);
      c.fromCache = true;
      return c;
    }

    const sources = [];
    const portSnap = await this.probePorts();

    let horizonResult = await this.retryFetch(this.fetchFromHorizon);
    sources.push({ source: horizonResult.source, status: horizonResult.status, error: horizonResult.error });

    let coreResult = await this.retryFetch(this.fetchFromCore);
    sources.push({ source: coreResult.source, status: coreResult.status, error: coreResult.error });

    let primary = null;
    let fallbackUsed = false;

    if (coreResult.status === 'success' && horizonResult.status === 'success') {
      primary = Object.assign({}, horizonResult.data, coreResult.data);
      primary.source = 'Core+Horizon';
      primary.core_verified = true;
      primary.sync = coreResult.data.sync || coreResult.data.core_state || horizonResult.data.sync;
      primary.sync_confidence = 'high';
      if (coreResult.data.ledger != null) primary.ledger = coreResult.data.ledger;
      if (coreResult.data.ledger_age != null) primary.ledger_age = coreResult.data.ledger_age;
      if (coreResult.data.core_state) primary.core_state = coreResult.data.core_state;
    } else if (coreResult.status === 'success') {
      primary = Object.assign({}, coreResult.data);
      primary.core_verified = true;
    } else if (horizonResult.status === 'success') {
      primary = Object.assign({}, horizonResult.data);
      primary.core_verified = false;
      primary.sync = (primary.sync || 'Horizon OK') + ' · Core n/a';
      primary.sync_confidence = 'low';
      fallbackUsed = true;
    } else {
      const stateResult = await this.fetchFromStateFile();
      sources.push({ source: stateResult.source, status: stateResult.status, error: stateResult.error });
      if (stateResult.status === 'success') {
        primary = Object.assign({}, stateResult.data);
        primary.core_verified = false;
        fallbackUsed = true;
      }
    }

    if (!primary) {
      primary = {
        source: 'none',
        sync: 'Unknown',
        ledger: null,
        core_verified: false,
        sync_confidence: 'low',
        confidence: 'low'
      };
      fallbackUsed = true;
    }

    primary.ports = portSnap.ports;
    primary.ports_open = portSnap.openCount;
    primary.ports_all_open = portSnap.openCount >= 3;
    primary.sources_trace = sources;
    primary.fallbackUsed = fallbackUsed;
    primary.ts = new Date().toISOString();

    // Health level (Core-first; Horizon-only = soft)
    const syncStr = String(primary.sync || '');
    const portsAllClosed = portSnap.openCount === 0;
    let level = 'ok';
    if (portsAllClosed) level = 'critical';
    else if (/not synced|unsynced|error|fail/i.test(syncStr)) level = 'warning';
    else if (/catching|joining|behind|slow|ingest lag/i.test(syncStr)) level = 'soft';
    else if (!primary.core_verified) level = 'soft';
    else level = 'ok';
    primary.level = level;

    this.cache.data = primary;
    this.cache.timestamp = Date.now();
    return primary;
  }

  getMetrics() {
    const r = this.metrics.requests || 1;
    return Object.assign({}, this.metrics, {
      successRate: (((r - this.metrics.failures) / r) * 100).toFixed(2) + '%'
    });
  }

  clearCache() {
    this.cache.data = null;
    this.cache.timestamp = 0;
  }
}

module.exports = PiNodeStatusMonitor;
