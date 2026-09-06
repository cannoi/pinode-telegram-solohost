#!/usr/bin/env node

/**
 * Data Validator & Diagnostic Tool
 * Compares two Pi Node status sources and identifies drift/inconsistencies
 */

const http = require('http');
const net = require('net');

class DataValidator {
  constructor(opts = {}) {
    this.nodeHost = opts.nodeHost || 'host.docker.internal';
    this.horizonPort = opts.horizonPort || 31401;
    this.corePort = opts.corePort || 11626;
    this.timeout = opts.timeout || 3000;
  }

  httpGet(url, timeout) {
    timeout = timeout || this.timeout;
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout }, (res) => {
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
        req.destroy();
        reject(new Error('timeout'));
      });
    });
  }

  /**
   * Validate Core /info response structure
   */
  validateCoreInfo(data) {
    const issues = [];

    if (!data || typeof data !== 'object') {
      issues.push({ severity: 'CRITICAL', field: 'response', msg: 'Not a valid JSON object' });
      return { valid: false, issues };
    }

    const info = data.info || data;

    // Check required fields
    if (info.state == null || typeof info.state !== 'string') {
      issues.push({ severity: 'CRITICAL', field: 'state', msg: 'Missing or invalid state' });
    }

    if (!info.ledger || info.ledger.num == null) {
      issues.push({ severity: 'CRITICAL', field: 'ledger.num', msg: 'Missing or invalid ledger number' });
    }

    if (info.ledger && info.ledger.age == null) {
      issues.push({ severity: 'WARNING', field: 'ledger.age', msg: 'Missing ledger age' });
    }

    // Validate state machine values
    const validStates = ['synced', 'catching', 'not-synced', 'waiting-for-ledger'];
    const state = (info.state || '').toLowerCase();
    if (!validStates.some((s) => state.includes(s))) {
      issues.push({ severity: 'WARNING', field: 'state', msg: `Unusual state: "${state}"` });
    }

    // Check age plausibility
    if (info.ledger && info.ledger.age != null) {
      const age = Number(info.ledger.age);
      if (age < 0) issues.push({ severity: 'ERROR', field: 'ledger.age', msg: 'Negative age' });
      if (age > 3600) issues.push({ severity: 'WARNING', field: 'ledger.age', msg: `Age too high: ${age}s (1h)` });
    }

    return {
      valid: issues.filter((i) => i.severity === 'CRITICAL').length === 0,
      issues
    };
  }

  /**
   * Validate Horizon root response
   */
  validateHorizonRoot(data) {
    const issues = [];

    if (!data || typeof data !== 'object') {
      issues.push({ severity: 'CRITICAL', field: 'response', msg: 'Not a valid JSON object' });
      return { valid: false, issues };
    }

    // Check ledger fields (at least one required)
    const hasLedger =
      data.history_latest_ledger != null ||
      data.core_latest_ledger != null ||
      data.ingest_latest_ledger != null;

    if (!hasLedger) {
      issues.push({ severity: 'CRITICAL', field: 'ledger_*', msg: 'No ledger fields found' });
    }

    // Check for timestamp
    if (!data.history_latest_ledger_closed_at && !data.core_latest_ledger_closed_at) {
      issues.push({ severity: 'WARNING', field: 'closed_at', msg: 'Missing ledger closed_at' });
    }

    // Validate ledger number plausibility
    const histL = this.num(data.history_latest_ledger);
    const coreL = this.num(data.core_latest_ledger);
    const ingestL = this.num(data.ingest_latest_ledger);

    if (histL && histL < 1000000) {
      issues.push({ severity: 'WARNING', field: 'history_latest_ledger', msg: `Unusually low: ${histL}` });
    }

    // Check ingest lag
    if (coreL && ingestL && coreL - ingestL > 100) {
      issues.push({
        severity: 'WARNING',
        field: 'ingest_lag',
        msg: `Large ingest lag: ${coreL - ingestL} ledgers`
      });
    }

    return {
      valid: issues.filter((i) => i.severity === 'CRITICAL').length === 0,
      issues
    };
  }

  /**
   * Detect ledger drift between Core and Horizon
   */
  detectLedgerDrift(coreData, horizonData) {
    const coreLedger = this.num(coreData && coreData.info ? coreData.info.ledger?.num : coreData?.ledger);
    const horizonLedger = this.num(
      horizonData ? Math.max(
        horizonData.history_latest_ledger,
        horizonData.core_latest_ledger,
        horizonData.ingest_latest_ledger
      ) : null
    );

    if (!coreLedger || !horizonLedger) {
      return { detectable: false, reason: 'Missing ledger data' };
    }

    const drift = Math.abs(coreLedger - horizonLedger);

    return {
      detectable: true,
      core_ledger: coreLedger,
      horizon_ledger: horizonLedger,
      drift: drift,
      drift_severity:
        drift > 500 ? 'CRITICAL' : drift > 100 ? 'WARNING' : drift > 10 ? 'INFO' : 'OK',
      drift_description:
        drift <= 10
          ? 'Normal'
          : drift <= 100
            ? 'Minor drift (Horizon ingest lag)'
            : drift <= 500
              ? 'Major drift (possible desync)'
              : 'Critical drift (likely misaligned)'
    };
  }

  /**
   * Detect sync status inconsistencies
   */
  detectSyncDrift(coreData, horizonData) {
    const coreState = (coreData && coreData.info ? coreData.info.state : null) || null;
    const horizonAge = horizonData ? (horizonData.history_latest_ledger_closed_at || horizonData.core_latest_ledger_closed_at) : null;

    if (!coreState) {
      return { detectable: false, reason: 'Missing Core state' };
    }

    let inferredSync = 'Unknown';
    if (horizonAge) {
      const ageMs = Date.now() - new Date(horizonAge).getTime();
      const ageSec = Math.floor(ageMs / 1000);
      if (ageSec <= 35) inferredSync = 'Likely Synced';
      else if (ageSec <= 120) inferredSync = 'Catching up';
      else inferredSync = 'Behind';
    }

    const coreStateNorm = String(coreState).toLowerCase();
    const isSynced = /synced/i.test(coreStateNorm) && !/not.?synced/i.test(coreStateNorm);

    const match = isSynced && inferredSync.includes('Synced');
    const mismatch = !isSynced && inferredSync === 'Likely Synced';

    return {
      detectable: true,
      core_state: coreState,
      horizon_inferred_sync: inferredSync,
      states_match: match,
      states_mismatch: mismatch,
      severity: mismatch ? 'WARNING' : 'OK',
      description: mismatch
        ? `Sync status mismatch: Core is "${coreState}" but Horizon age suggests "Synced"`
        : 'States consistent'
    };
  }

  /**
   * Full diagnostic run
   */
  async runDiagnostics() {
    console.log('\n=== Pi Node Data Drift Analysis ===\n');

    let coreData = null,
      horizonData = null,
      coreError = null,
      horizonError = null;

    // Get Core data
    console.log('📡 Probing Core /info...');
    try {
      coreData = await this.httpGet(`http://${this.nodeHost}:${this.corePort}/info`, this.timeout);
      console.log('  ✓ Core OK');
    } catch (e) {
      coreError = e.message;
      console.log(`  ✗ Core failed: ${e.message}`);
    }

    // Get Horizon data
    console.log('📡 Probing Horizon root...');
    try {
      horizonData = await this.httpGet(`http://${this.nodeHost}:${this.horizonPort}/`, this.timeout);
      console.log('  ✓ Horizon OK');
    } catch (e) {
      horizonError = e.message;
      console.log(`  ✗ Horizon failed: ${e.message}`);
    }

    console.log('\n');

    // Validate Core
    if (coreData) {
      console.log('Core /info validation:');
      const coreValidation = this.validateCoreInfo(coreData);
      if (coreValidation.valid) {
        console.log('  ✓ Valid response');
      } else {
        console.log('  ✗ Issues found:');
        coreValidation.issues.forEach((i) => {
          console.log(`    ${i.severity}: ${i.field} - ${i.msg}`);
        });
      }
    }

    // Validate Horizon
    if (horizonData) {
      console.log('\nHorizon root validation:');
      const horizonValidation = this.validateHorizonRoot(horizonData);
      if (horizonValidation.valid) {
        console.log('  ✓ Valid response');
      } else {
        console.log('  ✗ Issues found:');
        horizonValidation.issues.forEach((i) => {
          console.log(`    ${i.severity}: ${i.field} - ${i.msg}`);
        });
      }
    }

    // Detect drift
    console.log('\nLedger drift analysis:');
    const driftAnalysis = this.detectLedgerDrift(coreData, horizonData);
    if (driftAnalysis.detectable) {
      console.log(`  Core ledger: ${driftAnalysis.core_ledger}`);
      console.log(`  Horizon ledger: ${driftAnalysis.horizon_ledger}`);
      console.log(`  Drift: ${driftAnalysis.drift} ledgers (${driftAnalysis.drift_severity})`);
      console.log(`  → ${driftAnalysis.drift_description}`);
    } else {
      console.log(`  ℹ ${driftAnalysis.reason}`);
    }

    // Detect sync drift
    console.log('\nSync status consistency:');
    const syncAnalysis = this.detectSyncDrift(coreData, horizonData);
    if (syncAnalysis.detectable) {
      console.log(`  Core state: ${syncAnalysis.core_state}`);
      console.log(`  Horizon inferred: ${syncAnalysis.horizon_inferred_sync}`);
      console.log(`  Consistency: ${syncAnalysis.severity}`);
      console.log(`  → ${syncAnalysis.description}`);
    } else {
      console.log(`  ℹ ${syncAnalysis.reason}`);
    }

    console.log('\n=== End Analysis ===\n');

    return {
      core: { ok: !!coreData, error: coreError },
      horizon: { ok: !!horizonData, error: horizonError },
      drift: driftAnalysis,
      sync: syncAnalysis
    };
  }

  num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
}

// Main
if (require.main === module) {
  const validator = new DataValidator({
    nodeHost: process.env.NODE_HOST || 'host.docker.internal',
    horizonPort: parseInt(process.env.HORIZON_PORT || '31401'),
    corePort: parseInt(process.env.CORE_HTTP_PORT || '11626'),
    timeout: 5000
  });

  validator
    .runDiagnostics()
    .then((result) => {
      process.exit(result.core.ok && result.horizon.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('[error]', err.message);
      process.exit(1);
    });
}

module.exports = DataValidator;
