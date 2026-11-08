import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const url = process.env.JOURNEY_URL || 'http://127.0.0.1:8110';
// Scratch (downloads, failure screenshot) stays node-local; evidence persists beside the paper.
const output = process.env.JOURNEY_QA_DIR || path.join(os.tmpdir(), 'cornac-beauty-journey-qa');
const demo = fileURLToPath(new URL('../../', import.meta.url));
const evidence = process.env.JOURNEY_EVIDENCE_DIR || demo;
const figure = name => path.join(evidence, 'figures', name);
const json = async name => JSON.parse(await readFile(new URL(`../public/journeys/${name}`, import.meta.url), 'utf8'));
const manifest = await json('manifest.json');
const media = await json('media.json');
const question = 'A real shopper bought these 16 products. What did they buy next?';
await mkdir(output, {recursive:true});
await mkdir(path.join(evidence, 'figures'), {recursive:true});
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const errors = [], requests = [], failed = [], checks = [];
function watch(target) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  target.on('request', request => {if (!request.url().startsWith('data:')) requests.push(request.url());});
  target.on('response', response => {if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);});
  return target;
}
const page = watch(await context.newPage());
async function check(name, fn) {await fn(); checks.push({name,status:'passed'}); console.log(`PASS ${name}`);}
// Item indices from data-item; the left diff, right diff and recount use the same shelfDiff rule as the page.
const shelf = (target, id) => target.getByTestId(id).locator('article[data-item]').evaluateAll(cards => cards.map(card => Number(card.dataset.item)));
const history = target => target.locator('.journey-timeline li[data-item]').evaluateAll(rows => rows.map(row => Number(row.dataset.item)));
const choose = (target, id) => target.getByTestId(id).getByRole('button', {name:/^Choose /}).first().click();
async function at(target, text) {
  await target.getByText(text, {exact:true}).waitFor();
  await target.locator('.journey-recommendations[aria-busy="false"]').waitFor();
}
function shelfDiff(before, after) {
  const status = after.map((item, i) => {const p = before.indexOf(item); return p < 0 ? 'new' : p === i ? 'same' : 'moved';});
  return {newCount:status.filter(s => s === 'new').length, movedCount:status.filter(s => s === 'moved').length};
}
async function settle(target) {
  await target.mouse.move(0, 0);
  await target.evaluate(async () => {
    document.activeElement?.blur();
    scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    scrollTo(0, 0);
    await document.fonts.ready;
  });
  await target.waitForFunction(() => [...document.images].filter(image => image.checkVisibility()).every(image => image.complete));
}
async function openHook(viewport) {
  const fresh = watch(await context.newPage());
  await fresh.setViewportSize(viewport);
  await fresh.goto(url);
  await fresh.getByTestId('traditional-shelf').getByRole('button', {name:/^Guess /}).first().waitFor();
  return fresh;
}
// Fresh page at a hash such as `#p=...&r=1`; `init` runs before the page's own scripts.
async function openAt(hash, init) {
  const fresh = watch(await context.newPage());
  if (init) await fresh.addInitScript(init);
  await fresh.goto(new URL(hash, url).href);
  await fresh.locator('article[data-item]').first().waitFor();
  await fresh.locator('.journey-recommendations[aria-busy="false"]').waitFor();
  return fresh;
}
const started = performance.now();
try {
  await page.goto(url);
  await page.getByTestId('traditional-shelf').getByRole('button', {name:/^Guess /}).first().waitFor();
  const firstRenderMs = performance.now() - started;
  await check('page loads with the question and two shelves of five', async () => {
    assert.match(await page.title(), /Beauty recommendation journeys/);
    assert.ok(await page.getByRole('heading', {level:1, name:question, exact:true}).isVisible());
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.equal(await page.getByTestId('traditional-shelf').locator('article[data-item]').count(), 5);
    assert.equal(await page.getByTestId('sid-shelf').locator('article[data-item]').count(), 5);
    assert.equal(await page.locator('.journey-timeline li[data-item]').count(), 16);
    assert.equal(await page.locator('.journey-timeline li[data-item]:not([hidden])').count(), 6);
  });
  await check('product photos load', async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('.product-shelf img, .journey-timeline li:not([hidden]) img')].every(image => image.complete));
    const shelfWidths = await page.locator('.product-shelf img').evaluateAll(images => images.map(image => image.naturalWidth));
    const stripWidths = await page.locator('.journey-timeline li:not([hidden]) img').evaluateAll(images => images.map(image => image.naturalWidth));
    assert.ok(shelfWidths.length >= 10);
    assert.ok([...shelfWidths, ...stripWidths].every(width => width > 0));
  });
  const seed = manifest.pairs[0].seeds[0].id;
  await check('reveal marks the real purchase and keeps both lists', async () => {
    assert.equal(await page.getByRole('button', {name:/^Guess /}).count(), 10);
    assert.equal(await page.getByRole('button', {name:/^Choose /}).count(), 0);
    assert.equal(await page.getByText('They bought this').count(), 0);
    assert.equal(await page.locator('select').count(), 0);
    const before = [await shelf(page, 'traditional-shelf'), await shelf(page, 'sid-shelf')];
    await page.getByRole('button', {name:'Just show me', exact:true}).click();
    await page.getByRole('heading', {name:'Now you choose. Pick anything and watch both lists react.'}).waitFor();
    assert.deepEqual([await shelf(page, 'traditional-shelf'), await shelf(page, 'sid-shelf')], before);
    assert.equal(await page.getByText('They bought this').count(), 1);
    assert.equal(await page.getByTestId('sid-shelf').getByText('They bought this').count(), 1);
    assert.equal(await page.getByTestId('sid-shelf').locator('article.is-target').getAttribute('data-item'), String(media.targets[seed]));
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(await page.locator('h1').textContent(), "LETTER had it at #1. SASRec didn't list it.");
    assert.equal(await page.locator('.journey-question').textContent(), question);
    assert.equal(await page.locator('.product-shelf').getByRole('button', {name:/^Choose /}).count(), 10);
  });
  await check('Details shows the evaluation table', async () => {
    const toggle = page.getByRole('button', {name:'Details', exact:true});
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.journey-metrics').count(), 0);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    await page.getByRole('rowheader', {name:'LETTER · SID', exact:true}).waitFor();
    assert.ok(await page.locator('.journey-metrics').isVisible());
  });
  await check('shelves sit side by side with aligned rows', async () => {
    const traditional = await page.getByTestId('traditional-shelf').boundingBox();
    const sid = await page.getByTestId('sid-shelf').boundingBox();
    assert.ok(Math.abs(traditional.y - sid.y) < 1);
    assert.ok(Math.abs(traditional.width - sid.width) < 1);
    assert.ok(sid.x >= traditional.x + traditional.width);
    for (let i = 0; i < 5; i++) {
      const left = await page.getByTestId('traditional-shelf').locator('article[data-item]').nth(i).boundingBox();
      const right = await page.getByTestId('sid-shelf').locator('article[data-item]').nth(i).boundingBox();
      assert.ok(Math.abs(left.y - right.y) < 1);
      assert.ok(Math.abs(left.height - right.height) < 1);
    }
  });
  const initialHistory = await history(page);
  await check('four item strategies change the right shelf, not the history', async () => {
    const shelves = [];
    for (const policy of ['one_popularity','one_cosine','expand_popularity','expand_cosine']) {
      await page.getByLabel('SID to item strategy').selectOption(policy);
      shelves.push(await shelf(page, 'sid-shelf'));
      assert.deepEqual(await history(page), initialHistory);
    }
    assert.notDeepEqual(shelves[0], shelves[1]);
    assert.notDeepEqual(shelves[1], shelves[3]);
  });
  await check('bucket inspector lists other products and scores', async () => {
    await page.getByTestId('sid-shelf').locator('.bucket-link').first().click();
    await page.getByRole('heading', {name:/One SID,/}).waitFor();
    assert.equal(await page.locator('.bucket-columns h3').count(), 2);
    assert.ok(await page.locator('.bucket-columns li').count() > 2);
    await page.getByRole('button', {name:'Close bucket inspector'}).click();
    assert.equal(await page.locator('.journey-inspector').count(), 0);
  });
  const fixedMetrics = await page.locator('.journey-metrics').innerText();
  const beforeChoice = [await shelf(page, 'traditional-shelf'), await shelf(page, 'sid-shelf')];
  let choiceMs, afterChoice;
  await check('a choice updates both shelves and keeps the evaluation table', async () => {
    const selected = beforeChoice[0][0];
    const begin = performance.now();
    await choose(page, 'traditional-shelf');
    await at(page, 'Choice 2 of 2');
    await page.getByRole('status').filter({hasText:/new on the left|Nothing changed/}).waitFor();
    choiceMs = performance.now() - begin;
    assert.deepEqual(await history(page), [...initialHistory, selected]);
    assert.equal(await page.locator('.journey-timeline li[data-item]').last().locator('small').textContent(), 'Yours');
    assert.equal(await page.locator('.journey-metrics').innerText(), fixedMetrics);
    afterChoice = [await shelf(page, 'traditional-shelf'), await shelf(page, 'sid-shelf')];
    assert.equal(afterChoice[0].length, 5);
    assert.equal(afterChoice[1].length, 5);
  });
  await check('change line matches a recount of both shelves', async () => {
    const [left, right] = [0, 1].map(i => shelfDiff(beforeChoice[i], afterChoice[i]));
    const text = left.newCount || right.newCount || left.movedCount || right.movedCount
      ? `${left.newCount} new on the left, ${right.newCount} on the right.` : 'Nothing changed.';
    assert.equal(await page.locator('.change-line > p').textContent(), text);
    assert.equal(await page.locator('.journey-live').textContent(), text);
    assert.equal(await page.getByTestId('traditional-shelf').locator('article.is-new').count(), left.newCount);
    assert.equal(await page.getByTestId('sid-shelf').locator('article.is-new').count(), right.newCount);
    assert.equal(await page.locator('article.is-moved').count(), left.movedCount + right.movedCount);
    await page.getByRole('button', {name:'Why?', exact:true}).click();
    assert.equal(await page.locator('.why p').count(), 2);
  });
  await check('second choice ends the journey and Undo goes back', async () => {
    const previous = await shelf(page, 'sid-shelf');
    await choose(page, 'sid-shelf');
    await page.getByRole('heading', {name:'Final recommendations', exact:true}).waitFor();
    assert.equal(await page.getByRole('button', {name:/^Final suggestion:/}).count(), 10);
    assert.equal(await page.locator('.choose-product:not(:disabled)').count(), 0);
    await page.getByRole('button', {name:'Undo', exact:true}).click();
    await at(page, 'Choice 2 of 2');
    assert.deepEqual(await shelf(page, 'sid-shelf'), previous);
  });
  await check('recap shows what happened and its actions work', async () => {
    await choose(page, 'sid-shelf');
    await at(page, 'Journey complete');
    await page.getByRole('heading', {name:'What happened', exact:true}).waitFor();
    assert.match(await page.locator('.journey-recap p').first().textContent(), /^You picked .+, then .+\.$/);
    const link = page.getByRole('link', {name:'Get Cornac'});
    assert.equal(await link.getAttribute('href'), 'https://github.com/PreferredAI/cornac');
    assert.equal(await link.getAttribute('target'), '_blank');
    await page.getByRole('button', {name:'Another model', exact:true}).click();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Journey model pair');
    await page.getByRole('button', {name:'Undo', exact:true}).click();
    await at(page, 'Choice 2 of 2');
  });
  await check('save and replay restore the journey and reject a tampered file', async () => {
    const waiting = page.waitForEvent('download'); await page.getByRole('button', {name:'Save journey', exact:true}).click();
    const download = await waiting; const file = path.join(output, download.suggestedFilename()); await download.saveAs(file);
    await page.getByRole('button', {name:'Restart', exact:true}).click();
    await at(page, 'Choice 1 of 2');
    await page.getByLabel('Journey replay file').setInputFiles(file);
    await page.getByRole('status').filter({hasText:/Journey restored/}).waitFor();
    await at(page, 'Choice 2 of 2');
    const corrupted = JSON.parse(await readFile(file, 'utf8')); corrupted.history[0] = -1;
    const bad = path.join(output, 'tampered.json'); await writeFile(bad, JSON.stringify(corrupted));
    await page.getByLabel('Journey replay file').setInputFiles(bad);
    await page.getByRole('alert').filter({hasText:/Replay failed/}).waitFor();
    await page.getByLabel('Journey replay file').setInputFiles(file);
    await page.getByRole('alert').waitFor({state:'detached'});
    await page.getByRole('status').filter({hasText:/Journey restored/}).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
  });
  await check('changing the story restarts and keyboard choice works', async () => {
    await page.getByLabel('Starting story').selectOption({index:1});
    await at(page, 'Choice 1 of 2');
    assert.equal(await page.locator('.attendee-choice').count(), 0);
    await page.getByTestId('traditional-shelf').getByRole('button', {name:/^Choose /}).first().focus();
    await page.keyboard.press('Enter');
    await at(page, 'Choice 2 of 2');
  });
  await check('changing the story cancels a choice in flight', async () => {
    const roots = manifest.pairs[0].seeds.map(row => row.id);
    const racePage = watch(await context.newPage());
    let release;
    const pending = new Promise(resolve => {release = resolve;});
    await racePage.route('**/states/*.json', async route => {
      const id = new URL(route.request().url()).pathname.split('/').pop().replace('.json', '');
      if (!roots.includes(id)) await pending;
      await route.continue();
    });
    try {
      await racePage.goto(url);
      await racePage.getByRole('button', {name:'Just show me', exact:true}).click();
      await choose(racePage, 'traditional-shelf');
      await racePage.getByRole('status').filter({hasText:'Updating recommendations…'}).waitFor();
      await racePage.getByLabel('Starting story').selectOption(roots[1]);
      await at(racePage, 'Choice 1 of 2');
      const expected = await history(racePage);
      release();
      await racePage.waitForLoadState('networkidle');
      assert.deepEqual(await history(racePage), expected);
      assert.equal(await racePage.locator('.attendee-choice').count(), 0);
      assert.ok(await racePage.getByText('Choice 1 of 2', {exact:true}).isVisible());
    } finally {release(); await racePage.close();}
  });
  await check('a guess is marked and the real purchase revealed', async () => {
    const guessPage = await openHook({width:1440, height:1000});
    try {
      const guessed = (await shelf(guessPage, 'traditional-shelf'))[1];
      await guessPage.getByTestId('traditional-shelf').getByRole('button', {name:/^Guess /}).nth(1).click();
      await guessPage.getByText('Your guess', {exact:true}).waitFor();
      assert.equal(await guessPage.locator('.guess-pill').count(), 1);
      assert.equal(await guessPage.locator('article:has(.guess-pill)').getAttribute('data-item'), String(guessed));
      assert.equal(await guessPage.getByTestId('sid-shelf').getByText('They bought this').count(), 1);
      assert.ok(await guessPage.evaluate(() => Boolean(document.activeElement?.closest('.is-target'))));
      assert.equal(await guessPage.getByRole('button', {name:/^Guess /}).count(), 0);
    } finally {await guessPage.close();}
  });
  await check('same-code step: either product, different left shelf', async () => {
    const probed = manifest.pairs.filter(pair => pair.same_bucket_probe);
    assert.deepEqual(probed.map(pair => pair.id), ['sasrec-letter','bert-mlm-letter']);
    const last = () => page.locator('.journey-timeline li[data-item]').last().getAttribute('data-item');
    for (const pair of probed) {
      const probe = pair.same_bucket_probe;
      assert.ok(probe.native_addresses_equal);
      assert.equal(probe.traditional_top5_equal, false);
      await page.getByLabel('Journey model pair').selectOption(pair.id);
      await page.getByLabel('Starting story').selectOption(probe.seed);
      await at(page, 'Choice 1 of 2');
      const step = page.getByTestId('same-sid-step');
      await step.getByRole('button', {name:/^Choose /}).first().click();
      await at(page, 'Choice 2 of 2');
      assert.equal(await last(), String(probe.items[0]));
      const first = await shelf(page, 'traditional-shelf');
      await step.getByRole('button', {name:/^Try .* instead$/}).click();
      await page.waitForFunction(item => document.querySelector('.journey-timeline li:last-child')?.dataset.item === item, String(probe.items[1]));
      await at(page, 'Choice 2 of 2');
      const swapped = await shelf(page, 'traditional-shelf');
      assert.notDeepEqual(swapped, first);
      await page.getByRole('button', {name:'Undo', exact:true}).click();
      await at(page, 'Choice 1 of 2');
      await step.getByRole('button', {name:/^Choose /}).nth(1).click();
      await at(page, 'Choice 2 of 2');
      assert.equal(await last(), String(probe.items[1]));
      assert.deepEqual(await shelf(page, 'traditional-shelf'), swapped);
    }
  });
  await check('each model pair restarts with its own evaluation table', async () => {
    for (const pair of manifest.pairs) {
      await page.getByLabel('Journey model pair').selectOption(pair.id);
      await page.getByRole('button', {name:'Restart', exact:true}).click();
      await at(page, 'Choice 1 of 2');
      await page.getByRole('rowheader', {name:`${pair.sid} · SID`, exact:true}).waitFor();
      assert.equal(await page.locator('.traditional-heading .model-name').textContent(), pair.traditional);
      assert.equal(await page.locator('.attendee-choice').count(), 0);
      assert.equal(await page.getByTestId('traditional-shelf').locator('article[data-item]').count(), 5);
      assert.equal(await page.getByTestId('sid-shelf').locator('article[data-item]').count(), 5);
      await choose(page, 'sid-shelf');
      await at(page, 'Choice 2 of 2');
    }
  });
  await check('RPG pair shows one product per code and no strategy menu', async () => {
    await page.getByLabel('Journey model pair').selectOption('sasrec-rpg');
    await at(page, 'Choice 1 of 2');
    assert.ok(await page.getByText('One product per code', {exact:true}).isVisible());
    assert.equal(await page.getByLabel('SID to item strategy').count(), 0);
  });
  await check('BERT4Rec and TIGER journey saves and replays', async () => {
    await page.getByLabel('Journey model pair').selectOption('bert-mlm-tiger');
    await page.getByRole('button', {name:'Restart', exact:true}).click();
    await at(page, 'Choice 1 of 2');
    await page.getByRole('rowheader', {name:'TIGER · SID', exact:true}).waitFor();
    await choose(page, 'sid-shelf');
    await at(page, 'Choice 2 of 2');
    const saved = await history(page);
    const waiting = page.waitForEvent('download'); await page.getByRole('button', {name:'Save journey', exact:true}).click();
    const file = path.join(output, 'bert-mlm-tiger-journey.json'); await (await waiting).saveAs(file);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).provenance.traditional_model, 'BERT4Rec (MLM)');
    await page.getByRole('button', {name:'Restart', exact:true}).click();
    await at(page, 'Choice 1 of 2');
    await page.getByLabel('Journey replay file').setInputFiles(file);
    await page.getByRole('status').filter({hasText:/Journey restored/}).waitFor();
    await at(page, 'Choice 2 of 2');
    assert.deepEqual(await history(page), saved);
    assert.equal(await page.getByRole('alert').count(), 0);
  });
  // Desktop screenshots: revealed, Details on, default item strategy.
  for (const [pair, name] of [['bert-mlm-letter','journeys-desktop-bert-mlm.png'], ['sasrec-letter','journeys-desktop.png']]) {
    const row = manifest.pairs.find(p => p.id === pair);
    await page.getByLabel('Journey model pair').selectOption(pair);
    await at(page, 'Choice 1 of 2');
    await page.getByLabel('SID to item strategy').selectOption('one_cosine');
    await page.getByRole('rowheader', {name:`${row.traditional} · Item`, exact:true}).waitFor();
    await page.getByRole('rowheader', {name:`${row.sid} · SID`, exact:true}).waitFor();
    await settle(page);
    await page.screenshot({path:figure(name), fullPage:true, animations:'disabled'});
  }
  await check('no horizontal overflow; first view fits desktop and phone', async () => {
    for (const [width, height] of [[1440,1000],[1024,768],[390,844]]) {
      await page.setViewportSize({width, height});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const traditional = await page.getByTestId('traditional-shelf').boundingBox();
      const sid = await page.getByTestId('sid-shelf').boundingBox();
      if (width >= 1024) assert.ok(Math.abs(traditional.y - sid.y) < 1);
      else assert.ok(sid.y >= traditional.y + traditional.height);
    }
    const desktop = await openHook({width:1440, height:1000});
    try {
      for (const id of ['traditional-shelf','sid-shelf']) {
        const box = await desktop.getByTestId(id).boundingBox();
        assert.ok(box.y + box.height <= 1000);
      }
    } finally {await desktop.close();}
    const mobile = await openHook({width:390, height:844});
    try {
      assert.ok((await mobile.locator('article[data-item]').first().boundingBox()).y < 844);
      assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await settle(mobile);
      await mobile.screenshot({path:figure('journeys-mobile.png'), fullPage:true, animations:'disabled'});
      await mobile.screenshot({path:figure('journeys-mobile-viewport.png'), fullPage:false, animations:'disabled'});
    } finally {await mobile.close();}
  });
  await check('hash restores a journey', async () => {
    const seedId = manifest.pairs.find(pair => pair.id === 'bert-mlm-letter').seeds[1].id;
    const restored = await openAt(`#p=bert-mlm-letter&h=${seedId}&s=one_popularity&r=1`);
    try {
      assert.equal(await restored.getByLabel('Journey model pair').inputValue(), 'bert-mlm-letter');
      assert.equal(await restored.getByLabel('Starting story').inputValue(), seedId);
      assert.equal(await restored.getByLabel('SID to item strategy').inputValue(), 'one_popularity');
      assert.equal(await restored.getByText('They bought this', {exact:true}).count(), 1);
      await choose(restored, 'traditional-shelf');
      await at(restored, 'Choice 2 of 2');
      assert.match(await restored.evaluate(() => location.hash), /[#&]t=[^&]+/);
      const walked = await history(restored);
      await restored.reload();
      await at(restored, 'Choice 2 of 2');
      assert.deepEqual(await history(restored), walked);
    } finally {await restored.close();}
  });
  await check('share panel shows a QR of the link', async () => {
    // The reveal writes the hash, so location.href is the journey link.
    const shared = await openHook({width:1440, height:1000});
    try {
      await shared.getByRole('button', {name:'Just show me', exact:true}).click();
      await at(shared, 'Choice 1 of 2');
      const button = shared.getByRole('button', {name:'Share', exact:true});
      await button.click();
      const dialog = shared.getByRole('dialog');
      await dialog.locator('.share-qr svg').waitFor();
      assert.equal(await dialog.locator('input[readonly]').inputValue(), await shared.evaluate(() => location.href));
      assert.ok(await dialog.getByRole('button', {name:'Copy link', exact:true}).isVisible());
      await shared.keyboard.press('Escape');
      await dialog.waitFor({state:'detached'});
      assert.ok(await button.evaluate(element => element === document.activeElement));
    } finally {await shared.close();}
  });
  await check('details chart covers all eight pairs', async () => {
    const charted = watch(await context.newPage());
    const fetched = [];
    charted.on('request', request => {const {pathname} = new URL(request.url()); if (pathname.endsWith('/benchmark.json')) fetched.push(pathname);});
    try {
      await charted.goto(url);
      await charted.getByRole('button', {name:'Just show me', exact:true}).click();
      await at(charted, 'Choice 1 of 2');
      assert.equal(fetched.length, 1);
      await charted.getByRole('button', {name:'Details', exact:true}).click();
      const chart = charted.locator('.recall-chart svg');
      await chart.waitFor();
      assert.match(await chart.getAttribute('aria-label'), /^Recall@5 by model\. /);
      // One path per bar: SASRec and BERT4Rec item recall, then Item, SID and CCE for each of the four SID models.
      assert.equal(await chart.locator('path').count(), 2 + 4 * 3);
      assert.equal(fetched.length, 8);
      assert.deepEqual([...fetched].sort(), manifest.pairs.map(pair => `/journeys/${pair.benchmark}`).sort());
    } finally {await charted.close();}
  });
  await check('bucket view shows categories', async () => {
    const bucketPage = await openHook({width:1440, height:1000});
    try {
      await bucketPage.getByRole('button', {name:'Just show me', exact:true}).click();
      await at(bucketPage, 'Choice 1 of 2');
      assert.equal(await bucketPage.getByLabel('Journey model pair').inputValue(), 'sasrec-letter');
      assert.equal(await bucketPage.getByLabel('Starting story').inputValue(), manifest.pairs[0].seeds[0].id);
      assert.equal(await bucketPage.getByRole('button', {name:'Details', exact:true}).getAttribute('aria-pressed'), 'false');
      await bucketPage.locator('.bucket-link').first().click();
      await bucketPage.getByRole('heading', {name:"What's in this code", exact:true}).waitFor();
      const counts = await bucketPage.locator('.bucket-breakdown li strong').allTextContents();
      assert.equal(counts.length, 6);
      assert.equal(counts.reduce((sum, text) => sum + Number(text.replace(/\D/g, '')), 0), 1643);
      await bucketPage.getByLabel('Journey model pair').selectOption('sasrec-rpg');
      await at(bucketPage, 'Choice 1 of 2');
      await bucketPage.locator('.bucket-link').first().click();
      await bucketPage.locator('.journey-inspector').waitFor();
      assert.equal(await bucketPage.locator('.bucket-breakdown').count(), 0);
    } finally {await bucketPage.close();}
  });
  await check('kiosk loop plays and stops on input', async () => {
    // The idle timer reads window.__kioskIdleMs when it (re)starts and keeps a preset value, so set it before load.
    const kioskPage = await openAt('#k=1', () => {window.__kioskIdleMs = 1000;});
    try {
      const caption = kioskPage.locator('.kiosk-caption');
      await caption.waitFor({timeout:5000});
      const first = await caption.textContent();
      await kioskPage.waitForFunction(text => {const shown = document.querySelector('.kiosk-caption')?.textContent; return shown && shown !== text;}, first, {timeout:10000});
      assert.notEqual(await caption.textContent(), first);
      // A long idle spell after the input keeps the page with the visitor.
      await kioskPage.evaluate(() => {window.__kioskIdleMs = 60000;});
      await kioskPage.locator('body').dispatchEvent('pointerdown');
      await caption.waitFor({state:'detached', timeout:2000});
      await kioskPage.locator('.choose-product:not(:disabled), .guess-product:not(:disabled)').first().waitFor({timeout:5000});
      await kioskPage.waitForTimeout(1500);
      assert.equal(await caption.count(), 0);
    } finally {await kioskPage.close();}
  });
  await check('every pair lists the same histories', async () => {
    const ids = manifest.pairs[0].seeds.map(row => row.id);
    assert.ok(ids.length >= 2);
    assert.deepEqual(manifest.pairs[0].seeds.slice(0, 2).map(row => row.query_index), [145, 210]);
    const listPage = await openHook({width:1440, height:1000});
    try {
      await listPage.getByRole('button', {name:'Just show me', exact:true}).click();
      for (const pair of manifest.pairs) {
        assert.equal(pair.seeds.length, ids.length, `${pair.id} has ${pair.seeds.length} histories, not ${ids.length}`);
        assert.deepEqual(pair.seeds.map(row => row.id), ids, `${pair.id} lists other histories`);
        await listPage.getByLabel('Journey model pair').selectOption(pair.id);
        await at(listPage, 'Choice 1 of 2');
        assert.equal(await listPage.getByLabel('Journey model pair').inputValue(), pair.id);
        assert.equal(await listPage.getByLabel('Starting story').locator('option').count(), ids.length, `${pair.id} history menu`);
      }
    } finally {await listPage.close();}
  });
  await check('catalog covers every shown item', async () => {
    // A missing catalog entry shows as `Item <index>`; product names, full names, strip captions and titles are checked.
    const names = target => target.evaluate(() => [
      ...[...document.querySelectorAll('article[data-item] h3, article[data-item] .full-name p:first-of-type, .journey-timeline li[data-item] p, figcaption')].map(element => element.textContent),
      ...[...document.querySelectorAll('.journey-timeline li[data-item]')].map(element => element.title)]);
    const coverPage = await openHook({width:1440, height:1000});
    try {
      await coverPage.getByRole('button', {name:'Just show me', exact:true}).click();
      for (const pair of manifest.pairs) {
        await coverPage.getByLabel('Journey model pair').selectOption(pair.id);
        for (const seed of pair.seeds) {
          await coverPage.getByLabel('Starting story').selectOption(seed.id);
          await at(coverPage, 'Choice 1 of 2');
          const shown = await names(coverPage);
          assert.ok(shown.length >= 30);
          assert.deepEqual(shown.filter(text => text.startsWith('Item ')), [], `${pair.id} ${seed.id}`);
        }
      }
    } finally {await coverPage.close();}
  });
  await check('no API call, external request, failed response or console error', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(failed, []);
    assert.ok(requests.every(request => !request.includes('/api/')));
    assert.ok(requests.every(request => new URL(request).origin === new URL(url).origin));
  });
  // Receipt in the web-validation.json shape; hashes tie it to the reviewed sources and assets.
  const web = path.join(demo, 'web');
  const hashed = [...['src/Journeys.jsx','src/journeyParts.jsx','src/journeyExtras.jsx','src/journeys.css','src/main.jsx','index.html','dist/index.html',
    ...(await readdir(path.join(web,'dist/assets'))).map(name=>`dist/assets/${name}`),
    'public/journeys/manifest.json','dist/journeys/manifest.json','public/journeys/media.json'].map(name=>path.join(web,name)),
    ...['journeys-desktop.png','journeys-desktop-bert-mlm.png','journeys-mobile.png','journeys-mobile-viewport.png'].map(figure)];
  const files = {};
  for (const file of hashed) {
    const bytes = await readFile(file);
    files[path.relative(demo,file)] = {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  const receipt = path.join(evidence,'journeys-validation.json');
  await writeFile(receipt,JSON.stringify({date:new Date().toISOString(),url,browser:await browser.version(),
    browserPath:'Playwright Chromium; Browser plugin not available',viewports:['1440x1000','1024x768','390x844'],
    hardware:{platform:os.platform(),release:os.release(),cpu:os.cpus()[0].model,cores:os.cpus().length,node:process.version},
    firstRenderMs,choiceMs,checks,consoleErrors:errors,
    externalRequests:requests.filter(request=>new URL(request).origin!==new URL(url).origin),
    failedResponses:failed,
    pairs:manifest.pairs.map(pair=>pair.id),files,
    scope:'Scripted browser checks of the static site with eight prepared Beauty model pairs; it is not a model benchmark or a user study.'},null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,firstRenderMs,choiceMs,receipt}));
} catch (error) {
  await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
  console.error(error,errors,failed); process.exitCode=1;
} finally {await browser.close();}
