'use strict';
/** Unified Pi Node telemetry frame — one schema for Horizon, Core, Docker, history, AI */
const FRAME_VERSION = 1;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function applyPeerRule(o) {
  if (!o || typeof o !== 'object') return o;
  let inn = num(o.peer_in);
  let out = num(o.peer_out);
  let tot = num(o.peer_total);
  if (tot == null && inn != null && out != null) tot = inn + out;
  else if (tot == null && inn != null && out == null) tot = inn;
  else if (tot == null && out != null && inn == null) tot = out;
  if (tot == null) return o;
  if (tot < 8) {
    o.peer_in = 0;
    o.peer_out = tot;
    o.peer_total = tot;
    o.peer_rule = 'total_lt_8_all_outgoing';
  } else {
    if (inn != null && out != null) {
      o.peer_in = inn;
      o.peer_out = out;
      o.peer_total = inn + out;
    } else if (inn != null) {
      o.peer_in = inn;
      o.peer_out = Math.max(0, tot - inn);
      o.peer_total = tot;
    } else if (out != null) {
      o.peer_out = out;
      o.peer_in = Math.max(0, tot - out);
      o.peer_total = tot;
    } else {
      o.peer_total = tot;
    }
  }
  return o;
}

function toFrame(src) {
  src = src || {};
  const f = {
    frame: FRAME_VERSION,
    ts: src.ts || src.timestamp || new Date().toISOString(),
    source: src.source || null,
    sync: src.sync || null,
    sync_confidence: src.sync_confidence || null,
    core_state: src.core_state || null,
    core_verified: src.core_verified === true,
    ledger: num(src.ledger),
    ledger_age: num(src.ledger_age),
    ledger_closed_at: src.ledger_closed_at || null,
    ingest_lag: num(src.ingest_lag),
    peer_in: num(src.peer_in),
    peer_out: num(src.peer_out),
    peer_total: num(src.peer_total),
    ports: src.ports || null,
    ports_open: num(src.ports_open),
    ports_all_open: src.ports_all_open === true,
    docker: src.docker || null,
    docker_sock: src.docker_sock === true,
    container: src.container || null,
    cpu: num(src.cpu),
    ram: num(src.ram),
    temp: num(src.temp),
    protocol: src.protocol != null ? src.protocol : null,
    core_version: src.core_version || null,
    horizon_version: src.horizon_version || null,
    network: src.network || src.network_kind || null,
    network_kind: src.network_kind || null,
    level: src.level || null,
    sources: src.sources || null,
    verification: src.verification || null
  };
  applyPeerRule(f);
  // keep extra known keys from src without dropping them
  ['core_ledger', 'history_ledger', 'ingest_ledger', 'elder_ledger', 'tx_count', 'operation_count', 'base_fee', 'fsm', 'responseTime'].forEach(function (k) {
    if (src[k] != null && f[k] == null) f[k] = src[k];
  });
  return f;
}

function overlay(dst, src) {
  if (!src) return dst;
  Object.keys(src).forEach(function (k) {
    if (src[k] != null && src[k] !== '') dst[k] = src[k];
  });
  return applyPeerRule(dst);
}

module.exports = { FRAME_VERSION: FRAME_VERSION, applyPeerRule: applyPeerRule, toFrame: toFrame, overlay: overlay, num: num };
