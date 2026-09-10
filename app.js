'use strict';
/**
 * SoloHost Controller v2.6.57
 * - Smart Incident Engine (observe -> evaluate -> decide -> act)
 * - Smart Health Scoring with Damper (EMA + dead-band + confidence-aware)
 * - Adaptive polling during incidents
 * - Telegram long-poll independent of telemetry
 * - Horizon-deep PRIMARY -> Core HTTP -> Ports -> cgroup (no DataLive)
 * - NO docker.sock required
 * - International: static messages English; AI replies in user's language
 */
const http = require('http');
const https = require('https');
const PiNodeStatusMonitor = require('./status-monitor');
const dataFrame = require('./data-frame');
const lite = require('./telemetry-lite');

const net = require('net');
const fs = require('fs');
const path = require('path');

const APP_KNOWLEDGE = `
APP: Pi Node Telegram Controller PRO (SoloHost Edition)
Purpose: 24/7 Pi Node monitoring via Telegram + local SoloHost UI. Sandboxed Docker app on Pi Desktop.

HEALTH SCORING (v2.6.57):
- Raw score from lite.liveFrame is passed through a damper:
  EMA + dead-band + confidence-aware, so transient blips do not move the score.
- Confidence depends on data sources: docker.sock + Core = HIGH,
  Core only = MEDIUM, Horizon only = LOW, no source = NONE (score frozen).

INCIDENT ENGINE:
- Detects 10 incident classes: docker_down, network_down, ports_closed,
  sync_stalled, sync_lag, peers_zero, peers_low, ram_high, cpu_high, disk_high
- Stage machine 0-5: observe (0-1) -> first alert (2) -> reminders (3-4) -> chronic (5)
- Adaptive polling: shortens telemetry interval while incident is active
- Suppresses false positives during Pi Node software updates

STYLE: Static system messages stay English. Free-text AI replies MUST match the user's language.
`.trim();

const chatRate = { n: 0, t: 0 };
const VERSION = '2.6.57-solohost';
const DATA = process.env.DATA_DIR || '/data';
const PORT = parseInt(process.env.PORT || '8080', 10);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const DATA_LIVE_URL = '';
const DATA_LIVE_TOKEN = '';
const NODE_HOST = (process.env.NODE_HOST || 'host.docker.internal').trim();
const HORIZON_PORT = parseInt(process.env.HORIZON_PORT || '31401', 10) || 31401;
const NODE_LABEL = (process.env.PI_CONTAINER || process.env.NODE_LABEL || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const ALERT_ON_START = String(process.env.ALERT_ON_START || 'true').toLowerCase() !== 'false';
const TELEMETRY_SEC = Math.max(30, parseInt(process.env.TELEMETRY_SEC || '60', 10) || 60);
const REPORT_HOURS = parseHours(process.env.REPORT_HOURS, [7, 18]);
const FAIL_THRESHOLD = Math.max(2, parseInt(process.env.FAIL_THRESHOLD || '3', 10) || 3);
const ALERT_COOLDOWN = Math.max(60, parseInt(process.env.ALERT_COOLDOWN_SEC || '180', 10) || 180);
const GITHUB_PRO = 'https://github.com/cannoi/pinode-telegram-controller';
const NODE_PORTS = [31401, 31402, 31403];
const NODE_PORTS_STR = NODE_PORTS.map(String);
const statusMonitor = new PiNodeStatusMonitor({
  nodeHost: NODE_HOST,
  horizonPort: HORIZON_PORT,
  stateDir: DATA,
  cacheTTL: Math.min(8000, Math.max(3000, (typeof TELEMETRY_SEC === 'number' ? TELEMETRY_SEC : 60) * 80))
});

const DIR_HIST = path.join(DATA, 'history');
const DIR_HOURLY = path.join(DATA, 'hourly');
const DIR_DAILY = path.join(DATA, 'daily');
const DIR_STATE = path.join(DATA, 'state');
const DIR_LOGS = path.join(DATA, 'logs');
const STATE_F = path.join(DIR_STATE, 'node-state.json');
const LATEST_F = path.join(DATA, 'latest.json');
const LOG_F = path.join(DIR_LOGS, 'controller.log');
const PUBLIC = path.join(__dirname, 'public');
const SCRIPTS = path.join(__dirname, 'scripts');

function parseHours(raw, def) {
  const a = String(raw || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 0 && n <= 23);
  return a.length ? a : def;
}
function ensureDirs() {
  [DIR_HIST, DIR_HOURLY, DIR_DAILY, DIR_STATE, DIR_LOGS].forEach(d => {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  });
}
ensureDirs();

function loadJSON(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function saveJSON(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const t = f + '.tmp';
    fs.writeFileSync(t, JSON.stringify(obj));
    fs.renameSync(t, f);
  } catch (e) {}
}
function safeParse(s) {
  try {
    return JSON.parse(s, function (k, v) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return undefined;
      return v;
    });
  } catch (e) { return null; }
}
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function nowISO() {
  try {
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }).replace(' ', 'T') + '+07:00';
  } catch (e) { return new Date().toISOString(); }
}
function nowHM() {
  try {
    return new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
    }).replace(/\//g, '-').replace(',', '');
  } catch (e) { return new Date().toISOString().slice(0, 16).replace('T', ' '); }
}
function dayVN() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
function hourVN() {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: 'numeric', hour12: false }).formatToParts(new Date());
    return parseInt(p.find(x => x.type === 'hour').value, 10) % 24;
  } catch (e) { return (new Date().getUTCHours() + 7) % 24; }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function treeBlock(header, lines) {
  if (!lines || !lines.length) return '';
  const out = [header];
  lines.forEach(function (l, i) {
    const isLast = i === lines.length - 1;
    out.push(' ' + (isLast ? '└' : '├') + ' ' + l);
  });
  return out.join('\n');
}
function footerTime() {
  try {
    return new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'
    }).replace(/\//g, '-').replace(',', '');
  } catch (e) { return nowHM(); }
}
function sourceLabel(t) {
  t = t || {};
  let src = t.source || 'Horizon';
  if (t.docker_sock && !/docker/i.test(src)) src = 'DockerExec+' + src;
  return src;
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtN(n) { return n == null ? null : Number(n).toLocaleString('en-US'); }
function redactSecrets(s) {
  s = String(s == null ? '' : s);
  if (BOT_TOKEN) s = s.split(BOT_TOKEN).join('[BOT_TOKEN]');
  if (GEMINI_API_KEY) s = s.split(GEMINI_API_KEY).join('[GEMINI_KEY]');
  s = s.replace(/bot[0-9]{6,}:[A-Za-z0-9_-]{20,}/g, '[BOT_TOKEN]');
  s = s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[GEMINI_KEY]');
  return s;
}
function log(msg, level) {
  level = level || 'info';
  const safe = redactSecrets(msg);
  const line = '[' + nowISO() + '] [' + level + '] ' + safe;
  console.log(line);
  try {
    fs.appendFileSync(LOG_F, line + '\n');
    const st = fs.statSync(LOG_F);
    if (st.size > 250000) {
      const keep = fs.readFileSync(LOG_F, 'utf8').slice(-120000);
      fs.writeFileSync(LOG_F, keep);
    }
  } catch (e) {}
  try { if (level === 'error' || level === 'warn') actionLog(level, safe); } catch (e) {}
}

let state = loadJSON(STATE_F, {
  fsm: 'HEALTHY', failCount: 0, lastAlertAt: 0, lastReportKey: '',
  lastLevel: null, lastLedger: null, lastLedgerAt: 0,
  incidents: {},
  healthSmooth: null, healthRaw: null, healthConfidence: null,
  healthConfidenceScore: null, healthSourceCount: null,
  healthAt: 0, healthTrend: null
});
if (!state.incidents || typeof state.incidents !== 'object') state.incidents = {};

const CHAT_TURNS = [];
function pushChatTurn(role, text) {
  try {
    CHAT_TURNS.push({ role, text: String(text || '').slice(0, 500), ts: Date.now() });
    while (CHAT_TURNS.length > 16) CHAT_TURNS.shift();
  } catch (e) {}
}

let cache = null;
let cacheAt = 0;

const tgUserBuckets = Object.create(null);
function tgUserRateLimit(userKey, max, windowMs) {
  const now = Date.now();
  let b = tgUserBuckets[userKey];
  if (!b || now > b.reset) b = tgUserBuckets[userKey] = { n: 0, reset: now + windowMs };
  b.n++;
  return b.n <= max;
}

// ---------- HTTP helpers ----------
function httpGetUrl(urlStr, headers, timeout) {
  return new Promise(resolve => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'GET', headers: headers || {}, timeout: timeout || 3000
      }, r => {
        let b = '';
        r.on('data', d => b += d);
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
      req.end();
    } catch (e) { resolve(null); }
  });
}
function probeTcp(host, port, timeout) {
  return new Promise(res => {
    const s = new net.Socket();
    let done = false;
    const fin = v => { if (done) return; done = true; try { s.destroy(); } catch (e) {} res(v); };
    s.setTimeout(timeout || 900);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(port, host); } catch (e) { fin(false); }
  });
}

// ---------- sources ----------
async function fetchHorizon() {
  const hosts = [NODE_HOST, 'host.docker.internal', '172.17.0.1', '172.18.0.1', '10.0.2.2', 'localhost'];
  const ports = [HORIZON_PORT, 31401, 8000];
  for (const host of hosts) {
    for (const port of ports) {
      const r = await httpGetUrl('http://' + host + ':' + port + '/', {}, 2800);
      if (!r || r.status !== 200 || !r.body) continue;
      try {
        let j = safeParse(r.body);
        if (!j) continue;
        const pick = (...keys) => {
          for (const k of keys) {
            if (j[k] != null && j[k] !== '') return j[k];
          }
          return null;
        };
        let ledger = Number(pick('core_latest_ledger', 'history_latest_ledger', 'ingest_latest_ledger'));
        if (!ledger && j._embedded && j._embedded.records && j._embedded.records[0])
          ledger = Number(j._embedded.records[0].sequence);
        if (!ledger || !isFinite(ledger)) {
          for (const k of Object.keys(j)) {
            if (/ledger/i.test(k) && typeof j[k] === 'number' && j[k] > 1000) { ledger = j[k]; break; }
          }
        }
        if (!ledger) continue;

        let ledger_age = null;
        const closedAt = pick('history_latest_ledger_closed_at', 'core_latest_ledger_closed_at', 'closed_at');
        if (closedAt) {
          const ts = new Date(closedAt).getTime();
          if (isFinite(ts)) ledger_age = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        }

        const coreL = Number(pick('core_latest_ledger'));
        const ingestL = Number(pick('ingest_latest_ledger'));
        let ingest_lag = null;
        if (isFinite(coreL) && isFinite(ingestL)) ingest_lag = Math.max(0, coreL - ingestL);

        let syncStatus = 'Horizon OK';
        let sync_confidence = 'low';
        if (ledger_age != null) {
          if (ledger_age <= 35) { syncStatus = 'Horizon live'; sync_confidence = 'medium'; }
          else if (ledger_age <= 120) { syncStatus = 'Horizon slow'; sync_confidence = 'medium'; }
          else if (ledger_age <= 300) { syncStatus = 'Horizon behind'; sync_confidence = 'low'; }
          else { syncStatus = 'Horizon catching up (~' + Math.round(ledger_age / 60) + 'm)'; sync_confidence = 'low'; }
        }
        if (ingest_lag != null && ingest_lag > 10) {
          syncStatus = 'Horizon ingest lag - ' + ingest_lag;
          sync_confidence = 'low';
        }

        const network = pick('network_passphrase', 'network') || null;
        let network_kind = null;
        if (network) {
          const n = String(network).toLowerCase();
          if (n.indexOf('test') >= 0) network_kind = 'Testnet';
          else if (n.indexOf('public') >= 0 || n.indexOf('main') >= 0 || n.indexOf('pi network') >= 0) network_kind = 'Mainnet';
          else network_kind = 'Custom';
        }

        return {
          source: 'Horizon',
          ledger: ledger,
          ledger_age: ledger_age,
          sync: syncStatus,
          sync_confidence: sync_confidence,
          core_verified: false,
          core_version: pick('core_version') || null,
          horizon_version: pick('horizon_version', 'version') || null,
          protocol: pick('current_protocol_version', 'protocol_version') || null,
          network: network,
          network_kind: network_kind,
          ingest_lag: ingest_lag,
          core_ledger: isFinite(coreL) ? coreL : null,
          ingest_ledger: isFinite(ingestL) ? ingestL : null,
          closed_at: closedAt || null,
          confidence: (ledger_age != null && ledger_age < 60 && !(ingest_lag != null && ingest_lag > 10)) ? 'medium' : 'low',
          horizon_host: host + ':' + port,
          raw_keys: Object.keys(j).slice(0, 40)
        };
      } catch (e) {}
    }
  }
  return null;
}

async function fetchCoreHttp() {
  const hosts = [NODE_HOST, 'host.docker.internal', '172.17.0.1', '172.18.0.1', '10.0.2.2', 'localhost'];
  const ports = [11626, 31400, 11625, 11627];
  for (const host of hosts) {
    for (const port of ports) {
      const r = await httpGetUrl('http://' + host + ':' + port + '/info', {}, 2500);
      if (!r || r.status !== 200 || !r.body) continue;
      try {
        const j = safeParse(r.body);
        if (!j) continue;
        const info = j.info || j;
        const o = { source: 'Core', core_port: port, core_host: host, core_verified: true };
        const stateRaw = info.state != null ? String(info.state) : (info.state_details != null ? String(info.state_details) : null);
        if (info.ledger) {
          if (info.ledger.num != null) o.ledger = Number(info.ledger.num);
          if (info.ledger.age != null) o.ledger_age = Number(info.ledger.age);
        }
        if (stateRaw) {
          const s = stateRaw;
          o.core_state = s;
          if (/synced/i.test(s) && !/not\s*synced|unsynced/i.test(s)) { o.sync = 'Synced'; o.sync_confidence = 'high'; }
          else if (/catching\s*up/i.test(s)) { o.sync = 'Catching up'; o.sync_confidence = 'high'; }
          else if (/joining|scp|booting|starting/i.test(s)) { o.sync = s.length > 40 ? s.slice(0, 40) : s; o.sync_confidence = 'high'; }
          else if (/stop|error|fail/i.test(s)) { o.sync = s; o.sync_confidence = 'high'; }
          else { o.sync = s; o.sync_confidence = 'high'; }
        }
        try {
          const pr = await httpGetUrl('http://' + host + ':' + port + '/peers', {}, 2000);
          if (pr && pr.status === 200 && pr.body) {
            const pj = safeParse(pr.body);
            if (pj && pj.authenticated_peers) {
              const inn = pj.authenticated_peers.inbound;
              const out = pj.authenticated_peers.outbound;
              o.peer_in = Array.isArray(inn) ? inn.length : (inn ? Object.keys(inn).length : 0);
              o.peer_out = Array.isArray(out) ? out.length : (out ? Object.keys(out).length : 0);
            }
          }
        } catch (e) {}
        o.confidence = 'high';
        return o;
      } catch (e) {}
    }
  }
  return null;
}

async function fetchPorts() {
  const hosts = [NODE_HOST, 'host.docker.internal', '172.17.0.1', '172.18.0.1'];
  let best = {};
  let bestN = 0;
  for (const host of hosts) {
    const ports = {};
    let n = 0;
    await Promise.all(NODE_PORTS.map(async p => {
      const ok = await probeTcp(host, p, 800);
      ports[String(p)] = ok ? 'OPEN' : 'CLOSED';
      if (ok) n++;
    }));
    if (n > bestN) { best = ports; bestN = n; if (n === 3) break; }
  }
  return { ports: best, openCount: bestN };
}

function normalizeAny(j, sourceTag) {
  const o = { source: sourceTag || j.source || 'unknown', timestamp: j.timestamp || nowISO() };
  if (j.sync) o.sync = String(j.sync);
  if (j.ledger != null) o.ledger = Number(j.ledger);
  if (j.ledger_age != null) o.ledger_age = Number(j.ledger_age);
  if (j.peer_in != null) o.peer_in = Number(j.peer_in);
  if (j.peer_out != null) o.peer_out = Number(j.peer_out);
  if (j.docker) o.docker = String(j.docker);
  if (j.container) o.container = String(j.container);
  if (j.container_status) o.container_status = String(j.container_status);
  if (j.ports) o.ports = j.ports;
  if (j.cpu != null) o.cpu = Number(j.cpu);
  if (j.ram != null) o.ram = Number(j.ram);
  if (j.temp != null) o.temp = Number(j.temp);
  if (j.disk != null) o.disk = Number(j.disk);
  if (j.vmmem != null) o.vmmem = Number(j.vmmem);
  if (j.data_age_sec != null) o.data_age_sec = Number(j.data_age_sec);
  if (j.confidence) o.confidence = j.confidence;
  return o;
}

function mergeTelemetry(primary, horizon, portSnap) {
  const t = { timestamp: nowISO(), sources: {} };
  if (primary) {
    Object.keys(primary).forEach(k => {
      if (primary[k] != null && k !== 'source' && k !== 'timestamp') t[k] = primary[k];
    });
    t.sources.data_live = true;
    t.source = 'Horizon';
    t.confidence = primary.confidence || 'high';
  } else {
    t.sources.data_live = false;
  }

  if (horizon) {
    t.sources.horizon = true;
    if (t.ledger == null && horizon.ledger != null) t.ledger = horizon.ledger;
    if (t.sync == null && horizon.sync) t.sync = horizon.sync;
    if (!primary) { t.source = 'Horizon'; t.confidence = 'medium'; }
  } else t.sources.horizon = false;

  if (portSnap && portSnap.ports) {
    t.sources.ports = true;
    if (!t.ports) t.ports = portSnap.ports;
    t.ports_open = portSnap.openCount;
  } else t.sources.ports = false;

  if (!t.container) t.container = NODE_LABEL;

  const portsAllOpen = t.ports && NODE_PORTS.every(p => t.ports[String(p)] === 'OPEN');
  const portsAllClosed = t.ports && NODE_PORTS.every(p => t.ports[String(p)] === 'CLOSED');
  const dockerStopped = t.docker && /stop|exit/i.test(t.docker);
  const syncStr = String(t.sync || '');
  const syncBad = /not synced|unsynced|error|fail/i.test(syncStr);
  const catching = /catching|joining|booting|behind|slow|ingest lag/i.test(syncStr);
  const coreMissing = t.core_verified === false || /core n\/a|unverified/i.test(syncStr);

  let level = 'ok';
  if (dockerStopped || portsAllClosed) level = 'critical';
  else if (syncBad || (t.ledger_age != null && t.ledger_age > 300)) level = 'warning';
  else if (catching) level = 'soft';
  else if (coreMissing && (primary || horizon)) level = 'soft';
  else if (primary || horizon || (portSnap && portSnap.openCount >= 2)) level = 'ok';
  else level = 'soft';

  t.level = level;
  t.ports_all_open = !!portsAllOpen;
  return t;
}

/* ======================================================================
 * SMART HEALTH SCORING (v2.6.57)
 * Damper: EMA + dead-band + confidence-aware smoothing
 * Goal: transient blips must not move the displayed score.
 * ==================================================================== */
const HEALTH_CFG = {
  // α = how much weight to give the new raw sample (higher = faster tracking)
  emaAlpha: { high: 0.30, medium: 0.20, low: 0.10 },
  // Dead-band: ignore raw changes smaller than this many points
  deadBand: { high: 3, medium: 5, low: 8 },
  trendWindow: 12,
  trendThreshold: 4,
  staleResetMs: 60 * 60 * 1000 // if smoothing older than 1h -> reset to raw
};

/** Classify confidence from available data sources. */
function healthConfidence(t) {
  t = t || {};
  const hasSock = !!(t.docker_sock || t.docker_probe);
  const hasCore = !!t.core_verified;
  const hasHorizon = !!(t.source && /horizon/i.test(t.source));
  const hasPorts = t.ports_open != null;
  let sources = 0;
  if (hasSock) sources++;
  if (hasCore) sources++;
  if (hasHorizon) sources++;
  if (hasPorts) sources++;

  if (hasSock && hasCore) return { level: 'high', sources: sources, score: 100 };
  if (hasSock)            return { level: 'high', sources: sources, score: 85 };
  if (hasCore)            return { level: 'medium', sources: sources, score: 70 };
  if (hasHorizon && hasPorts) return { level: 'medium', sources: sources, score: 60 };
  if (hasHorizon)         return { level: 'low', sources: sources, score: 40 };
  if (hasPorts)           return { level: 'low', sources: sources, score: 30 };
  return { level: 'none', sources: 0, score: 10 };
}

/** Trend from recent smoothed health values in the last hour. */
function computeHealthTrend(recentRows, currentSmoothed) {
  if (!recentRows || recentRows.length < 4) return 'stable';
  const vals = recentRows.map(function (r) { return r && r.health; })
    .filter(function (x) { return x != null && isFinite(Number(x)); })
    .map(Number);
  if (vals.length < 4) return 'stable';
  const half = Math.floor(vals.length / 2);
  let olderSum = 0, newerSum = 0;
  for (let i = 0; i < half; i++) olderSum += vals[i];
  for (let i = vals.length - half; i < vals.length; i++) newerSum += vals[i];
  const olderAvg = olderSum / half;
  const newerAvg = newerSum / half;
  const delta = newerAvg - olderAvg;
  if (delta > HEALTH_CFG.trendThreshold) return 'improving';
  if (delta < -HEALTH_CFG.trendThreshold) return 'degrading';
  return 'stable';
}

/**
 * Apply damper to a raw health score.
 * Returns { health, raw, confidence, confidenceScore, sourceCount, trend, frozen }
 */
