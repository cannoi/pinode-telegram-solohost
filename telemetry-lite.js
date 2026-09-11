'use strict';
/**
 * Lightweight live frame + local health/trend. No extra HTTP.
 * Missing metrics stay null/unknown — never invented.
 *
 * [2.6.57] t.cpu / t.ram / t.disk now come from Windows Host (windows_host).
 * scoreCoreHealth() must NOT fall back to those for container metrics.
 */

function num(v) {
  if (v == null || v === '') return null;
  if (v === false || v === true) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
/** Host resources: 0 means not collected on SoloHost, not a real reading. */
function hostMetric(v) {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n;
}

function portsOkFrom(t) {
  if (!t) return 'unknown';
  if (t.ports_ok === true || t.ports_ok === false) return t.ports_ok;
  if (t.ports_all_open === true) return true;
  if (t.ports_open != null) {
    const n = num(t.ports_open);
    if (n == null) return 'unknown';
    return n >= 3;
  }
  if (t.ports && typeof t.ports === 'object') {
    const vals = Object.keys(t.ports).map(function (k) { return t.ports[k]; });
    if (!vals.length) return 'unknown';
    const open = vals.filter(function (v) { return /open|ok|true/i.test(String(v)); }).length;
    return open >= Math.min(3, vals.length);
  }
  return 'unknown';
}

function dockerStatusFrom(t) {
  if (!t) return 'unknown';
  if (t.docker_status) return String(t.docker_status);
  if (t.docker_sock !== true && !t.docker_probe) return 'unknown';
  const d = String(t.docker || '');
  if (/running|up/i.test(d)) return 'running';
  if (/exit|stop|dead/i.test(d)) return 'stopped';
  if (t.docker_sock === true) return 'available';
  return 'unknown';
}

function dockerHealthFrom(t) {
  if (!t) return 'unknown';
  if (t.docker_health) return String(t.docker_health);
  const st = dockerStatusFrom(t);
  if (st === 'unknown') return 'unknown';
  if (st === 'running' || st === 'available') return 'healthy';
  if (st === 'stopped') return 'unhealthy';
  return 'unknown';
}

/** Core health: only when docker.sock is on and Core/container fields exist. */
function scoreCoreHealth(t) {
  t = t || {};
  if (t.docker_sock !== true && t.docker_probe !== true) return null;
  if (!t.core_verified && !t.core_state && !t.container_health && t.peer_in == null && t.peer_out == null) {
    return null;
  }
  let score = 72;
  const st = String(t.core_state || t.sync || '');
  if (/synced/i.test(st) && !/not\s*synced/i.test(st)) score += 16;
  else if (/catching/i.test(st)) score -= 10;
  else if (/stop|error|fail/i.test(st)) score -= 24;
  const age = num(t.ledger_age);
  if (age != null) {
    if (age <= 20) score += 8;
    else if (age <= 60) score += 2;
    else if (age <= 180) score -= 10;
    else score -= 22;
  }
  const pin = num(t.peer_in);
  const pout = num(t.peer_out);
  if (pin != null || pout != null) {
    const tot = (pin || 0) + (pout || 0);
    if (tot >= 12) score += 6;
    else if (tot >= 6) score += 2;
    else if (tot >= 2) score -= 4;
    else score -= 14;
  }
  const ch = String(t.container_health || t.docker_health || '');
  if (/healthy/i.test(ch)) score += 6;
  else if (/unhealthy/i.test(ch)) score -= 16;
  const lag = num(t.ingest_lag);
  if (lag != null) {
    if (lag <= 5) score += 4;
    else if (lag > 50) score -= 10;
  }
  // [2.6.57] Chỉ dùng container_cpu/container_ram cho core health.
  // KHÔNG fallback sang t.cpu/t.ram vì đó là Host metrics (windows_host).
  const cpu = hostMetric(t.container_cpu);
  const ram = hostMetric(t.container_ram);
  if (cpu != null && cpu >= 95) score -= 8;
  if (ram != null && ram >= 92) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreHealth(t) {
  t = t || {};
  let score = 70;
  let used = 0;
  const sync = String(t.sync || '');
  if (sync) {
    used++;
    if (/synced|live|horizon ok/i.test(sync)) score += 18;
    catchup: if (/catch|syncing|slow/i.test(sync)) score -= 8;
    if (/not synced|offline|fail|error/i.test(sync)) score -= 28;
  }
  const age = num(t.ledger_age);
  if (age != null) {
    used++;
    if (age <= 20) score += 8;
    else if (age <= 60) score += 2;
    else if (age <= 180) score -= 8;
    else score -= 22;
  }
  const peers = num(t.peers != null ? t.peers : t.peer_total);
  if (peers != null) {
    used++;
    if (peers >= 12) score += 6;
    else if (peers >= 8) score += 2;
    else if (peers >= 3) score -= 6;
    else score -= 16;
  }
  const pok = portsOkFrom(t);
  if (pok === true) { used++; score += 8; }
  else if (pok === false) { used++; score -= 22; }
  const dh = dockerHealthFrom(t);
  if (dh === 'healthy') { used++; score += 4; }
  else if (dh === 'unhealthy') { used++; score -= 10; }
  const ram = hostMetric(t.ram);
  if (ram != null) {
    used++;
    if (ram >= 92) score -= 14;
    else if (ram >= 85) score -= 6;
  }
  const cpu = hostMetric(t.cpu);
  if (cpu != null) {
    used++;
    if (cpu >= 95) score -= 10;
    else if (cpu >= 85) score -= 4;
  }
  const disk = hostMetric(t.disk);
  if (disk != null) {
    used++;
    if (disk >= 95) score -= 16;
    else if (disk >= 88) score -= 6;
  }
  if (!used) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function trendFrom(curr, prevRows) {
  const rows = (prevRows || []).slice(-16);
  if (rows.length < 3 || !curr) return 'stable';
  const ages = rows.map(function (r) { return num(r.ledger_age); }).filter(function (x) { return x != null; });
  const peers = rows.map(function (r) { return num(r.peers != null ? r.peers : r.peer_total); }).filter(function (x) { return x != null; });
  const healths = rows.map(function (r) { return num(r.health); }).filter(function (x) { return x != null; });
  const rams = rows.map(function (r) { return num(r.ram); }).filter(function (x) { return x != null; });
  let bad = 0, good = 0;
  if (ages.length >= 3) {
    const a0 = ages[0], a1 = ages[ages.length - 1];
    if (a1 > a0 + 25) bad++;
    if (a1 + 15 < a0) good++;
  }
  if (peers.length >= 3) {
    const p0 = peers[0], p1 = peers[peers.length - 1];
    if (p1 + 8 < p0 || (p0 >= 8 && p1 < 8)) bad++;
    if (p1 > p0 + 6) good++;
  }
  if (healths.length >= 3) {
    const h0 = healths[0], h1 = healths[healths.length - 1];
    if (h1 + 8 < h0) bad++;
    if (h1 > h0 + 8) good++;
  }
  if (rams.length >= 3) {
    const r0 = rams[0], r1 = rams[rams.length - 1];
    if (r1 > r0 + 12 && r1 >= 80) bad++;
  }
  if (bad >= 2 && bad > good) return 'degrading';
  if (good >= 2 && good > bad) return 'improving';
  return 'stable';
}

function liveFrame(t, prevRows) {
  t = t || {};
  const peers = num(t.peer_total != null ? t.peer_total : (t.peer_in != null && t.peer_out != null ? t.peer_in + t.peer_out : t.peers));
  const pok = portsOkFrom(t);
  const ds = dockerStatusFrom(t);
  const dh = dockerHealthFrom(t);
  const health = scoreHealth(t);
  const coreHealth = scoreCoreHealth(t);
  const frame = {
    ts: t.ts || new Date().toISOString(),
    status: t.level || t.status || null,
    sync: t.sync || null,
    ledger: num(t.ledger),
    ledger_age: num(t.ledger_age),
    peers: peers,
    ports_ok: pok,
    cpu: hostMetric(t.cpu),
    ram: hostMetric(t.ram),
    disk: hostMetric(t.disk),
    docker_status: ds,
    docker_health: dh,
    health: health,
    core_health: coreHealth,
    health_source: coreHealth != null ? 'core' : 'horizon',
    trend: trendFrom(t, prevRows),
    source: t.source || null
  };
  return frame;
}

function historyRow(t) {
  const f = liveFrame(t);
  return {
    ts: f.ts,
    health: f.health,
    core_health: f.core_health,
    health_source: f.health_source,
    sync: f.sync,
    ledger: f.ledger,
    ledger_age: f.ledger_age,
    peers: f.peers,
    ports_ok: f.ports_ok,
    cpu: f.cpu,
    ram: f.ram,
    disk: f.disk,
    docker_status: f.docker_status,
    docker_health: f.docker_health,
    source: f.source,
    status: f.status
  };
}

function aiContext(t, extra) {
  extra = extra || {};
  const f = liveFrame(t, extra.prevRows);
  const out = {
    status: f.status,
    sync: f.sync,
    ledger: f.ledger,
    ledger_age: f.ledger_age,
    peers: f.peers,
    ports_ok: f.ports_ok,
    cpu: f.cpu,
    ram: f.ram,
    disk: f.disk,
    docker_status: f.docker_status,
    docker_health: f.docker_health,
    health: f.core_health != null ? f.core_health : f.health,
    horizon_health: f.health,
    core_health: f.core_health,
    health_source: f.health_source,
    trend: f.trend,
    source: f.source
  };
  const extraKeys = ['ledger_per_min','container_health','container_cpu','container_cpu_docker','container_cpu_cores','container_cpus','container_ram','container_ram_mb','container_ram_limit_mb','blkio','net_io','restart_count','oom','pid','peer_in','peer_out'];
  extraKeys.forEach(function (k) {
    if (t[k] != null && t[k] !== '' && t[k] !== 0) out[k] = t[k];
  });
  if (t.restart_count === 0) out.restart_count = 0;
  Object.keys(out).forEach(function (k) {
    if (out[k] == null) delete out[k];
  });
  if (extra.events) out.recent_events = extra.events;
  if (extra.diagnostic) out.diagnostic = extra.diagnostic;
  return out;
}

module.exports = {
  num, hostMetric, portsOkFrom, dockerStatusFrom, dockerHealthFrom,
  scoreHealth, scoreCoreHealth, trendFrom, liveFrame, historyRow, aiContext
};
