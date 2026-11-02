// End-to-end browser tests (Playwright). The app itself has no dependencies;
// install Playwright only to run these:  npm i -D playwright && npx playwright install chromium
// Run:  npm run test:e2e        (SCREENSHOTS=dir to save screenshots)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startApp } from '../helpers.js';

let chromium;
let devices;
try {
  ({ chromium, devices } = await import('playwright'));
} catch {
  try {
    ({ chromium, devices } = createRequire(import.meta.url)('playwright'));
  } catch {
    console.log('Playwright is not installed — skipping e2e tests (npm i -D playwright).');
    process.exit(0);
  }
}

const shots = process.env.SCREENSHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const app = await startApp();
const browser = await chromium.launch();
let failures = 0;
const results = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failures++;
    results.push(`  FAIL ${name}\n       ${String(e.stack || e).split('\n').slice(0, 4).join('\n       ')}`);
  }
}

async function newNote(page, body = {}) {
  const id = await page.evaluate(async (b) => (await (await fetch('api/notes', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceLang: 'en', targetLang: 'es', engine: 'echo', ...b }),
  })).json()).id, body);
  await page.goto(`${app.base}/n/${id}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.row');
  return id;
}

const srcTexts = (page) => page.$$eval('.row .cell.src .ta', (els) => els.map((e) => e.value));
const trTexts = (page) => page.$$eval('.row .cell.tr .ta', (els) => els.map((e) => e.value));
const serverNote = (page, id) => page.evaluate(async (i) => (await fetch(`api/notes/${i}`)).json(), id);

async function misaligned(page) {
  return page.$$eval('.row', (rows) => rows.map((r, i) => {
    const a = r.querySelector('.cell.src').getBoundingClientRect();
    const b = r.querySelector('.cell.tr').getBoundingClientRect();
    if (getComputedStyle(r.querySelector('.cell.tr')).display === 'none') return null;
    return Math.abs(a.top - b.top) > 0.5 || Math.abs(a.bottom - b.bottom) > 0.5 ? i + 1 : null;
  }).filter(Boolean));
}

const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
await page.goto(app.base + '/', { waitUntil: 'networkidle' });

await step('welcome note loads with tags rendered as pills', async () => {
  await page.waitForSelector('.row .pill');
  const pills = await page.$$eval('.cell.src .pill', (p) => p.map((x) => x.textContent));
  assert.ok(pills.includes('DIALOG') && pills.includes('/DIALOG') && pills.includes('NOTRANSLATE'));
  if (shots) await page.screenshot({ path: path.join(shots, 'editor.png') });
});

let id;
await step('typing, Enter splits, translations arrive line by line and stay aligned', async () => {
  id = await newNote(page);
  await page.click('.row .cell.src .ta');
  await page.keyboard.type('Short line.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A much longer line that wraps onto several visual lines because it simply keeps going with more and more words than fit.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Third');
  await page.waitForFunction(() => document.querySelectorAll('.row[data-tr="ok"]').length === 3, null, { timeout: 8000 });
  assert.deepEqual(await trTexts(page), ['SHORT LINE.', 'A MUCH LONGER LINE THAT WRAPS ONTO SEVERAL VISUAL LINES BECAUSE IT SIMPLY KEEPS GOING WITH MORE AND MORE WORDS THAN FIT.', 'THIRD']);
  assert.deepEqual(await misaligned(page), []);
  const heights = await page.$$eval('.row', (r) => r.map((x) => x.getBoundingClientRect().height));
  assert.ok(heights[1] > heights[0] * 1.5, 'long row is taller');
});

await step('autosave reaches the server; reloading translates nothing again', async () => {
  await page.waitForFunction(() => document.querySelector('#save-state').dataset.state === 'saved', null, { timeout: 8000 });
  const n = await serverNote(page, id);
  assert.equal(n.lines.length, 3);
  assert.equal(n.lines[2].tr, 'THIRD');
  let calls = 0;
  const onReq = (r) => { if (r.url().includes('/api/translate')) calls++; };
  page.on('request', onReq);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  page.off('request', onReq);
  assert.equal(calls, 0);
});

await step('editing one line retranslates only that line', async () => {
  const bodies = [];
  const onReq = (r) => { if (r.url().endsWith('/api/translate')) bodies.push(JSON.parse(r.postData())); };
  page.on('request', onReq);
  const ta = page.locator('.row .cell.src .ta').nth(2);
  await ta.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' line');
  await page.waitForFunction(() => document.querySelectorAll('.row .cell.tr .ta')[2].value === 'THIRD LINE', null, { timeout: 8000 });
  page.off('request', onReq);
  assert.deepEqual(bodies.flatMap((b) => b.texts), ['Third line']);
});

await step('Backspace at line start joins lines; undo / redo restore them', async () => {
  const ta = page.locator('.row .cell.src .ta').nth(2);
  await ta.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  let s = await srcTexts(page);
  assert.equal(s.length, 2);
  assert.ok(s[1].endsWith('fit.Third line'));
  await page.keyboard.press('Control+z');
  s = await srcTexts(page);
  assert.equal(s.length, 3);
  assert.equal(s[2], 'Third line');
  await page.keyboard.press('Control+Shift+z');
  assert.equal((await srcTexts(page)).length, 2);
  await page.keyboard.press('Control+z');
});

await step('multi-line paste creates rows and picks up tags', async () => {
  await page.locator('.row .cell.src .ta').nth(2).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const ta = document.activeElement;
    const dt = new DataTransfer();
    dt.setData('text/plain', '[VOCABULARY]\nperro - dog\n[/VOCABULARY]');
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const roles = await page.$$eval('.row', (r) => r.map((x) => x.dataset.role));
  assert.deepEqual(roles.slice(-3), ['open', 'text', 'close']);
  const styles = await page.$$eval('.row', (r) => r.map((x) => x.dataset.style));
  assert.equal(styles[styles.length - 2], 'vocab');
});

await step('slash menu inserts a DIALOG block; speaker names stay untranslated', async () => {
  await page.locator('.row .cell.src .ta').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/dia');
  await page.waitForSelector('#popover:not([hidden]) .menu-item');
  if (shots) await page.screenshot({ path: path.join(shots, 'slash-menu.png') });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ana: Hola amigo');
  await page.waitForFunction(() => [...document.querySelectorAll('.row .cell.tr .ta')].some((t) => t.value === 'Ana: HOLA AMIGO'), null, { timeout: 8000 });
  const roles = await page.$$eval('.row', (r) => r.map((x) => x.dataset.role));
  assert.deepEqual(roles.slice(-3), ['open', 'text', 'close']);
});

await step('NOTRANSLATE lines are copied, not sent to the engine', async () => {
  const bodies = [];
  const onReq = (r) => { if (r.url().endsWith('/api/translate')) bodies.push(...JSON.parse(r.postData()).texts); };
  page.on('request', onReq);
  await page.locator('.row .cell.src .ta').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[NOTRANSLATE] Juan Pérez');
  await page.waitForTimeout(1200);
  page.off('request', onReq);
  assert.ok(!bodies.some((b) => b.includes('Juan')));
  assert.equal((await trTexts(page)).at(-1), 'Juan Pérez');
});

await step('gutter selection: select two lines and delete them', async () => {
  const before = (await srcTexts(page)).length;
  await page.locator('.row .ln[data-g="src"]').nth(0).click();
  await page.locator('.row .ln[data-g="src"]').nth(1).click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.row.sel').count(), 2);
  assert.ok(await page.locator('#selbar').isVisible());
  await page.keyboard.press('Delete');
  assert.equal((await srcTexts(page)).length, before - 2);
});

await step('toggles: line numbers, zebra, hide translation pane, layout', async () => {
  await page.click('#tg-numbers');
  assert.equal(await page.locator('#rows.no-numbers').count(), 1);
  await page.click('#tg-numbers');
  await page.click('#tg-zebra');
  assert.equal(await page.locator('#rows.zebra').count(), 0);
  await page.click('#tg-zebra');
  await page.click('#tg-translation');
  assert.equal(await page.locator('#rows.no-tr').count(), 1);
  assert.equal(await page.locator('.row .cell.tr').first().isVisible(), false);
  await page.click('#tg-translation');
  await page.click('#tg-layout'); // auto -> side
  await page.click('#tg-layout'); // side -> stacked
  assert.equal(await page.locator('#rows.stacked').count(), 1);
  await page.click('#tg-layout'); // back to auto
  assert.deepEqual(await misaligned(page), []);
});

await step('plain-text mode keeps unchanged lines and their translations', async () => {
  const before = (await srcTexts(page)).length;
  const keptTr = (await trTexts(page))[0];
  await page.click('#btn-more');
  await page.click('.menu-item:has-text("Plain-text mode")');
  const ta = page.locator('#bulk-editor');
  await ta.press('Control+End');
  await page.keyboard.type('\nAdded in bulk mode');
  await page.click('#btn-bulk-done');
  const s = await srcTexts(page);
  assert.equal(s.at(-1), 'Added in bulk mode');
  await page.waitForFunction(() => document.querySelectorAll('.row .cell.tr .ta')[document.querySelectorAll('.row').length - 1].value === 'ADDED IN BULK MODE', null, { timeout: 8000 });
  assert.equal(s.length, before + 1);
  assert.equal((await trTexts(page))[0], keptTr, 'unchanged line keeps its translation');
});

await step('mobile: stacked layout, no horizontal overflow, translation under each line', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const m = await ctx.newPage();
  m.on('pageerror', (e) => pageErrors.push(`mobile: ${e.message}`));
  await m.goto(`${app.base}/n/${id}`, { waitUntil: 'networkidle' });
  await m.waitForSelector('.row');
  assert.equal(await m.locator('#rows.stacked').count(), 1);
  assert.equal(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const [a, b] = await m.$$eval('.row:first-child .cell', (c) => c.map((x) => x.getBoundingClientRect().top));
  assert.ok(b > a, 'translation sits below the original');
  if (shots) await m.screenshot({ path: path.join(shots, 'mobile.png') });
  await ctx.close();
});

await step('conflict: a stale save from another tab is detected', async () => {
  const p2 = await browser.newPage();
  await p2.goto(`${app.base}/n/${id}`, { waitUntil: 'networkidle' });
  await p2.locator('.row .cell.src .ta').first().click();
  await p2.keyboard.type('Edit from tab 2 ');
  await p2.waitForFunction(() => document.querySelector('#save-state').dataset.state === 'saved', null, { timeout: 8000 });
  await page.locator('.row .cell.src .ta').first().click();
  await page.keyboard.type('Edit from tab 1 ');
  await page.waitForSelector('.modal', { timeout: 8000 });
  assert.match(await page.locator('.modal h2').textContent(), /changed somewhere else/);
  await page.click('text=Overwrite with mine');
  await page.waitForFunction(() => document.querySelector('#save-state').dataset.state === 'saved', null, { timeout: 8000 });
  await p2.close();
});

await step('admin dashboard: every section loads', async () => {
  const a = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  a.on('pageerror', (e) => pageErrors.push(`admin: ${e.message}`));
  for (const v of ['overview', 'notes', 'engines', 'tags', 'cache', 'logs', 'api', 'settings', 'system']) {
    await a.goto(`${app.base}/admin#/${v}`, { waitUntil: 'networkidle' });
    await a.waitForTimeout(150);
    assert.equal(await a.locator('text=Could not load this page').count(), 0, v);
    if (shots && (v === 'overview' || v === 'engines')) await a.screenshot({ path: path.join(shots, `admin-${v}.png`) });
  }
  await a.goto(`${app.base}/admin#/engines`, { waitUntil: 'networkidle' });
  const card = a.locator('.engine[data-id="echo"]');
  await card.locator('summary').click();
  await card.locator('[data-act="test"]').click();
  await a.waitForSelector('.engine[data-id="echo"] [data-result]:has-text("HOLA")', { timeout: 5000 }).catch(async () => {
    const t = await card.locator('[data-result]').textContent();
    assert.match(t, /HELLO, WORLD/);
  });
  await a.close();
});

await step('no JavaScript errors in any page', async () => {
  // Expected HTTP 409 from the conflict test shows up as a console resource error; ignore those.
  const real = pageErrors.filter((e) => !/status of 409/.test(e));
  assert.deepEqual(real, [], real.join('\n'));
});

await browser.close();
await app.close();
console.log(`\nE2E results:\n${results.join('\n')}\n\n${failures ? `${failures} failed` : 'all passed'}`);
process.exit(failures ? 1 : 0);