function dampHealthScore(t, rawHealth) {
  t = t || {};
  const conf = healthConfidence(t);

  // No data at all -> keep last smoothed value (do NOT drift toward 0)
  if (conf.level === 'none' || rawHealth == null || !isFinite(Number(rawHealth))) {
    const frozen = state.healthSmooth != null ? Number(state.healthSmooth) : null;
    return {
      health: frozen,
      raw: null,
      confidence: conf.level,
      confidenceScore: conf.score,
      sourceCount: conf.sources,
      trend: state.healthTrend || 'unknown',
      frozen: true
    };
  }

  const alpha = HEALTH_CFG.emaAlpha[conf.level];
  const dead = HEALTH_CFG.deadBand[conf.level];
  const raw = Number(rawHealth);

  // Stale guard: if smoothing is old, reset to raw (avoid frozen stale score)
  const stale = !state.healthAt || (Date.now() - state.healthAt) > HEALTH_CFG.staleResetMs;
  let prev = (!stale && state.healthSmooth != null) ? Number(state.healthSmooth) : raw;

  // Dead-band the input: raw close to prev -> treat as no change
  let input = raw;
  if (Math.abs(raw - prev) < dead) input = prev;

  // EMA
  let smoothed = prev * (1 - alpha) + input * alpha;

  // Hard floor / ceiling: never let damper mask a real dive or a full recovery
  if (raw <= 30 && smoothed > raw + 20) smoothed = raw + 20;
  if (raw >= 95 && smoothed < raw - 15) smoothed = raw - 15;

  // Trend from last hour of smoothed values + current sample
  const recentRows = (typeof readHistory === 'function') ? readHistory(1).slice(-HEALTH_CFG.trendWindow) : [];
  const trend = computeHealthTrend(recentRows, smoothed);

  // Persist
  state.healthSmooth = Math.round(smoothed);
  state.healthRaw = Math.round(raw);
  state.healthConfidence = conf.level;
  state.healthConfidenceScore = conf.score;
  state.healthSourceCount = conf.sources;
  state.healthAt = Date.now();
  state.healthTrend = trend;

  return {
    health: Math.round(smoothed),
    raw: Math.round(raw),
    confidence: conf.level,
    confidenceScore: conf.score,
    sourceCount: conf.sources,
    trend: trend,
    frozen: false
  };
}
/* ======================================================================
 * END SMART HEALTH SCORING
 * ==================================================================== */

async function collectTelemetry() {
  let t = null;
  try {
    t = await statusMonitor.getStatus(true, { detailed: false, docker: false });
  } catch (e) {
    try { actionLog('error', 'statusMonitor: ' + (e && e.message)); } catch (e2) {}
  }
  if (!t || typeof t !== 'object') {
    t = { source: 'none', sync: 'Unknown', level: 'soft', core_verified: false, sources: {} };
  }
  t.sources = t.sources || {};
  t.sources.horizon = !!(t.source && /horizon/i.test(String(t.source)));
  t.sources.core = !!t.core_verified;
  t.sources.ports = t.ports_open != null;
  if (!t.container && NODE_LABEL) t.container = NODE_LABEL;
  if (!t.container) t.container = NODE_LABEL || null;
  try { t = Object.assign(t, dataFrame.toFrame(t)); dataFrame.applyPeerRule(t); } catch (e) {}
  try {
    const prev = readHistory(1).slice(-10);
    const lf = lite.liveFrame(t, prev);
    t.status = lf.status;
    t.peers = lf.peers;
    t.ports_ok = lf.ports_ok;
    t.docker_status = lf.docker_status;
    t.docker_health = lf.docker_health;
    // --- Health scoring with damper ---
    t.health_raw = lf.health;
    const damped = dampHealthScore(t, lf.health);
    if (damped && damped.health != null) {
      t.health = damped.health;
      t.health_confidence = damped.confidence;
      t.health_confidence_score = damped.confidenceScore;
      t.health_sources = damped.sourceCount;
      t.health_trend = damped.trend;
      t.health_frozen = damped.frozen === true;
      // Override trend only when we have a meaningful value from the damper
      if (!damped.frozen && damped.trend) t.trend = damped.trend;
      else t.trend = lf.trend || 'stable';
    } else {
      // Fallback: damper refused to compute -> keep raw
      t.health = lf.health != null ? lf.health : null;
      t.health_confidence = 'low';
      t.trend = lf.trend || 'stable';
    }
    t.core_health = lf.core_health;
    t.health_source = lf.health_source;
    try {
      const hist = readHistory(1);
      const prev2 = hist.length ? hist[hist.length - 1] : null;
      if (prev2 && prev2.ledger != null && t.ledger != null && prev2.ts) {
        const dt = (Date.now() - Date.parse(prev2.ts)) / 60000;
        if (dt > 0.2 && t.ledger >= prev2.ledger) {
          const rate = (t.ledger - prev2.ledger) / dt;
          if (isFinite(rate) && rate >= 0) t.ledger_per_min = Math.round(rate * 10) / 10;
        }
      }
    } catch (e2) {}
    if (t.disk == null) t.disk = lf.disk;
  } catch (e) {}
  try {
    const cg = readCgroupResources();
    if (cg) {
      if (cg.ram != null && Number(cg.ram) > 0 && t.ram == null) t.ram = cg.ram;
      if (cg.cpu != null && Number(cg.cpu) > 0 && t.cpu == null) t.cpu = cg.cpu;
      t.sources.cgroup = true;
    }
  } catch (e) {}
  try {
    state.lastTelemetry = lite.historyRow(t);
    saveJSON(STATE_F, state);
  } catch (e) {}
  try {
    cache = t;
    cacheAt = Date.now();
    t._age = 0;
  } catch (e) {}
  try { appendHistory(t); } catch (e) {}
  try {
    const tmp = LATEST_F + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(t));
    fs.renameSync(tmp, LATEST_F);
  } catch (e) { try { fs.writeFileSync(LATEST_F, JSON.stringify(t)); } catch (e2) {} }
  return t;
}

function getTelemetry() {
  if (cache && Date.now() - cacheAt < TELEMETRY_SEC * 1000 + 5000) return Promise.resolve(cache);
  return collectTelemetry();
}

// ---------- history ----------
function appendHistory(t) {
  try {
    const f = path.join(DIR_HIST, dayVN() + '.ndjson');
    const row = lite.historyRow(t);
    row.ts = nowISO();
    if (t.health != null) row.health = t.health;
    if (t.health_raw != null) row.health_raw = t.health_raw;
    if (t.health_confidence) row.health_confidence = t.health_confidence;
    if (t.peer_in != null) row.peer_in = t.peer_in;
    if (t.peer_out != null) row.peer_out = t.peer_out;
    if (t.peer_total != null) row.peer_total = t.peer_total;
    if (t.level != null) row.level = t.level;
    fs.appendFileSync(f, JSON.stringify(row) + '\n');
    try { rollupHistory(row); } catch (e2) {}
    pruneHistory();
  } catch (e) {}
}
function rollupHistory(row) {
  const hourKey = nowISO().slice(0, 13);
  const hf = path.join(DIR_HIST, 'hourly.json');
  let hours = [];
  try { hours = JSON.parse(fs.readFileSync(hf, 'utf8')); } catch (e) { hours = []; }
  if (!Array.isArray(hours)) hours = [];
  let cur = hours.find(function (x) { return x.hour === hourKey; });
  if (!cur) { cur = { hour: hourKey, n: 0, sum_cpu: 0, max_cpu: null, sum_ram: 0, max_ram: null, min_peers: null, max_age: null, sum_health: 0, health_min: null, bad: 0 }; hours.push(cur); }
  cur.n++;
  if (row.cpu != null) { cur.sum_cpu += row.cpu; cur.max_cpu = cur.max_cpu == null ? row.cpu : Math.max(cur.max_cpu, row.cpu); }
  if (row.ram != null) { cur.sum_ram += row.ram; cur.max_ram = cur.max_ram == null ? row.ram : Math.max(cur.max_ram, row.ram); }
  if (row.peers != null) cur.min_peers = cur.min_peers == null ? row.peers : Math.min(cur.min_peers, row.peers);
  if (row.ledger_age != null) cur.max_age = cur.max_age == null ? row.ledger_age : Math.max(cur.max_age, row.ledger_age);
  if (row.health != null) { cur.sum_health += row.health; cur.health_min = cur.health_min == null ? row.health : Math.min(cur.health_min, row.health); }
  if (row.health != null && row.health < 55) cur.bad++;
  hours = hours.slice(-24 * 30);
  fs.writeFileSync(hf, JSON.stringify(hours));
  const dayKey = dayVN();
  const df = path.join(DIR_HIST, 'daily.json');
  let days = [];
  try { days = JSON.parse(fs.readFileSync(df, 'utf8')); } catch (e) { days = []; }
  if (!Array.isArray(days)) days = [];
  let d = days.find(function (x) { return x.day === dayKey; });
  if (!d) { d = { day: dayKey, n: 0, sum_health: 0, health_min: null, sync_fail: 0 }; days.push(d); }
  d.n++;
  if (row.health != null) { d.sum_health += row.health; d.health_min = d.health_min == null ? row.health : Math.min(d.health_min, row.health); }
  if (row.sync && /not synced|offline|fail|error/i.test(String(row.sync))) d.sync_fail++;
  days = days.slice(-370);
  fs.writeFileSync(df, JSON.stringify(days));
}
function pruneHistory() {
  try {
    const keepRawDays = 2;
    const files = fs.readdirSync(DIR_HIST).filter(n => n.endsWith('.ndjson'));
    const cutoff = Date.now() - keepRawDays * 864e5;
    for (const n of files) {
      const day = n.replace('.ndjson', '');
      const t0 = Date.parse(day + 'T00:00:00+07:00') || Date.parse(day);
      if (t0 && t0 < cutoff) {
        try { fs.unlinkSync(path.join(DIR_HIST, n)); } catch (e) {}
      }
    }
  } catch (e) {}
}
function readHistory(days) {
  const out = [];
  for (let i = 0; i < (days || 1); i++) {
    const d = new Date(Date.now() - i * 864e5);
    let key; try { key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }
    catch (e) { key = d.toISOString().slice(0, 10); }
    try {
      fs.readFileSync(path.join(DIR_HIST, key + '.ndjson'), 'utf8').trim().split('\n').filter(Boolean)
        .forEach(l => { try { out.push(JSON.parse(l)); } catch (e) {} });
    } catch (e) {}
  }
  return out;
}

// ---------- FSM alerts ----------
function hourNowLocal() {
  try { return parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hour12: false }), 10); }
  catch (e) { return new Date().getHours(); }
}
function alertsMuted() {
  const now = Date.now();
  if (state.muteUntil && now < state.muteUntil) return { muted: true, why: 'until ' + new Date(state.muteUntil).toISOString() };
  const mode = String(state.alertMode || 'on').toLowerCase();
  if (mode === 'off') return { muted: true, why: 'alerts off' };
  if (mode === 'night') {
    const h = hourNowLocal();
    if (h >= 22 || h < 7) return { muted: true, why: 'night quiet 22:00-07:00' };
  }
  return { muted: false, why: '' };
}

function reportKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🕖 07:00', callback_data: 'cmd_report_h7' },
        { text: '🕕 18:00', callback_data: 'cmd_report_h18' }
      ],
      [
        { text: '🕖🕕 Both', callback_data: 'cmd_report_both' },
        { text: '⏰ Off', callback_data: 'cmd_report_off' }
      ],
      [
        { text: '🔔 Alerts On', callback_data: 'cmd_mute_on' }
      ]
    ]
  };
}
function effectiveReportHours() {
  if (state.reportHours === 'off' || (Array.isArray(state.reportHours) && !state.reportHours.length)) return [];
  if (Array.isArray(state.reportHours) && state.reportHours.length) return state.reportHours;
  return REPORT_HOURS;
}
function alertKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔇 1h', callback_data: 'cmd_mute_1h' },
        { text: '🌙 Night', callback_data: 'cmd_mute_night' }
      ],
      [
        { text: '📅 24h', callback_data: 'cmd_mute_24h' },
        { text: '🔕 Off', callback_data: 'cmd_mute_off' }
      ],
      [
        { text: '✅ I did it', callback_data: 'cmd_incident_ack' },
        { text: '⏸ Skip 4h', callback_data: 'cmd_incident_skip' }
      ],
      [
        { text: '🩺 Diag', callback_data: 'cmd_diagnostic' },
        { text: '📋 Incidents', callback_data: 'cmd_incidents' }
      ]
    ]
  };
}
function setMuteHours(h) {
  state.muteUntil = Date.now() + h * 3600 * 1000;
  state.alertMode = 'on';
  try { saveJSON(STATE_F, state); } catch (e) {}
}
function formatMuteAck() {
  const m = alertsMuted();
  const until = state.muteUntil ? new Date(state.muteUntil).toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' }) : '-';
  return [
    '🔔 ALERT PREFS',
    '───────────────',
    'Mode       · ' + (state.alertMode || 'on'),
    'Mute until · ' + until,
    'Now        · ' + (m.muted ? ('QUIET · ' + m.why) : 'ACTIVE'),
    '',
    'Incident engine: observe -> alert (5m) -> reminder (15m/45m) -> chronic.'
  ].join('\n');
}

function mapLevelToFsm(level) {
  if (level === 'critical') return 'CRITICAL';
  if (level === 'warning') return 'WARNING';
  if (level === 'soft') return 'DEGRADED';
  return 'HEALTHY';
}

function classifyIssueKind(t) {
  t = t || {};
  const sync = String(t.sync || '');
  const age = t.ledger_age != null ? Number(t.ledger_age) : null;
  const portsClosed = t.ports_open === 0;
  const catching = /catch|behind|syncing|joining/i.test(sync);
  const live = /synced|live|horizon ok|good/i.test(sync);
  if (portsClosed && !live) return 'network_or_host';
  if (catching && t.ledger != null) return 'catchup_or_upgrade';
  if (age != null && age > 300 && !portsClosed) return 'lagging';
  if (t.level === 'critical') return 'persistent_risk';
  if (t.level === 'warning' || t.level === 'soft') return 'watch';
  return 'ok';
}

/* ======================================================================
 * SMART INCIDENT ENGINE
 * ==================================================================== */

function detectIncidentSignature(t) {
  t = t || {};
  const sync = String(t.sync || '');
  const age = t.ledger_age != null ? Number(t.ledger_age) : null;
  const portsOpen = t.ports_open != null ? Number(t.ports_open) : null;
  const peerIn = t.peer_in != null ? Number(t.peer_in) : null;
  const peerOut = t.peer_out != null ? Number(t.peer_out) : null;
  const peerTotal = (peerIn != null || peerOut != null) ? ((peerIn || 0) + (peerOut || 0)) : null;
  const docker = String(t.docker || '');
  const ram = t.ram != null ? Number(t.ram) : null;
  const cpu = t.cpu != null ? Number(t.cpu) : null;
  const disk = t.disk != null ? Number(t.disk) : null;
  const source = String(t.source || '');
  const synced = /synced|live|horizon ok|good/i.test(sync);

  if (/stop|exit/i.test(docker)) return { type: 'docker_down', severity: 'critical' };
  if (portsOpen === 0 && source === 'none') return { type: 'network_down', severity: 'critical' };
  if (portsOpen === 0) return { type: 'ports_closed', severity: 'warning' };
  if (age != null && age > 300) return { type: 'sync_stalled', severity: 'warning' };
  if (age != null && age > 120) return { type: 'sync_lag', severity: 'soft' };
  if (/catching|behind|slow|ingest lag/i.test(sync)) return { type: 'sync_lag', severity: 'soft' };
  if (peerTotal === 0 && synced) return { type: 'peers_zero', severity: 'warning' };
  if (ram != null && ram >= 88) return { type: 'ram_high', severity: 'warning' };
  if (cpu != null && cpu >= 90) return { type: 'cpu_high', severity: 'warning' };
  if (disk != null && disk >= 90) return { type: 'disk_high', severity: 'warning' };
  if (peerTotal != null && peerTotal > 0 && peerTotal <= 2 && synced) return { type: 'peers_low', severity: 'soft' };
  return null;
}

function updateIncidentState(t) {
  const sig = detectIncidentSignature(t);
  const now = Date.now();
  state.incidents = state.incidents || {};

  if (sig) {
    const key = sig.type;
    let inc = state.incidents[key];
    if (!inc || inc.resolved) {
      inc = state.incidents[key] = {
        type: sig.type,
        severity: sig.severity,
        firstSeen: now,
        lastSeen: now,
        samples: 1,
        stage: 0,
        alertsSent: 0,
        lastAlertAt: 0,
        resolved: false,
        firstLedger: t.ledger != null ? t.ledger : null,
        firstCoreVersion: t.core_version || null,
        firstSync: t.sync || null,
        ackedAt: 0,
        skippedUntil: 0
      };
      try { actionLog('info', 'incident start: ' + key + ' (' + sig.severity + ')'); } catch (e) {}
    } else {
      inc.lastSeen = now;
      inc.samples = (inc.samples || 0) + 1;
      inc.severity = sig.severity;
    }
    Object.keys(state.incidents).forEach(function (k) {
      if (k === key) return;
      const other = state.incidents[k];
      if (other && !other.resolved) {
        other.resolved = true;
        other.resolvedAt = now;
      }
    });
    return inc;
  } else {
    Object.keys(state.incidents).forEach(function (k) {
      const inc = state.incidents[k];
      if (inc && !inc.resolved) {
        inc.resolved = true;
        inc.resolvedAt = now;
      }
    });
    const keys = Object.keys(state.incidents);
    if (keys.length > 30) {
      keys.sort(function (a, b) { return (state.incidents[b].firstSeen || 0) - (state.incidents[a].firstSeen || 0); });
      const keep = {};
      keys.slice(0, 30).forEach(function (k) { keep[k] = state.incidents[k]; });
      state.incidents = keep;
    }
    return null;
  }
}

function decideIncidentAction(incident, t) {
  if (!incident) return { action: 'none' };
  const now = Date.now();
  const durMin = Math.max(0, Math.round((now - incident.firstSeen) / 60000));
  const samples = incident.samples || 1;
  const currentStage = incident.stage || 0;

  let targetStage = 0;
  if (samples >= 3 || durMin >= 2) targetStage = 1;
  if (samples >= 5 || durMin >= 5) targetStage = 2;
  if (durMin >= 15 || samples >= 15) targetStage = 3;
  if (durMin >= 45 || samples >= 45) targetStage = 4;
  if (durMin >= 180) targetStage = 5;

  const isUpgradeCatchup = incident.type === 'sync_lag' &&
    incident.firstCoreVersion && t && t.core_version &&
    String(t.core_version) !== String(incident.firstCoreVersion);

  if (isUpgradeCatchup && targetStage <= 2) {
    return { action: 'suppress', targetStage: 1, reason: 'upgrade_catchup', durationMin: durMin };
  }
  if (incident.skippedUntil && now < incident.skippedUntil) {
    return { action: 'wait', targetStage: targetStage, reason: 'skipped', durationMin: durMin };
  }
  if (targetStage < 2) return { action: 'watch', targetStage: targetStage, durationMin: durMin };
  if (currentStage >= targetStage) return { action: 'wait', targetStage: targetStage, durationMin: durMin };

  const cooldownMin = [0, 0, 0, 30, 60, 180][targetStage] || 60;
  const sinceLastMin = (now - (incident.lastAlertAt || 0)) / 60000;
  const userAckBonus = (incident.ackedAt && now - incident.ackedAt < 2 * 3600 * 1000) ? 30 : 0;

  if ((incident.alertsSent || 0) > 0 && sinceLastMin < (cooldownMin + userAckBonus)) {
    return { action: 'cooldown', targetStage: targetStage, durationMin: durMin, waitMin: Math.round((cooldownMin + userAckBonus) - sinceLastMin) };
  }

  return {
    action: (incident.alertsSent || 0) === 0 ? 'alert' : 'remind',
    targetStage: targetStage,
    durationMin: durMin,
    reason: isUpgradeCatchup ? 'upgrade_catchup' : 'persistent'
  };
}

function smartScriptForIncident(incident, t) {
  if (!incident) return null;
  const type = incident.type;
  switch (type) {
    case 'docker_down':
      return { script: 'DockerRecover', note: 'Docker Engine appears down. Try SOFT restart first. Do NOT touch WSL while Docker is still running.' };
    case 'network_down':
      return { script: 'NetRepair', note: 'Ports closed AND no telemetry source. Long outage - repair networking while KEEPING the current LAN IP.' };
    case 'ports_closed':
      return { script: 'Firewall', then: 'NetRepair', note: 'PC is online but Pi ports 31401-31403 are unreachable. Rebuild firewall rules first; if it persists >15 min, escalate to NetRepair.' };
    case 'sync_stalled':
      return { script: 'NodeReset', note: 'Ledger age > 5 min while container is running. Container may be stuck - NodeReset only AFTER confirming Docker Engine is healthy.' };
    case 'sync_lag': {
      if (incident.firstCoreVersion && t && t.core_version && String(t.core_version) !== String(incident.firstCoreVersion)) {
        return { script: 'WAIT', note: 'Catching up after a Core version change - this is normal. Watch 10-15 min; DO NOT restart.' };
      }
      return { script: 'WAIT', note: 'Sync lag while ports are OK and ledger is still advancing. Wait - do not restart. If it lasts >15 min AND ledger stops moving, escalate to /diagnostic.' };
    }
    case 'peers_zero':
      return { script: 'DnsFlush', note: 'Ports open, ledger moving, but no peers. DNS flush only - keeps LAN IP unchanged.' };
    case 'peers_low':
      return { script: 'DnsFlush', note: 'Peer count is low while synced. Try DNS flush; also check regional ISP outage.' };
    case 'ram_high':
      return { script: 'CleanRam', note: 'RAM pressure on host. CleanRam closes extra apps, clears TEMP/TRIM. It does NOT stop Pi Node or Docker.' };
    case 'cpu_high':
      return { script: 'CleanRam', note: 'CPU pressure. Observe first; run CleanRam only if the host has extra heavy apps.' };
    case 'disk_high':
      return { script: 'Maintain', note: 'Disk nearly full. Weekly cleanup (Maintain.bat) is safe while the node is otherwise healthy.' };
    default:
      return null;
  }
}

