import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { request as playwrightRequest } from 'playwright';
import Handlebars from 'handlebars';

const defaultModelName = 'gemini-3.1-flash-lite';
const destinationUrl = process.env.AIPASS_BASE_URL ?? 'https://de.aipass.net';
const storageStatePath = new URL('../auth/storage-state.json', import.meta.url);
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
Handlebars.registerHelper('functionSignature', (tool) => {
  const functionDefinition = tool?.function ?? tool;
  const name = functionDefinition?.name ?? 'unknown';
  const properties = functionDefinition?.parameters?.properties ?? {};
  return `${name}( ${Object.keys(properties).join(', ')} ) { }`;
});
Handlebars.registerHelper('functionDescription', (tool) => {
  return (tool?.function ?? tool)?.description ?? 'No description provided.';
});
Handlebars.registerHelper('parameterLines', (tool) => {
  const properties = (tool?.function ?? tool)?.parameters?.properties ?? {};
  return Object.entries(properties).map(([name, parameter]) => {
    let shape = parameter?.type ?? 'unknown';
    if (parameter?.type === 'array' && parameter.items?.type) shape += `<${parameter.items.type}>`;
    if (Array.isArray(parameter?.enum)) shape += `; values: ${parameter.enum.join(', ')}`;
    const description = parameter?.description ?? 'No description provided.';
    return `${name} (${shape}): ${description}`;
  });
});
const initialMessageTemplate = Handlebars.compile(`##Additional Instruction for you
{{{systemMessage}}}

From this available library function
{{#each tools}}
{{{functionSignature this}}}
Description: {{{functionDescription this}}}
Parameters:
{{#each (parameterLines this)}}
- {{{this}}}
{{/each}}

{{/each}}

Ensure that you satisfy this request:
{{{userRequest}}}

Generate code to perform the task. I will provide the result from invoking the function in my system.

You can only create one function call at a time.`);

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

export function initialConversationMessage(request, userRequest) {
  const messages = Array.isArray(request.body?.messages) ? request.body.messages : [];
  const systemMessages = messages
    .filter((message) => message?.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content);
  if (typeof request.body?.system === 'string' && request.body.system.trim()) {
    systemMessages.unshift(request.body.system);
  }
  const systemMessage = systemMessages.join('\n\n') || '(none provided)';
  const requestedTools = Array.isArray(request.body?.tools) ? request.body.tools : [];
  const tools = [generateAnswerTool, ...requestedTools.filter((tool) => {
    const name = tool?.function?.name ?? tool?.name;
    return name !== generateAnswerTool.function.name;
  })];

  return initialMessageTemplate({
    systemMessage,
    tools,
    userRequest,
  });
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
      // Ignore keepalive and malformed events, as test-chat.js does.
    }
  }
  return content;
}

async function postDestination(context, url, options) {
  const upstreamResponse = await context.post(url, options);
  const body = await upstreamResponse.text();
  if (!upstreamResponse.ok()) {
    const error = new Error(`Destination POST ${url} failed with HTTP ${upstreamResponse.status()}: ${body}`);
    error.status = 502;
    throw error;
  }
  return body;
}

