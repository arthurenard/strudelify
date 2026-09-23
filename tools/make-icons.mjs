#!/usr/bin/env node
/**
 * Render the site's icon files and its link-preview card into packages/web/static (committed; the prerender
 * build step copies them into the site): favicon.svg, favicon-96.png, apple-touch-icon.png and og.png
 * (1200 x 630). Uses the system Chrome, like tools/shot.mjs.
 *   node tools/make-icons.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'packages/web/static');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const font = (file) => pathToFileURL(path.join(root, 'node_modules', file)).href;

/** The brand mark: three rising bars on the page's background, as the header shows it. */
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0a0c10"/><path d="M18 44V22l9 6v16zM29 44V16l9 6v22zM40 44V26l9 6v12z" fill="#31d97c"/></svg>`;

const CARD = `<!doctype html><html><head><style>
@font-face { font-family: Inter; src: url("${font('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}"); font-weight: 100 900; }
@font-face { font-family: Mono; src: url("${font('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2')}"); }
html, body { margin: 0; width: 1200px; height: 630px; background: #0a0c10; color: #f2f4f8; font-family: Inter, sans-serif; overflow: hidden; }
.card { position: relative; box-sizing: border-box; width: 1200px; height: 630px; padding: 72px 80px; display: flex; flex-direction: column; justify-content: space-between;
  background: radial-gradient(900px 500px at 85% 10%, rgba(49, 217, 124, 0.20), transparent 60%), radial-gradient(700px 500px at 0% 100%, rgba(80, 120, 255, 0.16), transparent 60%); }
.brand { display: flex; align-items: center; gap: 18px; font-size: 38px; font-weight: 800; letter-spacing: -0.02em; }
.brand svg { width: 64px; height: 64px; }
h1 { margin: 0; font-size: 84px; line-height: 1.02; letter-spacing: -0.045em; font-weight: 800; }
h1 span { background: linear-gradient(90deg, #31d97c, #5ad1ff); -webkit-background-clip: text; background-clip: text; color: transparent; }
pre { margin: 0; font: 26px/1.5 Mono, monospace; color: #9aa3b2; }
pre b { color: #31d97c; font-weight: 400; } pre i { color: #f2c46d; font-style: normal; }
</style></head><body><div class="card">
<div class="brand">${MARK}Strudelify</div>
<h1>Type a song.<br><span>Get Strudel code.</span></h1>
<pre><b>const</b> bass = note(<i>"&lt;[f1 ~ f1 ~ bb1 ~ bb1 ~] [ab1 db2]&gt;"</i>)
<b>const</b> kick = s(<i>"bd"</i>).struct(<i>"x ~@2 x!2 ~@3"</i>)</pre>
</div></body></html>`;

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'favicon.svg'), `${MARK}\n`);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  for (const [file, size] of [['favicon-96.png', 96], ['apple-touch-icon.png', 180]]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:#0a0c10">${MARK.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(out, file), omitBackground: false });
  }
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(CARD, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(out, 'og.png') });
} finally {
  await browser.close();
}
for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size, 'bytes');
