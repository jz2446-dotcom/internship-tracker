const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startHistoryServer } = require('./historyServer.js');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}

test('serves the dashboard HTML at /', async () => {
  const { server, port } = await startHistoryServer(() => '<html>hi</html>', () => null);
  const res = await get(port, '/');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/html/);
  assert.equal(res.body, '<html>hi</html>');
  server.close();
});

test('serves the current snapshot JSON at /api/data', async () => {
  let current = '{"agents":{}}';
  const { server, port } = await startHistoryServer(() => '<html/>', () => current);
  const res = await get(port, '/api/data');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/);
  assert.equal(res.body, '{"agents":{}}');
  server.close();
});

test('/api/data reflects a changed snapshot without restarting the server', async () => {
  let current = 'first';
  const { server, port } = await startHistoryServer(() => '<html/>', () => current);
  assert.equal((await get(port, '/api/data')).body, 'first');
  current = 'second';
  assert.equal((await get(port, '/api/data')).body, 'second');
  server.close();
});

test('returns 404 JSON at /api/data when no snapshot is selected', async () => {
  const { server, port } = await startHistoryServer(() => '<html/>', () => null);
  const res = await get(port, '/api/data');
  assert.equal(res.status, 404);
  server.close();
});

test('returns 404 for an unknown route', async () => {
  const { server, port } = await startHistoryServer(() => '<html/>', () => null);
  const res = await get(port, '/nope');
  assert.equal(res.status, 404);
  server.close();
});
