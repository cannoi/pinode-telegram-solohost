'use strict';
// Thin supervisor: runs the baked-in app.js only (no code loaded from /data).
const { spawn } = require('child_process');
const path = require('path');

const APP = path.join(__dirname, 'app.js');
function log(m) { console.log('[loader] ' + m); }

let child = null, stopping = false;

function startApp() {
  log('start ' + APP);
  child = spawn(process.execPath, [APP], { stdio: 'inherit', env: process.env });
  child.on('exit', function (code) {
    child = null;
    if (stopping) return;
    log('exit ' + code + ' -> restart 3s');
    setTimeout(startApp, 3000);
  });
}

process.on('SIGTERM', function () {
  stopping = true;
  if (child) child.kill('SIGTERM');
  setTimeout(function () { process.exit(0); }, 800);
});

startApp();
