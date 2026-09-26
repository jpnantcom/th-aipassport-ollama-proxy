import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const workerUrl = 'https://worker.test';
const apiToken = 'test-api-token';

function request(path, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${apiToken}`);
  return new Request(`${workerUrl}${path}`, { ...init, headers });
}

test('Worker health and Ollama model routes respond', async () => {
  const health = await worker.fetch(request('/health'), {});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const tags = await worker.fetch(request('/api/tags'), { API_BEARER_TOKEN: apiToken });
  assert.equal(tags.status, 200);
  assert.equal((await tags.json()).models[0].name, 'gemini-3.1-flash-lite');

  const show = await worker.fetch(request('/api/show', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model' }),
  }), { API_BEARER_TOKEN: apiToken });
  assert.equal((await show.json()).name, 'test-model');
});

test('Worker returns structured errors for invalid and oversized JSON', async () => {
  const invalid = await worker.fetch(request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad json',
  }), { API_BEARER_TOKEN: apiToken });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'Request body must be valid JSON.' });

  const oversized = await worker.fetch(request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"padding":"${'x'.repeat(1024 * 1024)}"}`,
  }), { API_BEARER_TOKEN: apiToken });
  assert.equal(oversized.status, 413);
});

test('Worker API requires its configured bearer token', async () => {
  const missingSecret = await worker.fetch(new Request(`${workerUrl}/api/tags`), {});
  assert.equal(missingSecret.status, 503);

  const unauthorized = await worker.fetch(new Request(`${workerUrl}/api/tags`, {
    headers: { authorization: 'Bearer wrong-token' },
  }), { API_BEARER_TOKEN: apiToken });
  assert.equal(unauthorized.status, 401);
});

test('proxied chat loads auth from R2 and sends matching cookies upstream', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamCalls = [];
  let authKey;
  let quotaCalls = 0;
  const env = {
    AIPASS_USER_AGENT: 'Playwright/1.63.0 (x64; windows 10.0) node/26.7',
    AUTH_BUCKET: {
      async get(key) {
        authKey = key;
        return {
          async json() {
            return {
              cookies: [
                { name: 'session', value: 'secret-cookie', domain: '.example.test', path: '/', secure: true },
                { name: 'other', value: 'not-for-this-host', domain: 'elsewhere.test', path: '/' },
                { name: 'expired', value: 'old', domain: 'example.test', path: '/', expires: 1 },
              ],
              origins: [],
            };
          },
        };
      },
    },
    AUTH_OBJECT_KEY: 'private/storage-state.json',
    API_BEARER_TOKEN: apiToken,
    AIPASS_BASE_URL: 'https://example.test',
    AIPASS_MODEL: 'server-model',
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    upstreamCalls.push({ url, init });
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), 'session=secret-cookie');
    assert.equal(headers.get('user-agent'), env.AIPASS_USER_AGENT);
    if (url.pathname === '/loaders/get-usage-quota') {
      quotaCalls += 1;
      const available = quotaCalls === 1 ? 1000 : 900;
      return Response.json({ creditStatus: { credits: { available }, creditsDecimals: 2 } });
    }
    if (url.pathname === '/chat.data') {
      assert.equal(new Headers(init.headers).get('content-type'), 'application/x-www-form-urlencoded');
      return Response.json({ conversationId: 'conversation-123' });
    }
    if (url.pathname === '/actions/send-message/conversation-123') {
      assert.equal(new Headers(init.headers).get('accept'), 'text/event-stream');
      return new Response('data: {"type":"text-delta","delta":"Hello"}\n\n');
    }
    throw new Error(`Unexpected upstream request: ${url.href}`);
  };

  try {
    const response = await worker.fetch(request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'Hi' }] }),
    }), env);

    assert.equal(response.status, 200);
    assert.equal(authKey, 'private/storage-state.json');
    assert.equal(upstreamCalls.length, 4);
    const body = await response.json();
    assert.equal(body.model, 'server-model');
    assert.match(body.message.content, /^Hello/);
    assert.match(body.message.content, /conversation-123/);
    assert.equal(body.eval_count, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('proxied chat reports a missing R2 auth object as unavailable', async () => {
  const response = await worker.fetch(request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, messages: [] }),
  }), {
    API_BEARER_TOKEN: apiToken,
    AUTH_BUCKET: { async get() { return null; } },
  });

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /missing from R2/);
});
