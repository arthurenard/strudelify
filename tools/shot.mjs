#!/usr/bin/env node
/**
 * Headless screenshot of the running web app (Vite dev server at 127.0.0.1:5173/strudelify/, or STRUDELIFY_URL) using the system Chrome.
 *   node tools/shot.mjs <url-or-song-id> <out.png> [--mobile] [--full] [--wait <ms>] [--click <selector>] [--width N --height N]
 * Examples:
 *   node tools/shot.mjs nirvana--smells-like-teen-spirit shots/nirvana.png
 *   node tools/shot.mjs "http://127.0.0.1:5173/strudelify/" shots/home.png --mobile
 * Also prints console errors from the page to stderr.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const target = args[0];
const out = args[1];
if (!target || !out) { console.error('usage: shot.mjs <url-or-song-id> <out.png> [--mobile] [--full] [--wait ms] [--click sel]'); process.exit(2); }
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const url = target.startsWith('http') ? target : `${(process.env.STRUDELIFY_URL ?? 'http://127.0.0.1:5173/strudelify').replace(/\/+$/, '')}/song/${target.replace(/^#/, '')}/`;
const mobile = flag('--mobile');
const width = Number(val('--width', mobile ? 390 : 1440));
const height = Number(val('--height', mobile ? 844 : 900));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => !document.getElementById('status')?.textContent?.includes('Loading'), { timeout: 30000 }).catch(() => {});
  if (url.includes('/song/')) await page.waitForFunction(() => document.getElementById('song')?.hidden === false, { timeout: 30000 }).catch(() => {});
  const click = val('--click');
  if (click) { await page.click(click); }
  await new Promise((r) => setTimeout(r, Number(val('--wait', 1500))));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: flag('--full') });
  const title = await page.title();
  console.log(`${out} (${width}x${height}${mobile ? ' mobile' : ''}) title="${title}"`);
  if (errors.length) console.error('page errors:\n' + errors.map((e) => '  ' + e).join('\n'));
} finally { await browser.close(); }
