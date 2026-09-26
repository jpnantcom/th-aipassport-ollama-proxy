import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from './server.js';

let server;
let baseUrl;

test.before(async () => {
  server = createServer(createApp({ proxyChat: false }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { response, body: await response.json() };
}

async function post(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

test('health endpoint responds', async () => {
  const { response, body } = await get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: 'ok' });
});

test('tags, ps, show, and model recommendation endpoints respond', async () => {
  const tags = await get('/api/tags');
  assert.equal(tags.response.status, 200);
  assert.equal(tags.body.models.length, 1);

  const ps = await get('/api/ps');
  assert.deepEqual(ps.body, { models: [] });

  const show = await post('/api/show', { model: 'stub-model' });
  assert.equal(show.body.name, 'stub-model');
  assert.equal(show.body.modelfile, 'FROM stub-model');

  const recommendation = await get('/api/recommend');
  assert.equal(recommendation.body.model, tags.body.models[0].name);
});

test('chat supports non-streaming and streaming responses', async () => {
  const nonStreaming = await post('/api/chat', {
    model: 'stub-model',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(nonStreaming.response.status, 200);
  assert.equal(nonStreaming.body.done, true);
  assert.equal(nonStreaming.body.message.role, 'assistant');

  const streaming = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'stub-model', messages: [] }),
  });
  const lines = (await streaming.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(streaming.status, 200);
  assert.equal(lines.at(-1).done, true);
});