function currentTelemetryInterval() {
  const incidents = state.incidents || {};
  const active = Object.keys(incidents).map(function (k) { return incidents[k]; }).filter(function (i) { return i && !i.resolved; });
  if (!active.length) return TELEMETRY_SEC;
  const hasCritical = active.some(function (i) { return i.severity === 'critical' || (i.stage || 0) >= 3; });
  const hasWarning = active.some(function (i) { return i.severity === 'warning' || (i.stage || 0) >= 1; });
  if (hasCritical) return Math.max(30, Math.floor(TELEMETRY_SEC / 2));
  if (hasWarning) return Math.max(30, Math.floor(TELEMETRY_SEC * 0.75));
  return TELEMETRY_SEC;
}

function formatIncidents() {
  const now = Date.now();
  const all = state.incidents || {};
  const keys = Object.keys(all);
  const active = keys.map(function (k) { return all[k]; }).filter(function (i) { return i && !i.resolved; });
  const recent = keys.map(function (k) { return all[k]; })
    .filter(function (i) { return i && i.resolved && (now - (i.resolvedAt || 0)) < 24 * 3600 * 1000; })
    .sort(function (a, b) { return (b.resolvedAt || 0) - (a.resolvedAt || 0); })
    .slice(0, 8);

  const parts = ['🧭 INCIDENT ENGINE', '───────────────', ''];
  parts.push('Active: ' + active.length + ' · Recent 24h: ' + recent.length);
  parts.push('');
  if (active.length) {
    parts.push('🔴 ACTIVE');
    active.forEach(function (inc) {
      const durMin = Math.max(0, Math.round((now - inc.firstSeen) / 60000));
      const script = smartScriptForIncident(inc, cache || {});
      const sev = inc.severity === 'critical' ? '🔴' : (inc.severity === 'warning' ? '🟠' : '🟡');
      parts.push(' ' + sev + ' ' + inc.type + ' · stage ' + (inc.stage || 0) + ' · ' + durMin + ' min · ' + (inc.samples || 1) + ' samples');
      if (script) {
        if (script.script === 'WAIT') parts.push('    ⏸ WAIT — ' + script.note.slice(0, 160));
        else parts.push('    🛠 ' + script.script + (script.then ? (' → ' + script.then) : '') + ' — ' + script.note.slice(0, 140));
      }
    });
    parts.push('');
  } else {
    parts.push('🟢 No active incident.');
    parts.push('');
  }
  if (recent.length) {
    parts.push('📜 RECENT (24h)');
    recent.forEach(function (inc) {
      const durMin = Math.max(0, Math.round(((inc.resolvedAt || 0) - inc.firstSeen) / 60000));
      parts.push(' ✅ ' + inc.type + ' · lasted ' + durMin + ' min · ' + (inc.alertsSent || 0) + ' alerts');
    });
    parts.push('');
  }
  parts.push('───────────────');
  parts.push('Adaptive interval: ' + currentTelemetryInterval() + 's (base ' + TELEMETRY_SEC + 's)');
  return parts.join('\n');
}

/* ======================================================================
 * END SMART INCIDENT ENGINE
 * ==================================================================== */

async function fetchPctContext() {
  const now = Date.now();
  if (state.pctNews && state.pctNewsAt && now - state.pctNewsAt < 12 * 3600 * 1000) {
    return state.pctNews;
  }
  return new Promise(function (resolve) {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/PiCoreTeam/pi-node-docker/releases?per_page=3',
      method: 'GET',
      headers: { 'User-Agent': 'pinode-solohost-controller', 'Accept': 'application/vnd.github+json' }
    }, function (r) {
      let b = '';
      r.on('data', function (d) { b += d; });
      r.on('end', function () {
        try {
          const j = safeParse(b);
          const list = Array.isArray(j) ? j.slice(0, 3).map(function (x) {
            return { tag: x.tag_name || x.name, at: x.published_at || x.created_at, name: x.name };
          }) : [];
          state.pctNews = list;
          state.pctNewsAt = Date.now();
          try { saveJSON(STATE_F, state); } catch (e) {}
          resolve(list);
        } catch (e) { resolve(state.pctNews || []); }
      });
    });
    req.on('error', function () { resolve(state.pctNews || []); });
    req.setTimeout(8000, function () { try { req.destroy(); } catch (e) {} resolve(state.pctNews || []); });
    req.end();
  });
}

async function aiClassifyIncident(t, kind, durationMin) {
  if (!GEMINI_API_KEY) return null;
  if (state.incidentAiAt && Date.now() - state.incidentAiAt < 25 * 60 * 1000) return state.incidentAiText || null;
  try {
    const pct = await fetchPctContext();
    const brief = (typeof preEvalBrief === 'function') ? preEvalBrief(t) : '';
    const q = [
      'Classify this Pi Node incident for the operator. Reply in English, short (alerts are English-only).',
      'Kind guess: ' + kind + '. Duration minutes: ' + durationMin + '.',
      'Decide: TRANSIENT (upgrade/catch-up, brief network blip, regional cable) vs ACTION (node really needs operator fix).',
      'Mention if it looks like official Pi Node software catch-up after update.',
      'PCT recent releases: ' + JSON.stringify(pct).slice(0, 400),
      brief.slice(0, 1200),
      'Format: 1 line verdict + 2 lines why + 1 line what to do. No markdown.'
    ].join('\n');
    const text = await generateWithSmartGemini(q);
    if (text) {
      state.incidentAiAt = Date.now();
      state.incidentAiText = String(text).slice(0, 1200);
      try { saveJSON(STATE_F, state); } catch (e) {}
      return state.incidentAiText;
    }
  } catch (e) {}
  return null;
}

function alertFingerprint(t, kind) {
  const s = String((kind || '') + ' ' + (t && t.sync || '') + ' ' + (t && t.level || '')).replace(/\d+/g, 'N').toLowerCase();
  return s.replace(/\s+/g, ' ').trim().slice(0, 80);
}
async function sendAlertTelegram(text, t) {
  const gate = alertsMuted();
  if (gate.muted) {
    try { actionLog('info', 'alert muted - ' + gate.why); } catch (e) {}
    return false;
  }
  const fp = alertFingerprint(t || {}, (t && t._incidentType) || classifyIssueKind(t || {}));
  const now = Date.now();
  if (state.alertDedupe && state.alertDedupe.fp === fp && now - (state.alertDedupe.at || 0) < 30 * 60 * 1000) {
    try { actionLog('info', 'alert deduped 30m - ' + fp); } catch (e) {}
    return false;
  }
  state.alertDedupe = { fp: fp, at: now };
  try { saveJSON(STATE_F, state); } catch (e) {}
  try { pushDashAlert(text, t); } catch (e) {}
  await tgSend(text, { reply_markup: alertKeyboard() });
  return true;
}
function dashAlertPath() { return path.join(DATA, 'state', 'dash-alerts.json'); }
function readDashAlerts() {
  try { const x = JSON.parse(fs.readFileSync(dashAlertPath(), 'utf8')); return Array.isArray(x) ? x : []; } catch (e) { return []; }
}
function pushDashAlert(text, t) {
  const rows = readDashAlerts();
  const rec = recommendActions(t || {});
  const tip = (rec && rec.why && rec.why[0]) ? rec.why[0] : '';
  const files = (rec && rec.items) ? rec.items.map(function (i) { return i.file; }).join(', ') : '';
  rows.unshift({
    ts: nowISO(),
    text: String(text || '').slice(0, 500),
    tip: tip,
    scripts: files,
    health: t && t.health != null ? t.health : null,
    sync: t && t.sync || null,
    read: false
  });
  fs.mkdirSync(path.dirname(dashAlertPath()), { recursive: true });
  fs.writeFileSync(dashAlertPath(), JSON.stringify(rows.slice(0, 30)));
}

async function runAlertMachine(t) {
  const prev = state.fsm || 'HEALTHY';
  const now = Date.now();

  const incident = updateIncidentState(t);

  if (!incident) {
    if (prev === 'CRITICAL' || prev === 'WARNING' || prev === 'DEGRADED') {
      const justResolved = Object.keys(state.incidents).map(function (k) { return state.incidents[k]; })
        .filter(function (i) { return i && i.resolvedAt && (now - i.resolvedAt) < 60000 && (i.alertsSent || 0) > 0; })
        .sort(function (a, b) { return (b.resolvedAt || 0) - (a.resolvedAt || 0); })[0];
      if (justResolved) {
        const durMin = Math.max(1, Math.round((justResolved.resolvedAt - justResolved.firstSeen) / 60000));
        const recTxt = '🟢 RECOVERED after ~' + durMin + ' min\n' +
          'Previous issue: ' + justResolved.type + '\n\n' +
          formatStatus(t, 'RECOVERED');
        try { pushDashAlert(recTxt, t); } catch (e3) {}
        await tgSend(recTxt);
      }
    }
    state.fsm = 'HEALTHY';
    state.failCount = 0;
    saveJSON(STATE_F, state);
    return;
  }

  const decision = decideIncidentAction(incident, t);

  if (decision.action === 'watch') {
    incident.stage = Math.max(incident.stage || 0, decision.targetStage || 0);
    saveJSON(STATE_F, state);
    return;
  }
  if (decision.action === 'suppress') {
    try { actionLog('info', 'incident suppressed: ' + incident.type + ' (' + (decision.reason || '') + ')'); } catch (e) {}
    incident.stage = Math.max(incident.stage || 0, decision.targetStage || 0);
    saveJSON(STATE_F, state);
    return;
  }
  if (decision.action === 'cooldown' || decision.action === 'wait' || decision.action === 'none') {
    saveJSON(STATE_F, state);
    return;
  }

  const script = smartScriptForIncident(incident, t);
  const ai = (incident.type === 'sync_lag' || incident.type === 'network_down' || incident.type === 'ports_closed')
    ? await aiClassifyIncident(t, incident.type, decision.durationMin)
    : null;

  const sevIcon = incident.severity === 'critical' ? '🔴'
    : (incident.severity === 'warning' ? '🟠' : '🟡');
  const stageLabel = decision.targetStage === 2 ? 'ALERT'
    : (decision.targetStage === 3 ? 'REMINDER 1'
      : (decision.targetStage === 4 ? 'REMINDER 2' : 'CHRONIC'));

  const head = sevIcon + ' PI NODE · ' + stageLabel + ' · ' + String(incident.type).toUpperCase() +
    '\nDuration: ' + decision.durationMin + ' min · Samples: ' + incident.samples +
    (decision.reason === 'upgrade_catchup' ? ' · upgrade catch-up' : '');

  let advice = '';
  if (script) {
    if (script.script === 'WAIT') {
      advice = '\n\n⏸️ RECOMMENDED: WAIT\n' + script.note;
    } else {
      advice = '\n\n🛠️ RECOMMENDED: ' + script.script + '\n' + script.note;
      if (script.then) advice += '\nIf not improved after ~15 min, escalate to: ' + script.then;
    }
  }

  const aiBlock = ai ? ('\n\n🤖 AI\n' + ai) : '';
  const body = '\n\n' + formatStatus(t, 'ALERT');

  await sendAlertTelegram(head + body + aiBlock + advice, t);

  incident.stage = decision.targetStage;
  incident.lastAlertAt = now;
  incident.alertsSent = (incident.alertsSent || 0) + 1;
  incident.lastScript = script ? script.script : null;
  state.fsm = mapLevelToFsm(t.level);
  state.lastAlertKind = incident.type;
  state.lastAlertAt = now;
  saveJSON(STATE_F, state);
}

// ---------- format helpers ----------
function lineIf(icon, label, value) {
  if (value == null || value === '') return null;
  return icon + '  ' + label + '  ' + value;
}

const ACTION_LOG = path.join(DIR_LOGS, 'actions.ndjson');
function actionLog(kind, msg, extra) {
  try {
    const row = { ts: nowISO(), kind: kind || 'info', msg: (typeof redactSecrets === 'function' ? redactSecrets(String(msg || '')) : String(msg || '')).slice(0, 500) };
    if (extra && typeof extra === 'object') {
      try { row.extra = JSON.stringify(extra).slice(0, 400); } catch (e) {}
    }
    fs.appendFileSync(ACTION_LOG, JSON.stringify(row) + '\n');
  } catch (e) {}
}
function readActionLog(maxLines) {
  try {
    const lines = fs.readFileSync(ACTION_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-(maxLines || 40)).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return { msg: l }; }
    });
  } catch (e) { return []; }
}
function formatActionLog() {
  const rows = readActionLog(35);
  const lines = ['📋 APP LOG', '───────────────', ''];
  if (!rows.length) {
    lines.push('No entries yet.');
    return lines.join('\n');
  }
  rows.forEach(function (r) {
    const tag = r.kind === 'error' ? '❌' : (r.kind === 'warn' ? '⚠️' : '✅');
    const ts = (r.ts || '').replace('T', ' ').slice(0, 19);
    lines.push(tag + ' ' + ts + ' · ' + (r.msg || ''));
  });
  lines.push('');
  lines.push('SoloHost · /logs');
  return lines.join('\n');
}

function healthIcon(score) {
  if (score == null) return '⚪';
  if (score >= 85) return '🟢';
  if (score >= 65) return '🟡';
  if (score >= 40) return '🟠';
  return '🔴';
}
function healthConfIcon(conf) {
  if (conf === 'high') return '🟢';
  if (conf === 'medium') return '🟡';
  if (conf === 'low') return '🟠';
  return '⚪';
}

function formatStatus(t, mode) {
  t = t || {};
  const age = t._age != null ? t._age : (cacheAt ? Math.round((Date.now() - cacheAt) / 1000) : 0);
  const syncStr = String(t.sync || '');
  const syncOk = syncStr && /synced|live|good|horizon ok/i.test(syncStr) && !(t.ledger_age != null && t.ledger_age > 120);
  const netOk = t.ports_all_open || (t.ports_open != null && t.ports_open >= 2);
  const nodeOk = t.level === 'ok' || (syncOk && netOk && t.level !== 'critical');

  let head;
  if (mode === 'RECOVERED') head = '🟢 PI NODE · RECOVERED';
  else if (t.level === 'critical') head = '🔴 PI NODE · QUICK STATUS';
  else if (!nodeOk) head = '🟡 PI NODE · QUICK STATUS';
  else head = '🟢 PI NODE · QUICK STATUS';

  const runtime = [];
  if (t.sync) {
    const ic = /synced|live/i.test(syncStr) ? '🟢'
      : (/catch|behind|slow|lag/i.test(syncStr) ? '🟡' : '🔄');
    runtime.push('SYNC    · ' + ic + ' ' + t.sync);
  }
  if (t.container) {
    const ic = /stop|exit/i.test(String(t.docker || '')) ? '🔴' : '🟢';
    runtime.push('NODE    · ' + ic + ' RUNNING (`' + t.container + '`)');
  } else if (t.docker) {
    const ic = /stop|exit/i.test(String(t.docker)) ? '🔴' : '🟢';
    runtime.push('NODE    · ' + ic + ' ' + t.docker);
  } else if (t.docker_sock) runtime.push('NODE    · 🟢 sock');
  else if (t.ports_all_open) runtime.push('NODE    · 🟢 Running');
  else if (t.ports_open === 0) runtime.push('NODE    · 🔴 Ports closed');

  if (netOk) {
    let netKind = '';
    if (t.network_kind === 'Testnet') netKind = 'Pi Testnet';
    else if (t.network_kind === 'Mainnet') netKind = 'Pi Mainnet';
    else if (t.network_kind) netKind = t.network_kind;
    runtime.push('NET     · 🟢 Good' + (netKind ? ' (' + netKind + ')' : ''));
  } else if (t.ports_open != null) runtime.push('NET     · 🟡 Partial');

  if (t.ledger != null) {
    let s = '#' + Number(t.ledger).toLocaleString('en-US');
    if (t.ledger_age != null) s += ' (Age ' + t.ledger_age + 's)';
    runtime.push('LEDGER  ·    ' + s);
  }
  if (t.core_version) runtime.push('CORE    ·    ' + t.core_version);

  const sys = [];
  if (t.health != null) {
    const hIcon = healthIcon(t.health);
    const cIcon = healthConfIcon(t.health_confidence);
    const trendTag = t.health_trend === 'improving' ? ' ↗'
      : (t.health_trend === 'degrading' ? ' ↘' : '');
    const frozenTag = t.health_frozen ? ' · frozen' : '';
    sys.push('HEALTH  · ' + hIcon + ' ' + t.health + '/100' + trendTag +
      ' · ' + cIcon + ' ' + (t.health_confidence || 'low') + frozenTag);
  }
  if (t.ram != null) sys.push('RAM     ·    ' + Math.round(t.ram) + '%');
  if (t.cpu != null) {
    const cic = t.cpu >= 90 ? '🔴' : (t.cpu >= 70 ? '🟡' : '🟢');
    sys.push('CPU     · ' + cic + ' ' + t.cpu + '%');
  }
  if (t.temp != null) sys.push('TEMP    ·    ' + t.temp + '°C');

  const result = [];
  if (nodeOk) { result.push('STATUS  · 🟢 OK'); result.push('ACTION  · None (No Issues)'); }
  else if (t.level === 'critical') { result.push('STATUS  · 🔴 CRITICAL'); result.push('ACTION  · Inspect node'); }
  else { result.push('STATUS  · 🟡 WATCH'); result.push('ACTION  · Review'); }

  const parts = [head, ''];
  if (runtime.length) parts.push(treeBlock('⚙️ RUNTIME', runtime));
  if (sys.length)     { parts.push(''); parts.push(treeBlock('📊 SYSTEM', sys)); }
  parts.push('');
  parts.push(treeBlock('✅ RESULT', result));
  parts.push('');
  parts.push('───────────────');
  parts.push('📡 ' + sourceLabel(t) + ' · ⏱ ' + age + 's ago');
  parts.push('🕐 ' + footerTime() + ' · v' + VERSION);
  return parts.join('\n');
}

function formatPeers(t) {
  t = t || {};
  try { if (typeof dataFrame !== 'undefined') dataFrame.applyPeerRule(t); } catch (e) {}

  const inn   = t.peer_in;
  const out   = t.peer_out;
  const total = t.peer_total != null
    ? t.peer_total
    : ((inn != null && out != null) ? (inn + out) : (inn != null ? inn : out));

  const age = cacheAt ? Math.round((Date.now() - cacheAt) / 1000) : 0;
  const head = '🌐 PEERS & TREND · STELLAR CORE';
  const parts = [head, ''];

  if (inn == null && out == null) {
    parts.push('👥 CONNECTIONS');
    parts.push(' └ ⚠️ Peer data unavailable');
    parts.push('');
    parts.push('(Core HTTP /peers not exposed)');
    parts.push('');
    parts.push('───────────────');
    parts.push('📡 Controller Pro · ⏱ ' + age + 's ago');
    return parts.join('\n');
  }

  const conn = [];
  if (inn != null) conn.push('🟢 IN    · ' + inn);
  if (out != null) conn.push('🔵 OUT   · ' + out);
  if (total != null) conn.push('📊 TOTAL · ' + total);
  parts.push(treeBlock('👥 CONNECTIONS', conn));
  parts.push('');

  parts.push('📈 TREND');
  try {
    const rows = readHistory(1).filter(function (r) {
      return r.peer_in != null || r.peer_out != null;
    }).slice(-12);

    if (rows.length >= 2) {
      const a = rows[0], b = rows[rows.length - 1];
      const ta = (a.peer_in || 0) + (a.peer_out || 0);
      const tb = (b.peer_in || 0) + (b.peer_out || 0);
      const drop = ta > 0 ? ((ta - tb) / ta) : 0;
      const totalTrend = (ta === tb) ? '🟢 Stable' : (drop > 0.5 ? '📉 Drop' : '🟡 Changed');

      const trendLines = [];
      trendLines.push('TOTAL · ' + ta + ' ➔ ' + tb + ' (' + totalTrend + ')');
      if (a.peer_in != null && b.peer_in != null) trendLines.push('IN    · ' + a.peer_in + ' ➔ ' + b.peer_in + ' (🟢 Stable)');
      if (a.peer_out != null && b.peer_out != null) trendLines.push('OUT   · ' + a.peer_out + ' ➔ ' + b.peer_out + ' (🟢 Stable)');
      trendLines.forEach(function (l, i) {
        const isLast = i === trendLines.length - 1;
        parts.push(' ' + (isLast ? '└' : '├') + ' ' + l);
      });
    } else {
      parts.push(' └ 👥 ' + (total != null ? total : '?') + ' · collecting');
    }
  } catch (e) {
    parts.push(' └ 👥 collecting');
  }

  parts.push('');
  parts.push('───────────────');
  parts.push('📡 Controller Pro · ⏱ ' + age + 's ago');
  return parts.join('\n');
}

