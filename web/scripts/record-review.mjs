import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Presentation-only caption overlay; no application source or predictions change.
const output = fileURLToPath(new URL('../../media/', import.meta.url));
const url = process.env.WORKBENCH_URL || 'http://127.0.0.1:8080';
await mkdir(path.join(output, 'frames'), {recursive: true});
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({
  viewport: {width: 1536, height: 1024}, acceptDownloads: true,
  recordVideo: {dir: path.join(output, 'raw'), size: {width: 1536, height: 1024}},
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const cues = [];
const start = performance.now();
await page.goto(url, {waitUntil: 'domcontentloaded'});
async function query(id) {
  await page.getByTestId('query-heading').filter({hasText: 'Query #' + id}).waitFor();
  await page.locator('.group-panel .selected-row').first().waitFor();
}
await query(145);
await page.evaluate(() => {
  const overlay = document.createElement('div');
  overlay.id = 'recording-caption';
  overlay.setAttribute('aria-hidden', 'true');
  Object.assign(overlay.style, {
    pointerEvents: 'none', position: 'fixed', left: '228px', right: '18px', bottom: '16px', zIndex: '9999',
    background: 'rgba(15,35,58,.97)', borderLeft: '5px solid #30b5a6',
    padding: '15px 22px', borderRadius: '8px', color: 'white',
    font: '19px/1.45 Arial, sans-serif', boxShadow: '0 5px 25px #12213333',
  });
  document.body.append(overlay);
});
async function scene(title, text, seconds = 8) {
  const elapsed = (performance.now() - start) / 1000;
  cues.push({start: elapsed, end: elapsed + seconds, title, text});
  await page.evaluate(({title, text}) => {
    const overlay = document.getElementById('recording-caption');
    overlay.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = title + '  ';
    heading.style.color = '#67e0d3';
    overlay.append(heading, document.createTextNode(text));
  }, {title, text});
  await page.screenshot({path: path.join(output, 'frames', String(cues.length).padStart(2, '0') + '.png')});
  await page.waitForTimeout(seconds * 1000);
}
await scene('LOCAL REVIEW DRAFT', '18 selected Beauty cases. Saved model predictions; live resolver selection and metric reconstruction.');
await page.getByTestId('query-7').click(); await query(7);
assert.equal(await page.getByTestId('sid-ndcg').textContent(), '1.0000');
assert.equal(await page.getByTestId('popularity-hit').textContent(), '0.0000');
assert.equal(await page.getByTestId('history_cosine-hit').textContent(), '0.0000');
await scene('1 · Diagnose an apparent hit', 'Query 7: the target SID is first, but neither explicit resolver selects the held-out item.');
await page.getByRole('button', {name: 'Next member page'}).click();
await page.getByTestId('member-page').filter({hasText: '21–40'}).waitFor();
await scene('Inspect the catalog group', 'This complete address has 1,643 members. Inspect scores and pagination; CCE is a reference expectation, not an item resolver.');
await page.getByTestId('query-145').click(); await query(145);
assert.equal(await page.getByTestId('history_cosine-hit').textContent(), '1.0000');
await scene('2 · Compare fixed predictions', 'Query 145: training-history cosine hits the target, while training popularity misses.');
await page.getByLabel('Group resolver', {exact: true}).selectOption('popularity');
await page.locator('.group-panel .selected-row').filter({hasText: /Hawaiian Tropic/}).waitFor();
await scene('Follow the selected member', 'Changing the explicit policy selects a different item from the same group. Scores use training data; targets only support evaluation.');
await page.getByTestId('query-210').click(); await query(210);
assert.equal(await page.getByTestId('popularity-hit').textContent(), '1.0000');
assert.equal(await page.getByTestId('history_cosine-hit').textContent(), '0.0000');
await scene('Opposite resolver outcome', 'Query 210: popularity wins. These selected examples do not establish a generally better resolver.');
await page.getByLabel('Model', {exact: true}).selectOption('tiger-openai-2025');
await page.getByTestId('member-page').filter({hasText: 'of 1'}).waitFor();
assert.equal(await page.getByTestId('sid-ndcg').textContent(), await page.getByTestId('cce-ndcg').textContent());
await scene('Injective control', 'TIGER has one item per complete address. Both explicit policies and the SID/item/CCE views agree.');
await page.locator('.contracts>summary').click();
await page.locator('.baseline').getByRole('button', {name: 'View top 10', exact: true}).click();
assert.equal(await page.locator('.baseline .ranking li').count(), 10);
await scene('3 · Compare the matched baseline', 'SASRec shares this history and target. Maximum contexts differ: 50 items for SASRec, 20 for SID runs. No equal-tuning claim.');
await page.locator('.contracts>summary').click();
const downloaded = page.waitForEvent('download');
await page.getByTestId('export').click();
const session = path.join(output, 'recorded-session.json');
await (await downloaded).saveAs(session);
await page.getByLabel('Session file', {exact: true}).setInputFiles(session);
await page.getByRole('status').filter({hasText: 'Replay passed'}).waitFor();
assert.deepEqual(errors, []);
await scene('Export and verify', 'The session retains inputs, contracts, provenance and results. Replay checks its checksum and reconstructs both resolver outcomes.');
const video = page.video();
await context.close();
await copyFile(await video.path(), path.join(output, 'walkthrough-review.webm'));
await browser.close();
const stamp = value => {
  const ms = Math.round(value * 1000);
  return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
};
await writeFile(path.join(output, 'walkthrough-review.vtt'), 'WEBVTT\n\n' + cues.map((cue, i) => (i + 1) + '\n' + stamp(cue.start) + ' --> ' + stamp(cue.end) + '\n' + cue.title + '\n' + cue.text + '\n').join('\n'));
await writeFile(path.join(output, 'recording-validation.json'), JSON.stringify({
  status: 'passed', scope: 'local review draft; no narration; caption overlay only',
  browserFallback: 'Browser plugin not available', browser: 'Chromium',
  viewport: '1536x1024', url, scenes: cues, assertionChecks: 9, consoleErrors: errors,
  elapsedSeconds: (performance.now() - start) / 1000,
}, null, 2) + '\n');
console.log(JSON.stringify({status: 'passed', scenes: cues.length, output}));
