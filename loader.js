'use strict';
/**
 * loader.js — process supervisor only.
 *
 * REMOVED (compliance fix): this file used to require('./auto-compose')
 * before starting the app. auto-compose.js silently rewrote the host's
 * docker-compose.yml to add a docker.sock mount and then tried to force
 * a container recreate (docker compose up --force-recreate / docker
 * restart / Docker Engine API restart / host .bat-.ps1 helpers) with NO
 * user consent step. That module and its dedicated
 * compose-templates/docker-compose.with-sock.yml template have been
 * deleted from this package.
 *
 * The ONLY supported way to enable docker.sock is still the existing
 * in-app consent flow in app.js (/docker/confirm, applyDockerConsentFiles),
 * which requires an explicit user click on the local UI and a manual
 * Stop -> Start in SoloHost. That flow is unchanged.
 */
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