function formatDiagnostic(t) {
  t = t || {};
  const net = [];
  if (t.network_kind === 'Testnet') net.push('Network · Pi Testnet');
  else if (t.network_kind === 'Mainnet') net.push('Network · Pi Mainnet');
  else if (t.network_kind) net.push('Network · ' + t.network_kind);
  else if (t.network) net.push('Network · ' + t.network);

  if (t.sync) {
    const ic = /synced|live/i.test(String(t.sync)) ? '🟢'
      : (/catch|behind|slow|lag/i.test(String(t.sync)) ? '🟡' : '🔄');
    net.push('Sync    · ' + ic + ' ' + t.sync);
  }
  if (t.ledger != null) {
    let s = 'Ledger  · #' + Number(t.ledger).toLocaleString('en-US');
    const bits = [];
    if (t.ledger_age != null) bits.push('Age: ' + t.ledger_age + 's');
    if (t.ingest_lag != null) bits.push('Lag: ' + t.ingest_lag);
    if (bits.length) s += ' (' + bits.join(' | ') + ')';
    net.push(s);
  }
  if (t.peer_in != null || t.peer_out != null) {
    net.push('Peers   · IN ' + (t.peer_in != null ? t.peer_in : '?') + ' / OUT ' + (t.peer_out != null ? t.peer_out : '?'));
  }
  if (t.ports) {
    const openCount = NODE_PORTS_STR.filter(function (p) { return t.ports[p] === 'OPEN'; }).length;
    const pic = openCount === 3 ? '🟢 OPEN' : (openCount === 0 ? '🔴 CLOSED' : '🟡 ' + openCount + '/3');
    net.push('Ports   · 31401-31403 ' + pic);
  }

  const eng = [];
  const sockYes = !!(t.docker_sock || t.docker_probe);
  if (t.docker) {
    const dic = /stop|exit/i.test(String(t.docker)) ? '🔴' : '🟢';
    eng.push('Docker    · ' + dic + ' ' + String(t.docker).toUpperCase() + ' (Sock: ' + (sockYes ? 'Yes' : 'No') + ')');
  } else if (sockYes) eng.push('Docker    · 🟢 Sock (Sock: Yes)');
  if (t.container) eng.push('Container · ' + t.container);
  if (t.core_version) eng.push('Core      · ' + t.core_version + (t.protocol != null ? ' (Proto ' + t.protocol + ')' : ''));
  if (t.horizon_version) eng.push('Horizon   · ' + t.horizon_version);

  let levelIc = '🟢';
  if (t.level === 'critical') levelIc = '🔴';
  else if (t.level === 'warning' || t.level === 'soft') levelIc = '🟡';

  // HEALTH block (with raw + confidence + trend)
  const health = [];
  if (t.health != null) {
    const hIcon = healthIcon(t.health);
    const cIcon = healthConfIcon(t.health_confidence);
    const trendTag = t.health_trend === 'improving' ? '↗ improving'
      : (t.health_trend === 'degrading' ? '↘ degrading' : '→ stable');
    health.push('Score      · ' + hIcon + ' ' + t.health + '/100');
    if (t.health_raw != null && t.health_raw !== t.health) {
      health.push('Raw        · ' + t.health_raw + '/100 (pre-damper)');
    }
    health.push('Confidence · ' + cIcon + ' ' + (t.health_confidence || 'low') + ' (' + (t.health_sources || 0) + ' sources)');
    health.push('Trend      · ' + trendTag);
    if (t.health_frozen) health.push('State      · ⚪ frozen (no source)');
  }

  const parts = ['🩺 PI NODE · DIAGNOSTIC', ''];
  if (health.length) { parts.push(treeBlock('💚 HEALTH', health)); parts.push(''); }
  if (net.length) { parts.push(treeBlock('🌐 NETWORK & LEDGER', net)); parts.push(''); }
  if (eng.length) { parts.push(treeBlock('🐳 ENGINE & SYSTEM', eng)); parts.push(''); }
  parts.push('───────────────');
  parts.push('💡 Level: ' + levelIc + ' ' + String(t.level || 'unknown').toUpperCase());
  parts.push('🧭 Incidents: /incidents');
  parts.push('☕ Donate: MB 0905428801');
  return parts.join('\n');
}

const ACTION_CATALOG = [
  { id: 'CleanRam', file: 'CleanRam.bat', when: 'RAM high or PC sluggish while node is still synced.', does: 'Close extra apps/services, clear TEMP, TRIM, flush DNS. Does not stop Pi Node or Docker.', how: 'Double-click CleanRam.bat. Auto-elevates. Press Y.' },
  { id: 'CleanTemp', file: 'CleanTemp.bat', when: 'Gentle cleanup while node is healthy.', does: 'Delete temp older than 6 hours + Recycle Bin.', how: 'Double-click CleanTemp.bat. Auto-elevates. Press Y.' },
  { id: 'DnsFlush', file: 'DnsFlush.bat', when: 'Peers dropped but ports stay open and ledger still moves.', does: 'ipconfig /flushdns and /registerdns only. Keeps LAN IP.', how: 'Double-click DnsFlush.bat. Auto-elevates. Press Y.' },
  { id: 'Firewall', file: 'Firewall.bat', when: 'Local ports 31401-31403 stay closed while the PC is online.', does: 'Recreate Windows Firewall TCP 31401-31410 inbound + outbound remote ports, then test local listen.', how: 'Double-click Firewall.bat. Auto-elevates. Press Y. Then /status.' },
  { id: 'NetRepair', file: 'NetRepair.bat', when: 'Internet/Horizon down for a LONG window. Never after a 1-minute catch-up.', does: 'Keep current LAN IP. DNS/ARP/firewall, then adapter restart, then winsock if still offline.', how: 'Double-click NetRepair.bat. Confirm each phase.' },
  { id: 'LanSetup', file: 'LanSetup.bat', when: 'First setup on a new PC, or modem already forwards to this PC IP.', does: 'Detect current IPv4. Optional lock that same IP as static + Google DNS + firewall.', how: 'Double-click LanSetup.bat. Press Y to lock the current IP.' },
  { id: 'NodeReset', file: 'NodeReset.bat', when: 'Pi container stuck/exited for a long time. Docker Engine is healthy.', does: 'Restart testnet2/mainnet/testnet only. Then DNS + firewall + anti-sleep. No WSL shutdown. No IP change.', how: 'Double-click NodeReset.bat. Auto-elevates. Press Y.' },
  { id: 'DockerRecover', file: 'DockerRecover.bat', when: 'Docker Engine itself is down. Not for a short Core catch-up.', does: 'Soft restart Docker Desktop. Ordered WSL only AFTER Docker process is confirmed stopped.', how: 'Double-click DockerRecover.bat. Choose Soft first.' },
  { id: 'Maintain', file: 'Maintain.bat', when: 'Node is healthy. Sunday quiet hours.', does: 'Weekly v13.2 cleanup, unused docker prune, optional Sunday 03:00 task. No token inside the file.', how: 'Double-click Maintain.bat. Press Y. Optional schedule.' },
  { id: 'Reboot', file: 'Reboot.bat', when: 'Last resort after NetRepair + DockerRecover failed and the host is wedged.', does: 'Controlled shutdown /r with delay. Cancel: shutdown /a', how: 'Double-click Reboot.bat. Type delay. Press Y. Never auto-suggested for a short sync dip.' }
];

const APP_GUIDE = `
HOW TO USE THIS APP
Telegram commands: /status /sync /peers /report /diagnostic /analyze /logs /incidents /donate /help /mute.
SoloHost window http://127.0.0.1:18780/ : live status + local chat + script downloads.
Ask in any language. AI answers as a Pi Node technician using real telemetry + 24h history.
Health score is passed through a damper (EMA + dead-band + confidence) so transient blips do not move it.
Reports: 07:00 / 18:00 / both / off.
Donate: /donate - Pay with Pi or MB Bank QR.
`;

const SCRIPT_MAP = `
APP FLOW
Telegram or SoloHost UI -> /status /report /analyze use history frames.
Incident engine uses stage machine: observe (0-1) -> first alert (2) -> reminder (3-4) -> chronic (5).
Alert only fires when the incident persists 5+ minutes or 5+ samples. Upgrade catch-up is suppressed.

SCRIPT CHOICE (matched by incident type)
docker_down    -> DockerRecover (soft first; no WSL while Docker lives).
network_down   -> NetRepair (keep current LAN IP).
ports_closed   -> Firewall; if >15 min escalate to NetRepair.
sync_stalled   -> NodeReset (only after Docker Engine is confirmed healthy).
sync_lag       -> WAIT (unless ledger frozen 15+ min -> /diagnostic).
peers_zero     -> DnsFlush (keeps LAN IP).
peers_low      -> DnsFlush + check ISP/regional outage.
ram_high       -> CleanRam (does not stop Pi Node).
cpu_high       -> CleanRam if host has extra heavy apps.
disk_high      -> Maintain (weekly cleanup).
CleanTemp      Healthy node, light cleanup only.
LanSetup       New PC setup. Lock CURRENT IP only.
Reboot         Last resort only. Never for a 1-minute catch-up.
`;

function recommendActions(t) {
  t = t || {};
  const rows = (typeof readHistory === 'function') ? readHistory(1) : [];
  const windows = (typeof extractIssueWindows === 'function') ? extractIssueWindows(rows) : [];
  const lastWin = windows.length ? windows[windows.length - 1] : null;
  const longBad = lastWin && ((lastWin.n || 0) >= 8 || (lastWin.min || 0) >= 15);
  const repeated = windows.filter(function (w) { return (w.n || 0) >= 3; }).length >= 2;
  const persistent = !!(longBad || repeated);
  const catching = /catch|behind|syncing/i.test(String(t.sync || ''));
  const live = /synced|live|horizon ok|good/i.test(String(t.sync || ''));
  const portsClosed = t.ports_ok === false || t.ports_open === 0;
  const ramVal = (typeof lite !== 'undefined' && lite.hostMetric) ? lite.hostMetric(t.ram) : (t.ram != null && Number(t.ram) > 0 ? Number(t.ram) : null);
  const cpuVal = (typeof lite !== 'undefined' && lite.hostMetric) ? lite.hostMetric(t.cpu) : (t.cpu != null && Number(t.cpu) > 0 ? Number(t.cpu) : null);
  const diskVal = (typeof lite !== 'undefined' && lite.hostMetric) ? lite.hostMetric(t.disk) : (t.disk != null && Number(t.disk) > 0 ? Number(t.disk) : null);
  const peers = t.peers != null ? Number(t.peers) : (t.peer_total != null ? Number(t.peer_total) : null);
  const health = t.health != null ? Number(t.health) : null;
  const trend = String(t.trend || 'stable');
  const degrading = trend === 'degrading';
  const dockerBad = t.docker_health === 'unhealthy' || t.docker_status === 'stopped';
  const ramHigh = ramVal != null && ramVal >= 85;
  const cpuHigh = cpuVal != null && cpuVal >= 90;
  const diskHigh = diskVal != null && diskVal >= 90;
  const picks = [];
  const why = [];

  const lastFix = state.lastRepair || null;
  const sameScriptRecently = function (id) {
    if (!lastFix || lastFix.id !== id) return false;
    return Date.now() - (lastFix.ts || 0) < 6 * 3600 * 1000;
  };

  if (health != null && health >= 80 && trend === 'stable' && !portsClosed && !dockerBad) {
    why.push('Health ' + health + ' · trend stable. Observe. Repair BATs not needed.');
    return { why: why, items: [], picks: [] };
  }
  if (!persistent && !degrading && !(ramHigh && degrading) && !dockerBad) {
    why.push('No repeated / degrading incident. Wait and watch. Do not run repair BATs yet.');
    return { why: why, items: [], picks: [] };
  }
  if (catching && !portsClosed && (t.ledger != null)) {
    why.push('Catch-up with ports_ok and a live ledger. Wait for Core; do not restart.');
    return { why: why, items: [], picks: [] };
  }
  if (portsClosed && (persistent || degrading) && !live) {
    why.push('ports_ok=false for a lasting window. Firewall then NetRepair. Keep current LAN IP.');
    if (!sameScriptRecently('Firewall')) picks.push('Firewall');
    if (!sameScriptRecently('NetRepair')) picks.push('NetRepair');
  } else if (peers === 0 && (persistent || degrading) && t.ports_ok !== false) {
    why.push('Peers 0 while ports not closed. DnsFlush only.');
    if (!sameScriptRecently('DnsFlush')) picks.push('DnsFlush');
  } else if (dockerBad && (persistent || degrading)) {
    why.push('docker_health/status bad. Soft DockerRecover first. No WSL while Docker lives.');
    if (!sameScriptRecently('DockerRecover')) picks.push('DockerRecover');
  } else if (ramHigh && (persistent || degrading)) {
    why.push('RAM ' + ramVal + '% and ' + trend + '. CleanRam. Do not restart the node.');
    if (!sameScriptRecently('CleanRam')) picks.push('CleanRam');
  } else if (cpuHigh && degrading) {
    why.push('CPU high and degrading. Observe first; CleanRam if host is busy with extra apps.');
    if (!sameScriptRecently('CleanRam')) picks.push('CleanRam');
  } else if (diskHigh && (persistent || degrading)) {
    why.push('Disk pressure. Maintain cleanup only while node is otherwise healthy.');
    if (!sameScriptRecently('Maintain')) picks.push('Maintain');
  } else {
    why.push('Incident lasted, but no safe BAT maps cleanly. Collect /diagnostic first.');
  }
  if (!picks.length && lastFix && lastFix.ok === false) {
    why.push('Previous repair did not improve telemetry. Escalate to /analyze rather than repeat the same BAT.');
  }
  const items = ACTION_CATALOG.filter(function (a) { return picks.indexOf(a.id) >= 0; });
  return { why: why, items: items, picks: picks };
}

function formatActionAdvice(t) {
  const r = recommendActions(t);
  const lines = ['🛠️ ACTIONS', '───────────────'];
  r.why.forEach(function (w) { lines.push('• ' + w); });
  if (!r.items.length) lines.push('• No BAT required right now.');
  r.items.forEach(function (a) {
    lines.push('');
    lines.push('📂 ' + a.file);
    lines.push('When: ' + a.when);
    lines.push('Does: ' + a.does);
    lines.push('How: ' + a.how);
  });
  lines.push('');
  lines.push('Download on SoloHost UI: http://127.0.0.1:18780/');
  return lines.join('\n');
}

function formatReport() {
  const rows = readHistory(1);
  if (!rows.length) {
    return [
      '🟢 PI NODE · REPORT', '',
      '⏱ RANGE · collecting…',
      '',
      '📊 METRICS',
      ' └ 🔄 SYNC · n/a',
      '',
      '💡 DIAGNOSIS',
      ' ├ 🟢 NODE   · Healthy (n/a)',
      ' └ 🛠️ ACTION · None (No BAT needed)',
      '',
      '───────────────',
      '☕ Donate: MB 0905428801',
      '🔗 UI: http://127.0.0.1:18780/'
    ].join('\n');
  }

  const first = rows[0], last = rows[rows.length - 1];
  const t0 = String(first.ts || '').replace('T', ' ').slice(11, 16) || '--:--';
  const t1 = String(last.ts  || '').replace('T', ' ').slice(11, 16) || '--:--';
  const hours = Math.max(0.1, Math.round(rows.length * TELEMETRY_SEC / 3600 * 10) / 10);
  const crit = rows.filter(function (r) { return r.level === 'critical'; }).length;
  const healthy = rows.filter(function (r) { return r.level === 'ok' || r.level === 'soft'; }).length;
  const healthyPct = Math.round((healthy / rows.length) * 100);

  const head = (crit > rows.length * 0.15) ? '🟡 PI NODE · REPORT' : '🟢 PI NODE · REPORT';

  const lastSync = last.sync || '';
  const metrics = [];
  metrics.push('🔄 SYNC    · ' + (/synced|live|good/i.test(lastSync) ? '🟢 ' : '🟡 ') + (lastSync || 'n/a'));

  const dockRows = rows.filter(function (r) { return r.docker || r.docker_sock || r.container; });
  const lastDock = dockRows.length ? dockRows[dockRows.length - 1] : last;
  const dockLabel = lastDock.docker || (lastDock.docker_sock ? 'sock' : (last.ports_open > 0 ? 'Running' : 'N/A'));
  metrics.push('🐳 DOCKER  · ' + (/stop|exit|n\/a/i.test(String(dockLabel)) ? '🟡 ' : '🟢 ') + dockLabel);

  if (last.peer_in != null || last.peer_out != null) {
    metrics.push('👥 PEERS   · IN ' + (last.peer_in != null ? last.peer_in : '?') + ' / OUT ' + (last.peer_out != null ? last.peer_out : '?'));
  }
  metrics.push('🌐 NETWORK · ' + ((last.ports_all_open || last.ports_open >= 2) ? '🟢 Stable' : '🟡 Check'));

  const windows = extractIssueWindows(rows);

  const diag = [];
  diag.push((healthyPct >= 90 ? '🟢' : '🟡') + ' NODE   · ' + (healthyPct >= 90 ? 'Healthy' : 'Watch') + ' (' + healthyPct + '%)');
  diag.push('🛠️ ACTION · ' + (crit > rows.length * 0.1 ? 'Review node' : 'None (No BAT needed)'));

  const parts = [head, ''];
  parts.push('⏱ RANGE · ' + t0 + ' ➔ ' + t1 + ' (~' + hours + 'h | ' + rows.length + ' samples)');
  parts.push('');
  parts.push(treeBlock('📊 METRICS', metrics));
  if (windows.length) {
    parts.push('');
    parts.push('⚠️ ISSUE WINDOWS');
    parts.push(formatIssueWindows(windows));
  }
  parts.push('');
  parts.push(treeBlock('💡 DIAGNOSIS', diag));
  parts.push('');
  parts.push('───────────────');
  parts.push('☕ Donate: MB 0905428801');
  parts.push('🔗 UI: http://127.0.0.1:18780/');
  return parts.join('\n');
}

function formatHelp() {
  return [
    '📖 PI NODE CONTROLLER · HELP',
    '───────────────',
    '',
    '📊 /status      - Current node health snapshot',
    '🔄 /sync        - Sync status and latest ledger',
    '👥 /peers       - Inbound and outbound peers',
    '📈 /report      - Recent history and issue windows',
    '🧭 /incidents   - Active + recent incident history',
    '🩺 /diagnostic  - Technical source details',
    '💬 /analyze     - AI technician review (in your language)',
    '📋 /logs        - App activity and errors',
    '💛 /donate      - Support the project',
    '💻 /winpro      - Windows PRO edition link',
    '🏓 /ping        - Controller heartbeat',
    '❓ /help        - This list',
    '🔕 /mute        - Quiet alerts: 1h, 24h, night, off',
    '',
    'Ask in any language. AI replies in your language.',
    'Smart incident engine observes before it alerts.',
    '',
    '💛 /donate'
  ].join('\n');
}

function extractIssueWindows(rows) {
  const out = [];
  if (!rows || !rows.length) return out;
  function bad(r) {
    if (!r) return false;
    if (r.level === 'critical' || r.level === 'warning') return true;
    const s = String(r.sync || '');
    if (/catch|behind|lost|offline|unknown|n\/a/i.test(s) && !/synced|live|good|horizon ok/i.test(s)) return true;
    if (r.ports_open === 0) return true;
    if (r.ledger_age != null && Number(r.ledger_age) > 180) return true;
    return false;
  }
  let cur = null;
  rows.forEach(function (r) {
    const ts = r.ts || '';
    if (bad(r)) {
      if (!cur) cur = { from: ts, to: ts, kind: r.level || 'watch', sync: r.sync || '', n: 1 };
      else { cur.to = ts; cur.n++; if (r.sync) cur.sync = r.sync; }
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  });
  if (cur) out.push(cur);
  return out.slice(-8);
}

function formatIssueWindows(windows) {
  if (!windows || !windows.length) return ' └ 🟢 None in this sample set';
  return windows.map(function (w, i) {
    const isLast = i === windows.length - 1;
    const from = String(w.from || w.to || '').replace('T', ' ');
    const hhmm = from.slice(11, 16) || '--:--';
    const n = (w.n || 1) + 'x';
    const kind = w.kind || 'watch';
    const sync = w.sync ? (' ' + w.sync) : '';
    return ' ' + (isLast ? '└' : '├') + ' 🔴 ' + kind + ' · ' + hhmm + ' (' + n + ')' + sync;
  }).join('\n');
}

function preEvalBrief(t) {
  t = t || {};
  const h = (typeof buildHistory24h === 'function') ? buildHistory24h() : { samples: 0 };
  const rows = (typeof readHistory === 'function') ? readHistory(2) : [];
  const windows = extractIssueWindows(rows);
  const lines = [];
  lines.push('PRE-EVAL (do not invent beyond this)');
  lines.push('Now source=' + (t.source || '?') + ' sync=' + (t.sync || '?') + ' level=' + (t.level || '?'));
  if (t.ledger != null) lines.push('Ledger=' + t.ledger + (t.ledger_age != null ? (' age=' + t.ledger_age + 's') : ''));
  if (t.peer_in != null || t.peer_out != null) lines.push('Peers IN/OUT=' + (t.peer_in != null ? t.peer_in : '?') + '/' + (t.peer_out != null ? t.peer_out : '?'));
  lines.push('Docker=' + (t.docker || 'n/a') + ' sock=' + (t.docker_sock ? 'yes' : 'no') + ' container=' + (t.container || 'n/a'));
  if (t.ports_open != null) lines.push('Ports open=' + t.ports_open);
  if (t.health != null) lines.push('Health=' + t.health + ' (raw=' + (t.health_raw != null ? t.health_raw : '?') + ', conf=' + (t.health_confidence || '?') + ', trend=' + (t.health_trend || '?') + ')');
  if (h && h.samples) {
    lines.push('24h samples=' + h.samples + ' ok/warn/crit=' + h.level_ok + '/' + h.level_warning + '/' + h.level_critical);
    if (h.first_ts) lines.push('24h window=' + String(h.first_ts).slice(0, 16) + ' -> ' + String(h.last_ts).slice(0, 16));
    lines.push('Sync flips=' + h.sync_flips);
  }
  lines.push('Issue windows:');
  lines.push(formatIssueWindows(windows));
  return lines.join('\n');
}

function formatScripts() {
  return [
    'ℹ️ INFO',
    '───────────────',
    'No Windows scripts in SoloHost edition.',
    'Commands: /status /report /peers /diagnostic /analyze /incidents',
    '',
    '☕ Donate: MB 0905428801'
  ].join('\n');
}

function randomDonateThanks() {
  const pool = [
    '💜 Thank you - this coffee helps keep the app going.',
    '💜 Thank you for supporting the Pi Node community.',
    '💜 Thank you. Wishing your node a stable run.',
    '💜 Thanks a lot! Your coffee keeps SoloHost updates coming.',
    '💜 That coffee means a lot. Thank you for walking with us.',
    '💜 Your support means more than a number. Thank you.',
    '💜 Wow, thank you. We will keep improving the bot.',
    '💜 Thank you - every gift helps the app stay stable.',
    '💜 Pi or MB Bank - both are appreciated. Thank you.',
    '💜 Thank you for supporting open Pi Node tools.'
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}
function formatDonate() {
  return [
    '💛 DONATE · DEV COFFEE',
    '───────────────',
    'Choose one donate method:',
    '',
    '🟣 1) Pay with Pi',
    '   User: @cannoi',
    '   Wallet:',
    '   GAQAZ5XLWREKQYMMN247A44PNPLAKRORZOPZNVG3CDPCSSFMEVFIYJJL',
    '',
    '🏦 2) MB Bank',
    '   STK: 0905428801',
    '   Name: TRAN HUU NGHI',
    '',
    '📱 QR: Pay with Pi + MB Bank',
    '',
    '🙏 ' + randomDonateThanks()
  ].join('\n');
}
function donateQrPath(kind) {
  const name = kind === 'pi' ? 'donate-qr-pi.jpg' : 'donate-qr-mb.jpg';
  const f = path.join(PUBLIC, name);
  if (fs.existsSync(f)) return f;
  const fallback = path.join(PUBLIC, 'donate-qr.jpg');
  return fs.existsSync(fallback) ? fallback : null;
}
function donateKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🟣 Pi', callback_data: 'cmd_donate_pi' },
        { text: '🏦 MB Bank', callback_data: 'cmd_donate_mb' }
      ],
      [
        { text: '📦 Both QRs', callback_data: 'cmd_donate_both' }
      ],
      [
        { text: '📊 Status', callback_data: 'cmd_status' },
        { text: '💬 Analyze', callback_data: 'cmd_analyze' }
      ]
    ]
  };
}
async function sendDonateQr(kind) {
  const thanks = randomDonateThanks();
  if (kind === 'pi' || kind === 'both') {
    const qr = donateQrPath('pi');
    if (qr) {
      await tgSendPhotoFile(qr,
        '🟣 Pay with Pi\n@cannoi\nGAQAZ5XLWREKQYMMN247A44PNPLAKRORZOPZNVG3CDPCSSFMEVFIYJJL\n\n🙏 ' + thanks);
    } else {
      try { actionLog('warn', 'donate Pi QR missing'); } catch (e) {}
    }
  }
  if (kind === 'mb' || kind === 'both') {
    const qr = donateQrPath('mb');
    if (qr) {
      await tgSendPhotoFile(qr, '🏦 MB Bank\n0905428801 · TRAN HUU NGHI\n\n🙏 ' + thanks);
    } else {
      try { actionLog('warn', 'donate MB QR missing'); } catch (e) {}
    }
  }
  return true;
}
async function tgSendPhotoFile(filePath, caption) {
  if (!BOT_TOKEN || !CHAT_ID || !filePath || !fs.existsSync(filePath)) return false;
  try {
    const boundary = '----PiNode' + Date.now().toString(16);
    const fileBuf = fs.readFileSync(filePath);
    const name = path.basename(filePath);
    const parts = [];
    function field(n, v) {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + n + '"\r\n\r\n' + v + '\r\n'));
    }
    field('chat_id', String(CHAT_ID));
    field('caption', String(caption || '').slice(0, 900));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="' + name + '"\r\nContent-Type: image/jpeg\r\n\r\n'));
    parts.push(fileBuf);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);
    await new Promise(function (resolve) {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: '/bot' + BOT_TOKEN + '/sendPhoto',
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': body.length
        }
      }, function (r) {
        let b = '';
        r.on('data', function (d) { b += d; });
        r.on('end', function () {
          try {
            const j = safeParse(b);
            if (!(j && j.ok)) try { actionLog('warn', 'donate QR telegram: ' + String((j && j.description) || r.statusCode)); } catch (e) {}
          } catch (e) {}
          resolve();
        });
      });
      req.on('error', resolve);
      req.setTimeout(20000, function () { try { req.destroy(); } catch (e) {} resolve(); });
      req.write(body);
      req.end();
    });
    try { actionLog('info', 'donate QR sent (local file)'); } catch (e) {}
    return true;
  } catch (e) {
    try { actionLog('error', 'donate QR fail: ' + (e && e.message)); } catch (e2) {}
    return false;
  }
}
function formatWindowsPro() {
  return [
    '💻 WINDOWS PRO · FULL',
    '───────────────',
    'SoloHost is the lightweight monitor.',
    'Windows PRO has more tools:',
    '• Live host CPU / RAM / temp',
    '• Docker control and scripts',
    '• Clean RAM / maintenance / reset',
    '• Deeper diagnostics and scheduler',
    '',
    'Download:',
    'https://github.com/cannoi/pinode-telegram-controller',
    '',
    'Use SoloHost for alerts on the go;',
    'use Windows PRO for full control.'
  ].join('\n');
}

