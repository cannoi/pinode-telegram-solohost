  const!= null ? d.quorum.missing : '—'));
    if   }, extra || {});
  
    if (state.pendingReset && now > state.pendingReset.until) state.pendingReset = null;
    saveJSON(STATE_F, state);
  } catch (e) {
    console.log('[monitor] ' + (e && e.message));
  }
}

// ---------- commands ----------
async function sendHelp(withKb) {
  const text =
    '<b>PI NODE TELEGRAM CONTROLLER</b>\n' +
    '<i>SoloHost Edition PRO</i>\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '<b>Lệnh nhanh:</b>\n' +
    '/status — trạng thái đầy đủ\n' +
    '/monitor — quét + mức cảnh báo\n' +
    '/ports — cổng 31401–3\n/sync — trạng thái đồng bộ\n' +
    '/docker — container node\n' +
    '/disk — dung lượng ổ\n' +
    '/logs — log container\n' +
    '/reset — restart node (cần xác nhận)\n' +
    '/report — báo cáo ngay\n' +
    '/history — lịch sử sự cố\n' +
    '/ping — kiểm tra bot\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '💬 Chat tự nhiên: <i>“node thế nào”</i>, <i>“cổng mở chưa”</i>\n\n' +
    '💻 <b>Bản Windows PRO</b> (CleanRAM, screenshot, AI…):\n' +
    GITHUB_PRO;
  return tgSend(text, withKb !== false ? { reply_markup: mainKeyboard() } : {});
}

async function handleReset() {
  const dn = await dockerNode();
  if (!dn || !dn.found) {
    return tgSend(
      '⚠️ <b>Không thể reset</b>\n\n' +
      'Chưa mount docker.sock hoặc không thấy container node.\n' +
      'Trên máy tin cậy: bỏ comment dòng sock trong docker-compose.yml.'
    );
  }
  state.pendingReset = { id: dn.id, name: dn.name, until: Date.now() + 60000 };
  saveJSON(STATE_F, state);
  return tgSend(
    `⚠️ <b>Xác nhận RESET node</b>\n` +
    `Container: <code>${esc(dn.name)}</code>\n\n` +
    `Gửi <b>/yes</b> trong 60 giây để restart.\nBỏ qua nếu không muốn.`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Xác nhận /yes', callback_data: 'cmd_yes' },
          { text: '❌ Hủy', callback_data: 'cmd_cancel' }
        ]]
      }
    }
  );
}

async function handleResetConfirm() {
  if (!state.pendingReset || Date.now() > state.pendingReset.until) {
    state.pendingReset = null;
    saveJSON(STATE_F, state);
    return tgSend('Không có yêu cầu reset đang chờ (hoặc đã hết hạn). Gõ /reset trước.');
  }
  const { id, name } = state.pendingReset;
  state.pendingReset = null;
  saveJSON(STATE_F, state);
  await tgSend('⏳ Đang restart <code>' + esc(name) + '</code>…');
  const ok = await dockerRestart(id);
  pushHist({ type: 'reset', severity: ok ? 'ok' : 'warning', name });
  if (ok) {
    await wait(4000);
    const st = await collectStatus();
    return tgSend('✅ Đã gửi lệnh restart.\n\n' + formatStatus(st), { reply_markup: mainKeyboard() });
  }
  return tgSend('❌ Restart thất bại. Kiểm tra quyền docker.sock.');
}

