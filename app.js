'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PiNodeStatusMonitor = require('./status-monitor');

let runtimeSettings = {
  aiToken: process.env.AI_TOKEN || '',
  tgToken: process.env.BOT_TOKEN || '',
  tgChatId: process.env.CHAT_ID || ''
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({status: 'ok'}));
    return;
  }
  if (req.url === '/api/status') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({sync: 'Catching up', ledger: '45,210,890', peers: '8'}));
    return;
  }
  if (req.url === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ aiToken: runtimeSettings.aiToken ? '***' : '', tgToken: runtimeSettings.tgToken ? '***' : '', tgChatId: runtimeSettings.tgChatId }));
    return;
  }
  if (req.url === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if(data.aiToken && data.aiToken !== '***') runtimeSettings.aiToken = data.aiToken;
        if(data.tgToken && data.tgToken !== '***') runtimeSettings.tgToken = data.tgToken;
        if(data.tgChatId !== undefined) runtimeSettings.tgChatId = data.tgChatId;
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({success: true}));
      } catch(e) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'Invalid JSON'}));
      }
    });
    return;
  }

  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not Found');
    } else {
      const ext = path.extname(filePath);
      let mime = 'text/html';
      if(ext === '.jpg') mime = 'image/jpeg';
      if(ext === '.png') mime = 'image/png';
      res.writeHead(200, {'Content-Type': mime});
      res.end(data);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pi Node Controller PRO running on port ${PORT}`);
});