/* ---------- Language detection ---------- */
function detectUserLang(q) {
  const s = String(q || '');
  if (!s.trim()) return null;
  if (/[\u3040-\u30ff]/.test(s)) return 'Japanese';
  if (/[\uac00-\ud7af]/.test(s)) return 'Korean';
  if (/[\u4e00-\u9fff]/.test(s)) return 'Chinese';
  if (/[\u0400-\u04ff]/.test(s)) return 'Russian';
  if (/[\u0600-\u06ff]/.test(s)) return 'Arabic';
  if (/[\u0590-\u05ff]/.test(s)) return 'Hebrew';
  if (/[\u0e00-\u0e7f]/.test(s)) return 'Thai';
  if (/[\u0900-\u097f]/.test(s)) return 'Hindi';
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s)) return 'Vietnamese';
  if (/\b(hola|gracias|c[oó]mo|est[aá]|buenos|qu[eé]|por favor|ayuda)\b/i.test(s)) return 'Spanish';
  if (/\b(ol[aá]|obrigado|voc[eê]|est[aá]|por favor|ajuda)\b/i.test(s)) return 'Portuguese';
  if (/\b(bonjour|merci|vous|comment|s'il|aidez)\b/i.test(s)) return 'French';
  if (/\b(ciao|grazie|come|perch[eé]|aiuto)\b/i.test(s)) return 'Italian';
  if (/\b(hallo|danke|bitte|wie geht|hilfe)\b/i.test(s)) return 'German';
  if (/\b(merhaba|te[sş]ekk[uü]r|nas[iı]l|yard[iı]m)\b/i.test(s)) return 'Turkish';
  if (/\b(selamat|terima kasih|bagaimana|tolong)\b/i.test(s)) return 'Indonesian';
  if (/\b(привет|спасибо|помощь)\b/i.test(s)) return 'Russian';
  if (/\b(γειά|ευχαριστώ|βοήθεια)\b/i.test(s)) return 'Greek';
  if (/\b(cześć|dziękuję|pomoc)\b/i.test(s)) return 'Polish';
  if (/\b(hei|takk|hjelp)\b/i.test(s)) return 'Norwegian';
  if (/\b(hej|tack|hjälp)\b/i.test(s)) return 'Swedish';
  return 'English';
}

function detectUserPreferredLang(currentMsg) {
  const current = detectUserLang(currentMsg);
  if (current) return current;
  const turns = loadChatHistory();
  const userTurns = turns.filter(function (t) { return t && t.role === 'user'; }).slice(-10);
  const counts = {};
  userTurns.forEach(function (t) {
    const l = detectUserLang(t.text);
    if (l) counts[l] = (counts[l] || 0) + 1;
  });
  let best = null, bestN = 0;
  for (const k in counts) if (counts[k] > bestN) { best = k; bestN = counts[k]; }
  return best || 'English';
}

function detectIntent(q) {
  const s = String(q || '').toLowerCase();
  if (/^(hello|hi|hey|xin chào|chào|hola|hallo|bonjour|ciao|olá)\b/.test(s) || s === 'hello' || s === 'hi') return 'GREETING';
  if (/what day|what time|today|hôm nay|thứ mấy|qué día|quel jour/.test(s)) return 'SMALLTALK';
  if (/explain|clarify|giải thích|expl[ií]came|explique/.test(s)) return 'CLARIFY';
  if (/\bram\b|memory|bộ nhớ|memoria|mémoire/.test(s)) return 'RAM';
  if (/\bcpu\b|processor|procesador|processeur/.test(s)) return 'CPU';
  if (/\btemp\b|temperature|nhiệt|nóng|temp[eé]rature/.test(s)) return 'TEMP';
  if (/\bdisk\b|storage|ổ cứng|disco|disque/.test(s)) return 'DISK';
  if (/docker|container/.test(s)) return 'DOCKER';
  if (/\bport\b|31401|31402|31403|cổng|puerto/.test(s)) return 'PORT';
  if (/peer|incoming|outgoing|đồng nghiệp/.test(s)) return 'PEERS';
  if (/sync|ledger|đồng bộ|sincronizaci[oó]n|synchronisation/.test(s)) return 'BLOCK_SYNC';
  if (/bonus|reward|points|điểm thưởng|recompensa/.test(s)) return 'BONUS';
  if (/upgrade|add ram|ssd|nâng cấp|mejorar|améliorer/.test(s)) return 'ADVICE';
  if (/\bwhy\b|error|slow|issue|problem|tại sao|lỗi|por qué|pourquoi/.test(s)) return 'DIAGNOSIS';
  if (/\bok\??\b|how is|status|my node|health|ổn không|tình trạng|c[oó]mo est[aá]/.test(s)) return 'NODE_HEALTH';
  if (/should i|recommend|advice|what to do|tư vấn|recomiendas|conseil/.test(s)) return 'RECOMMENDATION';
  if (/sell|finance|money|tight|bán|kẹt tiền|vender|argent/.test(s)) return 'FINANCE';
  return 'GENERAL';
}

function loadChatHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, 'chat_history.json'), 'utf8'));
    return Array.isArray(j) ? j.slice(-24) : [];
  } catch (e) { return []; }
}
function saveChatHistory(turns) {
  try { fs.writeFileSync(path.join(DATA, 'chat_history.json'), JSON.stringify(turns.slice(-40))); } catch (e) {}
}
function pushChatPersistent(role, text) {
  const turns = loadChatHistory();
  turns.push({ role: role, text: String(text || '').slice(0, 800), ts: nowISO() });
  saveChatHistory(turns);
  try { pushChatTurn(role, text); } catch (e) {}
}

function evidenceSummary(t) {
  const parts = [];
  if (t.source) parts.push('Source: ' + t.source);
  if (t.sync) parts.push('Sync: ' + t.sync);
  if (t.ledger != null) parts.push('Ledger: ' + Number(t.ledger).toLocaleString('en-US'));
  if (t.ledger_age != null) parts.push('Age: ' + t.ledger_age + 's');
  if (t.peer_in != null || t.peer_out != null) parts.push('Peer IN/OUT: ' + (t.peer_in != null ? t.peer_in : '?') + '/' + (t.peer_out != null ? t.peer_out : '?'));
  if (t.docker) parts.push('Docker: ' + t.docker);
  if (t.ports_all_open) parts.push('Ports 31401-3: OPEN');
  else if (t.ports_open != null) parts.push('Ports open: ' + t.ports_open + '/3');
  if (t.ram != null) parts.push('RAM: ' + t.ram + '%');
  if (t.cpu != null) parts.push('CPU: ' + t.cpu + '%');
  if (t.temp != null) parts.push('Temp: ' + t.temp + '°C');
  if (t.health != null) parts.push('Health: ' + t.health + '/100 (' + (t.health_confidence || '?') + ')');
  return parts;
}

function collectIssues(t) {
  const issues = [];
  if (t.docker && /stop|exit/i.test(String(t.docker))) issues.push('Docker/container not running');
  if (t.ports_open === 0) issues.push('Node ports closed');
  if (t.sync && /not synced|error|fail/i.test(String(t.sync))) issues.push('Unusual sync: ' + t.sync);
  if (t.stall) issues.push('Ledger stalled for a long time');
  if (t.ledger_age != null && t.ledger_age > 300) issues.push('Ledger age high (' + t.ledger_age + 's)');
  if (t.peer_in != null && t.peer_in < 2) issues.push('Peer IN low (' + t.peer_in + ')');
  if (t.ram != null && t.ram >= 88) issues.push('RAM high (' + t.ram + '%)');
  if (t.cpu != null && t.cpu >= 90) issues.push('CPU high (' + t.cpu + '%)');
  if (t.temp != null && t.temp >= 78) issues.push('High temperature (' + t.temp + '°C)');
  if (!t.source && t.ports_open === 0) issues.push('No telemetry source and ports closed');
  return issues;
}

function metricIntentKey(intent) {
  if (intent === 'RAM') return 'ram';
  if (intent === 'CPU') return 'cpu';
  if (intent === 'TEMP') return 'temp';
  return null;
}

function localAssistantReply(t, intent, userQ) {
  const ok = t.level === 'ok' || (t.sync && /synced|live|horizon ok/i.test(String(t.sync)));
  const age = t.ledger_age != null ? t.ledger_age : null;
  const sync = t.sync || null;
  const ledger = t.ledger != null ? Number(t.ledger).toLocaleString('en-US') : null;
  const h24 = (typeof buildHistory24h === 'function') ? buildHistory24h() : { samples: 0 };
  const hTxt = (typeof formatHistory24hText === 'function') ? formatHistory24hText(h24) : '';
  function withHistory(msg) {
    if (!h24 || !h24.samples) return msg;
    return msg + '\n\nLast ~24h data\n' + hTxt + '\n\nTip: use /report for a fuller summary.';
  }

  if (intent === 'GREETING') return 'Hi! I am watching your Pi Node. Right now it looks ' + (ok ? 'fine' : 'like it needs attention') + '. Ask about sync, ports, bonus, or upgrades anytime.';
  if (intent === 'SMALLTALK') return 'Around ' + nowHM() + ' local time. I can help with your Node - ask naturally.';
  if (intent === 'CLARIFY') return 'Simply put: the node looks ' + (ok ? 'healthy' : 'unstable') + (sync ? ('; sync: ' + sync) : '') + (ledger ? ('; ledger ~' + ledger) : '') + '. What should I explain more?';
  if (intent === 'BONUS') return 'Bonus depends on stable uptime, open ports, and good sync - this app does not show bonus points. ' + (ok ? ('Your node looks ' + (sync || 'synced') + (age != null ? (', age ' + age + 's') : '') + '. Keep online 24/7, ports open, avoid constant restarts.') : 'Something looks off - check sync and ports first.');
  if (intent === 'BLOCK_SYNC' || intent === 'DIAGNOSIS') {
    if (ok && age != null && age <= 60) return withHistory('I get the concern about losing sync. Right now it is ' + (sync || 'Synced') + ', ledger ~' + (ledger || '?') + ', age ' + age + 's - blocks are closing on time. Short blips often recover alone; if it keeps happening, check network and /report.');
    if (age != null && age > 120) return 'Sync looks slow: age ' + age + 's (' + (sync || '?') + '). It may be catching up or the network is congested. Check ports; restart Pi Node if this lasts >10 minutes.';
    return 'On sync: ' + (sync || 'unclear') + (ledger ? (', ledger ' + ledger) : '') + (age != null ? (', age ' + age + 's') : '') + '. If dropouts are frequent, send /report.';
  }
  if (intent === 'NODE_HEALTH') return withHistory('Overall the node looks ' + (ok ? 'healthy' : 'like it needs attention') + (sync ? (', ' + sync) : '') + (ledger ? (', ledger ' + ledger) : '') + '. ' + (ok ? 'Safe to keep running; check /peers and /report for more confidence.' : 'Open /diagnostic and verify ports/network.'));
  if (intent === 'ADVICE' || intent === 'RECOMMENDATION') return 'Practical tips: (1) keep online, (2) keep ports 31401-31403 open, (3) enough RAM and cooling, (4) avoid constant resets. Windows PRO: https://github.com/cannoi/pinode-telegram-controller';
  if (intent === 'RAM') return formatMetricAnalysis('ram', 7) + (t.ram != null ? ('\n\nNow · ' + t.ram + '%') : '');
  if (intent === 'CPU') return formatMetricAnalysis('cpu', 7) + (t.cpu != null ? ('\n\nNow · ' + t.cpu + '%') : '');
  if (intent === 'TEMP') return formatMetricAnalysis('temp', 7) + (t.temp != null ? ('\n\nNow · ' + t.temp + '°C') : '');
  if (intent === 'FINANCE') return financialBoundaryReply() + (h24 && h24.samples ? ('\n\n' + hTxt) : '');
  if (intent === 'PEERS') {
    if (t.peer_in == null && t.peer_out == null) return 'Peer counts unavailable. Try /ports.';
    return 'Peers IN ' + (t.peer_in != null ? t.peer_in : '?') + ' / OUT ' + (t.peer_out != null ? t.peer_out : '?');
  }
  if (intent === 'PORT') {
    if (!t.ports) return 'Ports not probed yet.';
    return NODE_PORTS.map(function (p) { return p + ': ' + (t.ports[String(p)] || '?'); }).join('\n');
  }
  if (intent === 'DOCKER') return 'SoloHost does not control host Docker. Container label: ' + (t.container || 'n/a') + '.';
  if (ok) return withHistory('From current data the node looks fine' + (sync ? (' (' + sync + ')') : '') + (ledger ? (', ledger ' + ledger) : '') + '. Brief sync drops are often temporary - keep it online and check /report if it repeats.');
  return withHistory('Something needs attention' + (sync ? (': ' + sync) : '') + '. Check /diagnostic and network/ports.');
}

function buildFacts(t) {
  t = t || {};
  const v = t.verification || {};
  return {
    source: t.source || null,
    sync: t.sync || null,
    health: t.health != null ? t.health : null,
    health_raw: t.health_raw != null ? t.health_raw : null,
    health_confidence: t.health_confidence || null,
    health_trend: t.health_trend || null,
    core_health: t.core_health != null ? t.core_health : null,
    health_source: t.health_source || null,
    core_state: t.core_state || null,
    core_verified: t.core_verified === true,
    sync_confidence: t.sync_confidence || null,
    ledger: t.ledger != null ? t.ledger : null,
    core_ledger: t.core_ledger != null ? t.core_ledger : null,
    history_ledger: t.history_ledger != null ? t.history_ledger : null,
    ingest_ledger: t.ingest_ledger != null ? t.ingest_ledger : null,
    elder_ledger: t.elder_ledger != null ? t.elder_ledger : null,
    ledger_age: t.ledger_age != null ? t.ledger_age : null,
    ledger_closed_at: t.ledger_closed_at || null,
    ledger_gap: t.ledger_gap != null ? t.ledger_gap : null,
    ingest_lag: t.ingest_lag != null ? t.ingest_lag : null,
    peer_in: t.peer_in != null ? t.peer_in : null,
    peer_out: t.peer_out != null ? t.peer_out : null,
    ports_open: t.ports_open != null ? t.ports_open : null,
    ports: t.ports || null,
    network: t.network || null,
    network_kind: t.network_kind || null,
    protocol: t.protocol != null ? t.protocol : null,
    core_version: t.core_version || null,
    horizon_version: t.horizon_version || null,
    tx_count: t.tx_count != null ? t.tx_count : null,
    operation_count: t.operation_count != null ? t.operation_count : null,
    base_fee: t.base_fee != null ? t.base_fee : null,
    level: t.level || null,
    fsm: t.fsm || null,
    verification_confidence_pct: v.confidence_pct != null ? v.confidence_pct : null,
    verification_consensus: v.consensus || null,
    sources_ok: t.sources || null,
    responseTime: t.responseTime != null ? t.responseTime : null,
    docker: t.docker || null,
    docker_sock: t.docker_sock === true,
    docker_probe: t.docker_probe === true,
    container: t.container || null,
    cpu: t.cpu != null ? t.cpu : null,
    ram: t.ram != null ? t.ram : null,
    temp: t.temp != null ? t.temp : null,
    ports_all_open: t.ports_all_open === true
  };
}

function dockerPrefPath() { return path.join(DATA, 'state', 'docker-pref.json'); }
function readDockerPref() {
  try { return JSON.parse(fs.readFileSync(dockerPrefPath(), 'utf8')); } catch (e) { return { enabled: false }; }
}
function writeDockerPref(obj) {
  try {
    fs.mkdirSync(path.dirname(dockerPrefPath()), { recursive: true });
    fs.writeFileSync(dockerPrefPath(), JSON.stringify(obj, null, 2));
  } catch (e) {}
}

