import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const signInUrl = 'https://de.aipass.net/sign-in?redirect_to=%2Fchat';
const authDirectory = new URL('../auth/', import.meta.url);
const storageStatePath = new URL('../auth/storage-state.json', import.meta.url);
const cookiesPath = new URL('../auth/cookies.json', import.meta.url);

const prompt = createInterface({ input, output });
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

try {
  console.log('Opening the sign-in page in a visible Chromium window.');
  await page.goto(signInUrl, { waitUntil: 'domcontentloaded' });
  console.log('Complete the sign-in flow in the browser window.');
  await prompt.question('When you are signed in, return here and press Enter to capture the session. ');

  await mkdir(authDirectory, { recursive: true });
  const storageState = await context.storageState();
  const cookies = await context.cookies();

  await writeFile(storageStatePath, `${JSON.stringify(storageState, null, 2)}\n`, 'utf8');
  await writeFile(cookiesPath, `${JSON.stringify(cookies, null, 2)}\n`, 'utf8');

  console.log(`Saved Playwright storage state to ${storageStatePath.pathname}`);
  console.log(`Saved ${cookies.length} cookie(s) to ${cookiesPath.pathname}`);
} finally {
  prompt.close();
  await browser.close();
}
