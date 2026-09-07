/**
 * Balanced Horizon-only sync label (no docker.sock / Core HTTP unverified).
 *
 * Why not "Synced":
 *   Core and Horizon ingest stay within a few ledgers while BOTH are still
 *   catching the network. Age of last closed ledger is the network signal.
 *
 * Style: v2.6.42 Horizon wording, plus ingest-lag overlay from later builds.
 */
function horizonSyncLabel(opts) {
  opts = opts || {};
  const age = opts.ledger_age != null && isFinite(Number(opts.ledger_age))
    ? Math.max(0, Number(opts.ledger_age)) : null;
  let lag = opts.ingest_lag != null && isFinite(Number(opts.ingest_lag))
    ? Math.max(0, Number(opts.ingest_lag)) : null;
  const coreL = opts.core_ledger != null ? Number(opts.core_ledger) : null;
  const ingestL = opts.ingest_ledger != null ? Number(opts.ingest_ledger) : null;
  const histL = opts.history_ledger != null ? Number(opts.history_ledger) : null;

  if (lag == null && isFinite(coreL) && isFinite(ingestL)) {
    lag = Math.max(0, coreL - ingestL);
  } else if (lag == null && isFinite(coreL) && isFinite(histL)) {
    lag = Math.max(0, coreL - histL);
  }

  if ((coreL === 0 && ingestL === 0) || (coreL === 0 && histL === 0)) {
    return {
      sync: 'Horizon catching up',
      sync_confidence: 'medium',
      sync_basis: 'horizon-bootstrap',
      sync_verified: false
    };
  }

  // Large ingest gap: Horizon has not ingested Core's view yet
  if (lag != null && lag > 50) {
    return {
      sync: 'Horizon ingest lag · ' + lag,
      sync_confidence: 'low',
      sync_basis: 'horizon-ingest-lag',
      sync_verified: false
    };
  }

  if (age != null) {
    if (age <= 35) {
      if (lag != null && lag > 10) {
        return {
          sync: 'Horizon ingest lag · ' + lag,
          sync_confidence: 'medium',
          sync_basis: 'horizon-age+lag',
          sync_verified: false
        };
      }
      return {
        sync: 'Horizon live',
        sync_confidence: 'medium',
        sync_basis: 'horizon-age',
        sync_verified: false
      };
    }
    if (age <= 120) {
      return {
        sync: lag != null && lag > 10 ? ('Horizon slow · lag ' + lag) : 'Horizon slow',
        sync_confidence: 'medium',
        sync_basis: 'horizon-age',
        sync_verified: false
      };
    }
    if (age <= 300) {
      return {
        sync: 'Horizon behind',
        sync_confidence: 'low',
        sync_basis: 'horizon-age',
        sync_verified: false
      };
    }
    const mins = Math.max(1, Math.round(age / 60));
    return {
      sync: 'Horizon catching up (~' + mins + 'm)',
      sync_confidence: 'low',
      sync_basis: 'horizon-age',
      sync_verified: false
    };
  }

  if (lag != null && lag > 10) {
    return {
      sync: 'Horizon ingest lag · ' + lag,
      sync_confidence: 'low',
      sync_basis: 'horizon-ingest-lag',
      sync_verified: false
    };
  }

  return {
    sync: 'Horizon OK',
    sync_confidence: 'low',
    sync_basis: 'horizon-root',
    sync_verified: false
  };
}

function applyHorizonSyncLabel(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const lab = horizonSyncLabel({
    ledger_age: obj.ledger_age,
    ingest_lag: obj.ingest_lag,
    core_ledger: obj.core_ledger,
    ingest_ledger: obj.ingest_ledger,
    history_ledger: obj.history_ledger
  });
  obj.sync = lab.sync;
  obj.sync_confidence = lab.sync_confidence;
  obj.sync_basis = lab.sync_basis;
  obj.sync_verified = false;
  obj.core_verified = false;
  return obj;
}

module.exports = { horizonSyncLabel, applyHorizonSyncLabel };
