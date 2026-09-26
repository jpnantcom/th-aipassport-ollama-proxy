const defaultModelName = 'gemini-3.1-flash-lite';
const defaultDestinationUrl = 'https://de.aipass.net';
const defaultAuthObjectKey = 'auth/storage-state.json';
const maxJsonBodyBytes = 1024 * 1024;

const generateAnswerTool = {
  type: 'function',
  function: {
    name: 'generate_answer',
    description: 'Use this action when the final answer is ready and only the answer message should be shown to the user.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The final answer to display to the user.',
        },
      },
      required: ['message'],
    },
  },
};

function createModel(name = defaultModelName) {
  const modelName = typeof name === 'string' && name.trim() ? name.trim() : defaultModelName;
  return {
    name: modelName,
    model: modelName,
    modified_at: new Date().toISOString(),
    size: 0,
    digest: 'stub',
    details: {
      parent_model: '',
      format: 'stub',
      family: 'stub',
      families: ['stub'],
      parameter_size: '0B',
      quantization_level: 'stub',
    },
  };
}

function requestedModel(request) {
  return request.body?.model || defaultModelName;
}

function chatMessage(request) {
  const messages = Array.isArray(request.body?.messages) ? request.body.messages : [];
  const lastUserMessage = [...messages].reverse().find((message) => message?.role === 'user');
  return typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
}

function toolDetails(tool) {
  const definition = tool?.function ?? tool;
  const name = definition?.name ?? 'unknown';
  const properties = definition?.parameters?.properties ?? {};
  const signature = `${name}( ${Object.keys(properties).join(', ')} ) { }`;
  const description = definition?.description ?? 'No description provided.';
  const parameters = Object.entries(properties).map(([parameterName, parameter]) => {
    let shape = parameter?.type ?? 'unknown';
    if (parameter?.type === 'array' && parameter.items?.type) shape += `<${parameter.items.type}>`;
    if (Array.isArray(parameter?.enum)) shape += `; values: ${parameter.enum.join(', ')}`;
    return `- ${parameterName} (${shape}): ${parameter?.description ?? 'No description provided.'}`;
  });
  return `${signature}\nDescription: ${description}\nParameters:\n${parameters.join('\n')}`;
}

export function initialConversationMessage(request, userRequest) {
  const messages = Array.isArray(request.body?.messages) ? request.body.messages : [];
  const systemMessages = messages
    .filter((message) => message?.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content);
  if (typeof request.body?.system === 'string' && request.body.system.trim()) {
    systemMessages.unshift(request.body.system);
  }
  const systemMessage = systemMessages.join('\n\n');
  const requestedTools = Array.isArray(request.body?.tools) ? request.body.tools : [];
  const tools = requestedTools.filter((tool) => {
    const name = tool?.function?.name ?? tool?.name;
    return name !== generateAnswerTool.function.name;
  });

  const sections = [];
  if (systemMessage) sections.push(`##Additional Instruction for you\n${systemMessage}`);
  if (tools.length) {
    sections.push([
      'From this available library function',
      [generateAnswerTool, ...tools].map(toolDetails).join('\n\n'),
      `Ensure that you satisfy this request:\n${userRequest}`,
      'Generate code to perform the task. I will provide the result from invoking the function in my system.',
      'You can only create one function call at a time.',
    ].join('\n\n'));
  } else if (userRequest) {
    sections.push(userRequest);
  }
  return sections.join('\n\n');
}

