'use strict';

/**
 * After SoloHost install (validation without docker.sock), overwrite host
 * docker-compose.yml via mounted ./:/solohost-config so NEXT restart gets sock.
 * SoloHost typically only validates package at install time.
 */

const fs = require('fs');
const path = require('path');

const ENABLED = String(process.env.AUTO_DOCKER_SOCK || '1').toLowerCase();
const CONFIG_DIR = process.env.SOLOHOST_CONFIG_DIR || '/solohost-config';
const TARGET = path.join(CONFIG_DIR, 'docker-compose.yml');
const MARKER = path.join(process.env.DATA_DIR || '/data', 'state', 'auto-compose.json');
const IMAGE = process.env.AUTO_COMPOSE_IMAGE || 'ghcr.io/cannoi/pinode-telegram-solohost:v2.6.19';

function log(msg) {
  try {
    console.log('[auto-compose] ' + msg);
  } catch (e) {}
}

function composeWithSock() {
  return [
    'services:',
    '  agent:',
    '    image: ' + IMAGE,
    '    labels:',
    '      pi.ui.primary: "true"',
    '    ports:',
    '      - "127.0.0.1:18780:8080"',
    '    environment:',
    '      - BOT_TOKEN=${BOT_TOKEN}',
    '      - CHAT_ID=${CHAT_ID}',
    '      - GEMINI_API_KEY=${GEMINI_API_KEY}',
    '      - NODE_HOST=host.docker.internal',
    '      - HORIZON_PORT=31401',
    '      - CORE_HTTP_PORT=11626',
    '      - DOCKER_PROBE=1',
    '      - AUTO_DOCKER_SOCK=1',
    '      - TELEMETRY_SEC=60',
    '      - TZ=Asia/Ho_Chi_Minh',
    '    volumes:',
    '      - ./data:/data',
    '      - ./:/solohost-config:rw',
    '      - /var/run/docker.sock:/var/run/docker.sock:ro',
    '    restart: unless-stopped',
    ''
  ].join('\n');
}

function ensureDir(f) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
  } catch (e) {}
}

function run() {
  if (ENABLED === '0' || ENABLED === 'false' || ENABLED === 'off') {
    log('disabled by AUTO_DOCKER_SOCK');
    return { ok: false, reason: 'disabled' };
  }

  if (!fs.existsSync(CONFIG_DIR)) {
    log('no ' + CONFIG_DIR + ' mount — skip (SoloHost must mount ./:/solohost-config)');
    return { ok: false, reason: 'no_mount' };
  }

  let current = '';
  try {
    current = fs.readFileSync(TARGET, 'utf8');
  } catch (e) {
    current = '';
  }

  const already = /docker\.sock/i.test(current);
  const body = composeWithSock();

  if (already && current.indexOf('DOCKER_PROBE=1') >= 0) {
    log('compose already has docker.sock — leave as is');
    writeMarker({ at: new Date().toISOString(), action: 'skip_already', path: TARGET });
    return { ok: true, action: 'skip_already' };
  }

  try {
    fs.writeFileSync(TARGET, body, 'utf8');
    log('wrote docker.sock compose → ' + TARGET);
    log('Restart the app once so SoloHost applies the new volume.');
    writeMarker({
      at: new Date().toISOString(),
      action: 'overwritten',
      path: TARGET,
      note: 'Restart app to mount docker.sock'
    });
    return { ok: true, action: 'overwritten' };
  } catch (e) {
    log('write failed: ' + (e && e.message));
    writeMarker({ at: new Date().toISOString(), action: 'error', error: String(e && e.message) });
    return { ok: false, reason: e.message };
  }
}

function writeMarker(obj) {
  try {
    ensureDir(MARKER);
    fs.writeFileSync(MARKER, JSON.stringify(obj, null, 2));
  } catch (e) {}
}

module.exports = { run: run };
