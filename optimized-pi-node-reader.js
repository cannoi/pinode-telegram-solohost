'use strict';

/**
 * Optimized Pi Node reader — Horizon root first (real-data approach)
 * Single GET host:port/ exposes almost all status fields.
 * Optional /ledgers?limit=1&order=desc for precise age/tx stats.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

class OptimizedPiNodeReader {
  constructor(options) {
    options = options || {};
    this.config = {
      horizonHost: options.horizonHost || process.env.NODE_HOST || 'host.docker.internal',
      horizonPort: options.horizonPort || parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401,
      stateDir: options.stateDir || process.env.DATA_DIR || '/data',
      timeouts: { quick: 2000, standard: 4500 }
    };
    this.cache = {
      status: { data: null, time: 0, ttl: 5000 },
      ledgerInfo: { data: null, time: 0, ttl: 10000 }
    };
    this.stats = { requests: 0, cacheHits: 0, errors: 0, avgResponseTime: 0 };
  }

  setEndpoint(host, port) {
    if (host) this.config.horizonHost = host;
    if (port) this.config.horizonPort = port;
  }

  httpGet(url, timeout) {
    timeout = timeout || 4500;
    return new Promise(function (resolve, reject) {
      const req = http.get(url, { timeout: timeout }, function (res) {
        let data = '';
        res.on('data', function (c) { data += c; });
        res.on('end', function () {
          if (res.statusCode === 200) resolve(data);
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

  /**
   * Full field extract from Horizon root JSON
   */
  parseHorizonRoot(parsed) {
    const coreL = num(parsed.core_latest_ledger);
    const histL = num(parsed.history_latest_ledger);
    const ingestL = num(parsed.ingest_latest_ledger);
    const elderL = num(parsed.history_elder_ledger);
    const closedAt = parsed.history_latest_ledger_closed_at ||
      parsed.core_latest_ledger_closed_at || null;

    let ledger_age = null;
    if (closedAt) {
      const ts = new Date(closedAt).getTime();
      if (isFinite(ts)) ledger_age = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    }

    let ingest_lag = null;
    if (coreL != null && ingestL != null) ingest_lag = Math.max(0, coreL - ingestL);

    // Prefer history/core ledger for display
    const ledger = histL != null ? histL : (coreL != null ? coreL : ingestL);

    let sync = 'Horizon OK';
    let conf = 'medium';
    if (ledger_age != null) {
      if (ledger_age <= 35) { sync = 'Horizon live'; conf = 'high'; }
      else if (ledger_age <= 120) { sync = 'Horizon slow'; conf = 'medium'; }
      else if (ledger_age <= 300) { sync = 'Horizon behind'; conf = 'low'; }
      else { sync = 'Horizon catching up (~' + Math.round(ledger_age / 60) + 'm)'; conf = 'low'; }
    }
    if (ingest_lag != null && ingest_lag > 10) {
      sync = 'Horizon ingest lag · ' + ingest_lag;
      conf = 'low';
    }

    const network = parsed.network_passphrase || null;
    let network_kind = null;
    if (network) {
      const n = String(network).toLowerCase();
      if (/test/.test(n)) network_kind = 'testnet';
      else if (/public|main/.test(n)) network_kind = 'mainnet';
      else network_kind = 'custom';
    }

    return {
      source: 'Horizon',
      probe: 'horizon-root',
      sync: sync,
      sync_confidence: conf,
      confidence: conf,
      core_verified: false,
      ledger: ledger,
      core_ledger: coreL,
      history_ledger: histL,
      ingest_ledger: ingestL,
      elder_ledger: elderL,
      ledger_closed_at: closedAt,
      ledger_age: ledger_age,
      ingest_lag: ingest_lag,
      horizon_version: parsed.horizon_version || null,
      core_version: parsed.core_version || null,
      protocol: parsed.current_protocol_version != null
        ? parsed.current_protocol_version
        : (parsed.core_supported_protocol_version != null
          ? parsed.core_supported_protocol_version : null),
      protocol_core: parsed.core_supported_protocol_version != null
        ? parsed.core_supported_protocol_version : null,
      network: network,
      network_kind: network_kind,
      // keep raw useful extras for AI
      horizon_raw_keys: Object.keys(parsed).filter(function (k) { return k.charAt(0) !== '_'; })
    };
  }

  async fetchHorizonRoot() {
    const url = 'http://' + this.config.horizonHost + ':' + this.config.horizonPort + '/';
    const t0 = Date.now();
    const body = await this.httpGet(url, this.config.timeouts.standard);
    const parsed = JSON.parse(body);
    const data = this.parseHorizonRoot(parsed);
    if (!data.ledger) throw new Error('Horizon root missing ledger fields');
    data.probe_url = url;
    data.responseTime = Date.now() - t0;
    return data;
  }

  async fetchLedgerDetails() {
    if (this.cache.ledgerInfo.data &&
        Date.now() - this.cache.ledgerInfo.time < this.cache.ledgerInfo.ttl) {
      return this.cache.ledgerInfo.data;
    }
    const url = 'http://' + this.config.horizonHost + ':' + this.config.horizonPort +
      '/ledgers?limit=1&order=desc';
    try {
      const body = await this.httpGet(url, this.config.timeouts.standard);
      const parsed = JSON.parse(body);
      const record = parsed._embedded && parsed._embedded.records && parsed._embedded.records[0];
      if (!record) return null;
      const closedAt = record.closed_at;
      const age = closedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(closedAt).getTime()) / 1000))
        : null;
      const data = {
        ledger: num(record.sequence),
        closed_at: closedAt,
        ledger_age: age,
        tx_count: num(record.successful_transaction_count),
        failed_tx_count: num(record.failed_transaction_count),
        operation_count: num(record.operation_count),
        protocol_version: num(record.protocol_version),
        base_fee: num(record.base_fee_in_stroops),
        base_reserve: num(record.base_reserve_in_stroops),
        max_tx_set_size: num(record.max_tx_set_size)
      };
      this.cache.ledgerInfo.data = data;
      this.cache.ledgerInfo.time = Date.now();
      return data;
    } catch (e) {
      return null;
    }
  }

  /**
   * @param {object} options fresh|detailed
   */
  async getStatus(options) {
    options = options || {};
    const fresh = !!options.fresh;
    const detailed = !!options.detailed;
    this.stats.requests++;

    if (!fresh && this.cache.status.data &&
        Date.now() - this.cache.status.time < this.cache.status.ttl) {
      this.stats.cacheHits++;
      const c = Object.assign({}, this.cache.status.data);
      c.fromCache = true;
      return c;
    }

    const t0 = Date.now();
    try {
      const data = await this.fetchHorizonRoot();
      if (detailed) {
        const det = await this.fetchLedgerDetails();
        if (det) {
          data.ledger_detail = det;
          if (det.ledger_age != null) data.ledger_age = det.ledger_age;
          if (det.ledger != null && data.ledger == null) data.ledger = det.ledger;
          data.tx_count = det.tx_count;
          data.operation_count = det.operation_count;
          data.base_fee = det.base_fee;
          data.base_reserve = det.base_reserve;
          if (det.protocol_version != null) data.protocol = det.protocol_version;
        }
      }

      // level from horizon age
      let level = 'ok';
      if (data.ledger_age != null && data.ledger_age > 300) level = 'warning';
      else if (data.ingest_lag != null && data.ingest_lag > 50) level = 'soft';
      else if (data.ledger_age != null && data.ledger_age > 120) level = 'soft';
      data.level = level;
      data.ts = new Date().toISOString();
      data.responseTime = Date.now() - t0;

      this.cache.status.data = data;
      this.cache.status.time = Date.now();
      this._updateStats(data.responseTime, true);
      return data;
    } catch (err) {
      this.stats.errors++;
      this._updateStats(Date.now() - t0, false);
      // state fallback
      try {
        const sf = path.join(this.config.stateDir, 'state', 'node-state.json');
        const raw = JSON.parse(fs.readFileSync(sf, 'utf8'));
        const snap = raw.lastTelemetry || null;
        if (snap) {
          snap.source = 'State';
          snap.fromCache = true;
          snap.level = snap.level || 'soft';
          return snap;
        }
      } catch (e) {}
      throw err;
    }
  }

  _updateStats(ms, ok) {
    this.stats.avgResponseTime = this.stats.avgResponseTime * 0.8 + ms * 0.2;
  }

  getStats() {
    const r = this.stats.requests || 1;
    return {
      totalRequests: this.stats.requests,
      cacheHits: this.stats.cacheHits,
      cacheHitRate: ((this.stats.cacheHits / r) * 100).toFixed(1) + '%',
      errors: this.stats.errors,
      avgResponseTime: Math.round(this.stats.avgResponseTime) + 'ms'
    };
  }

  clearCache() {
    this.cache.status.data = null;
    this.cache.ledgerInfo.data = null;
  }
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

module.exports = OptimizedPiNodeReader;
