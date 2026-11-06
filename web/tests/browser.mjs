import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const output = process.env.WORKBENCH_QA_DIR || '/tmp/cornac-www2027-web-qa';
const url = process.env.WORKBENCH_URL || 'http://127.0.0.1:8080';
await mkdir(output, {recursive: true});
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({viewport: {width: 1536, height: 1024}, acceptDownloads: true, recordVideo: {dir: path.join(output, 'video'), size: {width: 1536, height: 1024}}});
const externalRequests = [];
await context.route('**/*', route => {
  if (['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)) return route.continue();
  externalRequests.push(route.request().url()); return route.abort();
});
const page = await context.newPage();
const errors = [];
process.on('uncaughtException', async error => {
  console.error(error, errors);
  await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({error: String(error), consoleErrors: errors}, null, 2));
  await browser.close(); process.exit(1);
});
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {if (['error', 'warning'].includes(message.type())) errors.push(message.text());});
const checks = [];
const interactionMs = {};
async function check(name, fn) {await fn(); checks.push({name, status: 'passed'}); console.log(`PASS ${name}`);}
async function waitQuery(id) {
  await page.getByTestId('query-heading').filter({hasText: `Query #${id}`}).waitFor();
  await page.locator('.group-panel .selected-row').first().waitFor();
}
const start = performance.now();
await page.goto(`${url}/?view=diagnostics`, {waitUntil: 'domcontentloaded'});
await waitQuery(145);
const firstMeaningfulMs = performance.now() - start;
await check('page identity, meaningful content, no framework overlay', async () => {
  assert.match(await page.title(), /Cornac.*Recommendation diagnostics/);
  assert.equal(new URL(page.url()).origin, url);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.match(await page.locator('main').innerText(), /Native prediction trace/);
});
await check('local typography, ordered workflow and skip navigation', async () => {
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => [...document.fonts].some(font => font.family.includes('Google Sans Flex') && font.status === 'loaded')));
  assert.match(await page.locator('h1').evaluate(element => getComputedStyle(element).fontFamily), /Google Sans Flex/);
  assert.deepEqual(await page.locator('.workflow-heading h2').allTextContents(), ['Query context', 'Compare recommendations', 'Inspect the decision']);
  await page.getByRole('link', {name: 'Skip to diagnostics'}).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('main').evaluate(element => element === document.activeElement), true);
  assert.equal(await page.getByTestId('task-2a').getAttribute('aria-pressed'), 'true');
  // Restore the initial route after exercising anchor navigation.
  await page.evaluate(() => { history.replaceState(null, '', `${location.pathname}?view=diagnostics`); scrollTo(0, 0); });
});
await check('guided presets synchronize model, query, cutoff and resolver', async () => {
  for (const [task, query, model, policy] of [
    ['task-1', 7, 'letter-openai-2025', 'history_cosine'],
    ['task-2b', 210, 'letter-openai-2025', 'popularity'],
    ['task-3', 145, 'tiger-openai-2025', 'history_cosine'],
    ['task-2a', 145, 'letter-openai-2025', 'history_cosine'],
  ]) {
    await page.getByTestId(task).focus(); await page.keyboard.press('Enter');
    await waitQuery(query);
    assert.equal(await page.getByLabel('Model', {exact:true}).inputValue(), model);
    assert.equal(await page.getByLabel('Cutoff', {exact:true}).inputValue(), '10');
    assert.equal(await page.getByLabel('Group resolver', {exact:true}).inputValue(), policy);
  }
});
await check('API drawer copies displayed Python and closes by keyboard', async () => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('toggle-code').click();
  const code = await page.locator('.python-code').innerText();
  assert.match(code, /rqvae_codebook_size/);
  assert.ok(!code.includes('loss_type'));
  await page.getByTestId('copy-code').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code);
  await page.getByRole('button', {name:'Close Python snippet'}).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByTestId('python-drawer').count(), 0);
});
await check('member search filters results, empty state and target jump clears search', async () => {
  const search = page.getByLabel('Filter collision group', {exact:true});
  await search.fill('Fine Liner');
  await page.waitForResponse(r => r.url().includes('/api/group?') && r.url().includes('search=Fine'));
  assert.match(await page.locator('.group-panel').innerText(), /Fine Liner/);
  await search.fill('no-such-catalog-member-xyz');
  await page.waitForResponse(r => r.url().includes('search=no-such'));
  await page.getByTestId('jump-to-target').click();
  await page.locator('.group-panel .target-member-row').first().waitFor();
  assert.equal(await search.inputValue(), '');
});
await check('real cosine win, explicit items and SID/CCE references', async () => {
  assert.equal(await page.getByTestId('popularity-hit').textContent(), '0.0000');
  assert.equal(await page.getByTestId('history_cosine-hit').textContent(), '1.0000');
  assert.equal(await page.getByTestId('sid-ndcg').textContent(), '1.0000');
  assert.equal(await page.getByTestId('cce-ndcg').textContent(), '0.0028');
  assert.match(await page.locator('.group-panel .selected-row').innerText(), /Real Techniques Fine Liner Brush/);
  assert.match(await page.getByTestId('member-page').innerText(), /1–20 of 1,643/);
});
await page.screenshot({path: path.join(output, 'desktop.png'), fullPage: true});
await check('resolver changes selected member and native trace', async () => {
  const before = performance.now();
  await page.getByLabel('Group resolver', {exact: true}).selectOption('popularity');
  await page.locator('.group-panel .selected-row').filter({hasText: /Hawaiian Tropic/}).waitFor();
  interactionMs.resolverSwitchToRenderedMember = performance.now() - before;
  assert.match(await page.locator('.trace-panel .selected-row').innerText(), /Hawaiian Tropic/);
  await page.getByLabel('Group resolver', {exact: true}).selectOption('history_cosine');
  await page.locator('.group-panel .selected-row').filter({hasText: /Fine Liner Brush/}).waitFor();
});
await check('real group pagination and native-row selection', async () => {
  await page.getByRole('button', {name: 'Next member page'}).click();
  await page.getByTestId('member-page').filter({hasText: '21–40'}).waitFor();
  await page.getByRole('button', {name: 'Previous member page'}).click();
  await page.getByTestId('member-page').filter({hasText: '1–20'}).waitFor();
  await page.getByRole('button', {name: 'Inspect prediction rank 2', exact: true}).click();
  await page.getByTestId('member-page').filter({hasText: 'of 31'}).waitFor();
  await page.getByRole('button', {name: 'Inspect prediction rank 1', exact: true}).click();
  await page.getByTestId('member-page').filter({hasText: 'of 1,643'}).waitFor();
});
await check('opposite real resolver win on identical query', async () => {
  const before = performance.now();
  await page.getByTestId('query-210').click(); await waitQuery(210);
  interactionMs.querySwitchToRenderedMember = performance.now() - before;
  assert.equal(await page.getByTestId('popularity-hit').textContent(), '1.0000');
  assert.equal(await page.getByTestId('history_cosine-hit').textContent(), '0.0000');
});
await page.screenshot({path: path.join(output, 'popularity-win.png'), fullPage: true});
await check('SID-hit/item-miss task and live filters', async () => {
  await page.getByLabel('Case filter', {exact: true}).selectOption('sid_hit_item_miss');
  await page.getByTestId('query-7').click(); await waitQuery(7);
  assert.equal(await page.getByTestId('sid-ndcg').textContent(), '1.0000');
  assert.equal(await page.getByTestId('popularity-hit').textContent(), '0.0000');
  assert.equal(await page.getByTestId('history_cosine-hit').textContent(), '0.0000');
  assert.match(await page.locator('.trace-panel .selected-row').innerText(), /Target address/);
  await page.getByTestId('jump-to-target').click();
  await page.locator('.group-panel .target-member-row').first().waitFor();
  await page.getByLabel('Filter collision group', {exact: true}).fill('Fine Liner');
  await page.getByLabel('Filter collision group', {exact: true}).fill('');
  await page.getByTestId('toggle-code').click();
  await page.getByTestId('python-drawer').waitFor();
  await page.getByTestId('toggle-code').click();
  await page.getByLabel('Case filter', {exact: true}).selectOption('invalid_outputs');
  await page.getByText('No selected cases match this filter.').waitFor();
  await page.getByLabel('Case filter', {exact: true}).selectOption('all');
});
await page.screenshot({path: path.join(output, 'sid-hit-item-miss.png'), fullPage: true});
await check('TIGER injective agreement, matched baseline and contexts', async () => {
  const switched = page.waitForResponse(response => response.url().includes('/api/query?') && response.url().includes('tiger-openai-2025'));
  await page.getByLabel('Model', {exact: true}).selectOption('tiger-openai-2025');
  await switched;
  await waitQuery(7);
  assert.equal(await page.getByTestId('popularity-ndcg').textContent(), await page.getByTestId('history_cosine-ndcg').textContent());
  assert.equal(await page.getByTestId('sid-ndcg').textContent(), await page.getByTestId('cce-ndcg').textContent());
  assert.match(await page.getByTestId('member-page').innerText(), /of 1/);
  await page.locator('.contracts>summary').click();
  assert.match(await page.locator('.contracts').innerText(), /Maximum history: 50 items/);
  assert.match(await page.locator('.contracts').innerText(), /OpenAI tokenizer features and ST5 resolver features/);
  await page.locator('.baseline').getByRole('button', {name: 'View top 10', exact: true}).click();
  assert.equal(await page.locator('.baseline .ranking li').count(), 10);
  await page.locator('.contracts>summary').click();
});
await check('cutoff controls update evaluated and visible output', async () => {
  await page.getByLabel('Cutoff', {exact: true}).selectOption('5');
  await page.getByText('Item Hit@5', {exact: true}).first().waitFor();
  await page.getByLabel('Cutoff', {exact: true}).selectOption('20');
  await page.getByText('Item Hit@20', {exact: true}).first().waitFor();
  await page.getByLabel('Cutoff', {exact: true}).selectOption('10');
  await page.getByText('Item Hit@10', {exact: true}).first().waitFor();
});
await check('downloaded session independently replays through UI', async () => {
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export').click();
  const download = await downloadPromise;
  const file = path.join(output, 'session.json');
  await download.saveAs(file);
  const session = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(session.payload_sha256);
  await page.getByLabel('Session file', {exact: true}).setInputFiles(file);
  await page.getByRole('status').filter({hasText: 'Replay passed'}).waitFor();
});
await check('keyboard selection and full history disclosure', async () => {
  const switched = page.waitForResponse(response => response.url().includes('/api/query?') && response.url().includes('letter-openai-2025'));
  await page.getByLabel('Model', {exact: true}).selectOption('letter-openai-2025');
  await switched;
  await page.getByLabel('Case filter', {exact: true}).selectOption('all');
  await page.getByTestId('query-145').focus(); await page.keyboard.press('Enter'); await waitQuery(145);
  await page.locator('.history-events .text-button').click();
  assert.equal(await page.locator('.history-flow li').count(), 16);
  await page.locator('.history-events .text-button').click();
});
await check('desktop and mobile have no document overflow or blank UI', async () => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({width: 1024, height: 768});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: path.join(output, 'tablet.png'), fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.getByTestId('query-heading').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.getByRole('heading', {name: 'Recommendation diagnostics'}).isVisible());
  await page.getByTestId('query-145').waitFor();
  assert.ok(await page.getByTestId('query-145').evaluate(element => {
    const current = element.getBoundingClientRect(); const rail = element.parentElement.getBoundingClientRect();
    return current.left >= rail.left && current.right <= rail.right;
  }));
  await page.screenshot({path: path.join(output, 'mobile.png'), fullPage: true});
  await page.screenshot({path: path.join(output, 'mobile-viewport.png'), fullPage: false});
  await page.getByLabel('Group resolver', {exact: true}).selectOption('popularity');
  await page.locator('.group-panel .selected-row').filter({hasText: /Hawaiian Tropic/}).waitFor();
});
await check('console and framework health', async () => assert.deepEqual(errors, []));
let cleanLaunchMs;
await check('clean offline runtime without site packages or node_modules', async () => {
  const clean = await mkdtemp(path.join(os.tmpdir(), 'cornac-workbench-portable-'));
  await mkdir(path.join(clean, 'workbench-assets'), {recursive: true});
  await mkdir(path.join(clean, 'web'), {recursive: true});
  await Promise.all([
    cp(new URL('../../workbench.py', import.meta.url), path.join(clean, 'workbench.py')),
    cp(new URL('../../serve_workbench.py', import.meta.url), path.join(clean, 'serve_workbench.py')),
    cp(new URL('../../workbench-assets/bundle.json.gz', import.meta.url), path.join(clean, 'workbench-assets/bundle.json.gz')),
    cp(new URL('../dist/', import.meta.url), path.join(clean, 'web/dist'), {recursive: true})
  ]);
  const before = performance.now();
  const server = spawn(process.env.WORKBENCH_PYTHON || 'python3', ['-S', 'serve_workbench.py', '--port', '8081'], {cwd: clean, stdio: 'ignore'});
  try {
    let ready = false;
    for (let retry = 0; retry < 100; retry++) {
      try {ready = (await fetch('http://127.0.0.1:8081/api/bootstrap')).ok;} catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready); cleanLaunchMs = performance.now() - before;
    const cleanPage = await context.newPage();
    await cleanPage.goto('http://127.0.0.1:8081/?view=diagnostics', {waitUntil: 'domcontentloaded'});
    await cleanPage.getByTestId('history_cosine-hit').filter({hasText: '1.0000'}).waitFor();
    assert.deepEqual(externalRequests, []);
    await cleanPage.close();
  } finally {server.kill();}
});

