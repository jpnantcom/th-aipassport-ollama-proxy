import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const signInUrl = 'https://de.aipass.net/sign-in?redirect_to=%2Fchat';
const edgeExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const edgeUserDataDir = fileURLToPath(new URL('../auth/edge-profile/', import.meta.url));
const startedAt = new Date();
const timestamp = [
  startedAt.getFullYear(),
  String(startedAt.getMonth() + 1).padStart(2, '0'),
  String(startedAt.getDate()).padStart(2, '0'),
  String(startedAt.getHours()).padStart(2, '0'),
  String(startedAt.getMinutes()).padStart(2, '0'),
].join('');
const reportFileName = `${timestamp}-network.md`;
const reportPath = new URL(`../${reportFileName}`, import.meta.url);
const events = [];
const pendingBodyReads = [];

function isXhrRequest(request) {
  return request.resourceType() === 'xhr' || request.resourceType() === 'fetch';
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function addEvent(event) {
  events.push({
    time: new Date().toISOString(),
    ...event,
  });
}

const context = await chromium.launchPersistentContext(edgeUserDataDir, {
  executablePath: edgeExecutable,
  headless: false,
  args: ['--profile-directory=Default'],
});
const page = context.pages()[0] ?? await context.newPage();

page.on('request', async (request) => {
  if (!isXhrRequest(request)) return;

  addEvent({
    type: 'request',
    method: request.method(),
    resourceType: request.resourceType(),
    url: safeUrl(request.url()),
    postData: request.postData() ?? '',
  });
});

page.on('response', (response) => {
  if (!isXhrRequest(response.request())) return;

  const bodyRead = (async () => {
    let body = '';
    try {
      const bytes = await response.body();
      const contentType = response.headers()['content-type'] ?? '';
      body = contentType.includes('text/') || contentType.includes('json')
        ? bytes.toString('utf8')
        : `[base64 binary body]\n${bytes.toString('base64')}`;
    } catch (error) {
      body = `[response body unavailable: ${error.message}]`;
    }

    addEvent({
      type: 'response',
      status: response.status(),
      resourceType: response.request().resourceType(),
      url: safeUrl(response.url()),
      body,
    });
  })();
  pendingBodyReads.push(bodyRead);
});

page.on('requestfailed', (request) => {
  if (!isXhrRequest(request)) return;

  addEvent({
    type: 'request-failed',
    method: request.method(),
    resourceType: request.resourceType(),
    url: safeUrl(request.url()),
    postData: request.postData() ?? '',
    failure: request.failure()?.errorText ?? 'unknown failure',
  });
});

await page.goto(signInUrl, { waitUntil: 'domcontentloaded' });
console.log('Edge is open with your Default profile. Complete sign-in or exercise the page.');
const prompt = createInterface({ input, output });
await prompt.question(`Press Enter to stop capture and write ${reportFileName}. `);
prompt.close();
await Promise.allSettled(pendingBodyReads);

const lines = [
  '# Network capture',
  '',
  `- Captured at: ${new Date().toISOString()}`,
  `- Page: ${safeUrl(page.url())}`,
  `- XHR/fetch events: ${events.length}`,
  '',
  '> This file contains request POST data and response bodies. Treat it as sensitive and do not commit or share it.',
  '',
];

for (const [index, event] of events.entries()) {
  lines.push(
    `## ${index + 1}. ${event.type.toUpperCase()}`,
    '',
    `- Time (UTC): ${event.time}`,
    `- Method: ${event.method ?? ''}`,
    `- Status: ${event.status ?? ''}`,
    `- Resource: ${event.resourceType}`,
    `- URL: ${event.url}`,
    ...(event.type === 'request-failed' ? [`- Failure: ${event.failure}`] : []),
    '',
    event.type === 'request' || event.type === 'request-failed' ? '### POST body' : '### Response body',
    '',
    '```text',
    event.type === 'request' || event.type === 'request-failed' ? event.postData : event.body,
    '```',
    '',
  );
}

await writeFile(reportPath, lines.join('\n'), 'utf8');
console.log(`Wrote ${events.length} network events to ${reportPath.pathname}`);
await context.close();