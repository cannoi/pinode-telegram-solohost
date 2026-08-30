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

let child = null, stopping = false;

function startApp() {
  const p = appPath();
  log('start ' + p);
  child = spawn(process.execPath, [p], { stdio: 'inherit', env: process.env });
  child.on('exit', function (code) {
    child = null;
    if (stopping) return;
    log('exit ' + code + ' → restart 3s');
    setTimeout(startApp, 3000);
  });
}

function boot() {
  let auto;
  try {
    auto = require('./auto-compose');
  } catch (e) {
    log('auto-compose missing: ' + (e && e.message));
    return startApp();
  }

  Promise.resolve(auto.runAsync ? auto.runAsync() : auto.run())
    .then(function (r) {
      if (r && r.exiting) {
        log('auto-compose: recreate in progress — loader exit');
        setTimeout(function () { process.exit(0); }, 1000);
        return;
      }
      if (r && r.action === 'overwritten') {
        log('auto-compose: compose written (sock=' + !!r.sock + ')');
        if (!r.sock) {
          log('auto-compose: run APPLY_DOCKER_SOCK.bat in app folder OR Restart once in SoloHost');
        }
      } else if (r && r.action === 'skip_already') {
        log('auto-compose: sock compose already present');
      } else if (r && !r.ok) {
        log('auto-compose: ' + (r.reason || 'skip'));
      }
      startApp();
    })
    .catch(function (e) {
      log('auto-compose error: ' + (e && e.message));
      startApp();
    });
}

process.on('SIGTERM', function () {
  stopping = true;
  if (child) child.kill('SIGTERM');
  setTimeout(function () { process.exit(0); }, 800);
});

boot();