export function finalAnswerFromAction(content) {
  const match = content.match(/<action\s+name=["']generate_answer["'][\s\S]*?<parameters>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/parameters>/i);
  if (!match) return content;

  try {
    const parameters = JSON.parse(match[1].trim());
    if (typeof parameters === 'string') return parameters;
    const answer = parameters?.message ?? parameters?.answer ?? parameters?.content;
    return typeof answer === 'string' ? answer : content;
  } catch {
    return content;
  }
}

function conversationIdFromMessages(request) {
  const messages = Array.isArray(request.body?.messages) ? request.body.messages : [];
  for (const message of [...messages].reverse()) {
    if (message?.role !== 'assistant' || typeof message.content !== 'string') continue;
    const match = message.content.match(/```aipass-sess\s*([\s\S]*?)\s*```/i);
    if (!match) continue;
    try {
      const session = JSON.parse(match[1]);
      if (typeof session.conversationId === 'string' && session.conversationId.trim()) {
        return session.conversationId.trim();
      }
    } catch {
      // Ignore malformed session markers and start a new conversation.
    }
  }
  return undefined;
}

function withConversationSession(content, conversationId) {
  return `${content}\n\n\`\`\`aipass-sess\n${JSON.stringify({ conversationId })}\n\`\`\``;
}

function findProperty(value, propertyName) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length - 1; index += 1) {
      if (value[index] === propertyName) return value[index + 1];
    }
    for (const item of value) {
      const result = findProperty(item, propertyName);
      if (result !== undefined) return result;
    }
  } else if (value && typeof value === 'object') {
    if (propertyName in value) return value[propertyName];
    for (const item of Object.values(value)) {
      const result = findProperty(item, propertyName);
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${description} returned invalid JSON: ${error.message}`);
  }
}

function parseDestinationStream(text) {
  let content = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice('data: '.length);
    if (payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload);
      if (event.type === 'text-delta') content += event.delta ?? '';
    } catch {
      // Ignore keepalive and malformed events.
    }
  }
  return content;
}

function readQuota(quota) {
  const creditStatus = quota?.creditStatus;
  const available = Number(creditStatus?.credits?.available);
  const decimals = Number(creditStatus?.creditsDecimals ?? 0);
  if (!Number.isFinite(available)) return undefined;
  return {
    available,
    decimals,
    credits: available / 10 ** decimals,
  };
}

function calculateQuotaUsage(before, after) {
  if (!before || !after) return undefined;
  const rawCreditsUsed = Math.max(0, before.available - after.available);
  return {
    raw_credits_used: rawCreditsUsed,
    credits_used: rawCreditsUsed / 10 ** after.decimals,
    quota_before: before.credits,
    quota_after: after.credits,
    credits_decimals: after.decimals,
  };
}

function estimateTokenCount(text) {
  return Math.max(0, Math.ceil((text ?? '').length / 4));
}

function isCookieApplicable(cookie, destination) {
  const host = destination.hostname.toLowerCase();
  const cookieDomain = typeof cookie?.domain === 'string' ? cookie.domain.replace(/^\./, '').toLowerCase() : '';
  if (cookieDomain && host !== cookieDomain && !host.endsWith(`.${cookieDomain}`)) return false;
  if (cookie.secure && destination.protocol !== 'https:') return false;

  const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  if (!destination.pathname.startsWith(cookiePath)) return false;
  if (cookie.expires && Number(cookie.expires) > 0 && Number(cookie.expires) <= Date.now() / 1000) return false;
  return typeof cookie.name === 'string' && cookie.name.length > 0 && typeof cookie.value === 'string';
}

async function loadAuthCookieHeader(env, destination) {
  const bucket = env.AUTH_BUCKET;
  if (!bucket || typeof bucket.get !== 'function') {
    const error = new Error('The AUTH_BUCKET R2 binding is not configured.');
    error.status = 503;
    throw error;
  }

  let object;
  try {
    object = await bucket.get(env.AUTH_OBJECT_KEY || defaultAuthObjectKey);
  } catch {
    const error = new Error('Unable to load captured authentication from R2.');
    error.status = 503;
    throw error;
  }
  if (!object) {
    const error = new Error('Captured authentication is missing from R2.');
    error.status = 503;
    throw error;
  }

  let authState;
  try {
    authState = await object.json();
  } catch {
    const error = new Error('The R2 authentication object is not valid JSON.');
    error.status = 503;
    throw error;
  }
  const cookies = Array.isArray(authState) ? authState : authState?.cookies;
  if (!Array.isArray(cookies)) {
    const error = new Error('The R2 authentication object must contain a cookies array.');
    error.status = 503;
    throw error;
  }

  const cookieHeader = cookies
    .filter((cookie) => isCookieApplicable(cookie, destination))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  if (!cookieHeader) {
    const error = new Error('No unexpired cookies for the upstream host were found in R2 authentication.');
    error.status = 503;
    throw error;
  }
  return cookieHeader;
}

async function upstreamRequest(destination, cookieHeader, path, { method = 'GET', form, data, headers: extraHeaders = {}, userAgent } = {}) {
  const url = new URL(path, destination);
  if (url.origin !== destination.origin) throw new Error('Upstream request must remain on the configured origin.');

  const headers = new Headers({
    accept: 'application/json, text/plain, */*',
    origin: destination.origin,
    referer: new URL('/chat', destination).href,
    cookie: cookieHeader,
  });
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  if (userAgent) headers.set('user-agent', userAgent);

  let body;
  if (form) {
    body = new URLSearchParams(form);
    headers.set('content-type', 'application/x-www-form-urlencoded');
  } else if (data !== undefined) {
    body = JSON.stringify(data);
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(url, { method, headers, body, redirect: 'manual' });
  const responseBody = await response.text();
  if (!response.ok) {
    const error = new Error(`Destination ${method} ${url.pathname} failed with HTTP ${response.status}: ${responseBody}`);
    error.status = 502;
    throw error;
  }
  return responseBody;
}

async function getDestination(destination, cookieHeader, path, userAgent) {
  const body = await upstreamRequest(destination, cookieHeader, path, { userAgent });
  return parseJson(body, `Destination GET ${path}`);
}

async function proxyChat(request, env) {
  const startedAt = performance.now();
  let destination;
  try {
    destination = new URL(env.AIPASS_BASE_URL || defaultDestinationUrl);
  } catch {
    const error = new Error('AIPASS_BASE_URL must be a valid URL.');
    error.status = 500;
    throw error;
  }
  const cookieHeader = await loadAuthCookieHeader(env, destination);
  const modelId = env.AIPASS_MODEL || requestedModel(request);
  const userAgent = env.AIPASS_USER_AGENT;
  const message = chatMessage(request);

  let quotaBefore;
  try {
    quotaBefore = readQuota(await getDestination(destination, cookieHeader, '/loaders/get-usage-quota', userAgent));
  } catch {
    quotaBefore = undefined;
  }

  let conversationId = conversationIdFromMessages(request);
  const isNewConversation = !conversationId;
  if (!conversationId) {
    const createBody = parseJson(await upstreamRequest(destination, cookieHeader, '/chat.data', {
      method: 'POST',
      form: {
        message: message.slice(0, 100),
        folderId: '',
        modelId,
        intent: 'create-conversation',
        clientCreateRequestId: crypto.randomUUID(),
      },
      userAgent,
    }), 'Conversation creation');
    conversationId = findProperty(createBody, 'conversationId');
    if (!conversationId) {
      const error = new Error('Conversation creation did not return a conversationId.');
      error.status = 502;
      throw error;
    }
  }

  const streamedBody = await upstreamRequest(destination, cookieHeader, `/actions/send-message/${encodeURIComponent(conversationId)}`, {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      referer: new URL(`/chat/${encodeURIComponent(conversationId)}`, destination).href,
    },
    userAgent,
    data: {
      modelId,
      messages: [{
        id: crypto.randomUUID(),
        role: 'user',
        metadata: { modelId },
        parts: [{
          type: 'text',
          text: isNewConversation ? initialConversationMessage(request, message) || message : message,
        }],
      }],
    },
  });

  let quotaAfter;
  try {
    quotaAfter = readQuota(await getDestination(destination, cookieHeader, '/loaders/get-usage-quota', userAgent));
  } catch {
    quotaAfter = undefined;
  }

  return {
    model: request.body?.model ?? modelId,
    conversationId,
    content: finalAnswerFromAction(parseDestinationStream(streamedBody)),
    quotaUsage: calculateQuotaUsage(quotaBefore, quotaAfter),
    totalDuration: Math.max(0, Math.round((performance.now() - startedAt) * 1_000_000)),
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return jsonResponse({ error: error?.message ?? 'Internal server error' }, status);
}

function apiPath(pathname) {
  if (pathname === '/api') return '/';
  return pathname.startsWith('/api/') ? pathname.slice('/api'.length) : pathname;
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxJsonBodyBytes) {
    const error = new Error('Request body must not exceed 1 MB.');
    error.status = 413;
    throw error;
  }

  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxJsonBodyBytes) {
      await reader.cancel();
      const error = new Error('Request body must not exceed 1 MB.');
      error.status = 413;
      throw error;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('Request body must be a JSON object.');
      error.status = 400;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    const invalidJsonError = new Error('Request body must be valid JSON.');
    invalidJsonError.status = 400;
    throw invalidJsonError;
  }
}

export async function handleOllamaRequest(request, env = {}, options = {}) {
  const url = new URL(request.url);
  const path = apiPath(url.pathname);
  if (path === '/health' && request.method === 'GET') return jsonResponse({ status: 'ok' });
  if (!url.pathname.startsWith('/api/')) return jsonResponse({ error: 'Not found' }, 404);

  const expectsBody = request.method === 'POST' && (path === '/chat' || path === '/show');
  let body = {};
  if (expectsBody) {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return jsonResponse({ error: 'Content-Type must be application/json.' }, 415);
    }
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return errorResponse(error);
    }
  }
  const apiRequest = { body };

  if (path === '/chat') {
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
    if (options.proxyChat === false) {
      const model = requestedModel(apiRequest);
      const content = 'This is a stub response. Ollama inference is not connected yet.';
      const responseBody = {
        model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content },
        done: true,
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: chatMessage(apiRequest) ? 1 : 0,
        eval_count: content.length,
        eval_duration: 0,
      };
      if (body.stream === false) return jsonResponse(responseBody);
      return new Response(`${JSON.stringify({ ...responseBody, done: false })}\n${JSON.stringify(responseBody)}\n`, {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    try {
      const result = await proxyChat(apiRequest, env);
      const responseBody = {
        model: result.model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: withConversationSession(result.content, result.conversationId),
        },
        done: true,
        done_reason: 'stop',
        total_duration: result.totalDuration,
        load_duration: 0,
        prompt_eval_count: estimateTokenCount(chatMessage(apiRequest)),
        prompt_eval_duration: 0,
        eval_count: result.quotaUsage?.raw_credits_used ?? estimateTokenCount(result.content),
        eval_duration: result.totalDuration,
      };
      if (body.stream === false) return jsonResponse(responseBody);
      const finalChunk = { ...responseBody, message: { role: 'assistant', content: '' } };
      return new Response(`${JSON.stringify({ ...responseBody, done: false })}\n${JSON.stringify(finalChunk)}\n`, {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (path === '/show' && request.method === 'POST') {
    const model = requestedModel(apiRequest);
    return jsonResponse({
      ...createModel(model),
      modelfile: `FROM ${model}`,
      parameters: '',
      template: '{{ .Prompt }}',
      system: '',
      license: 'stub',
      capabilities: ['completion'],
    });
  }

  if (request.method === 'GET' && path === '/tags') return jsonResponse({ models: [createModel()] });
  if (request.method === 'GET' && path === '/ps') return jsonResponse({ models: [] });
  if (request.method === 'GET' && ['/recommend', '/recommend-model', '/recommend_model'].includes(path)) {
    return jsonResponse({
      model: defaultModelName,
      models: [createModel()],
      reason: 'Stub recommendation; replace with model selection logic.',
    });
  }
  return jsonResponse({ error: 'Not found' }, 404);
}
