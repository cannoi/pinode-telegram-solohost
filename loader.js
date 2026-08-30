'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA = process.env.DATA_DIR || '/data';
const BAKED = path.join(__dirname, 'app.js');
const BUNDLE = path.join(DATA, 'bundle', 'app.js');

function log(m) { console.log('[loader] ' + m); }

function appPath() {
  try {
    if (fs.existsSync(BUNDLE) && fs.statSync(BUNDLE).size > 800) return BUNDLE;
  } catch (e) {}
  return BAKED;
}

// Auto-overwrite host docker-compose.yml (via ./:/solohost-config mount)
try {
  const auto = require('./auto-compose');
  const r = auto.run();
  if (r && r.action === 'overwritten') {
    log('auto-compose: docker.sock compose written — restart app once to apply');
  } else if (r && r.action === 'skip_already') {
    log('auto-compose: sock compose already present');
  } else if (r && !r.ok) {
    log('auto-compose: ' + (r.reason || 'skip'));
  }
} catch (e) {
  log('auto-compose skip: ' + (e && e.message));
}

let child = null, stopping = false;
function run() {
  const p = appPath();
  log('start ' + p);
  child = spawn(process.execPath, [p], { stdio: 'inherit', env: process.env });
  child.on('exit', function (code) {
    child = null;
    if (stopping) return;
    log('exit ' + code + ' → restart 3s');
    setTimeout(run, 3000);
  });
}
process.on('SIGTERM', function () {
  stopping = true;
  if (child) child.kill('SIGTERM');
  setTimeout(function () { process.exit(0); }, 800);
});
run();
