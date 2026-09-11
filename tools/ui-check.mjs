#!/usr/bin/env node
/**
 * Headless UI check of the running web app (Vite dev server on 127.0.0.1:5173) with the system Chrome:
 * no page or console errors, no horizontal scroll at 390/768/1440, the landing page baked with the index's
 * song count, one identity colour per song (landing card = search row), canonical artist names in search
 * rows, chord-lane labels without a trailing ellipsis, the readout agreeing with the highlighted block, and
 * no trace of the previous song while the next one loads (hash change and search Enter, on a throttled
 * connection, with a resize in between). Exits 1 on any failure.
 *   node tools/ui-check.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.STRUDELIFY_URL ?? 'http://127.0.0.1:5173';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()} ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  const throttle = (on) => cdp.send('Network.emulateNetworkConditions', on
    ? { offline: false, latency: 800, downloadThroughput: 40 * 1024, uploadThroughput: 40 * 1024 }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const waitSong = () => page.waitForFunction(() => document.getElementById('song')?.hidden === false && !document.getElementById('song').classList.contains('loading'), { timeout: 60000 });
  const state = () => page.evaluate(() => ({
    title: document.getElementById('title').textContent,
    bar: document.getElementById('pos-bar').textContent,
    chord: document.getElementById('pos-chord').textContent,
    lanes: document.querySelectorAll('#lane-chords > *').length + document.querySelectorAll('#lane-sections > *').length + document.querySelectorAll('#ov-lanes > *').length,
    lines: document.getElementById('code-lines').textContent,
    moreHidden: document.getElementById('code-more').hidden,
    loading: document.getElementById('song').classList.contains('loading'),
    active: document.querySelector('#lane-chords .ch.active')?.dataset.tip ?? '',
    labels: Array.from(document.querySelectorAll('#lane-chords .chl')).map((l) => l.textContent),
    scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
  }));
  const noStale = (s, when) => check(!s.loading || (s.lanes === 0 && s.bar === '' && s.chord === '' && s.lines === '' && s.moreHidden), `${when}: nothing of the previous song while loading (${JSON.stringify({ lanes: s.lanes, bar: s.bar, chord: s.chord, lines: s.lines })})`);

  // Landing: baked count, tile colour identity.
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  const count = await page.evaluate(async () => (await (await fetch('/db/index.json')).json()).length);
  const raw = await (await fetch(`${BASE}/`)).text();
  check(raw.includes(`Browse ${count.toLocaleString('en-US')} library entries`), `index.html is baked with the entry count (${count})`);
  const cardTile = await page.evaluate(() => document.querySelector('#examples .ex')?.style.getPropertyValue('--tile'));
  const cardTitle = await page.evaluate(() => document.querySelector('#examples .ex .ex-t')?.textContent);
  await page.click('#q'); await page.type('#q', cardTitle); await sleep(400);
  const rowTile = await page.evaluate((t) => Array.from(document.querySelectorAll('#results .opt')).find((r) => r.querySelector('.t').textContent === t)?.querySelector('.opt-tile').style.getPropertyValue('--tile'), cardTitle);
  check(!!cardTile && cardTile === rowTile, `one identity colour for "${cardTitle}" (card ${cardTile}, row ${rowTile})`);
  // Search rows: canonical artists.
  const rows = async (q) => { await page.evaluate(() => { document.getElementById('q').value = ''; }); await page.type('#q', q); await sleep(400); return page.evaluate(() => ({ rows: Array.from(document.querySelectorAll('#results .opt')).map((r) => `${r.querySelector('.t').textContent} / ${r.querySelector('.a').textContent}`), groups: Array.from(document.querySelectorAll('#results .group b')).map((g) => g.textContent) })); };
  const bj = await rows('billie jean'); check(bj.rows[0] === 'Billie Jean / Michael Jackson', `search "billie jean": ${bj.rows[0]}`);
  const wall = await rows('the wall'); check(wall.rows.filter((r) => r.startsWith('Off the Wall')).length === 1 && wall.rows.includes('Off the Wall / Michael Jackson'), `search "the wall": one Off the Wall row, by Michael Jackson`);
  const abba = await rows('abba'); check(abba.groups[0] === 'ABBA', `search "abba": group ${abba.groups[0]}`);
  const elton = await rows('elton john'); check(elton.groups[0] === 'Elton John', `search "elton john": group ${elton.groups[0]}`);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  check(!errors.length, `landing + search: no errors${errors.length ? '\n  ' + errors.join('\n  ') : ''}`); errors.length = 0;

  // Songs at three widths: no horizontal scroll, labels, readout vs lane.
  for (const [w, h] of [[1440, 900], [768, 1024], [390, 844]]) {
    await page.setViewport({ width: w, height: h, isMobile: w < 768, hasTouch: w < 768 });
    for (const id of ['pink-floyd--another-brick-in-the-wall-part-2', 'james-brown--i-don-t-mind', 'steve-miller-band--the-joker']) {
      await page.goto(`${BASE}/#${id}`, { waitUntil: 'networkidle0' }); await waitSong(); await sleep(400);
      const s = await state();
      check(s.scrollW === s.innerW, `${w}px ${id}: no horizontal scroll (${s.scrollW}/${s.innerW})`);
      check(!s.labels.some((l) => l.includes('…')), `${w}px ${id}: no ellipsis in lane labels`);
      check(s.active.startsWith(s.chord.replace(/maj7.*|m7.*|7.*|\/.*/, '').replace(/[♯♭]/, (c) => c)), `${w}px ${id}: readout "${s.chord}" agrees with the highlighted block "${s.active}"`);
    }
    check(!errors.length, `${w}px: no errors${errors.length ? '\n  ' + errors.join('\n  ') : ''}`); errors.length = 0;
  }

  // Stale state while the next song loads.
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/#pink-floyd--another-brick-in-the-wall-part-2`, { waitUntil: 'networkidle0' }); await waitSong(); await sleep(400);
  await page.evaluate(() => { document.getElementById('track').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
  await throttle(true);
  await page.evaluate(() => { location.hash = '#led-zeppelin--stairway-to-heaven'; });
  await sleep(150); const h1 = await state(); check(h1.loading && h1.title === 'Stairway To Heaven', 'hash change: new title with the skeleton within 150 ms'); noStale(h1, 'hash +150 ms');
  await sleep(400); noStale(await state(), 'hash +550 ms');
  await page.setViewport({ width: 1200, height: 900 }); await sleep(300); noStale(await state(), 'hash, resized while loading');
  await throttle(false); await waitSong(); await sleep(400);
  const lz = await state(); check(lz.title === 'Stairway To Heaven' && lz.lanes > 0 && lz.bar.startsWith('bar 1 /'), `loaded: ${lz.title} ${lz.bar}`);
  await throttle(true);
  await page.click('#q'); await page.type('#q', 'i don'); await sleep(400); await page.keyboard.press('Enter');
  await sleep(150); const s1 = await state(); check(s1.title === "I Don't Mind", 'search Enter: new title at once'); noStale(s1, 'search +150 ms');
  await sleep(400); noStale(await state(), 'search +550 ms');
  await throttle(false); await waitSong(); await sleep(400);
  const jb = await state(); check(jb.lanes > 0 && jb.bar === 'bar 1 / 85', `loaded: ${jb.title} ${jb.bar}`);
  check(!errors.length, `song switching: no errors${errors.length ? '\n  ' + errors.join('\n  ') : ''}`);
} finally { await browser.close(); }
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