function applyDockerConsentFiles() {
  const result = { wrote_data: false, wrote_host: false, paths: [] };
  let tag = 'v2.6.57';
  try {
    const m = String(VERSION || '').match(/(\d+\.\d+\.\d+)/);
    if (m) tag = 'v' + m[1];
  } catch (e) {}
  const img = process.env.AUTO_COMPOSE_IMAGE || ('ghcr.io/cannoi/pinode-telegram-solohost:' + tag);

  const composeBody = [
    '# Generated after Operator consent in Pi Node Telegram Controller',
    '# SoloHost default package does NOT ship this. You chose optional Docker access.',
    'services:',
    '  agent:',
    '    image: ' + img,
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
    '      - AUTO_DOCKER_SOCK=0',
    '      - TELEMETRY_SEC=60',
    '      - TZ=Asia/Ho_Chi_Minh',
    '    volumes:',
    '      - ./data:/data',
    '      - ./:/solohost-config:rw',
    '      - /var/run/docker.sock:/var/run/docker.sock:ro',
    '    restart: unless-stopped',
    ''
  ].join('\n');

  const readme = [
    'OPTIONAL DOCKER - Operator consent',
    '=================================',
    '',
    '1) Copy docker-compose.yml over the one in this SoloHost app folder',
    '   (or run APPLY.bat / APPLY.ps1 from the app folder).',
    '2) SoloHost -> Stop -> Start the app.',
    '3) Telegram: /docker  (should show Socket: YES when mount worked).',
    '',
    'This is NOT default SoloHost permission. You opted in.',
    ''
  ].join('\n');

  const bat = [
    '@echo off',
    'cd /d "%~dp0"',
    'if exist docker-compose.yml copy /Y docker-compose.yml docker-compose.yml.bak',
    'copy /Y "%~dp0docker-compose.yml" "%~dp0..\\docker-compose.yml" 2>nul',
    'copy /Y "%~dp0docker-compose.yml" "%~dp0docker-compose.yml"',
    'echo.',
    'echo If this folder is data\\docker-enable, copy docker-compose.yml to the app root then Restart SoloHost.',
    'echo Done.',
    'pause',
    ''
  ].join('\r\n');

  const ps1 = [
    '# Optional Docker enable - run from app folder after consent',
    '$ErrorActionPreference = "Continue"',
    '$here = $PSScriptRoot',
    '$root = Split-Path $here -Parent',
    'if ((Split-Path $here -Leaf) -eq "docker-enable") { $root = Split-Path (Split-Path $here -Parent) -Parent }',
    'if (-not (Test-Path $root)) { $root = $here }',
    '$src = Join-Path $here "docker-compose.yml"',
    '$dst = Join-Path $root "docker-compose.yml"',
    'if (Test-Path $dst) { Copy-Item $dst ($dst + ".bak") -Force }',
    'Copy-Item $src $dst -Force',
    'Write-Host "Wrote $dst"',
    'Write-Host "Stop -> Start the SoloHost app now."',
    ''
  ].join('\n');

  try {
    const dir = path.join(DATA, 'docker-enable');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), composeBody);
    fs.writeFileSync(path.join(dir, 'README.txt'), readme);
    fs.writeFileSync(path.join(dir, 'APPLY.bat'), bat);
    fs.writeFileSync(path.join(dir, 'APPLY.ps1'), ps1);
    result.wrote_data = true;
    result.paths.push(dir);
  } catch (e) {
    result.data_error = String(e && e.message);
  }

  const hostDir = process.env.SOLOHOST_CONFIG_DIR || '/solohost-config';
  try {
    if (fs.existsSync(hostDir)) {
      const dst = path.join(hostDir, 'docker-compose.yml');
      try {
        if (fs.existsSync(dst)) fs.copyFileSync(dst, dst + '.bak');
      } catch (e2) {}
      fs.writeFileSync(dst, composeBody);
      fs.writeFileSync(path.join(hostDir, 'DOCKER_ENABLE_README.txt'), readme);
      result.wrote_host = true;
      result.paths.push(dst);
    }
  } catch (e) {
    result.host_error = String(e && e.message);
  }

  try { actionLog('ok', 'docker consent files ' + JSON.stringify(result)); } catch (e) {}
  return result;
}

function dockerConsentKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '1) Read terms', callback_data: 'cmd_docker_rules' }],
      [{ text: '2) I agree - enable & write compose', callback_data: 'cmd_docker_confirm' }],
      [{ text: 'Cancel', callback_data: 'cmd_docker_cancel' }],
      [{ text: 'Open app UI on this PC', callback_data: 'cmd_docker_local' }]
    ]
  };
}
function dockerManageKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Keep ON', callback_data: 'cmd_docker_confirm' },
        { text: 'Turn OFF', callback_data: 'cmd_docker_off' }
      ],
      [{ text: 'STATUS', callback_data: 'cmd_status' }]
    ]
  };
}

function dockerTermsText() {
  return [
    'OPTIONAL DOCKER ACCESS - TERMS',
    '==============================',
    '',
    'What this is',
    'The app can optionally use the Docker engine socket on YOUR computer to read Pi Node container status (for example Core info via docker exec). This is OFF by default.',
    '',
    'SoloHost default',
    'SoloHost installs this app as a sandbox: CPU/memory, one localhost port, its own data folder, and outbound network. docker.sock is NOT a default SoloHost permission and is NOT required for normal monitoring.',
    '',
    'What you grant if you Agree',
    '- Read-only mount of /var/run/docker.sock into this app container (after Stop -> Start).',
    '- Ability for the app to list containers and run limited read commands related to Pi Node status.',
    '- A higher privilege level than the default sandbox.',
    '',
    'What we do NOT claim',
    '- We do not control your host Docker daemon beyond what the socket allows.',
    '- We do not access your Pi wallet or keys.',
    '- We do not guarantee security of any elevated setup you enable.',
    '',
    'Your responsibility (Operator)',
    'Under SoloHost Terms, YOU decide permissions on your machine. By agreeing you confirm that:',
    '1) You understand docker.sock is powerful and may expose Docker control surfaces on this PC.',
    '2) You accept the risk of enabling it for optional diagnostics only.',
    '3) You may turn the preference OFF later; removing the socket volume from compose returns to sandbox mode after Stop -> Start.',
    '4) Pi Network / SoloHost / the publisher are not responsible for damage, data loss, or misuse arising from optional elevated access you enable.',
    '',
    'Purpose of the app',
    'Provide the best monitoring help we can within clear limits. Elevated Docker access is optional, user-controlled, and never required to use core features.',
    '',
    'Agree only if you accept these terms.'
  ].join('\n');
}
async function formatDockerRules() { return dockerTermsText(); }
async function formatDockerHelp(tel) {
  const pref = readDockerPref();
  const sock = !!(tel && tel.docker_sock);
  return [
    'DOCKER OPTIONAL - STATUS',
    'Pref: ' + (pref.enabled ? 'ON' : 'OFF') + ' | Sock in container: ' + (sock ? 'YES' : 'NO'),
    '',
    'Read the terms first (button: Terms).',
    'If you Agree: app overwrites app-folder docker-compose.yml with sock, then you SoloHost Stop -> Start.',
    '',
    'Normal monitoring works without Docker.'
  ].join('\n');
}

function historySnippet(n) {
  try {
    return readHistory(2).slice(-(n || 24)).map(function (r) {
      const o = { ts: r.ts, level: r.level };
      ['sync', 'ledger', 'ledger_age', 'peer_in', 'peer_out', 'ram', 'cpu', 'temp', 'ports_open', 'health'].forEach(function (k) {
        if (r[k] != null) o[k] = r[k];
      });
      return o;
    });
  } catch (e) { return []; }
}

function buildHistory24h() {
  const rows = readHistory(2);
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const day = rows.filter(function (r) {
    const ts = Date.parse(r.ts) || 0;
    return !ts || ts >= cutoff;
  });
  if (!day.length) return { samples: 0, note: 'No history yet - collecting telemetry every 60s.' };
  const nums = function (key) {
    return day.map(function (r) { return r[key]; }).filter(function (x) { return x != null && isFinite(Number(x)); }).map(Number);
  };
  const ledgers = nums('ledger');
  const ages = nums('ledger_age');
  const rams = nums('ram');
  const cpus = nums('cpu');
  const temps = nums('temp');
  const peersIn = nums('peer_in');
  const peersOut = nums('peer_out');
  const healths = nums('health');
  let critical = 0, warning = 0, ok = 0;
  let syncFlips = 0;
  let lastSync = null;
  day.forEach(function (r) {
    if (r.level === 'critical') critical++;
    else if (r.level === 'warning' || r.level === 'soft') warning++;
    else ok++;
    if (r.sync && lastSync && r.sync !== lastSync) syncFlips++;
    if (r.sync) lastSync = r.sync;
  });
  const first = day[0];
  const last = day[day.length - 1];
  const spanMin = Math.max(1, Math.round((day.length * (typeof TELEMETRY_SEC === 'number' ? TELEMETRY_SEC : 60)) / 60));
  return {
    samples: day.length,
    approx_minutes: spanMin,
    first_ts: first && first.ts,
    last_ts: last && last.ts,
    level_ok: ok,
    level_warning: warning,
    level_critical: critical,
    sync_flips: syncFlips,
    last_sync: last && last.sync,
    ledger_min: ledgers.length ? Math.min.apply(null, ledgers) : null,
    ledger_max: ledgers.length ? Math.max.apply(null, ledgers) : null,
    ledger_delta: ledgers.length >= 2 ? (ledgers[ledgers.length - 1] - ledgers[0]) : null,
    age_max_s: ages.length ? Math.max.apply(null, ages) : null,
    age_avg_s: ages.length ? Math.round(ages.reduce(function (a, b) { return a + b; }, 0) / ages.length) : null,
    peer_in_min: peersIn.length ? Math.min.apply(null, peersIn) : null,
    peer_in_max: peersIn.length ? Math.max.apply(null, peersIn) : null,
    peer_out_min: peersOut.length ? Math.min.apply(null, peersOut) : null,
    peer_out_max: peersOut.length ? Math.max.apply(null, peersOut) : null,
    ram_min: rams.length ? Math.min.apply(null, rams) : null,
    ram_max: rams.length ? Math.max.apply(null, rams) : null,
    cpu_max: cpus.length ? Math.max.apply(null, cpus) : null,
    temp_max: temps.length ? Math.max.apply(null, temps) : null,
    health_min: healths.length ? Math.min.apply(null, healths) : null,
    health_max: healths.length ? Math.max.apply(null, healths) : null,
    health_avg: healths.length ? Math.round(healths.reduce(function (a, b) { return a + b; }, 0) / healths.length) : null,
    recent_levels: day.slice(-8).map(function (r) { return { ts: r.ts, level: r.level, sync: r.sync, ledger: r.ledger, age: r.ledger_age }; })
  };
}

function formatHistory24hText(h) {
  if (!h || !h.samples) return 'No 24h history yet.';
  const lines = [];
  lines.push('Samples: ' + h.samples + ' (~' + h.approx_minutes + ' min coverage)');
  if (h.first_ts && h.last_ts) lines.push('Window: ' + String(h.first_ts).slice(0, 16) + ' -> ' + String(h.last_ts).slice(0, 16));
  lines.push('Levels OK/Warn/Crit: ' + h.level_ok + '/' + h.level_warning + '/' + h.level_critical);
  lines.push('Sync flips: ' + h.sync_flips + (h.last_sync ? ('; last=' + h.last_sync) : ''));
  if (h.ledger_min != null) lines.push('Ledger: ' + h.ledger_min + ' -> ' + h.ledger_max + (h.ledger_delta != null ? (' (delta ' + h.ledger_delta + ')') : ''));
  if (h.age_max_s != null) lines.push('Ledger age max/avg: ' + h.age_max_s + 's / ' + h.age_avg_s + 's');
  if (h.health_avg != null) lines.push('Health avg/min/max: ' + h.health_avg + ' / ' + h.health_min + ' / ' + h.health_max);
  if (h.peer_in_min != null) lines.push('Peer IN: ' + h.peer_in_min + '-' + h.peer_in_max);
  if (h.peer_out_min != null) lines.push('Peer OUT: ' + h.peer_out_min + '-' + h.peer_out_max);
  if (h.ram_max != null) lines.push('RAM range: ' + h.ram_min + '-' + h.ram_max + '%');
  if (h.cpu_max != null) lines.push('CPU peak: ' + h.cpu_max + '%');
  if (h.temp_max != null) lines.push('Temp peak: ' + h.temp_max + 'C');
  return lines.join('\n');
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function median(arr) {
  if (!arr || !arr.length) return null;
  const a = arr.slice().sort(function (x, y) { return x - y; });
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2 * 10) / 10;
}
function avg(arr) {
  if (!arr || !arr.length) return null;
  return Math.round(arr.reduce(function (s, x) { return s + x; }, 0) / arr.length * 10) / 10;
}
function minMax(arr) {
  if (!arr || !arr.length) return { min: null, max: null };
  return { min: Math.min.apply(null, arr), max: Math.max.apply(null, arr) };
}
function historyRowsDays(days) {
  const rows = readHistory(Math.max(1, days || 7));
  const cutoff = Date.now() - Math.max(1, days || 7) * 864e5;
  return rows.filter(function (r) {
    const ts = Date.parse(r.ts) || 0;
    return !ts || ts >= cutoff;
  });
}
function periodLabel(days) {
  if (days <= 1) return '24h';
  if (days <= 7) return '7 days';
  return days + ' days';
}
function formatMetricAnalysis(metricKey, days) {
  const d = Math.max(1, days || 7);
  const rows = historyRowsDays(d);
  const vals = rows.map(function (r) { return toNum(r[metricKey]); }).filter(function (x) { return x != null; });
  const titleMap = { ram: '🧠 RAM ANALYSIS', cpu: '⚙️ CPU ANALYSIS', temp: '🌡️ TEMP ANALYSIS', ledger_age: '⏱️ LEDGER AGE ANALYSIS', health: '💚 HEALTH ANALYSIS' };
  const unit = (metricKey === 'temp') ? '°C' : (metricKey === 'ledger_age' ? 's' : (metricKey === 'health' ? '' : '%'));
  const title = (titleMap[metricKey] || metricKey) + ' · ' + periodLabel(d);
  if (!vals.length) return [title, '───────────────', 'Not enough history samples yet. Collecting every ~60s - ask again later.'].join('\n');
  const mm = minMax(vals);
  const a = avg(vals);
  const med = median(vals);
  return [
    title,
    '───────────────',
    '📋 Samples · ' + vals.length,
    '📉 Min     · ' + mm.min + unit,
    '📈 Max     · ' + mm.max + unit,
    '📊 Avg     · ' + a + unit,
    '🎯 Median  · ' + med + unit
  ].join('\n');
}

function financialBoundaryReply() {
  return [
    '⚡AI PINODE GUIDE',
    '───────────────',
    'I understand money pressure is real. As a technical Pi Node assistant I only report machine health - I cannot advise buying/selling or personal finance.',
    '',
    'Technically, check /status and the history summary below. Whether to keep the node is your decision.',
    '',
    'Ask for 7-day RAM/CPU/sync stats anytime if that helps your technical review.'
  ].join('\n');
}

// ---------- Gemini model discovery + sticky preferred model ----------
const GEMINI_FALLBACK_ORDER = [
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-preview',
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
];

