import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input } from 'node:process';
import { randomUUID } from 'node:crypto';
import { request } from 'playwright';

const baseUrl = 'https://de.aipass.net';
const modelId = process.env.AIPASS_MODEL ?? 'gemini-3.1-flash-lite';
const storageStatePath = new URL('../auth/storage-state.json', import.meta.url);
const defaultMessage = 'create a simple hello world in nodejs';

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

function parseSerializedResponse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The server returned an unexpected response: ${error.message}\n${text}`);
  }
}

function parseStreamedResponse(text) {
  let responseText = '';
  let finishReason;

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;

    const payload = line.slice('data: '.length);
    if (payload === '[DONE]') continue;

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }

    if (event.type === 'text-delta') responseText += event.delta ?? '';
    if (event.type === 'finish') finishReason = event.finishReason;
  }

  if (!responseText) {
    throw new Error(`The streamed response did not contain any text. Finish reason: ${finishReason ?? 'unknown'}`);
  }

  return responseText;
}

async function postAndCheck(context, url, options) {
  const response = await context.post(url, options);
  const body = await response.text();

  if (!response.ok()) {
    throw new Error(`POST ${url} failed with HTTP ${response.status()}: ${body}`);
  }

  return body;
}

async function main() {
  const args = process.argv.slice(2);
  const message = args.length > 0 ? args.join(' ') : await promptForMessage();
  try {
    await access(storageStatePath);
  } catch {
    throw new Error('Captured authentication is missing. Run "npm run login" first.');
  }

  const clientCreateRequestId = randomUUID();
  const context = await request.newContext({
    baseURL: baseUrl,
    storageState: fileURLToPath(storageStatePath),
    extraHTTPHeaders: {
      accept: 'application/json, text/plain, */*',
      origin: baseUrl,
      referer: `${baseUrl}/chat`,
    },
  });

  try {
    console.log(`Creating conversation for: ${message}`);
    const createResponse = await postAndCheck(context, '/chat.data', {
      form: {
        message,
        folderId: '',
        modelId,
        intent: 'create-conversation',
        clientCreateRequestId,
      },
    });

    const createData = parseSerializedResponse(createResponse);
    const conversationId = findProperty(createData, 'conversationId');
    if (!conversationId) {
      throw new Error(`Conversation creation did not return a conversationId:\n${createResponse}`);
    }

    console.log(`Conversation: ${conversationId}`);
    const messageId = randomUUID();
    const streamedResponse = await postAndCheck(
      context,
      `/actions/send-message/${encodeURIComponent(conversationId)}`,
      {
        headers: {
          accept: 'text/event-stream',
          referer: `${baseUrl}/chat/${conversationId}`,
        },
        data: {
          modelId,
          messages: [
            {
              id: messageId,
              role: 'user',
              metadata: { modelId },
              parts: [{ type: 'text', text: message }],
            },
          ],
        },
      },
    );

    console.log('\nResponse:\n');
    console.log(parseStreamedResponse(streamedResponse));
  } finally {
    await context.dispose();
  }
}

async function promptForMessage() {
  if (!input.isTTY) return defaultMessage;

  const prompt = createInterface({ input, output: process.stdout });
  try {
    const message = await prompt.question(`Message [${defaultMessage}]: `);
    return message.trim() || defaultMessage;
  } finally {
    prompt.close();
  }
}

main().catch((error) => {
  console.error(`Chat test failed: ${error.message}`);
  process.exitCode = 1;
});