async function runCmd(cmd) {
  if (cmd === 'status' || cmd === 's') {
    const st = await collectStatus();
    return tgSend(formatStatus(st, { withLink: true }), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'monitor' || cmd === 'm') {
    const st = await collectStatus();
    return tgSend('🔍 <b>Monitor</b>\n\n' + formatStatus(st) +
      `\n\nMức: <b>${SEV_LABEL[st.severity]}</b> · Alert đã gửi: ${state.alertCount || 0}`,
      { reply_markup: mainKeyboard() });
  }
  if (cmd === 'ports') {
    const lo = await localOpen();
    return tgSend(
      '<b>Cổng node 31401–31403</b>\n━━━━━━━━━━━━━━━━\n' +
      REQUIRED.map(p => (lo.includes(p) ? '✅' : '❌') + '  <code>' + p + '</code>').join('\n') +
      (lo.length === 0 ? '\n\n⚠️ Không thấy cổng nào mở trên host.' : ''),
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'sync' || cmd === 'dongbo') {
    const st = await collectStatus();
    const n = st.node;
    return tgSend(
      '<b>Đồng bộ Pi Node</b>\n━━━━━━━━━━━━━━━━\n' +
      '• Trạng thái: <b>' + esc(syncLabel(n.sync)) + '</b>\n' +
      '• Node: ' + (n.running ? 'ONLINE' : 'OFFLINE') + '\n' +
      '• Nguồn: ' + (n.dockerAccess ? 'docker exec' : 'host :11626 / suy đoán') + '\n' +
      '' + detailBlock + '🕐 ' + esc(nowStr()),
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'docker') {
    const dn = await dockerNode();
    if (!dn) {
      return tgSend('Docker sock <b>không</b> được mount.\nTrạng thái đang suy từ cổng nội bộ.', { reply_markup: mainKeyboard() });
    }
    if (!dn.found) return tgSend('Không tìm thấy container Pi Node.', { reply_markup: mainKeyboard() });
    return tgSend(
      `<b>Docker node</b>\n━━━━━━━━━━━━━━━━\n` +
      `• Tên: <code>${esc(dn.name)}</code>\n` +
      `• State: <b>${dn.running ? 'running' : 'stopped'}</b>\n` +
      `• Status: ${esc(dn.status)}\n` +
      `• Proto: ${esc(dn.proto || '—')}\n` +
      `• Image: <code>${esc(dn.image)}</code>`,
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'disk') {
    const d = diskInfo();
    if (!d) return tgSend('Không đọc được disk.');
    return tgSend(
      `<b>Disk</b>\n━━━━━━━━━━━━━━━━\n` +
      `• Đã dùng: <b>${d.usedGB}</b> / ${d.totalGB} GB (<b>${d.pct}%</b>)\n` +
      `• Còn trống: ${d.availGB} GB`,
      { reply_markup: mainKeyboard() }
    );
  }
  if (cmd === 'logs') {
    const dn = await dockerNode();
    if (!dn || !dn.found) return tgSend('Không có docker sock hoặc không thấy container.');
    const logs = await dockerLogs(dn.id, 35);
    if (!logs) return tgSend('Không lấy được logs.');
    const clipped = logs.length > 3500 ? logs.slice(-3500) : logs;
    return tgSend('<b>Logs gần nhất</b>\n<pre>' + esc(clipped) + '</pre>');
  }
  if (cmd === 'reset') return handleReset();
  if (cmd === 'yes' || cmd === 'confirm') return handleResetConfirm();
  if (cmd === 'cancel') {
    state.pendingReset = null;
    saveJSON(STATE_F, state);
    return tgSend('Đã hủy reset.', { reply_markup: mainKeyboard() });
  }
  if (cmd === 'report') {
    const st = await collectStatus();
    return tgSend('📋 <b>Báo cáo</b>\n\n' + formatStatus(st, { withLink: true }), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'history') {
    if (!history.length) return tgSend('Chưa có sự kiện.', { reply_markup: mainKeyboard() });
    const lines = history.slice(0, 12).map(h => {
      let t;
      try {
        t = new Date(h.t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
      } catch (e) { t = new Date(h.t).toISOString(); }
      return `• ${esc(t)} — <b>${esc(h.type)}</b> (${esc(h.severity || '')})`;
    });
    return tgSend('<b>Lịch sử gần đây</b>\n━━━━━━━━━━━━━━━━\n' + lines.join('\n'), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'ping') {
    return tgSend('🏓 <b>pong</b>\nSoloHost PRO <code>v' + VERSION + '</code>\n' + detailBlock + '🕐 ' + esc(nowStr()), { reply_markup: mainKeyboard() });
  }
  if (cmd === 'start' || cmd === 'help') return sendHelp(true);
  return null;
}

async function handleText(text) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase();
  const cmd = lower.split(/\s+/)[0].replace(/@\w+$/, '').replace(/^\//, '');

  if (raw.startsWith('/')) {
    const r = await runCmd(cmd);
    if (r) return r;
    return tgSend('Không rõ lệnh. Gõ /help', { reply_markup: mainKeyboard() });
  }

  // ngôn ngữ tự nhiên
  if (/node|trạng thái|status|thế nào|ra sao|online|offline/i.test(raw)) return runCmd('status');
  if (/cổng|port/i.test(raw)) return runCmd('ports');
  if (/reset|khởi động lại|restart/i.test(raw)) return runCmd('reset');
  if (/giúp|help|lệnh/i.test(raw)) return runCmd('help');
  return null;
}

// ---------- long poll (message + callback) ----------
let offset = 0;
async function pollTelegram() {
  if (!BOT_TOKEN) return;
  try {
    const r = await tgApi('getUpdates', {
      offset, timeout: 25,
      allowed_updates: ['message', 'callback_query']
    });
    if (!r || !r.ok || !Array.isArray(r.result)) return;
    for (const u of r.result) {
      offset = u.update_id + 1;

      if (u.callback_query) {
        const cq = u.callback_query;
        if (CHAT_ID && String(cq.message && cq.message.chat && cq.message.chat.id) !== String(CHAT_ID)) continue;
        const data = cq.data || '';
        await tgAnswerCb(cq.id);
        if (data.startsWith('cmd_')) {
          const c = data.slice(4);
          try { await runCmd(c); } catch (e) { console.log('[cb] ' + (e && e.message)); }
        }
        continue;
      }

      const msg = u.message;
      if (!msg || !msg.text) continue;
      if (CHAT_ID && String(msg.chat.id) !== String(CHAT_ID)) continue;
      try { await handleText(msg.text); } catch (e) {
        console.log('[cmd] ' + (e && e.message));
      }
    }
  } catch (e) {
    console.log('[tg] ' + (e && e.message));
  }
}
async function tgLoop() {
  while (true) {
    await pollTelegram();
    await wait(300);
  }
}

// ---------- HTTP + UI ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon'
};

let INDEX_HTML = '';
try { INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'); } catch (e) {
  INDEX_HTML = '<h1>Pi Node Controller</h1>';
}

const srv = http.createServer(async function (req, res) {
  const u = (req.url || '/').split('?')[0];
  try {
    if (u === '/healthz' || u === '/health') { res.end('ok'); return; }
    if (u === '/api/status') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(await collectStatus()));
      return;
    }
    if (u === '/api/history') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(history.slice(0, 30)));
      return;
    }
    if (u === '/api/info') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        version: VERSION,
        githubPro: GITHUB_PRO,
        donateUrl: DONATE_URL,
        hasBot: !!BOT_TOKEN,
        hasChat: !!CHAT_ID,
        reportHours: REPORT_HOURS,
        alertCooldown: ALERT_COOLDOWN,
        time: nowStr()
      }));
      return;
    }
    if (u === '/' || u === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(INDEX_HTML);
      return;
    }
    const rel = path.normalize(u).replace(/^(\.\.[/\\])+/, '');
    const f = path.join(PUBLIC, rel);
    fs.readFile(f, function (err, data) {
      if (err) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', MIME[path.extname(f).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(data);
    });
  } catch (e) {
    res.statusCode = 500;
    res.end('error');
  }
});

srv.listen(PORT, '0.0.0.0', function () {
  console.log('[pinode-tg] SoloHost PRO v' + VERSION + ' :' + PORT);
  console.log('[pinode-tg] bot=' + (BOT_TOKEN ? 'yes' : 'NO') + ' chat=' + (CHAT_ID || 'NO'));
  console.log('[pinode-tg] time=' + nowStr());
});

_cpuSampler();
monitorTick();
setInterval(monitorTick, 12000);

if (BOT_TOKEN && CHAT_ID) {
  tgLoop();
  if (ALERT_ON_START) {
    setTimeout(async () => {
      const st = await collectStatus();
      await tgSend(
        '✅ <b>Controller SoloHost PRO đã online</b>\n\n' + formatStatus(st, { withLink: true }),
        { reply_markup: mainKeyboard() }
      );
    }, 2500);
  }
} else {
  console.log('[pinode-tg] thiếu BOT_TOKEN/CHAT_ID — chỉ web UI');
}