const samples = {};
for (const [name, endpoint] of Object.entries({query: '/api/query?query=145&model=letter-openai-2025&cutoff=10', group: '/api/group?query=145&model=letter-openai-2025&address=195,184,83,0&resolver=history_cosine&offset=0&limit=20', export: '/api/export?query=145&model=letter-openai-2025&cutoff=10'})) {
  samples[name] = [];
  for (let index = 0; index < 10; index++) {
    const before = performance.now(); const response = await page.request.get(url + endpoint); await response.body();
    assert.equal(response.status(), 200); samples[name].push(performance.now() - before);
  }
}
await page.setViewportSize({width:1536,height:1024});
await page.getByLabel('Group resolver', {exact:true}).selectOption('history_cosine');
await page.locator('.group-panel .selected-row').filter({hasText:/Fine Liner Brush/}).waitFor();
await page.screenshot({path:path.join(output,'desktop-final.png'),fullPage:true});
await page.screenshot({path:path.join(output,'desktop-viewport.png'),fullPage:false});
const report = {date: new Date().toISOString(), url, browser: await browser.version(), browserPath: 'Playwright Chromium; Browser plugin not available', viewports: ['1536x1024','1024x768','390x844'], hardware:{platform:os.platform(),release:os.release(),cpu:os.cpus()[0].model,cores:os.cpus().length,node:process.version},firstMeaningfulMs,cleanLaunchMs,interactionMs,latencyMs:samples,checks,consoleErrors:errors,externalRequests,walkthroughVideo:await page.video().path(),scope:'18 selected diagnostic/neutral walkthrough queries; not a model-quality benchmark or participant usability study'};
await writeFile(path.join(output,'browser-validation.json'),JSON.stringify(report,null,2)+'\n');
await context.close(); await browser.close();
console.log(JSON.stringify({passed:checks.length,output,firstMeaningfulMs},null,2));
