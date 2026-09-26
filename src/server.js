import express from 'express';
import { pathToFileURL } from 'node:url';
import { createOllamaRouter } from './ollama-stub.js';

export function createApp(options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createOllamaRouter(options));

  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.use((_request, response) => response.status(404).json({ error: 'Not found' }));
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
