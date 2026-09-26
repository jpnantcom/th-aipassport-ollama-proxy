import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('Node server proxies chat with cookies from a local Playwright storage state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thpassport-auth-'));
  const authStatePath = join(directory, 'storage-state.json');
  const originalEnvironment = {
    AUTH_STATE_PATH: process.env.AUTH_STATE_PATH,
    AUTH_OBJECT_KEY: process.env.AUTH_OBJECT_KEY,
    AIPASS_BASE_URL: process.env.AIPASS_BASE_URL,
  };
  const storageState = {
    cookies: [{ name: 'session', value: 'local-test-cookie', domain: 'example.test', path: '/', secure: true }],
    origins: [],
  };
  await writeFile(authStatePath, JSON.stringify(storageState));

  process.env.AUTH_STATE_PATH = authStatePath;
  process.env.AUTH_OBJECT_KEY = 'auth/storage-state.json';
  process.env.AIPASS_BASE_URL = 'https://example.test';

  const originalFetch = globalThis.fetch;
  const upstreamCalls = [];
  const testServer = createServer(createApp());

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== 'https://example.test') return originalFetch(input, init);

    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), 'session=local-test-cookie');
    assert.match(headers.get('user-agent'), /^Playwright\/\d+\.\d+\.\d+ \(/);
    upstreamCalls.push({ url, init, headers });
    if (url.pathname === '/loaders/get-usage-quota') return Response.json({});
    if (url.pathname === '/chat.data') {
      assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
      assert.equal(new URLSearchParams(init.body).get('message'), 'Why Sky is blue');
      return Response.json({ conversationId: 'local-test-conversation' });
    }
    if (url.pathname === '/actions/send-message/local-test-conversation') {
      const payload = JSON.parse(init.body);
      assert.equal(payload.modelId, 'gemini-3.1-flash-lite');
      assert.equal(payload.messages[0].parts[0].text, 'Why Sky is blue');
      return new Response('data: {"type":"text-delta","delta":"OK"}\n\n');
    }
    throw new Error(`Unexpected upstream request: ${url.href}`);
  };

  try {
    await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const { port } = testServer.address();
    const chatRequest = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.1-flash-lite',
        stream: false,
        messages: [{ role: 'user', content: 'Why Sky is blue' }],
      }),
    };
    const response = await originalFetch(`http://127.0.0.1:${port}/api/chat`, chatRequest);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.done, true);
    assert.match(body.message.content, /^OK/);
    assert.equal(upstreamCalls.length, 4);

    await writeFile(authStatePath, JSON.stringify({ cookies: [], origins: [] }));
    const refreshedResponse = await originalFetch(`http://127.0.0.1:${port}/api/chat`, chatRequest);
    assert.equal(refreshedResponse.status, 503);
    assert.match((await refreshedResponse.json()).error, /No unexpired cookies/);
    assert.equal(await readFile(authStatePath, 'utf8'), JSON.stringify({ cookies: [], origins: [] }));
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => testServer.close((error) => error ? reject(error) : resolve()));
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
