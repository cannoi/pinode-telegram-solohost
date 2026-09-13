#!/usr/bin/env node
/**
 * Standalone pair agent (optional).
 *   node agent/solohost-agent.mjs --backend https://YOUR-APP-ORIGIN --label "Home SoloHost"
 * Then open http://127.0.0.1:31480
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createBridge, normOrigin } = require('../pi-browser-bridge.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const backend = normOrigin(arg('backend', process.env.PI_BROWSER_BACKEND || ''));
const label = arg('label', process.env.PI_BROWSER_LABEL || 'Home SoloHost');
if (!backend) {
  console.error('Usage: node agent/solohost-agent.mjs --backend https://app-origin --label "Home SoloHost"');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.pnc-data');
const bridge = createBridge({ backend: backend, label: label, dataDir: dataDir, stateFile: path.join(dataDir, 'agent-state.json') });

const PORT = parseInt(process.env.PAIR_PORT || '31480', 10);
const page = function (snap) {
  const code = snap.code || '————————';
  const st = snap.paired ? 'paired' : snap.status;
  return `<!doctype html><meta charset="utf-8"><title>Connect Pi Browser</title>
<style>body{font-family:Segoe UI,sans-serif;background:#0f141c;color:#e8eef7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:rgba(20,28,40,.86);padding:28px 32px;border-radius:16px;max-width:420px;text-align:center;box-shadow:0 10px 40px #0008}
.code{font-size:2rem;letter-spacing:.2em;font-weight:700;margin:16px 0}
.hint{opacity:.75;font-size:.9rem}a{color:#7dd3fc}</style>
<div class="card">
<h1>🔗 Connect</h1>
<p class="hint">${snap.label || ''}</p>
<div class="code">${code}</div>
<p>${st}${snap.expiresIn ? (' · ' + snap.expiresIn + 's') : ''}</p>
<p class="hint">Pi Browser → My Nodes → type the 8 characters<br>or ${snap.deepLink || 'pinode://pair?c=…'}</p>
${snap.error ? ('<p class="hint">⚠️ ' + String(snap.error).slice(0,180) + '</p>') : ''}
<p class="hint">This page is localhost only.</p>
</div>
<script>setTimeout(function(){location.reload()},4000)</script>`;
};

const srv = http.createServer(async (req, res) => {
  const u = (req.url || '/').split('?')[0];
  res.setHeader('X-Frame-Options', 'DENY');
  if (u === '/api/snap') {
    if (req.method === 'POST' && /disconnect/.test(req.url)) {
      const s = await bridge.disconnect();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(s)); return;
    }
    let s = bridge.snapshot();
    if (!s.paired && (!s.code || s.status === 'idle' || s.status === 'expired')) s = await bridge.createPair();
    else s = await bridge.pollPair();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(s)); return;
  }
  let s = bridge.snapshot();
  if (!s.paired && (!s.code || s.status === 'idle' || s.status === 'expired')) {
    try { s = await bridge.createPair(); } catch (e) {}
  } else {
    try { s = await bridge.pollPair(); } catch (e) {}
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page(s));
});

srv.listen(PORT, '127.0.0.1', async () => {
  console.log('Connect UI http://127.0.0.1:' + PORT);
  console.log('Backend ' + backend);
  try { await bridge.createPair(); } catch (e) { console.error(e.message); }
  const s = bridge.snapshot();
  if (s.code) console.log('Code ' + s.code + '  ' + (s.deepLink || ''));
  if (s.error) console.error(s.error);
});

setInterval(async function () {
  try {
    const s = await bridge.pollPair();
    if (s.paired) {
      await bridge.heartbeat({ source: 'standalone-agent', ts: Date.now() });
    }
  } catch (e) {}
}, 8000);