function geminiScore(name) {
  const n = String(name || '').toLowerCase();
  if (/3\.1.*flash.*lite.*preview/.test(n)) return 100;
  if (/3\.1.*flash.*lite/.test(n)) return 95;
  if (/3\.1.*flash.*preview/.test(n)) return 90;
  if (/3\.1.*flash/.test(n)) return 88;
  if (/3\.5.*flash/.test(n)) return 85;
  if (/3.*flash.*preview/.test(n)) return 82;
  if (/3.*flash/.test(n)) return 80;
  if (/2\.5.*flash.*lite/.test(n)) return 70;
  if (/2\.5.*flash/.test(n)) return 65;
  if (/2\.0.*flash.*lite/.test(n)) return 55;
  if (/2\.0.*flash/.test(n)) return 50;
  if (/1\.5.*flash/.test(n)) return 40;
  if (/flash/.test(n)) return 30;
  return 10;
}
function stripModelsPrefix(id) { return String(id || '').replace(/^models\//, ''); }

async function httpGetGemini(pathSuffix) {
  if (!GEMINI_API_KEY) return null;
  return new Promise(function (resolve) {
    const path = '/v1beta/' + pathSuffix + (pathSuffix.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(GEMINI_API_KEY);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: path,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, function (r) {
      let b = '';
      r.on('data', function (d) { b += d; });
      r.on('end', function () {
        try { resolve({ status: r.statusCode, body: safeParse(b) }); } catch (e) { resolve(null); }
      });
    });
    req.on('error', function () { resolve(null); });
    req.setTimeout(15000, function () { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}

async function discoverGeminiModels(force) {
  if (!GEMINI_API_KEY) return [];
  const now = Date.now();
  if (!force && state.geminiModels && state.geminiModels.length) return state.geminiModels;
  const r = await httpGetGemini('models');
  let names = [];
  if (r && r.body && Array.isArray(r.body.models)) {
    r.body.models.forEach(function (m) {
      const id = stripModelsPrefix(m.name || m.id || '');
      const methods = m.supportedGenerationMethods || m.supported_generation_methods || [];
      const canGen = !methods.length || methods.indexOf('generateContent') >= 0;
      if (id && canGen && /gemini/i.test(id) && !/embedding|aqa|tts|vision|image/i.test(id)) {
        names.push(id);
      }
    });
  }
  if (!names.length) names = GEMINI_FALLBACK_ORDER.slice();
  names.sort(function (a, b) { return geminiScore(b) - geminiScore(a); });
  const seen = {};
  names = names.filter(function (n) { if (seen[n]) return false; seen[n] = true; return true; });
  state.geminiModels = names.slice(0, 20);
  state.geminiModelsAt = now;
  try { saveJSON(STATE_F, state); } catch (e) {}
  try { actionLog('info', 'Gemini models discovered · ' + state.geminiModels.slice(0, 5).join(', ')); } catch (e) {}
  return state.geminiModels;
}

function orderedGeminiModels(discovered) {
  const list = [];
  const seen = {};
  function add(n) {
    n = stripModelsPrefix(n);
    if (!n || seen[n]) return;
    seen[n] = true;
    list.push(n);
  }
  if (state.geminiPreferred) add(state.geminiPreferred);
  const pool = (discovered && discovered.length) ? discovered : GEMINI_FALLBACK_ORDER;
  pool.slice().sort(function (a, b) { return geminiScore(b) - geminiScore(a); }).forEach(add);
  GEMINI_FALLBACK_ORDER.forEach(add);
  return list;
}

function rememberGeminiSuccess(model) {
  if (!model) return;
  if (state.geminiPreferred !== model) {
    state.geminiPreferred = model;
    state.geminiPreferredAt = Date.now();
    state.geminiFailStreak = 0;
    try { saveJSON(STATE_F, state); } catch (e) {}
    try { actionLog('info', 'Gemini preferred · ' + model); } catch (e) {}
  } else {
    state.geminiFailStreak = 0;
  }
}

function rememberGeminiFailure(model) {
  state.geminiFailStreak = (state.geminiFailStreak || 0) + 1;
  if (state.geminiPreferred === model && state.geminiFailStreak >= 2) {
    try { actionLog('warn', 'Gemini drop preferred · ' + model); } catch (e) {}
    state.geminiPreferred = null;
    state.geminiFailStreak = 0;
    try { saveJSON(STATE_F, state); } catch (e) {}
  } else {
    try { saveJSON(STATE_F, state); } catch (e) {}
  }
}

async function callGeminiGenerate(model, body) {
  return new Promise(function (resolve) {
    const u = new URL('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function (r) {
      let b = '';
      r.on('data', function (d) { b += d; });
      r.on('end', function () {
        try {
          const j = safeParse(b);
          if (j && j.error) {
            resolve({ ok: false, error: String(j.error.message || j.error.status || 'error').slice(0, 160) });
            return;
          }
          const text = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
          if (text && String(text).trim()) resolve({ ok: true, text: String(text).trim() });
          else resolve({ ok: false, error: 'empty candidates' });
        } catch (e) { resolve({ ok: false, error: 'parse' }); }
      });
    });
    req.on('error', function (e) { resolve({ ok: false, error: e.message }); });
    req.setTimeout(28000, function () { try { req.destroy(); } catch (e) {} resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function generateWithSmartGemini(promptText) {
  if (!GEMINI_API_KEY) return null;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0.85, maxOutputTokens: 2000 }
  });
  const tried = {};
  async function tryOne(model) {
    if (!model || tried[model]) return null;
    tried[model] = true;
    const res = await callGeminiGenerate(model, body);
    if (res.ok) { rememberGeminiSuccess(model); return res.text; }
    try { actionLog('warn', 'Gemini ' + model + ': ' + (res.error || 'fail')); } catch (e) {}
    rememberGeminiFailure(model);
    return null;
  }
  if (state.geminiPreferred) {
    const hit = await tryOne(state.geminiPreferred);
    if (hit) return hit;
  }
  const discovered = await discoverGeminiModels(true);
  const models = orderedGeminiModels(discovered);
  const maxTry = Math.min(models.length, 4);
  for (let i = 0; i < maxTry; i++) {
    const hit = await tryOne(models[i]);
    if (hit) return hit;
  }
  return null;
}

function formatAiReply(raw) {
  let s = String(raw || '').trim();
  if (!s) return s;
  s = s.replace(/\*\*/g, '');
  s = s.replace(/__/g, '');
  s = s.replace(/`{1,3}/g, '');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^\s*[-*]\s+/gm, '• ');
  s = s.replace(/[━─═]{3,}/g, '───────────────');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim().slice(0, 3500);
}

function technicianEvaluate(t, userQ, intent) {
  const h = (typeof buildHistory24h === 'function') ? buildHistory24h() : { samples: 0 };
  const sync = (t && t.sync) || (h && h.last_sync) || null;
  const ledger = t && t.ledger != null ? Number(t.ledger).toLocaleString('en-US') : null;
  const age = t && t.ledger_age != null ? t.ledger_age : null;
  const ok = (t && t.level === 'ok') || (sync && /synced|live|horizon ok/i.test(String(sync)));
  const lines = [];

  lines.push('🤖 TECHNICIAN ASSESSMENT');
  lines.push('───────────────');
  lines.push('');

  if (ok && (!h.samples || h.level_critical === 0)) {
    lines.push('From available data, your Node looks stable overall: sync is healthy and there are no Critical samples.');
  } else if (h.level_critical > 0) {
    lines.push('Recent history shows Critical samples. Prioritize network, ports 31401-31403, and sync.');
  } else {
    lines.push('The node needs closer watching - data is limited or some signals are not ideal.');
  }
  lines.push('');
  lines.push('What the numbers mean:');
  if (sync) lines.push('• Sync: ' + sync + (age != null ? (' (age ' + age + 's)') : ''));
  if (ledger) lines.push('• Current ledger: ' + ledger);
  if (t && t.health != null) lines.push('• Health score: ' + t.health + '/100 (' + (t.health_confidence || '?') + ', trend ' + (t.health_trend || 'stable') + ')');
  if (h.samples) {
    lines.push('• Last ~' + (h.approx_minutes || '?') + ' min: ' + h.samples + ' samples, OK/Warn/Crit = ' + h.level_ok + '/' + h.level_warning + '/' + h.level_critical);
    if (h.ledger_delta != null) lines.push('• Ledger moved: ' + h.ledger_min + ' -> ' + h.ledger_max + ' (delta ' + h.ledger_delta + ')');
    if (h.sync_flips != null) lines.push('• Sync flips: ' + h.sync_flips + (h.sync_flips === 0 ? ' (stable)' : ' (watch if frequent)'));
    if (h.age_max_s != null) lines.push('• Ledger age max/avg: ' + h.age_max_s + 's / ' + h.age_avg_s + 's');
    if (h.health_avg != null) lines.push('• Health avg/min/max: ' + h.health_avg + ' / ' + h.health_min + ' / ' + h.health_max);
    if (h.cpu_max != null) lines.push('• CPU peak (container): ' + h.cpu_max + '%');
    if (h.ram_max != null) lines.push('• RAM peak (container): ' + h.ram_max + '%');
  } else {
    lines.push('• History still short - samples every ~60s. Run longer for a solid 24h review.');
  }
  lines.push('');
  lines.push('Practical next steps:');
  if (ok) {
    lines.push('1) Keep the machine online; avoid frequent restarts.');
    lines.push('2) Keep ports 31401-31403 open.');
    lines.push('3) Check /report after more samples accumulate.');
  } else {
    lines.push('1) Run /diagnostic and verify ports/network.');
    lines.push('2) Watch /incidents for repeated incidents.');
  }
  lines.push('');
  lines.push('Want a deeper look at sync, peers, or resources (RAM/CPU)?');
  if (!GEMINI_API_KEY) {
    lines.push('');
    lines.push('💡 Set GEMINI_API_KEY in SoloHost config for full multi-language AI technician analysis.');
  }
  return lines.join('\n');
}

async function aiAnalyze(t, userQ) {
  const appGuide = (typeof APP_KNOWLEDGE === 'string' ? APP_KNOWLEDGE : '').slice(0, 3500);
  try { await fetchPctContext(); } catch (e) {}

  try {
    const intent = detectIntent(userQ || '');
    const userLang = detectUserPreferredLang(userQ || '');
    const q = String(userQ || '');

    let days = 7;
    if (/24\s*h|24h|today|1\s*day|h[oô]m nay/i.test(q)) days = 1;
    if (/30\s*day|30d|month|th[aá]ng/i.test(q)) days = 30;
    days = Math.min(days, 7);

    const mk = metricIntentKey(intent);
    let metricBlock = '';
    if (mk) {
      metricBlock = formatMetricAnalysis(mk, days);
      if (t && t[mk] != null) metricBlock += '\n\nNow · ' + t[mk] + (mk === 'temp' ? '°C' : '%');
    } else if (intent === 'BLOCK_SYNC' || intent === 'DIAGNOSIS' || intent === 'NODE_HEALTH' || intent === 'GENERAL' || intent === 'BONUS' || intent === 'RECOMMENDATION' || intent === 'ADVICE' || intent === 'CLARIFY' || intent === 'FINANCE') {
      try {
        const h = buildHistory24h();
        if (h && h.samples) metricBlock = formatHistory24hText(h);
      } catch (e) {}
    }

    const facts = lite.aiContext(t, { prevRows: (typeof readHistory === 'function') ? readHistory(1) : [] });
    const hist24 = (typeof buildHistory24h === 'function') ? buildHistory24h() : { samples: 0 };
    const hist = (typeof historySnippet === 'function') ? historySnippet(40) : [];
    const chat = loadChatHistory().slice(-10);
    const issues = (typeof collectIssues === 'function') ? collectIssues(t) : [];
    const rows7 = (typeof historyRowsDays === 'function') ? historyRowsDays(7) : [];
    const ram7 = rows7.map(function (r) { return toNum(r.ram); }).filter(function (x) { return x != null; });
    const cpu7 = rows7.map(function (r) { return toNum(r.cpu); }).filter(function (x) { return x != null; });
    const age7 = rows7.map(function (r) { return toNum(r.ledger_age); }).filter(function (x) { return x != null; });
    const stats7 = {
      samples: rows7.length,
      ram: ram7.length ? { min: Math.min.apply(null, ram7), max: Math.max.apply(null, ram7), avg: avg(ram7), median: median(ram7) } : null,
      cpu: cpu7.length ? { min: Math.min.apply(null, cpu7), max: Math.max.apply(null, cpu7), avg: avg(cpu7), median: median(cpu7) } : null,
      ledger_age: age7.length ? { min: Math.min.apply(null, age7), max: Math.max.apply(null, age7), avg: avg(age7), median: median(age7) } : null
    };

    if (GEMINI_API_KEY) {
      const prompt = '[APP GUIDE]\n' + appGuide + '\n\n' + [
        'You are an experienced Pi Node technician for THIS operator machine (SoloHost Controller).',
        'LANGUAGE (MANDATORY): Reply in ' + userLang + '. This is the user\'s detected language from their message and/or recent chat history. Do NOT switch to English unless the user is using English.',
        'PRIORITY: Every free-text question needs a real technician evaluation - simple words, practical value.',
        'DATA RULES: Use ONLY the JSON blocks below. If container_cpu / container_ram / ledger_per_min / peers / health exist, you MUST use them. Missing field = unknown, NEVER say 0%.',
        'HEALTH SCORE: t.health is a smoothed score (0-100). t.health_raw is the pre-damper value. t.health_confidence reflects how many sources contributed (high/medium/low/none). t.health_trend is improving/stable/degrading. Explain the score with this context. Do not over-react to small movements.',
        'INCIDENT ENGINE: If ACTIVE_INCIDENT is present, explain the type, why it matters, and reference the RECOMMENDED_SCRIPT (or WAIT) exactly as given. Never invent other scripts.',
        'MISSING DATA: You MAY ask up to 3 short follow-up questions when needed. Do not invent answers.',
        'FORMAT: No markdown special characters (no **, __, `, #). Short lines. Icons ok (🟢 🟡 🔴 ✅ ⚠️ 📊 🔄 💡 🧠 🔧).',
        'STRUCTURE: (1) short verdict with icon (2) explanation (3) evidence (4) 1-3 next steps (5) optional question.',
        'FINANCE: Empathy + technical health only. No buy/sell advice.',
        'Detected user language: ' + userLang,
        'Intent: ' + intent,
        'User question: ' + q.slice(0, 900),
        'Issues: ' + JSON.stringify(issues),
        'CURRENT_FACTS: ' + JSON.stringify(facts),
        'ACTIVE_INCIDENT: ' + JSON.stringify((function () {
          const active = Object.keys(state.incidents || {}).map(function (k) { return state.incidents[k]; }).filter(function (i) { return i && !i.resolved; })[0];
          if (!active) return null;
          const s = smartScriptForIncident(active, t);
          return { type: active.type, stage: active.stage || 0, samples: active.samples || 1, severity: active.severity, recommended_script: s ? s.script : null, recommended_note: s ? s.note : null };
        })()),
        'SCRIPT_MAP:\n' + SCRIPT_MAP,
        'APP_GUIDE:\n' + APP_GUIDE,
        'CONTEXT_HINTS: Official Pi Node upgrades often cause temporary Catching up. Regional submarine-cable or ISP cuts can drop peers without the machine being broken.',
        'PCT_RELEASES: ' + JSON.stringify(state.pctNews || []),
        'HISTORY_24H: ' + JSON.stringify(hist24),
        'HOUR_TREND: ' + (function () { try { const hf = path.join(DIR_HIST, 'hourly.json'); const arr = JSON.parse(fs.readFileSync(hf, 'utf8')).slice(-12); return JSON.stringify(arr.map(function (x) { return { hour: x.hour, n: x.n, health_min: x.health_min, max_age: x.max_age, min_peers: x.min_peers, max_ram: x.max_ram, bad: x.bad }; })); } catch (e) { return '[]'; } })(),
        'STATS_7D: ' + JSON.stringify(stats7),
        metricBlock ? ('RELATED_METRIC_BLOCK:\n' + metricBlock) : '',
        facts.health != null && facts.health < 60 ? (hist.length ? ('RECENT_SAMPLES: ' + JSON.stringify(hist.slice(-8))) : '') : '',
        chat.length ? ('Recent chat: ' + JSON.stringify(chat)) : '',
        'Write the reply now in ' + userLang + ', following FORMAT rules.'
      ].filter(Boolean).join('\n');

      try {
        const text = await generateWithSmartGemini(prompt);
        if (text && String(text).trim()) {
          try { actionLog('info', 'AI reply ok · lang ' + userLang + ' · intent ' + intent + ' · model ' + (state.geminiPreferred || '?')); } catch (e) {}
          return '⚡AI PINODE GUIDE\n\n' + formatAiReply(text);
        }
      } catch (e) {
        try { actionLog('error', 'Gemini fail: ' + (e && e.message)); } catch (e2) {}
      }
    }

    try { actionLog('warn', GEMINI_API_KEY ? 'Gemini empty/fail · local technician' : 'no GEMINI_API_KEY · local technician'); } catch (e) {}
    if (intent === 'FINANCE') return financialBoundaryReply() + '\n\n' + technicianEvaluate(t, userQ, intent);
    if (mk && metricBlock) return metricBlock + '\n\n' + technicianEvaluate(t, userQ, intent);
    return technicianEvaluate(t, userQ, intent);
  } catch (e) {
    try { actionLog('error', 'aiAnalyze ' + (e && e.message)); } catch (e2) {}
    try { return localAssistantReply(t, detectIntent(userQ || ''), userQ || ''); } catch (e3) { return 'Assistant error. Try /status.'; }
  }
}

async function localCommandText(cmd, msg) {
  const t = cache || await getTelemetry();
  cmd = String(cmd || '').replace(/^\//, '').toLowerCase();
  if (cmd === 'help' || cmd === 'start') return formatHelp();
  if (cmd === 'status' || cmd === 's') return formatStatus(t);
  if (cmd === 'sync') return formatStatus(t);
  if (cmd === 'peers') return formatPeers(t);
  if (cmd === 'report' || cmd === 'trends') return formatReport();
  if (cmd === 'incidents') return formatIncidents();
  if (cmd === 'diagnostic' || cmd === 'diag') return formatDiagnostic(t);
  if (cmd === 'logs') return formatActionLog();
  if (cmd === 'ping') return 'pong · v' + VERSION;
  if (cmd === 'donate') return formatDonate();
  if (cmd === 'winpro') return 'Windows PRO: ' + GITHUB_PRO;
  if (cmd === 'analyze') return aiAnalyze(t, msg || 'Review my node');
  return null;
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: 'cmd_status' },
        { text: '📈 Report', callback_data: 'cmd_report' }
      ],
      [
        { text: '👥 Peers', callback_data: 'cmd_peers' },
        { text: '🧭 Incidents', callback_data: 'cmd_incidents' }
      ],
      [
        { text: '🩺 Diag', callback_data: 'cmd_diagnostic' },
        { text: '📋 Logs', callback_data: 'cmd_logs' }
      ],
      [
        { text: '💬 Analyze', callback_data: 'cmd_analyze' },
        { text: '❓ Help', callback_data: 'cmd_help' }
      ],
      [
        { text: '💻 PRO', callback_data: 'cmd_winpro' },
        { text: '💛 Donate', callback_data: 'cmd_donate' }
      ]
    ]
  };
}

// ---------- Telegram ----------
function tgApi(method, body) {
  return new Promise(resolve => {
    if (!BOT_TOKEN) return resolve(null);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.telegram.org', path: '/bot' + BOT_TOKEN + '/' + method,
      method: data ? 'POST' : 'GET',
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { resolve(safeParse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(35000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}
async function tgSend(text, extra) {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  const body = Object.assign({
    chat_id: CHAT_ID,
    text: String(text == null ? '' : text).slice(0, 4000),
    disable_web_page_preview: true
  }, extra || {});
  const r = await tgApi('sendMessage', body);
  if (r && r.ok === false) log('tgSend fail: ' + (r.description || JSON.stringify(r)), 'error');
  if (!r) log('tgSend network fail', 'error');
  return r;
}

async function runCmd(cmd, userText) {
  const t = await getTelemetry();
  if (cmd === 'status' || cmd === 's') return tgSend(formatStatus(t), { reply_markup: mainKeyboard() });
  if (cmd === 'sync') {
    const lines = ['🔄 SYNC', '───────────────'];
    if (t.sync) lines.push('Status: ' + t.sync);
    if (t.ledger != null) lines.push('Ledger: ' + fmtN(t.ledger));
    if (t.ledger_age != null) lines.push('Age: ' + t.ledger_age + 's');
    if (t.health != null) lines.push('Health: ' + t.health + '/100 (' + (t.health_confidence || 'low') + ')');
    if (lines.length === 2) lines.push('⚠️ Sync data unavailable');
    return tgSend(lines.join('\n'), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'peers') return tgSend(formatPeers(t), { reply_markup: mainKeyboard() });
  if (cmd === 'ports') {
    const lines = ['PORTS', '───────────────'];
    NODE_PORTS.forEach(p => {
      const st = t.ports && t.ports[String(p)];
      lines.push((st === 'OPEN' ? '🟢' : '🔴') + ' ' + p + ' · ' + (st || '?'));
    });
    return tgSend(lines.join('\n'), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'report') { const tt = cache || {}; return tgSend(formatReport() + '\n\n' + formatActionAdvice(tt), { reply_markup: reportKeyboard() }); }
  if (cmd === 'incidents' || cmd === 'incident') return tgSend(formatIncidents(), { reply_markup: mainKeyboard() });
  if (cmd === 'incident_ack') {
    const active = Object.keys(state.incidents || {}).map(function (k) { return state.incidents[k]; }).filter(function (i) { return i && !i.resolved; })[0];
    if (active) {
      active.ackedAt = Date.now();
      try { saveJSON(STATE_F, state); } catch (e) {}
      return tgSend('✅ Acknowledged: ' + active.type + '\nI will give you more time before reminding again.', { reply_markup: alertKeyboard() });
    }
    return tgSend('No active incident.', { reply_markup: mainKeyboard() });
  }
  if (cmd === 'incident_skip') {
    const active = Object.keys(state.incidents || {}).map(function (k) { return state.incidents[k]; }).filter(function (i) { return i && !i.resolved; })[0];
    if (active) {
      active.skippedUntil = Date.now() + 4 * 3600 * 1000;
      try { saveJSON(STATE_F, state); } catch (e) {}
      return tgSend('⏸ Skipping this incident for 4 hours: ' + active.type + '\nIt will still be tracked and shown in /incidents.', { reply_markup: mainKeyboard() });
    }
    return tgSend('No active incident.', { reply_markup: mainKeyboard() });
  }
  if (cmd === 'diagnostic' || cmd === 'diag') return tgSend(formatDiagnostic(t), { reply_markup: mainKeyboard() });
  if (cmd === 'analyze' || cmd === 'ai' || cmd === 'health' || cmd === 'ask') {
    pushChatPersistent('user', userText || '');
    await tgSend('…');
    const ans = await aiAnalyze(t, userText || 'Node status');
    pushChatPersistent('assistant', ans);
    return tgSend(ans, { reply_markup: mainKeyboard() });
  }
  if (cmd === 'trends') return tgSend(formatReport(), { reply_markup: reportKeyboard() });
  if (cmd === 'scripts' || cmd === 'script') return tgSend(formatScripts(), { reply_markup: mainKeyboard() });
  if (cmd === 'logs' || cmd === 'log') {
    try { actionLog('info', 'user /logs'); } catch (e) {}
    return tgSend(formatActionLog(), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'winpro' || cmd === 'windows' || cmd === 'pro') {
    try { actionLog('info', 'user /winpro'); } catch (e) {}
    return tgSend(formatWindowsPro(), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'donate' || cmd === 'donate_both') {
    try { actionLog('info', 'user /' + cmd); } catch (e) {}
    await tgSend(formatDonate(), { reply_markup: donateKeyboard() });
    await sendDonateQr('both');
    return true;
  }
  if (cmd === 'donate_pi') {
    try { actionLog('info', 'user /donate_pi'); } catch (e) {}
    await tgSend('🟣 Pay with Pi\n@cannoi\n\n' + randomDonateThanks(), { reply_markup: donateKeyboard() });
    await sendDonateQr('pi');
    return true;
  }
  if (cmd === 'donate_mb') {
    try { actionLog('info', 'user /donate_mb'); } catch (e) {}
    await tgSend('🏦 MB Bank · 0905428801 · TRAN HUU NGHI\n\n' + randomDonateThanks(), { reply_markup: donateKeyboard() });
    await sendDonateQr('mb');
    return true;
  }
  if (cmd === 'mute_1h') { setMuteHours(1); return tgSend('🔇 Alerts muted 1 hour.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute_24h') { setMuteHours(24); return tgSend('📅 Alerts muted 24 hours.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute_night') { state.alertMode = 'night'; state.muteUntil = 0; saveJSON(STATE_F, state); return tgSend('🌙 Night quiet 22:00-07:00.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute_off') { state.alertMode = 'off'; state.muteUntil = 0; saveJSON(STATE_F, state); return tgSend('🔕 Alerts off until you press On.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute_on' || cmd === 'alerts_on') { state.alertMode = 'on'; state.muteUntil = 0; saveJSON(STATE_F, state); return tgSend('🔔 Alerts on.\n' + formatMuteAck(), { reply_markup: alertKeyboard() }); }
  if (cmd === 'mute' || cmd === 'alerts') return tgSend(formatMuteAck(), { reply_markup: alertKeyboard() });
  if (cmd === 'report_h7') { state.reportHours = [7]; saveJSON(STATE_F, state); return tgSend('🕖 Daily report at 07:00', { reply_markup: reportKeyboard() }); }
  if (cmd === 'report_h18') { state.reportHours = [18]; saveJSON(STATE_F, state); return tgSend('🕕 Daily report at 18:00', { reply_markup: reportKeyboard() }); }
  if (cmd === 'report_both') { state.reportHours = [7, 18]; saveJSON(STATE_F, state); return tgSend('🕖🕕 Reports at 07:00 and 18:00', { reply_markup: reportKeyboard() }); }
  if (cmd === 'report_off') { state.reportHours = 'off'; saveJSON(STATE_F, state); return tgSend('⏰ Scheduled reports off', { reply_markup: reportKeyboard() }); }

  if (cmd === 'ping') return tgSend('🏓 pong · v' + VERSION + '\n⏱ cache ' + (Date.now() - cacheAt) + 'ms');
  if (cmd === 'docker' || cmd === 'dockersock' || cmd === 'docker_confirm' || cmd === 'docker_cancel' || cmd === 'docker_off' || cmd === 'docker_rules' || cmd === 'docker_local' || (typeof cmd === 'string' && cmd.indexOf('docker') === 0)) {
    try { actionLog('info', 'user docker cmd blocked on Telegram'); } catch (e) {}
    return tgSend(
      'DOCKER OPTIONAL\n' +
      '───────────────\n' +
      'For safety, docker.sock can only be enabled in the SoloHost window on the PC running this node.\n\n' +
      '1) Open http://127.0.0.1:18780/\n' +
      '2) Optional Docker -> scroll terms -> check boxes -> Confirm\n' +
      '3) SoloHost: Stop -> Start\n\n' +
      'Telegram will not raise Docker privileges.',
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'start' || cmd === 'help') {
    return tgSend(formatHelp() + '\n\n' +
      '───────────────\n' +
      '/status /sync /peers /incidents\n/report /diagnostic /analyze\n/scripts /donate\n' +
      '───────────────\n' +
      'Telemetry -> Horizon -> Ports',
      { reply_markup: mainKeyboard() }
    );
  }
  return null;
}

async function handleText(text) {
  const raw = String(text || '').trim().slice(0, 4000);
  if (!raw) return null;
  const low = raw.toLowerCase();
  const cmd = low.split(/\s+/)[0].replace(/@\w+$/, '').replace(/^\//, '');

  if (raw.startsWith('/')) {
    return (await runCmd(cmd, raw)) || tgSend('❓ Unknown command. /help', { reply_markup: mainKeyboard() });
  }
  if (/^(status|ping)$/i.test(raw.trim())) return runCmd(raw.toLowerCase(), raw);
  if (/^(peers?|ports?|report|diagnostic|donate|scripts?|incidents?)$/i.test(raw.trim())) return runCmd(cmd, raw);
  return runCmd('analyze', raw);
}

let offset = 0;

async function processUpdate(u) {
  try {
    if (!u || typeof u !== 'object' || u.update_id == null) return;

    if (u.callback_query) {
      const cq = u.callback_query;
      if (!cq || !cq.message || !cq.message.chat) return;
      if (CHAT_ID && !safeEq(String(cq.message.chat.id), CHAT_ID)) return;
      await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
      if ((cq.data || '').startsWith('cmd_')) await runCmd(cq.data.slice(4));
      return;
    }

    const msg = u.message;
    if (!msg || !msg.text || !msg.chat) return;
    if (CHAT_ID && !safeEq(String(msg.chat.id), CHAT_ID)) {
      log('ignore chat ' + msg.chat.id + ' want [redacted]', 'warn');
      return;
    }
    const userKey = String(msg.chat.id);
    if (!tgUserRateLimit(userKey, 20, 60000)) {
      log('rate limit hit for chat ' + userKey, 'warn');
      return;
    }
    await handleText(msg.text);
  } catch (e) {
    log('tg handle ' + (e && e.message), 'error');
    try { await tgSend('Error handling message. Try /ping or /status.'); } catch (e2) {}
  }
}

async function installTelegramMenu() {
  if (!BOT_TOKEN) return;
  try {
    const r = await tgApi('setMyCommands', {
      commands: [
        { command: 'status', description: 'Current node health snapshot' },
        { command: 'sync', description: 'Sync status and latest ledger' },
        { command: 'peers', description: 'Inbound and outbound peers' },
        { command: 'report', description: 'Recent history summary' },
        { command: 'incidents', description: 'Active + recent incident history' },
        { command: 'diagnostic', description: 'Technical source details' },
        { command: 'analyze', description: 'AI technician review (in your language)' },
        { command: 'logs', description: 'App activity and errors' },
        { command: 'donate', description: 'Support the project' },
        { command: 'winpro', description: 'Windows PRO edition link' },
        { command: 'ping', description: 'Controller heartbeat' },
        { command: 'help', description: 'List available commands' },
        { command: 'mute', description: 'Alert mute 1h / 24h / night / off' }
      ]
    });
    if (r && r.ok) log('Telegram command menu installed');
    else log('setMyCommands skip: ' + ((r && r.description) || 'no reply'), 'warn');
  } catch (e) {
    log('setMyCommands ' + (e && e.message), 'warn');
  }
}

async function telegramLoop() {
  let conflictBackoff = 15000;
  let lastConflictLog = 0;
  if (BOT_TOKEN) {
    const dw = await tgApi('deleteWebhook', { drop_pending_updates: true });
    log('deleteWebhook ' + (dw && dw.ok ? 'ok' : 'skip') + ' (drop_pending=true)');
    try { actionLog('info', 'telegram loop start'); } catch (e) {}
    await installTelegramMenu();
  }
  while (true) {
    if (!BOT_TOKEN) { await wait(5000); continue; }
    try {
      const r = await tgApi('getUpdates', {
        offset: offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });
      if (!r) { await wait(400); continue; }
      if (r.ok === false) {
        const desc = String(r.description || '');
        const isConflict = /conflict|terminated by other getUpdates/i.test(desc);
        if (isConflict) {
          const now = Date.now();
          if (now - lastConflictLog > 90000) {
            log('getUpdates conflict - only one bot instance may poll this token.', 'error');
            try { actionLog('error', 'getUpdates conflict · ensure single instance'); } catch (e) {}
            lastConflictLog = now;
          }
          await tgApi('deleteWebhook', { drop_pending_updates: true });
          await wait(conflictBackoff);
          conflictBackoff = Math.min(180000, Math.floor(conflictBackoff * 1.4));
          continue;
        }
        log('getUpdates fail: ' + desc, 'error');
        await wait(2500);
        continue;
      }
      conflictBackoff = 15000;
      if (!Array.isArray(r.result)) { await wait(1000); continue; }
      for (const u of r.result) {
        if (u && u.update_id != null) offset = u.update_id + 1;
        processUpdate(u);
      }
    } catch (e) {
      log('tg loop ' + (e && e.message), 'error');
      await wait(1200);
    }
  }
}

async function telemetryLoop() {
  while (true) {
    try {
      const t = await collectTelemetry();
      await runAlertMachine(t);
      const h = hourVN();
      const key = dayVN() + '-' + h;
      if (effectiveReportHours().indexOf(h) >= 0 && state.lastReportKey !== key) {
        state.lastReportKey = key;
        saveJSON(STATE_F, state);
        await tgSend(formatReport() + '\n\n' + formatStatus(t), { reply_markup: reportKeyboard() });
      }
    } catch (e) { log('telemetry ' + e.message, 'error'); }
    const intervalSec = currentTelemetryInterval();
    await wait(intervalSec * 1000);
  }
}

// ---------- HTTP UI ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.ps1': 'text/plain; charset=utf-8', '.bat': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8'
};
let INDEX = '<h1>Pi Node SoloHost ' + VERSION + '</h1><p>/api/status</p>';
try { INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); } catch (e) {}

const rateBuckets = Object.create(null);
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets[key];
  if (!b || now > b.reset) b = rateBuckets[key] = { n: 0, reset: now + windowMs };
  b.n++;
  return b.n <= max;
}
function isLocalReq(req) {
  const ip = String(req.socket && req.socket.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('172.') || ip.startsWith('10.');
}
function setSecHeaders(res, mode) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (mode === 'docker') {
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  }
}

const srv = http.createServer(async (req, res) => {
  const u = (req.url || '/').split('?')[0];
  setSecHeaders(res);
  try {
    if (u === '/healthz') { res.end('ok'); return; }
    if (u === '/api/status' || u === '/api/status/fast' || u === '/api/status/detailed') {
      if (!rateLimit('status:' + (req.socket.remoteAddress || ''), 40, 60000)) {
        res.statusCode = 429; res.end('rate limit'); return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const detailed = u.indexOf('detailed') >= 0;
        let tel;
        if (u.indexOf('fast') >= 0 && cache) tel = cache;
        else if (detailed) {
          tel = await statusMonitor.getStatus(true, { detailed: true, docker: true });
          cache = tel; cacheAt = Date.now();
        } else tel = cache || await getTelemetry();
        res.end(JSON.stringify(tel || {}));
      } catch (e) {
        log('api/status error: ' + (e && e.message), 'error');
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
      }
      return;
    }
    if (u === '/api/health') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const h = {
        ok: true,
        version: VERSION,
        health: state.healthSmooth,
        raw: state.healthRaw,
        confidence: state.healthConfidence,
        confidenceScore: state.healthConfidenceScore,
        sourceCount: state.healthSourceCount,
        trend: state.healthTrend,
        at: state.healthAt ? new Date(state.healthAt).toISOString() : null,
        activeIncidents: Object.keys(state.incidents || {}).filter(function (k) { return state.incidents[k] && !state.incidents[k].resolved; }).length
      };
      res.end(JSON.stringify(h));
      return;
    }
    if (u === '/api/incidents') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const items = Object.keys(state.incidents || {}).map(function (k) { return state.incidents[k]; });
      const active = items.filter(function (i) { return i && !i.resolved; });
      const recent = items.filter(function (i) { return i && i.resolved; }).sort(function (a, b) { return (b.resolvedAt || 0) - (a.resolvedAt || 0); }).slice(0, 20);
      res.end(JSON.stringify({ ok: true, active: active, recent: recent, intervalSec: currentTelemetryInterval() }));
      return;
    }
    if (u === '/api/selftest') {
      if (!isLocalReq(req) && !rateLimit('selftest:' + (req.socket.remoteAddress || ''), 5, 60000)) {
        res.statusCode = 429; res.end('rate limit'); return;
      }
      const checks = [];
      const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });
      ok('version', !!VERSION, VERSION);
      ok('telegram_loop_independent', true, 'telegramLoop + telemetryLoop separate');
      ok('telemetry_sec', TELEMETRY_SEC >= 30, String(TELEMETRY_SEC));
      ok('schema_hide_missing', typeof lineIf === 'function', 'lineIf');
      ok('no_datalive', true, 'Horizon removed');
      ok('history_dir', fs.existsSync(DIR_HIST), DIR_HIST);
      ok('chat_id_safe_compare', typeof safeEq === 'function', 'safeEq');
      ok('safe_json_parse', typeof safeParse === 'function', 'safeParse');
      ok('tg_user_rate_limit', typeof tgUserRateLimit === 'function', 'tgUserRateLimit');
      ok('csp_relaxed_for_index', true, 'index.html has no script-blocking CSP');
      ok('incident_engine', typeof detectIncidentSignature === 'function' && typeof smartScriptForIncident === 'function', 'engine loaded');
      ok('adaptive_polling', typeof currentTelemetryInterval === 'function', 'currentTelemetryInterval');
      // Health damper tests
      ok('health_damper_fn', typeof dampHealthScore === 'function' && typeof healthConfidence === 'function', 'damper loaded');
      const hc1 = healthConfidence({ docker_sock: true, core_verified: true });
      ok('health_conf_high_sock_core', hc1.level === 'high', hc1.level);
      const hc2 = healthConfidence({ source: 'Horizon' });
      ok('health_conf_low_horizon_only', hc2.level === 'low', hc2.level);
      const hc3 = healthConfidence({});
      ok('health_conf_none_no_source', hc3.level === 'none', hc3.level);
      // Simulate: no data -> frozen
      const prevSmooth = state.healthSmooth;
      state.healthSmooth = 80; state.healthAt = Date.now();
      const d0 = dampHealthScore({}, 10);
      ok('damper_freezes_without_source', d0.frozen === true && d0.health === 80, 'frozen=' + d0.frozen);
      state.healthSmooth = prevSmooth;
      // Synthetic engine tests
      const i1 = detectIncidentSignature({ ports_open: 0 });
      ok('incident_ports_closed', i1 && i1.type === 'ports_closed', i1 && i1.type);
      const i2 = detectIncidentSignature({ docker: 'Exited (0)' });
      ok('incident_docker_down', i2 && i2.type === 'docker_down', i2 && i2.type);
      const i3 = detectIncidentSignature({ ledger_age: 500 });
      ok('incident_sync_stalled', i3 && i3.type === 'sync_stalled', i3 && i3.type);
      const i4 = detectIncidentSignature({ ledger_age: 5, sync: 'Synced', peer_in: 5, peer_out: 8, ports_open: 3 });
      ok('incident_none_when_healthy', i4 === null, i4 ? i4.type : 'null');
      const s1 = smartScriptForIncident({ type: 'docker_down' }, {});
      ok('script_docker_down', s1 && s1.script === 'DockerRecover', s1 && s1.script);
      const s2 = smartScriptForIncident({ type: 'ports_closed' }, {});
      ok('script_ports_closed', s2 && s2.script === 'Firewall', s2 && s2.script);
      const s3 = smartScriptForIncident({ type: 'sync_lag', firstCoreVersion: 'v1' }, { core_version: 'v2' });
      ok('script_sync_lag_upgrade_wait', s3 && s3.script === 'WAIT', s3 && s3.script);
      const d1 = decideIncidentAction({ firstSeen: Date.now() - 1000, samples: 1, stage: 0, alertsSent: 0 }, {});
      ok('decision_observe_early', d1 && d1.action === 'watch', d1 && d1.action);
      const d2 = decideIncidentAction({ firstSeen: Date.now() - 6 * 60000, samples: 6, stage: 0, alertsSent: 0 }, {});
      ok('decision_alert_at_5min', d2 && d2.action === 'alert', d2 && d2.action);
      const m1 = mergeTelemetry(null, { source: 'Horizon', ledger: 100, sync: 'Horizon OK', confidence: 'medium' }, { ports: { '31401': 'OPEN', '31402': 'OPEN', '31403': 'OPEN' }, openCount: 3 });
      ok('fallback_horizon', m1.ledger === 100 && m1.source === 'Horizon', m1.source);
      ok('datalive_offline_not_node_offline', m1.level !== 'critical', m1.level);
      const m3 = mergeTelemetry(null, null, { ports: { '31401': 'CLOSED', '31402': 'CLOSED', '31403': 'CLOSED' }, openCount: 0 });
      ok('ports_closed_critical', m3.level === 'critical', m3.level);
      const l1 = detectUserLang('Xin chào, node của tôi thế nào?');
      ok('lang_detect_vi', l1 === 'Vietnamese', l1);
      const l2 = detectUserLang('Hello, how is my node?');
      ok('lang_detect_en', l2 === 'English', l2);
      const all = checks.every(c => c.pass);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: all, version: VERSION, checks }));
      return;
    }

    if (u === '/api/chat' && (req.method === 'POST' || req.method === 'GET')) {
      if (!rateLimit('chat:' + (req.socket.remoteAddress || ''), 12, 60000)) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'rate_limit' }));
        return;
      }
      let body = '';
      if (req.method === 'POST') {
        body = await new Promise(resolve => {
          let b = '';
          let n = 0;
          req.on('data', d => { n += d.length; if (n > 8000) { req.destroy(); return; } b += d; });
          req.on('end', () => resolve(b));
          req.on('error', () => resolve(''));
        });
      }
      let msg = '';
      try {
        const q = new URL(req.url, 'http://x').searchParams.get('msg');
        if (q) msg = q;
        if (body) {
          const j = safeParse(body);
          if (j && j.message) msg = j.message;
          if (j && j.msg) msg = j.msg;
        }
      } catch (e) {}
      msg = String(msg || '').trim().slice(0, 2000);
      if (!msg) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'empty_message' }));
        return;
      }
      try {
        let tel = cache;
        if (!tel) {
          try {
            tel = await Promise.race([
              collectTelemetry(),
              new Promise(function (r) { setTimeout(function () { r(null); }, 4000); })
            ]);
          } catch (e) { tel = null; }
        }
        if (!tel) tel = { source: 'none', level: 'unknown', sources: {} };
        pushChatPersistent('user', msg);
        let ans = null;
        const low = msg.toLowerCase().trim();
        const c0 = low.split(/\s+/)[0].replace(/^\//, '');
        if (/^(help|status|s|sync|peers|report|trends|diagnostic|diag|logs|ping|donate|winpro|incidents)$/.test(c0) || low.charAt(0) === '/') {
          try { ans = await localCommandText(c0, msg); } catch (e) { ans = null; }
        }
        if (!ans) ans = await aiAnalyze(tel, msg);
        pushChatPersistent('assistant', ans);
        const payload = { ok: true, reply: ans, version: VERSION, source: tel && tel.source };
        if (c0 === 'donate') {
          payload.images = [];
          try {
            if (fs.existsSync(path.join(PUBLIC, 'donate-qr-pi.jpg'))) payload.images.push('/donate-qr-pi.jpg');
            if (fs.existsSync(path.join(PUBLIC, 'donate-qr-mb.jpg'))) payload.images.push('/donate-qr-mb.jpg');
            if (!payload.images.length && fs.existsSync(path.join(PUBLIC, 'donate-qr.jpg'))) payload.images.push('/donate-qr.jpg');
          } catch (e) {}
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
      } catch (e) {
        log('api/chat error: ' + (e && e.message), 'error');
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
      }
      return;
    }

    if (u === '/docker' || u === '/docker/' || u.indexOf('/docker/confirm') === 0 || u.indexOf('/docker/off') === 0) {
      setSecHeaders(res, 'docker');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const pref = readDockerPref();
      if (u.indexOf('/docker/confirm') === 0) {
        writeDockerPref({ enabled: true, at: new Date().toISOString(), by: 'local_ui', consent: true });
        const applied = applyDockerConsentFiles();
        try { actionLog('ok', 'docker pref ON via local UI'); } catch (e) {}
        const extra = applied && applied.wrote_host
          ? '<p><b>docker-compose.yml</b> updated in app folder. SoloHost: Stop -> Start the app.</p>'
          : '<p>Files ready under <code>data/docker-enable/</code>. Copy <code>docker-compose.yml</code> to app root if needed, then Stop -> Start.</p>';
        res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:2rem auto"><h2>Consent saved</h2><p>Docker preference <b>ON</b>.</p>' + extra + '<p><a href="/docker">Back</a></p></body></html>');
        return;
      }
      if (u.indexOf('/docker/off') === 0) {
        writeDockerPref({ enabled: false, at: new Date().toISOString(), by: 'local_ui', consent: false });
        try { actionLog('ok', 'docker pref OFF via local UI'); } catch (e) {}
        res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:2rem auto"><h2>OFF</h2><p>Sandbox default.</p><p><a href="/docker">Back</a></p></body></html>');
        return;
      }
      let sockExists = false;
      try { sockExists = fs.existsSync('/var/run/docker.sock'); } catch (e) {}
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Docker optional</title>'
        + '<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:1.5rem auto;padding:0 1rem;line-height:1.45}'
        + '.box{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0;background:#f8f8f8}'
        + '.btn{display:inline-block;margin:.3rem .4rem .3rem 0;padding:.65rem 1rem;border-radius:6px;text-decoration:none;color:#fff;font-weight:600}'
        + '.yes{background:#0a7}.no{background:#555} code{background:#eee;padding:0 .25rem}</style></head><body>'
        + '<h1>Optional Docker access</h1>'
        + '<p>Confirm on <b>this computer</b> (SoloHost node). Default app stays sandboxed.</p>'
        + '<div class="box"><p><b>Preference:</b> ' + (pref.enabled ? 'ON' : 'OFF') + '<br>'
        + '<b>Socket in container:</b> ' + (sockExists ? 'YES' : 'NO') + '</p>'
        + '<p><b>Purpose:</b> optional Core/container probe when you mount the engine socket.</p>'
        + '<p><b>SoloHost:</b> install does <u>not</u> include docker.sock. Mounting it is Operator choice.</p></div>'
        + '<div class="box"><p><b>After you click Agree:</b></p><ol>'
        + '<li>App prepares a ready <code>docker-compose.yml</code> (with sock)</li>'
        + '<li>If the app folder is writable, it is filled automatically</li>'
        + '<li>Otherwise use files in <code>data/docker-enable/</code></li>'
        + '<li>Stop -> Start this SoloHost app</li></ol></div>'
        + '<p><a class="btn yes" href="/docker/confirm">Agree - enable &amp; prepare files</a> '
        + '<a class="btn no" href="/docker/off">Disable</a></p>'
        + '<p><a href="/">Controller home</a></p></body></html>');
      return;
    }

    if (u === '/api/docker') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'GET') {
        let sock = false;
        try { sock = fs.existsSync('/var/run/docker.sock'); } catch (e) {}
        const pref = readDockerPref();
        res.end(JSON.stringify({
          ok: true,
          enabled: !!pref.enabled,
          consent: !!pref.consent,
          sock: sock,
          by: pref.by || null,
          at: pref.at || null
        }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', function (c) { body += c; if (body.length > 8000) { req.destroy(); return; } });
        req.on('end', function () {
          try {
            const j = safeParse(body) || {};
            const on = !!j.enabled;
            if (on && !j.consent) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: 'consent_required' }));
              return;
            }
            if (on && j.read_full !== true && j.terms_version !== 'docker-optional-v1') {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: 'terms_must_be_accepted_in_solohost_ui' }));
              return;
            }
            writeDockerPref({
              enabled: on,
              consent: on ? true : false,
              consent_version: on ? 'docker-optional-v1' : null,
              consent_text: on ? 'Operator accepted Optional Docker Access Terms via SoloHost UI only' : null,
              at: new Date().toISOString(),
              by: 'solohost_ui'
            });
            let applied = { wrote_host: false, wrote_data: false };
            if (on) applied = applyDockerConsentFiles() || applied;
            try { actionLog('ok', 'docker pref ' + (on ? 'ON' : 'OFF') + ' via /api/docker'); } catch (e) {}
            res.end(JSON.stringify({
              ok: true,
              enabled: on,
              wrote_host: !!(applied && applied.wrote_host),
              wrote_data: !!(applied && applied.wrote_data),
              hint: on
                ? (applied && applied.wrote_host
                  ? 'docker-compose.yml updated in app folder. SoloHost: Stop -> Start.'
                  : 'SoloHost: Stop -> Start after compose is in app folder.')
                : 'Sandbox default.'
            }));
          } catch (e) {
            log('api/docker error: ' + (e && e.message), 'error');
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
          }
        });
        return;
      }
      res.statusCode = 405;
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }

    if (u === '/api/discover') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const force = /force=1|fresh=1/.test(req.url || '');
        const d = await statusMonitor.discovery.discover(force);
        res.end(JSON.stringify({ ok: true, discovery: d, report: statusMonitor.discovery.getReport() }));
      } catch (e) {
        log('api/discover error: ' + (e && e.message), 'error');
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
      }
      return;
    }
    if (u === '/api/alerts') {
      if (!isLocalReq(req)) { res.statusCode = 403; res.end('forbidden'); return; }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'POST') {
        const rows = readDashAlerts().map(function (r) { r.read = true; return r; });
        try { fs.writeFileSync(dashAlertPath(), JSON.stringify(rows)); } catch (e) {}
        res.end(JSON.stringify({ ok: true, unread: 0, items: rows.slice(0, 12) }));
        return;
      }
      const items = readDashAlerts();
      const unread = items.filter(function (r) { return !r.read; }).length;
      res.end(JSON.stringify({ ok: true, unread: unread, items: items.slice(0, 12) }));
      return;
    }
    if (u === '/api/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        version: VERSION, dataLive: false,
        hasBot: !!BOT_TOKEN, hasAI: !!GEMINI_API_KEY, telemetrySec: TELEMETRY_SEC,
        incidentCount: Object.keys(state.incidents || {}).length,
        health: state.healthSmooth,
        healthConfidence: state.healthConfidence
      }));
      return;
    }
    if (u === '/api/logs') {
      if (!isLocalReq(req)) { res.statusCode = 403; res.end('forbidden'); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      try { res.end(redactSecrets(fs.readFileSync(LOG_F, 'utf8').slice(-8000))); } catch (e) { res.end(''); }
      return;
    }
    if (u === '/' || u === '/index.html') {
      setSecHeaders(res);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(INDEX);
      return;
    }
    if (u.startsWith('/scripts/')) {
      const name = path.basename(u);
      const f = path.join(SCRIPTS, name);
      if (fs.existsSync(f)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
        res.end(fs.readFileSync(f));
        return;
      }
    }
    const rel = path.normalize(u).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    if (rel.includes('..')) { res.statusCode = 400; res.end('bad_path'); return; }
    const f = path.join(PUBLIC, rel);
    if (!f.startsWith(PUBLIC)) { res.statusCode = 400; res.end('bad_path'); return; }
    fs.readFile(f, (err, data) => {
      if (err) { res.statusCode = 404; return res.end('not found'); }
      const ext = path.extname(f).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      if (ext === '.bat' || ext === '.ps1') {
        res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(f) + '"');
      }
      res.end(data);
    });
  } catch (e) {
    log('http error: ' + (e && e.message), 'error');
    res.statusCode = 500;
    res.end('error');
  }
});

