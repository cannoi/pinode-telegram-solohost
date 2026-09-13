'use strict';

/**
 * Docker.sock is opt-in only (UI terms + Confirm, then Operator Stop → Start).
 * This module must never overwrite compose or restart containers by itself.
 */

function log(msg) {
  try { console.log('[auto-compose] ' + msg); } catch (e) {}
}

async function runAsync() {
  log('no-op — docker.sock is never auto-applied');
  return { ok: true, action: 'disabled', reason: 'consent_only' };
}

function run() {
  return runAsync();
}

module.exports = { run: run, runAsync: runAsync };
