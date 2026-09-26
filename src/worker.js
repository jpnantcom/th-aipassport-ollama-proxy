import { handleOllamaRequest } from './ollama-stub.js';

async function hasValidBearerToken(request, expectedToken) {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ') || !expectedToken) return false;

  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(authorization.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedToken)),
  ]);
  const actualBytes = new Uint8Array(actual);
  const expectedBytes = new Uint8Array(expected);
  let difference = 0;
  for (let index = 0; index < actualBytes.length; index += 1) {
    difference |= actualBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

function errorResponse(message, status, headers = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return handleOllamaRequest(request, env);
    }
    if (!env.API_BEARER_TOKEN) {
      return errorResponse('API_BEARER_TOKEN is not configured.', 503);
    }
    if (!await hasValidBearerToken(request, env.API_BEARER_TOKEN)) {
      return errorResponse('Unauthorized.', 401, { 'www-authenticate': 'Bearer' });
    }
    return handleOllamaRequest(request, env);
  },
};