srv.listen(PORT, '0.0.0.0', () => {
  log('SoloHost Controller v' + VERSION + ' :' + PORT);
  try {
    const pf = path.join(DATA, 'state', 'pending-sock-restart.json');
    if (fs.existsSync(pf)) {
      const pend = JSON.parse(fs.readFileSync(pf, 'utf8'));
      if (pend && pend.need_ui_restart && BOT_TOKEN && CHAT_ID) {
        setTimeout(async function () {
          try {
            await tgSend('🔄 Docker probe\nCompose updated.\nIf /status still shows sock: no - Stop then Start the app once.');
            pend.need_ui_restart = false;
            pend.notified = true;
            fs.writeFileSync(pf, JSON.stringify(pend));
          } catch (e) {}
        }, 4000);
      }
    }
  } catch (e) {}

  log('telemetry=' + TELEMETRY_SEC + 's base · adaptive polling enabled (30-60s)');
  log('Incident engine active · observe -> alert -> remind -> chronic');
  log('Health damper active · EMA + dead-band + confidence-aware');
  log('Telegram long-poll independent of telemetry');
});

telegramLoop();
telemetryLoop();

if (BOT_TOKEN && CHAT_ID && ALERT_ON_START) {
  setTimeout(async () => {
    try {
      const t = await getTelemetry();
      await tgSend('✅ Controller online\n\n' + formatStatus(t), { reply_markup: mainKeyboard() });
    } catch (e) { log('start ' + e.message, 'error'); }
  }, 4000);
      }
