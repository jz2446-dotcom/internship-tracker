// lib/historyServer.js — tiny local HTTP server backing the History panel's
// embedded BrowserView: '/' serves the real dashboard HTML, '/api/data' serves
// whichever snapshot is currently selected (swappable without restarting).
const http = require('http');

function createHistoryServer(getHtml, getSnapshotJson) {
  return http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtml());
      return;
    }
    if (url === '/api/data') {
      const json = getSnapshotJson();
      if (json == null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no snapshot selected' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(json);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
}

function startHistoryServer(getHtml, getSnapshotJson) {
  const server = createHistoryServer(getHtml, getSnapshotJson);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { createHistoryServer, startHistoryServer };
