import express from 'express';
import { readFile } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleOllamaRequest } from './ollama-stub.js';

const defaultAuthObjectKey = 'auth/storage-state.json';
const defaultAuthStatePath = fileURLToPath(new URL('../auth/storage-state.json', import.meta.url));
const { version: playwrightVersion } = createRequire(import.meta.url)('playwright/package.json');

function localPlaywrightUserAgent() {
  const [major = 'unknown', minor = 'unknown'] = release().split('.');
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macOS' : 'linux';
  const osVersion = process.platform === 'win32' ? `${major}.${minor}` : 'unknown';
  const nodeVersion = process.versions.node.split('.').slice(0, 2).join('.');
  const ciToken = process.env.CI ? ' CI/1' : '';
  return `Playwright/${playwrightVersion} (${arch()}; ${osName} ${osVersion}) node/${nodeVersion}${ciToken}`;
}

function createLocalAuthBucket(authStatePath = defaultAuthStatePath, objectKey = defaultAuthObjectKey) {
  return {
    async get(key) {
      if (key !== objectKey) return null;

      let storageState;
      try {
        storageState = await readFile(authStatePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }

      return {
        async json() {
          return JSON.parse(storageState);
        },
      };
    },
  };
}

export function createApp(options = {}) {
  const app = express();
  const env = options.env ?? {
    ...process.env,
    AIPASS_USER_AGENT: process.env.AIPASS_USER_AGENT || localPlaywrightUserAgent(),
    AUTH_BUCKET: createLocalAuthBucket(
      process.env.AUTH_STATE_PATH ? resolve(process.cwd(), process.env.AUTH_STATE_PATH) : defaultAuthStatePath,
      process.env.AUTH_OBJECT_KEY || defaultAuthObjectKey,
    ),
  };
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(async (incoming, outgoing, next) => {
    try {
      const headers = new Headers(incoming.headers);
      headers.delete('content-length');
      headers.delete('transfer-encoding');
      const init = { method: incoming.method, headers };
      if (incoming.body !== undefined) init.body = JSON.stringify(incoming.body);
      const request = new Request(`http://${incoming.headers.host}${incoming.originalUrl}`, init);
      const result = await handleOllamaRequest(request, env, options);
      outgoing.status(result.status);
      result.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.send(await result.text());
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      return response.status(400).json({ error: 'Request body must be valid JSON' });
    }
    console.error(error);
    return response.status(error.status ?? 500).json({ error: error.message ?? 'Internal server error' });
  });

  return app;
}

const app = createApp();
const port = Number.parseInt(process.env.PORT ?? '11434', 10);
const host = process.env.HOST ?? '127.0.0.1';

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  app.listen(port, host, () => {
    console.log(`Ollama stub API listening at http://${host}:${port}`);
  });
}

export default app;
