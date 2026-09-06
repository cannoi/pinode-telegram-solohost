'use strict';

/**
 * OPTIMIZED HTTP Reader - Fixed for accurate Pi Node status without docker.sock
 * 
 * KEY IMPROVEMENTS:
 * 1. Core HTTP /info is PRIMARY (never falls back unless Core truly unreachable)
 * 2. Sticky discovery: remembers working Core/Horizon endpoints between cycles
 * 3. Parallel + race-first discovery (faster endpoint location)
 * 4. Sync status inference when Core unavailable (with confidence marking)
 * 5. Ledger drift detection and alerting
 * 6. Explicit source attribution (sync=verified vs sync=inferred)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

class OptimizedHttpReader {
  constructor(options) {
    options = options || {};
    this.config = {
      nodeHosts: [
        options.nodeHost || process.env.NODE_HOST || 'host.docker.internal',
        'host.docker.internal',
        '172.17.0.1',
        '172.18.0.1',
        'localhost',
        '127.0.0.1'
      ],
      horizonPorts: [
        parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401,
        31401, 8000, 31400
      ],
      corePorts: [
        parseInt(process.env.CORE_HTTP_PORT || '11626', 10) || 11626,
        11626, 11826, 31400, 11625
      ],
      stateDir: options.stateDir || process.env.DATA_DIR || '/data',
      timeouts: { core: 2000, horizon: 4500 }
    };

    this.cache = {
      status: { data: null, time: 0, ttl: 5000 },
      ledger: { data: null, time: 0, ttl: 10000 },
      discovery: { core: null, horizon: null }
    };

    this.sticky = this.loadSticky();
    this.stats = {
      requests: 0,
      coreHits: 0,
      horizonFallbacks: 0,
      inferredSync: 0,
      errors: 0
    };
  }

  // ============ STICKY DISCOVERY ============

  loadSticky() {
    try {
      const f = path.join(this.config.stateDir, 'state', 'discovery.json');
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      return { coreHost: null, corePort: null, horizonHost: null, horizonPort: null };
    }
  }

  saveSticky(discovery) {
    try {
      const d = path.dirname(path.join(this.config.stateDir, 'state', 'discovery.json'));
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      const entry = {
        strategy: 'adaptive',
        coreHost: discovery.coreHost,
        corePort: discovery.corePort,
        horizonHost: discovery.horizonHost,
        horizonPort: discovery.horizonPort,
        at: Date.now(),
        verified: discovery.coreOk || discovery.horizonOk
      };
      fs.writeFileSync(
        path.join(this.config.stateDir, 'state', 'discovery.json'),
        JSON.stringify(entry, null, 2)
      );
    } catch (e) {
      // Silent fail
    }
  }

  // ============ HTTP UTILITIES ============

  httpGet(url, timeoutMs) {
    timeoutMs = timeoutMs || 4500;
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('JSON parse error'));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch (e) {}
        reject(new Error('timeout'));
      });
    });
  }

  httpGetText(url, timeoutMs) {
    timeoutMs = timeoutMs || 2500;
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 200) resolve(data);
          else reject(new Error('HTTP ' + res.statusCode));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} reject(new Error('timeout')); });
    });
  }

  // ============ CORE HTTP PROBE (PRIMARY) ============

  /**
   * Core /info is the source of truth for:
   * - Actual ledger number (not ingest/history)
   * - Sync state (synced/catching/not-synced)
   * - Ledger age (time since close)
   * - Peer counts
   */
  async probeCoreHttp() {
    const start = Date.now();

    // Phase 1: Try sticky host first (fast path)
    if (this.sticky.coreHost && this.sticky.corePort) {
      try {
        const result = await this.httpGet(
          `http://${this.sticky.coreHost}:${this.sticky.corePort}/info`,
          this.config.timeouts.core
        );
        if (result && result.info) {
          this.stats.coreHits++;
          return this.parseCoreInfo(
            result,
            this.sticky.coreHost,
            this.sticky.corePort,
            Date.now() - start
          );
        }
      } catch (e) {
        // Sticky host failed, continue to discovery
      }
    }

    // Phase 2: Parallel discovery (race-first)
    const candidates = [];
    for (const host of this.config.nodeHosts) {
      for (const port of this.config.corePorts) {
        candidates.push({ host, port });
      }
    }

    // Try in batches of 6 (parallelism limit)
    for (let i = 0; i < candidates.length; i += 6) {
      const batch = candidates.slice(i, i + 6);
      try {
        const found = await this.raceFirst(
          batch.map((c) =>
            this.httpGet(`http://${c.host}:${c.port}/info`, this.config.timeouts.core).then(
              (result) => {
                if (result && result.info) {
                  this.sticky.coreHost = c.host;
                  this.sticky.corePort = c.port;
                  this.stats.coreHits++;
                  return this.parseCoreInfo(result, c.host, c.port, Date.now() - start);
                }
                return null;
              }
            ).catch(() => null)
          )
        );
        if (found) {
          this.saveSticky(this.sticky);
          return found;
        }
      } catch (e) {
        // Continue to next batch
      }
    }

    // Phase 3: Core exhausted, return failure signal
    this.stats.errors++;
    return { ok: false, reason: 'Core unreachable on all hosts/ports' };
  }

  parseCoreInfo(result, host, port, latency) {
    const info = result.info || result;
    if (!info || (info.state == null && !(info.ledger && info.ledger.num != null))) {
      return { ok: false, reason: 'Invalid Core /info' };
    }

    const ledger = info.ledger && info.ledger.num != null ? Number(info.ledger.num) : null;
    if (ledger == null) {
      return { ok: false, reason: 'Core missing ledger number' };
    }

    const ledgerAge = info.ledger && info.ledger.age != null ? Number(info.ledger.age) : null;
    const state = String(info.state || '').toLowerCase();

    // Actual state machine from Core
    let sync = 'Unknown';
    let syncConfidence = 'low';
    if (/synced|catching/i.test(state)) {
      sync = /synced/i.test(state) && !/not.?synced/i.test(state) ? 'Synced' : 'Catching up';
      syncConfidence = /synced/i.test(state) ? 'high' : 'medium';
    } else if (state) {
      sync = state.charAt(0).toUpperCase() + state.slice(1);
      syncConfidence = 'medium';
    }

    const result_obj = {
      ok: true,
      source: 'Core',
      probe: 'core-http',
      core_verified: true,
      sync_verified: true,
      sync: sync,
      sync_confidence: syncConfidence,
      core_host: host,
      core_port: port,
      core_state: state,
      ledger: ledger,
      ledger_age: ledgerAge,
      latency: Math.round(latency)
    };

    // Optional peers
    if (info.peers) {
      const peers = info.peers;
      result_obj.peer_in = peers.inbound != null ? Number(peers.inbound) : null;
      result_obj.peer_out = peers.outbound != null ? Number(peers.outbound) : null;
    }

    return result_obj;
  }

  // ============ HORIZON HTTP PROBE (FALLBACK) ============

  async probeHorizonRoot() {
    const start = Date.now();

    // Phase 1: Sticky Horizon
    if (this.sticky.horizonHost && this.sticky.horizonPort) {
      try {
        const result = await this.httpGet(
          `http://${this.sticky.horizonHost}:${this.sticky.horizonPort}/`,
          this.config.timeouts.horizon
        );
        if (result && (result.core_latest_ledger != null || result.history_latest_ledger != null)) {
          const parsed = this.parseHorizonRoot(result, this.sticky.horizonHost, this.sticky.horizonPort, Date.now() - start);
          return this.enrichHorizon(this.sticky.horizonHost, this.sticky.horizonPort, parsed);
        }
      } catch (e) {
        // Continue to discovery
      }
    }

    // Phase 2: Parallel discovery
    const candidates = [];
    for (const host of this.config.nodeHosts) {
      for (const port of this.config.horizonPorts) {
        candidates.push({ host, port });
      }
    }

    for (let i = 0; i < candidates.length; i += 6) {
      const batch = candidates.slice(i, i + 6);
      try {
        const found = await this.raceFirst(
          batch.map((c) =>
            this.httpGet(`http://${c.host}:${c.port}/`, this.config.timeouts.horizon).then(
              (result) => {
                if (result && (result.core_latest_ledger != null || result.history_latest_ledger != null)) {
                  this.sticky.horizonHost = c.host;
                  this.sticky.horizonPort = c.port;
                  const parsed = this.parseHorizonRoot(result, c.host, c.port, Date.now() - start);
                  return this.enrichHorizon(c.host, c.port, parsed);
                }
                return null;
              }
            ).catch(() => null)
          )
        );
        if (found) {
          this.saveSticky(this.sticky);
          return found;
        }
      } catch (e) {
        // Continue
      }
    }

    return { ok: false, reason: 'Horizon unreachable' };
  }

  parseHorizonRoot(data, host, port, latency) {
    const coreL = this.num(data.core_latest_ledger);
    const histL = this.num(data.history_latest_ledger);
    const ingestL = this.num(data.ingest_latest_ledger);

    const ledger = coreL != null ? coreL : (histL != null ? histL : ingestL);
    if (ledger == null) {
      return { ok: false, reason: 'Horizon missing ledger fields' };
    }

    const closedAt = data.history_latest_ledger_closed_at || data.core_latest_ledger_closed_at;
    let ledgerAge = null;
    if (closedAt) {
      const ts = new Date(closedAt).getTime();
      if (isFinite(ts)) {
        ledgerAge = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      }
    }

    // Ingest lag signal (Core ahead of Horizon ingest)
    let ingestLag = null;
    if (coreL != null && ingestL != null) {
      ingestLag = Math.max(0, coreL - ingestL);
    }

    // Official Pi node-status rule (no docker.sock):
    // Synced when core and ingest are within 5 ledgers.
    let syncInferred = 'Unknown';
    let syncConfidence = 'low';
    let syncBasis = 'unknown';
    if (coreL === 0 && ingestL === 0) {
      syncInferred = 'Catching Up';
      syncConfidence = 'medium';
      syncBasis = 'horizon-bootstrap';
    } else if (coreL != null && ingestL != null) {
      if (ingestLag != null && ingestLag <= 5) {
        syncInferred = 'Synced';
        syncConfidence = 'high';
        syncBasis = 'horizon-core-vs-ingest';
      } else {
        syncInferred = 'Syncing';
        syncConfidence = 'medium';
        syncBasis = 'horizon-core-vs-ingest';
      }
    } else if (ledgerAge != null) {
      if (ledgerAge <= 35) { syncInferred = 'Likely Synced'; syncConfidence = 'medium'; }
      else if (ledgerAge <= 300) { syncInferred = 'Behind'; syncConfidence = 'low'; }
      else { syncInferred = 'Stalled/Offline'; syncConfidence = 'low'; }
      syncBasis = 'age-inferred';
    }

    return {
      ok: true,
      source: 'Horizon',
      probe: 'horizon-root',
      core_verified: false,
      sync_verified: syncBasis === 'horizon-core-vs-ingest' && ingestLag != null && ingestLag <= 5,
      sync: syncInferred,
      sync_basis: syncBasis,
      sync_confidence: syncConfidence,
      horizon_host: host,
      horizon_port: port,
      ledger: ledger,
      core_ledger: coreL,
      history_ledger: histL,
      ingest_ledger: ingestL,
      ledger_age: ledgerAge,
      ingest_lag: ingestLag,
      latency: Math.round(latency),
      network: data.network_passphrase || null,
      horizon_version: data.horizon_version || null,
      core_version: data.core_version || null,
      protocol: data.current_protocol_version != null ? data.current_protocol_version : null
    };
  }


  async enrichHorizon(host, port, parsed) {
    if (!parsed || !parsed.ok) return parsed;
    try {
      const led = await this.httpGet('http://' + host + ':' + port + '/ledgers?order=desc&limit=1', 2500);
      const rec = led && led._embedded && led._embedded.records && led._embedded.records[0];
      if (rec) {
        if (rec.closed_at && parsed.ledger_age == null) {
          const ts = new Date(rec.closed_at).getTime();
          if (isFinite(ts)) parsed.ledger_age = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        }
        if (rec.sequence != null && parsed.history_ledger == null) parsed.history_ledger = Number(rec.sequence);
        parsed.tx_count = rec.successful_transaction_count != null ? Number(rec.successful_transaction_count) : null;
      }
    } catch (e) {}
    try {
      let met = null;
      try { met = await this.httpGet('http://' + host + ':' + port + '/metrics', 2000); } catch (e1) { met = null; }
      if (met && typeof met === 'object' && !Buffer.isBuffer(met)) {
        const coreM = met['stellar_core.latest_ledger'] || met['horizon.stellar_core.latest_ledger'] || met['horizon.stellar_core.latest_ledger'];
        const histM = met['history.latest_ledger'] || met['horizon.history.latest_ledger'];
        const cv = coreM && (coreM.value != null ? coreM.value : coreM);
        const hv = histM && (histM.value != null ? histM.value : histM);
        if (parsed.core_ledger == null && cv != null) parsed.core_ledger = Number(cv);
        if (parsed.history_ledger == null && hv != null) parsed.history_ledger = Number(hv);
      } else {
        const raw = await this.httpGetText('http://' + host + ':' + port + '/metrics', 2000);
        const pick = function (name) {
          const re = new RegExp('^' + name.replace(/\./g, '\\.') + '(?:\\s|\\{)[^\\n]*?\\s([0-9.]+)$', 'm');
          const m = raw.match(re) || raw.match(new RegExp(name.replace(/\./g,'\\.') + '\\s+([0-9.]+)'));
          return m ? Number(m[1]) : null;
        };
        const cv = pick('horizon_stellar_core_latest_ledger') || pick('stellar_core_latest_ledger');
        const hv = pick('horizon_history_latest_ledger') || pick('history_latest_ledger');
        if (parsed.core_ledger == null && cv != null) parsed.core_ledger = cv;
        if (parsed.history_ledger == null && hv != null) parsed.history_ledger = hv;
      }
      if (parsed.core_ledger != null && parsed.history_ledger != null) {
        parsed.ingest_lag = Math.max(0, Number(parsed.core_ledger) - Number(parsed.history_ledger));
      } else if (parsed.core_ledger != null && parsed.ingest_ledger != null) {
        parsed.ingest_lag = Math.max(0, Number(parsed.core_ledger) - Number(parsed.ingest_ledger));
      }
      if (parsed.core_ledger != null && parsed.ledger == null) parsed.ledger = parsed.core_ledger;
    } catch (e) {}
    return parsed;
  }

  // ============ LEDGER DRIFT DETECTION ============

  validateLedgerConsistency(core, horizon) {
    if (!core || !core.ledger || !horizon || !horizon.ledger) {
      return { ok: true, drift: null, issue: null };
    }

    const drift = Math.abs(core.ledger - horizon.ledger);
    if (drift > 500) {
      return { ok: false, drift: drift, issue: 'MAJOR_DRIFT', action: 'use_core_only' };
    } else if (drift > 100) {
      return { ok: true, drift: drift, issue: 'NORMAL_DRIFT', action: 'monitor' };
    } else {
      return { ok: true, drift: drift, issue: null, action: null };
    }
  }

  // ============ MAIN STATUS COLLECTION ============

  async getStatus(options) {
    options = options || {};
    const fresh = !!options.fresh;
    this.stats.requests++;

    if (!fresh && this.cache.status.data && Date.now() - this.cache.status.time < this.cache.status.ttl) {
      const c = Object.assign({}, this.cache.status.data);
      c.fromCache = true;
      return c;
    }

    const t0 = Date.now();

    // Parallel probes
    const [coreResult, horizonResult] = await Promise.all([this.probeCoreHttp(), this.probeHorizonRoot()]);

    const status = {
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - t0,
      sources: {
        core: coreResult.ok,
        horizon: horizonResult.ok
      }
    };

    // ============ SOURCE PRIORITY: CORE FIRST ============

    if (coreResult.ok) {
      // Core is available: use it for everything
      Object.assign(status, {
        source: 'Core',
        sync: coreResult.sync,
        sync_verified: true,
        sync_confidence: coreResult.sync_confidence,
        core_verified: true,
        ledger: coreResult.ledger,
        ledger_age: coreResult.ledger_age,
        core_state: coreResult.core_state,
        core_host: coreResult.core_host,
        core_port: coreResult.core_port
      });

      if (coreResult.peer_in != null) status.peer_in = coreResult.peer_in;
      if (coreResult.peer_out != null) status.peer_out = coreResult.peer_out;

      // Supplement with Horizon if available
      if (horizonResult.ok) {
        status.source = 'Core+Horizon';
        if (horizonResult.protocol != null && !status.protocol) status.protocol = horizonResult.protocol;
        if (horizonResult.horizon_version && !status.horizon_version) status.horizon_version = horizonResult.horizon_version;

        // Check ledger consistency
        const drift = this.validateLedgerConsistency(coreResult, horizonResult);
        if (!drift.ok) {
          status.ledger_drift = drift;
          status.ledger_drift_action = 'core_data_used';
        }
      }
    } else if (horizonResult.ok) {
      // Core unavailable: fall back to Horizon (with warnings)
      this.stats.horizonFallbacks++;
      this.stats.inferredSync++;

      Object.assign(status, {
        source: 'Horizon',
        sync: horizonResult.sync,
        sync_verified: false,
        sync_basis: 'age_inferred',
        sync_confidence: horizonResult.sync_confidence,
        core_verified: false,
        ledger: horizonResult.ledger,
        ledger_age: horizonResult.ledger_age,
        core_ledger: horizonResult.core_ledger,
        history_ledger: horizonResult.history_ledger,
        ingest_ledger: horizonResult.ingest_ledger,
        ingest_lag: horizonResult.ingest_lag,
        core_version: horizonResult.core_version,
        horizon_version: horizonResult.horizon_version,
        protocol: horizonResult.protocol,
        network: horizonResult.network,
        tx_count: horizonResult.tx_count,
        core_unreachable: true,
        warning: 'CORE_HTTP_UNAVAILABLE'
      });
    } else {
      // Both failed: try state file fallback
      const stateData = this.readStateFile();
      if (stateData.ok) {
        Object.assign(status, stateData.data);
        status.source = 'State (Cache)';
        status.fromCache = true;
        status.warning = 'ALL_PROBES_FAILED';
      } else {
        status.source = 'None';
        status.ok = false;
        status.error = 'All data sources unavailable';
        this.stats.errors++;
        return status;
      }
    }

    status.stats = {
      coreHits: this.stats.coreHits,
      horizonFallbacks: this.stats.horizonFallbacks,
      inferredSync: this.stats.inferredSync,
      errors: this.stats.errors
    };

    this.cache.status.data = status;
    this.cache.status.time = Date.now();
    return status;
  }

  // ============ STATE FILE FALLBACK ============

  readStateFile() {
    try {
      const f = path.join(this.config.stateDir, 'state', 'node-state.json');
      if (!fs.existsSync(f)) return { ok: false };

      const state = JSON.parse(fs.readFileSync(f, 'utf8'));
      const tel = state.lastTelemetry || null;

      if (!tel) return { ok: false };

      const age = tel.ts ? Date.now() - new Date(tel.ts).getTime() : null;
      const maxAge = 120000; // 2 minutes

      if (age != null && age > maxAge) {
        return { ok: false, reason: 'state_too_old' };
      }

      return {
        ok: true,
        data: {
          sync: tel.sync || 'Unknown',
          ledger: tel.ledger,
          core_verified: tel.core_verified,
          fromStateFile: true,
          stateAge: age
        }
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ============ UTILITIES ============

  num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  raceFirst(promises) {
    return Promise.race(
      promises.map((p) => Promise.resolve(p).then((result) => (result ? Promise.resolve(result) : Promise.reject())))
    ).catch(() => null);
  }

  getStats() {
    return Object.assign({}, this.stats);
  }

  clearCache() {
    this.cache.status.data = null;
    this.cache.ledger.data = null;
  }
}

module.exports = OptimizedHttpReader;