async function getDestination(context, url) {
  const upstreamResponse = await context.get(url);
  const body = await upstreamResponse.text();
  if (!upstreamResponse.ok()) return undefined;
  return parseJson(body, `Destination GET ${url}`);
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

async function proxyChat(request) {
  try {
    await access(storageStatePath);
  } catch {
    const error = new Error('Captured authentication is missing. Run "npm run login" first.');
    error.status = 503;
    throw error;
  }

  const startedAt = process.hrtime.bigint();
  const modelId = process.env.AIPASS_MODEL ?? requestedModel(request);
  const message = chatMessage(request);
  const context = await playwrightRequest.newContext({
    baseURL: destinationUrl,
    storageState: fileURLToPath(storageStatePath),
    extraHTTPHeaders: {
      accept: 'application/json, text/plain, */*',
      origin: destinationUrl,
      referer: `${destinationUrl}/chat`,
    },
  });

  try {
    let quotaBefore;
    try {
      quotaBefore = readQuota(await getDestination(context, '/loaders/get-usage-quota'));
    } catch {
      quotaBefore = undefined;
    }

    let conversationId = conversationIdFromMessages(request);
    const isNewConversation = !conversationId;
    if (!conversationId) {
      const createBody = parseJson(await postDestination(context, '/chat.data', {
        form: {
          message: message.slice(0, 100),
          folderId: '',
          modelId,
          intent: 'create-conversation',
          clientCreateRequestId: randomUUID(),
        },
      }), 'Conversation creation');
      conversationId = findProperty(createBody, 'conversationId');
      if (!conversationId) {
        const error = new Error('Conversation creation did not return a conversationId.');
        error.status = 502;
        throw error;
      }
    }

    const streamedBody = await postDestination(
      context,
      `/actions/send-message/${encodeURIComponent(conversationId)}`,
      {
        headers: {
          accept: 'text/event-stream',
          referer: `${destinationUrl}/chat/${conversationId}`,
        },
        data: {
          modelId,
          messages: [{
            id: randomUUID(),
            role: 'user',
            metadata: { modelId },
            parts: [{
              type: 'text',
              text: isNewConversation ? initialConversationMessage(request, message) : message,
            }],
          }],
        },
      },
    );
    let quotaAfter;
    try {
      quotaAfter = readQuota(await getDestination(context, '/loaders/get-usage-quota'));
    } catch {
      quotaAfter = undefined;
    }

    return {
      model: request.body?.model ?? modelId,
      conversationId,
      content: finalAnswerFromAction(parseDestinationStream(streamedBody)),
      quotaUsage: calculateQuotaUsage(quotaBefore, quotaAfter),
      totalDuration: Number(process.hrtime.bigint() - startedAt),
    };
  } finally {
    await context.dispose();
  }
}

export function createOllamaRouter({ proxyChat: shouldProxyChat = true } = {}) {
  return async (request, response, next) => {
    const path = request.path;

    if (path === '/chat') {
      if (shouldProxyChat) {
        try {
          const result = await proxyChat(request);
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
            prompt_eval_count: estimateTokenCount(chatMessage(request)),
            prompt_eval_duration: 0,
            eval_count: result.quotaUsage?.raw_credits_used ?? estimateTokenCount(result.content),
            eval_duration: result.totalDuration,
          };
          if (request.body?.stream === false) return response.json(responseBody);
          response.type('application/x-ndjson');
          const finalChunk = {
            ...responseBody,
            message: { role: 'assistant', content: '' },
          };
          return response.send(`${JSON.stringify({ ...responseBody, done: false })}\n${JSON.stringify(finalChunk)}\n`);
        } catch (error) {
          return next(error);
        }
      }

      const model = requestedModel(request);
      const content = 'This is a stub response. Ollama inference is not connected yet.';
      const result = {
        model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content },
        done: true,
        total_duration: 0,
        load_duration: 0,
        prompt_eval_count: chatMessage(request) ? 1 : 0,
        eval_count: content.length,
        eval_duration: 0,
      };

      if (request.body?.stream === false) return response.json(result);

      response.type('application/x-ndjson');
      return response.send(`${JSON.stringify({ ...result, done: false })}\n${JSON.stringify(result)}\n`);
    }

    if (path === '/tags') return response.json({ models: [createModel()] });
    if (path === '/ps') return response.json({ models: [] });

    if (path === '/show') {
      const model = requestedModel(request);
      return response.json({
        ...createModel(model),
        modelfile: `FROM ${model}`,
        parameters: '',
        template: '{{ .Prompt }}',
        system: '',
        license: 'stub',
        capabilities: ['completion'],
      });
    }

    if (path === '/recommend' || path === '/recommend-model' || path === '/recommend_model') {
      return response.json({
        model: defaultModelName,
        models: [createModel()],
        reason: 'Stub recommendation; replace with model selection logic.',
      });
    }

    return next();
  };
}
