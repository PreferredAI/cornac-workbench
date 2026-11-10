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
const state = (pair, id) => json(`${pair}/states/${id}.json`);
const manifest = await json('manifest.json');
const media = await json('media.json');
const pair = manifest.pairs[0], seed = pair.seeds[0].id;
const root = await state(pair.id, seed);
const target = media.targets[seed];
const short = item => media.items[String(item)].short;
const listing = (await readFile(path.join(demo, 'paper.tex'), 'utf8')).match(/\\begin\{verbatim\}\n([\s\S]*?)\n\\end\{verbatim\}/)[1];
const steps = ['Shopper', 'Two recommenders', 'SID to item', 'Next items', 'Made with Cornac'];
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
// Item indices from data-item; the change line and recap are recounted with the page's own rules.
const items = locator => locator.evaluateAll(rows => rows.map(row => Number(row.dataset.item)));
const shelf = (target, id) => items(target.getByTestId(id).locator('article[data-item]'));
const history = target => items(target.locator('.journey-timeline li[data-item]'));
const ids = cards => cards.map(card => card.item);
const choose = (target, id) => target.getByTestId(id).getByRole('button', {name:/^Add /}).first().click();
const count = (value, word) => `${value.toLocaleString()} ${word}${value === 1 ? '' : 's'}`;
function shelfDiff(before, after) {
  const status = after.map((item, i) => {const p = before.indexOf(item); return p < 0 ? 'new' : p === i ? 'same' : 'moved';});
  return {newCount:status.filter(s => s === 'new').length, movedCount:status.filter(s => s === 'moved').length};
}
function codesDiff(before, after) {
  const [a, b] = [before, after].map(node => node.buckets.map(bucket => bucket.address.join(',')));
  return {same:a.join('|') === b.join('|'), newCount:b.filter(address => !a.includes(address)).length, total:b.length};
}
async function scene(target, n) {
  await target.locator(`.tour[data-scene="${n}"] .tour-scene h1`).waitFor();
}
// Explore screen at a given progress label, with no request in flight.
async function at(target, text) {
  await target.getByText(text, {exact:true}).waitFor();
  await target.locator('.journey-recommendations[aria-busy="false"]').waitFor();
}
// Scene 4 after `depth` choices, with no request in flight (a choice made while busy is ignored).
async function steered(target, depth) {
  await target.waitForFunction(n => document.querySelectorAll('.journey-timeline li[data-item]').length === n, root.history.length + depth);
  await target.locator('.s4-shelves[aria-busy="false"]').waitFor();
  await target.waitForFunction(() => !document.querySelector('.journey-live')?.textContent.startsWith('Updating'));
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
const fits = target => target.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
// Fresh page at a hash such as `#v=tour&sc=2`; `init` runs before the page's own scripts.
async function openAt(hash, {viewport, init} = {}) {
  const fresh = watch(await context.newPage());
  if (viewport) await fresh.setViewportSize(viewport);
  if (init) await fresh.addInitScript(init);
  await fresh.goto(new URL(hash, url).href);
  return fresh;
}
const started = performance.now();
try {
  const benchmarks = [];
  page.on('request', request => {const {pathname} = new URL(request.url()); if (pathname.endsWith('/benchmark.json')) benchmarks.push(pathname);});
  await page.goto(url);
  await page.locator('.tour-pick').first().waitFor();
  const firstRenderMs = performance.now() - started;
  // Catalog titles decoded the way the page decodes them.
  const titles = await page.evaluate(rows => Object.fromEntries(Object.entries(rows).map(([id, row]) => {
    const area = document.createElement('textarea'); area.innerHTML = row.title || `Item ${id}`; return [id, area.value];})), await json('catalog.json'));
  // The tour's naming rule: an item whose short name repeats among the history, the root's lists and `extra` gets its full title.
  const labeler = (start, extra = []) => {
    const pool = [...new Set([...start.history, ...[...start.traditional, ...start.shelves.one_cosine, ...start.shelves.one_popularity].map(card => card.item), ...extra])];
    return item => pool.some(other => other !== item && short(other) === short(item)) ? titles[String(item)].charAt(0).toUpperCase() + titles[String(item)].slice(1) : short(item);
  };
  const named = labeler(root);
  await check('scene 1 shows the 16 purchases with photos', async () => {
    assert.equal(await page.title(), 'Cornac Workbench');
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.equal(await page.locator('h1').textContent(), `One user's purchase history: ${root.history.length} items from Amazon Beauty.`);
    assert.equal(await page.getByText('Step 1 of 5', {exact:true}).count(), 1);
    assert.deepEqual(await items(page.locator('.tour-photos li[data-item]')), root.history);
    assert.deepEqual(await page.locator('.tour-photos li[data-item] p').allTextContents(), root.history.map(named));
    await page.waitForFunction(() => [...document.querySelectorAll('.tour-photos img, .tour-pick img')].every(image => image.complete));
    const widths = await page.locator('.tour-photos img').evaluateAll(images => images.map(image => image.naturalWidth));
    assert.equal(widths.length, 16);
    assert.ok(widths.every(width => width > 0));
  });
  const cards = await items(page.locator('.tour-pick'));
  await check('four guess cards with distinct names', async () => {
    assert.equal(cards.length, 4);
    assert.ok(cards.includes(target));
    assert.deepEqual(cards, [...cards].sort((a, b) => a - b));
    const listed = [...root.traditional, ...root.shelves.one_cosine, ...root.shelves.one_popularity].map(card => card.item);
    for (const item of cards.filter(item => item !== target)) assert.ok(listed.includes(item) && !root.history.includes(item));
    assert.equal(new Set(await page.locator('.tour-pick-name').allTextContents()).size, 4);
    assert.ok(await page.getByRole('button', {name:'Show the answer', exact:true}).isVisible());
    assert.equal(await page.getByText('Next purchase').count(), 0);
  });
  await check('a wrong guess shows both badges and no takeaway', async () => {
    const decoy = cards.find(item => item !== target);
    await page.locator(`.tour-pick[data-item="${decoy}"]`).click();
    const real = page.locator(`.tour-pick[data-item="${target}"]`);
    await real.getByText('Next purchase', {exact:true}).waitFor();
    assert.equal(await page.getByText('Next purchase', {exact:true}).count(), 1);
    assert.equal(await page.locator(`.tour-pick[data-item="${decoy}"]`).getByText('Your guess', {exact:true}).count(), 1);
    assert.equal(await page.getByText('Your guess', {exact:true}).count(), 1);
    const name = await real.locator('.tour-pick-name').textContent();
    assert.equal(name, named(target));
    assert.equal(name, 'Real Techniques Fine Liner Brush');
    assert.equal(await page.locator('.tour-takeaway').count(), 0);
    assert.equal(await page.locator('.tour-ask .tour-body').textContent(), 'Which item did this user buy next? Pick one.');
    assert.equal(await page.getByRole('button', {name:'Show the answer'}).count(), 0);
  });
  await check('Show the answer reveals without a guess', async () => {
    const fresh = await openAt('#v=tour&sc=1');
    try {
      await fresh.getByRole('button', {name:'Show the answer', exact:true}).click();
      await fresh.locator(`.tour-pick.is-target[data-item="${target}"]`).getByText('Next purchase', {exact:true}).waitFor();
      assert.equal(await fresh.getByText('Your guess').count(), 0);
      assert.equal(await fresh.locator('.tour-takeaway').count(), 0);
    } finally {await fresh.close();}
  });
  await check('scene 1: the History picker restarts the tour on that history', async () => {
    // A non-default picking rule shows that the switch keeps the strategy.
    const fresh = await openAt('#s=expand_popularity&v=tour&sc=1');
    try {
      const picker = fresh.locator('.tour-shopper select[aria-label="History"]');
      assert.equal(await fresh.locator('.tour-shopper > span').textContent(), 'History');
      await fresh.locator('.tour-pick').first().waitFor();
      assert.deepEqual(await picker.locator('option').allTextContents(), pair.seeds.map(row => row.label));
      assert.deepEqual(await picker.locator('option').evaluateAll(options => options.map(option => option.value)), pair.seeds.map(row => row.id));
      assert.equal(await picker.inputValue(), seed);
      await fresh.locator('.tour-pick').first().click();
      await fresh.getByText('Your guess', {exact:true}).waitFor();
      const other = pair.seeds.find(row => row.label === 'Tools & accessories, 8 purchases');
      const start = await state(pair.id, other.id);
      await picker.selectOption({label:other.label});
      await fresh.waitForFunction(id => location.hash.includes(`h=${id}&`), other.id);
      await fresh.locator('.tour-pick').first().waitFor();
      assert.equal(await fresh.locator('h1').textContent(), "One user's purchase history: 8 items from Amazon Beauty.");
      assert.deepEqual(await items(fresh.locator('.tour-photos li[data-item]')), start.history);
      assert.equal(start.history.length, 8);
      assert.ok((await items(fresh.locator('.tour-pick'))).includes(media.targets[other.id]));
      assert.equal(await fresh.getByText('Next purchase').count(), 0);
      assert.equal(await fresh.getByText('Your guess').count(), 0);
      assert.ok(await fresh.getByRole('button', {name:'Show the answer', exact:true}).isVisible());
      assert.equal(await picker.inputValue(), other.id);
      assert.equal(await fresh.locator('.tour').getAttribute('data-scene'), '1');
      assert.equal(await fresh.evaluate(() => location.hash), `#p=${pair.id}&h=${other.id}&s=expand_popularity&v=tour&sc=1`);
      await fresh.getByRole('button', {name:'Next', exact:true}).click();
      await scene(fresh, 2);
      assert.equal(await fresh.locator('h1').textContent(), 'SASRec and LETTER recommend from the same history.');
      assert.deepEqual(await items(fresh.getByTestId('tour-semantic-list').locator('li[data-item]')), ids(start.shelves.expand_popularity));
    } finally {await fresh.close();}
  });
  const current = () => page.locator('.tour-steps [aria-current="step"]').textContent();
  await check('stepper: five steps, Next and Back', async () => {
    assert.deepEqual(await page.locator('.tour-steps button').allTextContents(), steps);
    assert.equal(await current(), 'Shopper');
    assert.ok(await page.getByRole('button', {name:'Back', exact:true}).isDisabled());
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await scene(page, 2);
    assert.equal(await current(), 'Two recommenders');
    assert.equal(await page.getByText('Step 2 of 5', {exact:true}).count(), 1);
    assert.equal(await page.locator('.tour-steps li.is-reached').count(), 2);
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H1');
    assert.match(await page.evaluate(() => location.hash), /&v=tour&sc=2$/);
    await page.getByRole('button', {name:'Back', exact:true}).click();
    await scene(page, 1);
    assert.equal(await current(), 'Shopper');
  });
  await check('arrow keys and step dots move between scenes', async () => {
    await page.keyboard.press('ArrowRight');
    await scene(page, 2);
    await page.keyboard.press('ArrowLeft');
    await scene(page, 1);
    await page.locator('.tour-steps button', {hasText:'SID to item'}).click();
    await scene(page, 3);
    assert.equal(await current(), 'SID to item');
    await page.locator('.tour-steps button', {hasText:'Two recommenders'}).click();
    await scene(page, 2);
  });
  await check('scene 2: two lists of five, the next purchase on the SID side', async () => {
    assert.equal(await page.locator('h1').textContent(), 'SASRec and LETTER recommend from the same history.');
    assert.equal(await page.locator('.tour-reveal').textContent(), 'LETTER ranks the next purchase #1. SASRec does not have it in its top 5.');
    const left = page.getByTestId('tour-traditional-list'), right = page.getByTestId('tour-semantic-list');
    assert.deepEqual(await items(left.locator('li[data-item]')), ids(root.traditional));
    assert.deepEqual(await items(right.locator('li[data-item]')), ids(root.shelves.one_cosine));
    assert.equal(await right.getByText('Next purchase', {exact:true}).count(), 1);
    assert.equal(await right.locator('li.is-target').getAttribute('data-item'), String(target));
    assert.equal(await left.getByText('Next purchase').count(), 0);
    assert.deepEqual(await page.locator('.tour-column-head h2').allTextContents(), ['Sequential model', 'Generative SID model']);
    assert.deepEqual(await page.locator('.tour-column-head .model-name').allTextContents(), ['SASRec', 'LETTER']);
    assert.equal(await page.locator('.tour-takeaway').count(), 0);
  });
  const rule = 'Generates 5 Semantic IDs (SIDs), short token sequences computed from item text; several items can share one SID.';
  await check('scene 2: item ids for SASRec, SIDs for LETTER', async () => {
    const left = page.getByTestId('tour-traditional-list'), right = page.getByTestId('tour-semantic-list');
    assert.deepEqual(await left.locator('li[data-item] .tour-id').allTextContents(), root.traditional.map(card => `item ${card.item}`));
    assert.equal(await left.locator('.tour-code').count(), 0);
    assert.equal(await right.locator('.tour-id').count(), 0);
    assert.deepEqual(await right.locator('li[data-item] .tour-code').allTextContents(), root.shelves.one_cosine.map(card => card.address.join('·')));
    assert.deepEqual(await right.locator('.tour-code').evaluateAll(pills => pills.map(element => element.title)), root.shelves.one_cosine.map(card => card.address.join('·')));
    assert.equal(await right.locator('.tour-code').first().textContent(), '195·184·83·0');
    const rpg = await openAt('#p=sasrec-rpg&v=tour&sc=2');
    try {
      await scene(rpg, 2);
      const start = await state('sasrec-rpg', seed);
      assert.deepEqual(await rpg.locator('.tour-code').allTextContents(), Array(5).fill('32-part SID'));
      assert.deepEqual(await rpg.locator('.tour-code').evaluateAll(pills => pills.map(element => element.title)), start.shelves.one_cosine.map(card => card.address.join('·')));
      assert.deepEqual(await rpg.locator('.tour-id').allTextContents(), start.traditional.map(card => `item ${card.item}`));
      assert.equal(await rpg.locator('.tour-column-line').last().textContent(), 'Generates 5 Semantic IDs (SIDs), short token sequences computed from item text. Each of these SIDs belongs to one item.');
    } finally {await rpg.close();}
  });
  await check('scene 2: the SID model line does not change with the resolver', async () => {
    assert.deepEqual(await page.locator('.tour-column-line').allTextContents(), ['Scores all 12,068 items and shows the top 5.', rule]);
    const fill = await openAt('#s=expand_cosine&v=tour&sc=2');
    try {
      await scene(fill, 2);
      assert.equal(await fill.locator('.tour-column-line').last().textContent(), rule);
      const right = fill.getByTestId('tour-semantic-list');
      assert.deepEqual(await items(right.locator('li[data-item]')), ids(root.shelves.expand_cosine));
      assert.deepEqual(await right.locator('.tour-code').allTextContents(), Array(5).fill('195·184·83·0'));
    } finally {await fill.close();}
  });
  await check('scene 2: the result line for each history', async () => {
    // The six histories cover all four sentences: SID model only, sequential only, both and neither.
    const sentences = new Set();
    for (const entry of pair.seeds) {
      const start = await state(pair.id, entry.id), next = media.targets[entry.id];
      const [s, t] = [start.shelves.one_cosine, start.traditional].map(cards => ids(cards).indexOf(next) + 1);
      const expected = s && t ? `LETTER ranks the next purchase #${s}. SASRec ranks it #${t}.`
        : s ? `LETTER ranks the next purchase #${s}. SASRec does not have it in its top 5.`
        : t ? `SASRec ranks the next purchase #${t}. LETTER does not have it in its top 5.` : 'Neither model has the next purchase in its top 5.';
      sentences.add(expected.replace(/\d/g, 'n'));
      const view = await openAt(`#h=${entry.id}&v=tour&sc=2`);
      try {
        await scene(view, 2);
        assert.equal(await view.locator('.tour-reveal').textContent(), expected, entry.label);
      } finally {await view.close();}
    }
    assert.equal(sentences.size, 4);
  });
  await settle(page);
  await page.screenshot({path:figure('journeys-desktop.png'), fullPage:true, animations:'disabled'});
  const bert = await openAt('#p=bert-mlm-letter&v=tour&sc=2');
  try {
    await scene(bert, 2);
    await bert.getByTestId('tour-semantic-list').getByText('Next purchase', {exact:true}).waitFor();
    assert.deepEqual(await bert.locator('.tour-column-head .model-name').allTextContents(), ['BERT4Rec (MLM)', 'LETTER']);
    await settle(bert);
    await bert.screenshot({path:figure('journeys-desktop-bert-mlm.png'), fullPage:true, animations:'disabled'});
  } finally {await bert.close();}
  const bucket = root.buckets[0];
  // Items the current resolver takes from SID k (rows count from 1).
  const takes = (target, k) => items(target.locator('.s3-row').nth(k - 1).locator('.s3-pick'));
  const fromCode = (cards, k) => ids(cards.filter(card => card.sid_rank === k));
  const radio = (target, group, name) => target.getByRole('radiogroup', {name:group, exact:true}).getByRole('radio', {name, exact:true});
  // Step 3's opening for the default history; it stays put when the resolver changes.
  const opening = ["LETTER predicted the next purchase's SID, but 1,643 items share it.", "It is LETTER's #1 SID. Which item LETTER shows from each SID is decided by a resolver:"];
  const opened = async target => [await target.locator('h1').textContent(), await target.locator('.tour-body').textContent()];
  await check('scene 3: two resolver controls and five SID rows', async () => {
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await scene(page, 3);
    assert.deepEqual(await opened(page), opening);
    assert.deepEqual(await page.locator('.s3-controls .s3-control-label').allTextContents(), ['Items per SID', 'Order within a SID']);
    assert.deepEqual(await page.locator('.s3-control [role="radiogroup"]').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label'))), ['Items per SID', 'Order within a SID']);
    for (const [group, options] of [['Items per SID', ['One item per SID', 'All items per SID']], ['Order within a SID', ['Most similar', 'Most popular']]]) {
      assert.deepEqual(await page.getByRole('radiogroup', {name:group, exact:true}).locator('label').allTextContents(), options);
      assert.ok(await radio(page, group, options[0]).isChecked(), group);
    }
    assert.equal(await page.locator('.s3-controls p.s3-note').textContent(),
      'Most similar: cosine similarity between the item and the history. Most popular: purchases in the training data.');
    assert.deepEqual(await page.locator('ol.s3-rows > li.s3-row').evaluateAll(rows => rows.map(row => row.dataset.code)), root.buckets.map(row => row.address.join(',')));
    assert.deepEqual(await page.locator('.s3-row .s3-rank').allTextContents(), ['#1', '#2', '#3', '#4', '#5']);
    assert.deepEqual(await page.locator('.s3-row code.s3-pill').allTextContents(), root.buckets.map(row => row.address.join('·')));
    assert.deepEqual(await page.locator('.s3-row .s3-size').allTextContents(), root.buckets.map(row => count(row.size, 'item')));
    assert.equal(await page.locator('.s3-row .s3-size').first().textContent(), '1,643 items');
    assert.equal(bucket.size, 1643);
    for (const k of [1, 2, 3, 4, 5]) {
      assert.deepEqual(await takes(page, k), fromCode(root.shelves.one_cosine, k), `row ${k}`);
      assert.equal(fromCode(root.shelves.one_cosine, k).length, 1);
    }
    assert.equal(await page.locator('.s3-row.is-unused').count(), 0);
    assert.equal(await page.locator('.s3-pick.is-target').getAttribute('data-item'), String(target));
    assert.equal(await page.locator('.s3-rows').getByText('Next purchase', {exact:true}).count(), 1);
    assert.deepEqual(await page.locator('.s3-how-button').evaluateAll(buttons => buttons.map(button => `${button.textContent} ${button.getAttribute('aria-expanded')}`)), Array(5).fill('Show ranking false'));
    assert.equal(await page.locator('.s3-how').count(), 0);
    assert.equal(await page.locator('.tour-takeaway').count(), 0);
    assert.equal(await page.locator('.s3-scores').count(), 0);
  });
  await check('scene 3: Most popular swaps 695 and 2739 in row 1', async () => {
    assert.deepEqual([bucket.popularity[0].item, bucket.cosine[0].item], [695, 2739]);
    const first = item => page.waitForFunction(value => document.querySelector('.s3-row .s3-pick')?.dataset.item === value, item);
    await radio(page, 'Order within a SID', 'Most popular').check();
    await first('695');
    for (const k of [1, 2, 3, 4, 5]) assert.deepEqual(await takes(page, k), fromCode(root.shelves.one_popularity, k), `row ${k}`);
    assert.match(await page.evaluate(() => location.hash), /s=one_popularity/);
    assert.deepEqual(await opened(page), opening);
    assert.equal(await page.locator('.tour-takeaway').count(), 0);
    assert.equal(await page.locator('.s3-scores > p').textContent(), 'Cornac evaluates SID models at three levels (LETTER, Recall@5, 22,363 test users):');
    const metrics = (await json(pair.benchmark)).metrics;
    const scores = await page.locator('.s3-scores dd').allTextContents();
    assert.deepEqual(scores, ['0.196', '0.016', '0.004']);
    assert.deepEqual(scores, [metrics.sid, metrics.one_popularity, metrics.cce].map(row => row.recall.toFixed(3)));
    assert.deepEqual(await page.locator('.s3-scores dl > div .s3-score-label').allTextContents(), ['SID-level', 'Item-level', 'CCE']);
    assert.deepEqual(await page.locator('.s3-scores dl > div .s3-score-note').allTextContents(), ["next item's SID in the top 5 SIDs",
      'next item in the 5 items shown; depends on the resolver', 'each SID expanded into all its items in random order; expected item-level score']);
    for (const [key, item] of [['ArrowRight', '2739'], ['ArrowLeft', '695'], ['ArrowRight', '2739']]) {
      await page.keyboard.press(key);
      await first(item);
    }
    assert.equal(await page.locator('.tour').getAttribute('data-scene'), '3');
    assert.match(await page.evaluate(() => location.hash), /s=one_cosine/);
    // Correct item follows the rule on screen.
    assert.deepEqual(await page.locator('.s3-scores dd').allTextContents(), ['0.196', metrics.one_cosine.recall.toFixed(3), '0.004']);
  });
  await check('scene 3: All items per SID leaves rows 2-5 unused', async () => {
    assert.ok(root.shelves.expand_cosine.every(card => card.sid_rank === 1));
    await radio(page, 'Items per SID', 'All items per SID').check();
    await page.waitForFunction(() => document.querySelectorAll('.s3-row.is-unused').length === 4);
    assert.match(await page.evaluate(() => location.hash), /s=expand_cosine/);
    assert.deepEqual(await opened(page), opening);
    assert.deepEqual(await takes(page, 1), ids(root.shelves.expand_cosine));
    assert.deepEqual(await page.locator('.s3-row').evaluateAll(rows => rows.map(row => row.classList.contains('is-unused'))), [false, true, true, true, true]);
    for (const k of [2, 3, 4, 5]) assert.deepEqual(await takes(page, k), [], `row ${k}`);
    assert.deepEqual(await page.locator('.s3-row p.s3-unused').allTextContents(), Array(4).fill('Not used'));
    assert.equal(await page.locator('.s3-pick.is-target').getAttribute('data-item'), String(target));
    const metrics = (await json(pair.benchmark)).metrics;
    assert.equal(await page.locator('.s3-scores dd').nth(1).textContent(), metrics.expand_cosine.recall.toFixed(3));
    await radio(page, 'Items per SID', 'One item per SID').check();
    await page.waitForFunction(() => !document.querySelector('.s3-row.is-unused'));
    assert.match(await page.evaluate(() => location.hash), /s=one_cosine/);
  });
  await check('scene 3: Show ranking opens one SID at a time', async () => {
    const fresh = await openAt('#r=1&v=tour&sc=3');
    try {
      await scene(fresh, 3);
      const buttons = fresh.locator('.s3-row .s3-how-button'), panel = fresh.locator('.s3-how');
      const members = () => panel.locator('ol.s3-members > li[data-item]');
      const scores = () => members().locator('small').allTextContents();
      assert.equal(await fresh.locator('.s3-scores').count(), 0);
      await buttons.first().click();
      await panel.waitFor();
      assert.equal(await panel.count(), 1);
      assert.equal(await panel.getAttribute('id'), 's3-how-1');
      assert.equal(await fresh.locator('.s3-row').first().locator('.s3-how').count(), 1);
      assert.equal(await buttons.first().getAttribute('aria-controls'), 's3-how-1');
      assert.equal(bucket.cosine.length, 12);
      assert.deepEqual(await items(members()), ids(bucket.cosine));
      assert.deepEqual(await scores(), bucket.cosine.map(row => `similarity ${row.score.toFixed(3)}`));
      assert.deepEqual(await items(panel.locator('li.is-shown')), [bucket.cosine[0].item]);
      assert.equal(await panel.locator('p.s3-more').textContent(), '+ 1,631 more items');
      assert.equal(await panel.getByRole('heading', {name:'Categories in this SID', exact:true}).count(), 1);
      const rows = await panel.locator('.bucket-breakdown li').evaluateAll(lis => lis.map(li => [li.querySelector('span').textContent, Number(li.querySelector('strong').textContent.replace(/\D/g, ''))]));
      assert.deepEqual(rows, media.buckets[pair.sid][bucket.address.join(',')].categories);
      assert.equal(rows.length, 6);
      assert.equal(rows.reduce((sum, [, value]) => sum + value, 0), 1643);
      // Show ranking counts as the first action, so the scores and the line before them appear.
      assert.equal(await fresh.locator('.s3-scores > p').textContent(), 'Cornac evaluates SID models at three levels (LETTER, Recall@5, 22,363 test users):');
      await fresh.locator('.s3-scores dd').nth(2).waitFor();
      // The open panel follows the order within a SID.
      await radio(fresh, 'Order within a SID', 'Most popular').check();
      await fresh.waitForFunction(item => document.querySelector('.s3-members li')?.dataset.item === item, String(bucket.popularity[0].item));
      assert.deepEqual(await items(members()), ids(bucket.popularity));
      assert.deepEqual(await scores(), bucket.popularity.map(row => count(row.score, 'purchase')));
      assert.deepEqual(await items(panel.locator('li.is-shown')), [695]);
      await radio(fresh, 'Order within a SID', 'Most similar').check();
      const second = root.buckets[1];
      await buttons.nth(1).click();
      await fresh.locator('#s3-how-2').waitFor();
      assert.equal(await panel.count(), 1);
      assert.equal(await fresh.locator('#s3-how-1').count(), 0);
      assert.deepEqual(await buttons.evaluateAll(list => list.map(button => button.getAttribute('aria-expanded'))), ['false', 'true', 'false', 'false', 'false']);
      assert.deepEqual(await fresh.locator('.s3-row').evaluateAll(list => list.map(row => row.classList.contains('is-open'))), [false, true, false, false, false]);
      assert.deepEqual(await items(members()), ids(second.cosine));
      assert.deepEqual(await items(panel.locator('li.is-shown')), fromCode(root.shelves.one_cosine, 2));
      assert.equal(await panel.locator('p.s3-more').textContent(), `+ ${second.size - 12} more items`);
      await buttons.nth(1).click();
      await panel.waitFor({state:'detached'});
    } finally {await fresh.close();}
  });
  await check('scene 3 on RPG: each SID belongs to one item', async () => {
    const rpg = await openAt('#p=sasrec-rpg&v=tour&sc=3');
    try {
      await scene(rpg, 3);
      const row = manifest.pairs.find(entry => entry.id === 'sasrec-rpg');
      const start = await state(row.id, seed);
      assert.deepEqual(await opened(rpg), ['Each of these SIDs belongs to one item.', 'So the resolver does not change the list.']);
      assert.equal(await rpg.getByRole('radiogroup').count(), 0);
      assert.equal(await rpg.locator('.s3-controls').count(), 0);
      assert.deepEqual(await rpg.locator('.s3-row').evaluateAll(rows => rows.map(entry => entry.dataset.code)), start.buckets.map(entry => entry.address.join(',')));
      assert.deepEqual(await rpg.locator('.s3-row code.s3-pill').allTextContents(), Array(5).fill('32-part SID'));
      assert.deepEqual(await rpg.locator('.s3-row code.s3-pill').evaluateAll(pills => pills.map(element => element.title)), start.buckets.map(entry => entry.address.join('·')));
      assert.deepEqual(await rpg.locator('.s3-row .s3-size').allTextContents(), Array(5).fill('1 item'));
      for (const k of [1, 2, 3, 4, 5]) assert.deepEqual(await takes(rpg, k), fromCode(start.shelves.one_cosine, k), `row ${k}`);
      assert.equal(await rpg.locator('.s3-row.is-unused').count(), 0);
      assert.equal(await rpg.locator('.bucket-breakdown').count(), 0);
      await rpg.locator('.s3-scores dd').nth(2).waitFor();
      const metrics = (await json(row.benchmark)).metrics;
      assert.deepEqual(await rpg.locator('.s3-scores dd').allTextContents(), [metrics.sid, metrics.one_cosine, metrics.cce].map(entry => entry.recall.toFixed(3)));
      assert.equal(await rpg.locator('.tour-takeaway').count(), 0);
    } finally {await rpg.close();}
  });
  await check('scene 3: the opening follows the history, not the resolver', async () => {
    // The first card with the next purchase in any stored list gives its SID rank and size.
    function expected(row, start, history) {
      const next = media.targets[history];
      const body = `Which item ${row.sid} shows from each SID is decided by a resolver:`;
      const card = ['one_cosine', 'one_popularity', 'expand_cosine', 'expand_popularity'].map(key => start.shelves[key].find(entry => entry.item === next)).find(Boolean);
      if (card?.bucket_size > 1) return [`${row.sid} predicted the next purchase's SID, but ${card.bucket_size.toLocaleString()} items share it.`, `It is ${row.sid}'s #${card.sid_rank} SID. ${body}`];
      if (start.buckets[0].size > 1) return [`${row.sid}'s top SID is shared by ${count(start.buckets[0].size, 'item')}.`, body];
      return [`${row.sid}'s SIDs here are shared by up to ${count(Math.max(...start.buckets.map(entry => entry.size)), 'item')}.`, body];
    }
    const cases = [
      ['sasrec-letter', '72e96fcc60073db89607', ["LETTER predicted the next purchase's SID, but 2 items share it.", "It is LETTER's #4 SID. Which item LETTER shows from each SID is decided by a resolver:"]],
      ['sasrec-diffgrm', '72e96fcc60073db89607', ["DiffGRM predicted the next purchase's SID, but 2 items share it.", "It is DiffGRM's #5 SID. Which item DiffGRM shows from each SID is decided by a resolver:"]],
      ['sasrec-letter', '3dccf369bed6e951a10f', ["LETTER's top SID is shared by 1,643 items.", 'Which item LETTER shows from each SID is decided by a resolver:']],
    ];
    for (const [id, history, strings] of cases) {
      const row = manifest.pairs.find(entry => entry.id === id);
      const start = await state(id, history);
      assert.deepEqual(expected(row, start, history), strings, `${id} ${history}`);
      const view = await openAt(`#p=${id}&h=${history}&v=tour&sc=3`);
      try {
        await scene(view, 3);
        assert.deepEqual(await opened(view), strings, `${id} ${history}`);
        for (const [group, name] of [['Order within a SID', 'Most popular'], ['Items per SID', 'All items per SID'], ['Order within a SID', 'Most similar']]) {
          await radio(view, group, name).check();
          assert.deepEqual(await opened(view), strings, `${id} ${history} ${name}`);
        }
      } finally {await view.close();}
    }
    // DiffGRM misses the next purchase in step 2 under the default resolver; its SID is #5 and the top SID has one item.
    const diffgrm = await state('sasrec-diffgrm', cases[1][1]);
    assert.ok(!ids(diffgrm.shelves.one_cosine).includes(media.targets[cases[1][1]]));
    assert.equal(diffgrm.buckets[0].size, 1);
    assert.deepEqual(expected(pair, root, seed), opening);
  });
  await check('one name per item in steps 1-4', async () => {
    // History item 1294 and the next purchase 2739 share a short name, so both show their full titles everywhere in the tour.
    assert.equal(short(2739), short(1294));
    const want = {2739:'Real Techniques Fine Liner Brush', 1294:'Real Techniques Expert Face Brush'};
    assert.deepEqual([named(2739), named(1294)], [want[2739], want[1294]]);
    const view = await openAt('#v=tour&sc=1');
    const seen = [];
    const read = async (where, selector) => {
      const element = view.locator(selector).first();
      await element.waitFor();
      seen.push([where, Number(await element.evaluate(node => node.closest('[data-item]').dataset.item)), await element.textContent()]);
    };
    try {
      await view.locator('.tour-pick').first().waitFor();
      await read('step 1 history', '.tour-photos li[data-item="1294"] p');
      await read('step 1 card', '.tour-pick[data-item="2739"] .tour-pick-name');
      await view.getByRole('button', {name:'Show the answer', exact:true}).click();
      await view.getByRole('button', {name:'Next', exact:true}).click();
      await scene(view, 2);
      await read('step 2 list', '[data-testid="tour-semantic-list"] li[data-item="2739"] p');
      await view.getByRole('button', {name:'Next', exact:true}).click();
      await scene(view, 3);
      await read('step 3 row', '.s3-pick[data-item="2739"] p');
      await view.locator('.s3-how-button').first().click();
      await read('step 3 ranking', '.s3-members li[data-item="2739"] p');
      await view.getByRole('button', {name:'Next', exact:true}).click();
      await scene(view, 4);
      await read('step 4 preview', '[data-testid="sid-shelf"] article[data-item="2739"] h3');
      await view.getByRole('button', {name:'Choose items to add', exact:true}).click();
      await read('step 4 list', '[data-testid="sid-shelf"] article[data-item="2739"] h3');
      await read('step 4 strip', '.s4 .journey-timeline li[data-item="1294"] p');
      assert.deepEqual(seen.filter(([, item, text]) => text !== want[item]), []);
      assert.equal(seen.length, 8);
      // Explore keeps the short names.
      await view.getByRole('button', {name:'Skip tour', exact:true}).click();
      await at(view, 'Choice 1 of 2');
      assert.equal(await view.locator('.journey-timeline li[data-item="1294"] p').textContent(), short(1294));
    } finally {await view.close();}
  });
  let choiceMs;
  const [first] = ids(root.traditional);
  const next = await state(pair.id, root.next[String(first)]);
  const sids = await json('sids.json');
  const sidText = address => address.length > 8 ? `${address.length}-part SID` : address.join('·');
  // Two items with one SID: the manifest's probe on its history, otherwise the two lowest items of the first SID
  // (by rank) with at least two items on the root's lists that have next states.
  function samePair(row, history, start) {
    const probe = row.same_bucket_probe;
    if (probe?.seed === history) return {items:probe.items, address:probe.address};
    const cards = Object.values(start.shelves).flat().filter(card => start.next[String(card.item)]);
    for (const entry of start.buckets) {
      const found = [...new Set(cards.filter(card => card.address.join(',') === entry.address.join(',')).map(card => card.item))].sort((a, b) => a - b);
      if (found.length > 1) return {items:found.slice(0, 2), address:entry.address};
    }
    return null;
  }
  // The two input rows of step 4 as shown: aria-label, label, `{n} earlier`, then each cell as
  // [item, position, token, appended, SID cell, title].
  const inputs = target => target.evaluate(() => ['traditional', 'semantic'].map(side => {
    const row = document.querySelector(`.s4 .${side}-heading div.s4-input[role="group"]`);
    return [row.getAttribute('aria-label'), row.querySelector('p.s4-input-label').textContent, row.querySelector('ol.s4-seq > li.s4-more')?.textContent ?? null,
      [...row.querySelectorAll('ol.s4-seq > li.s4-entry')].map(cell => [Number(cell.dataset.item), cell.querySelector('small').textContent,
        cell.querySelector('span').textContent, cell.classList.contains('is-new'), cell.classList.contains('s4-sid'), cell.title])];
  }));
  // The same rows from the data: the last three positions of the history plus the added items; SIDs from sids.json.
  function expectedInputs(row, history, added) {
    const input = [...history, ...added], from = Math.max(0, input.length - 3), shown = input.slice(from);
    const sid = item => sids.sids[row.sid][String(item)];
    const cells = (token, isSid) => shown.map((item, i) => {
      const position = from + i + 1, isNew = position > history.length;
      return [item, isNew ? `${position} · added` : String(position), token(item), isNew, isSid, isSid ? sid(item).join('·') : ''];
    });
    const more = from ? `${from} earlier` : null;
    return [[`${row.traditional} reads item IDs: ${shown.join(', ')}`, `${row.traditional} reads item IDs`, more, cells(String, false)],
      [`${row.sid} reads SIDs: ${shown.map(item => sidText(sid(item))).join(', ')}`, `${row.sid} reads SIDs`, more, cells(item => sidText(sid(item)), true)]];
  }
  const sameLine = (row, [a, b], k, m) => `${m === 5 ? `After item ${a} or item ${b}, ${row.sid} reads the same input and predicts the same 5 SIDs.` : `${row.sid}'s two SID lists share ${m} of 5 SIDs.`} ${
    row.traditional} reads two different item IDs; ${k === 5 ? 'here its two top-5 lists happen to be the same.' : `its two top-5 lists share ${k} of 5 items.`}`;
  // Checks phase 1 of step 4 against the data, picking each item of the pair in turn; returns the pair and the overlaps.
  async function phaseOne(target, row, history) {
    const start = await state(row.id, history);
    assert.equal(await target.locator('.s4').getAttribute('data-phase'), '1');
    assert.equal(await target.locator('h1').textContent(), 'How each model reads the history');
    await target.locator('.s4 .semantic-heading div.s4-input').waitFor();
    assert.deepEqual(await inputs(target), expectedInputs(row, start.history, []));
    assert.deepEqual(await shelf(target, 'traditional-shelf'), ids(start.traditional));
    assert.deepEqual(await shelf(target, 'sid-shelf'), ids(start.shelves.one_cosine));
    assert.equal(await target.locator('.s4 .choose-product').count(), 0);
    assert.equal(await target.locator('.s4 .journey-timeline').count(), 0);
    assert.equal(await target.locator('.s4 > button.s4-go.primary').textContent(), 'Choose items to add');
    const same = samePair(row, history, start);
    if (!same) {
      assert.equal(await target.locator('p.s4-same-none').textContent(), `Each of the ${start.buckets.length} ${row.sid} SIDs here belongs to one item, so there are no two items with the same SID to compare.`);
      assert.equal(await target.getByTestId('same-sid-step').count(), 0);
      assert.equal(await target.locator('p.s4-same-line').count(), 0);
      return null;
    }
    const [a, b] = same.items, address = same.address.join('·');
    assert.deepEqual(same.items.map(item => sids.sids[row.sid][String(item)].join('·')), [address, address]);
    const step = target.getByTestId('same-sid-step');
    assert.equal(await step.locator('p#s4-same-intro').textContent(), `Items ${a} and ${b} have the same ${row.sid} SID. Pick one to see what each model reads and recommends.`);
    const picker = step.getByRole('radiogroup', {name:'Item to add', exact:true});
    assert.deepEqual(await items(picker.locator('label.s4-pick[data-item]')), [a, b]);
    assert.equal(await picker.locator('label.s4-pick.is-on').count(), 0);
    assert.equal(await picker.locator('input[type="radio"]:checked').count(), 0);
    const after = await Promise.all(same.items.map(item => state(row.id, start.next[String(item)])));
    // The root's pool plus the pair and both next states' lists, as in the app.
    const label = labeler(start, [a, b, ...after.flatMap(entry => ids([...entry.traditional, ...entry.shelves.one_cosine]))]);
    for (const item of [a, b]) {
      const card = picker.locator(`label.s4-pick[data-item="${item}"]`);
      assert.equal(await card.locator('p').textContent(), label(item));
      assert.equal(await card.locator('.tour-id').textContent(), `item ${item}`);
      assert.equal(await card.locator('code').textContent(), sidText(same.address));
    }
    assert.equal(await target.locator('p.s4-same-line').textContent(), '');
    const k = ids(after[0].traditional).filter(item => ids(after[1].traditional).includes(item)).length;
    const m = after[0].buckets.filter(entry => after[1].buckets.some(other => other.address.join(',') === entry.address.join(','))).length;
    for (const [i, item] of [a, b].entries()) {
      await picker.locator(`label.s4-pick[data-item="${item}"] input`).check();
      await target.waitForFunction(value => document.querySelector('.s4 .traditional-heading .s4-entry.is-new')?.dataset.item === value, String(item));
      await target.waitForFunction(() => document.querySelector('p.s4-same-line')?.textContent);
      assert.deepEqual(await items(picker.locator('label.s4-pick.is-on')), [item]);
      assert.deepEqual(await inputs(target), expectedInputs(row, start.history, [item]));
      assert.deepEqual(await shelf(target, 'traditional-shelf'), ids(after[i].traditional));
      assert.deepEqual(await shelf(target, 'sid-shelf'), ids(after[i].shelves.one_cosine));
      // Change pills against the history's own top 5; nothing is added.
      assert.equal(await target.getByTestId('traditional-shelf').locator('article.is-new').count(), shelfDiff(ids(start.traditional), ids(after[i].traditional)).newCount);
      assert.equal(await target.getByTestId('sid-shelf').locator('article.is-new').count(), shelfDiff(ids(start.shelves.one_cosine), ids(after[i].shelves.one_cosine)).newCount);
      assert.equal(await target.locator('p.s4-same-line').textContent(), sameLine(row, same.items, k, m));
      assert.equal(await target.locator('.s4 .choose-product').count(), 0);
    }
    return {items:same.items, common:k, both:m};
  }
  await check('scene 4: phase 1 previews two items with one SID', async () => {
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await scene(page, 4);
    const hash = await page.evaluate(() => location.hash);
    assert.deepEqual(await phaseOne(page, pair, seed), {items:[88, 610], common:0, both:5});
    assert.equal(await page.locator('p.s4-same-line').textContent(),
      'After item 88 or item 610, LETTER reads the same input and predicts the same 5 SIDs. SASRec reads two different item IDs; its two top-5 lists share 0 of 5 items.');
    assert.deepEqual((await inputs(page)).map(([label]) => label), ['SASRec reads item IDs: 1295, 667, 610', `LETTER reads SIDs: ${sidText(sids.sids.LETTER['1295'])}, ${sidText(sids.sids.LETTER['667'])}, 195·184·83·0`]);
    assert.equal(await page.evaluate(() => location.hash), hash);
    await page.getByRole('button', {name:'Choose items to add', exact:true}).click();
    await page.locator('.s4[data-phase="2"]').waitFor();
    assert.equal(await page.locator('h1').textContent(), 'Add an item to the history and compare the new top 5.');
    assert.equal(await page.getByTestId('same-sid-step').count(), 0);
    assert.equal(await page.locator('.s4 > button.s4-back').textContent(), 'How each model reads the history');
    assert.deepEqual(await inputs(page), expectedInputs(pair, root.history, []));
    assert.equal(await page.evaluate(() => location.hash), hash);
  });
  await check('scene 4: the two input rows line up', async () => {
    // Per column: the row's top, then each cell's offset from the row start, width and height.
    const cells = target => target.evaluate(() => ['traditional', 'semantic'].map(side => {
      const seq = document.querySelector(`.s4 .${side}-heading div.s4-input ol.s4-seq`), base = seq.getBoundingClientRect();
      return [Math.round(base.top), [...seq.children].map(cell => {const box = cell.getBoundingClientRect(); return [box.left - base.left, box.width, box.height];})];
    }));
    for (const width of [1440, 1000]) {
      const view = await openAt('#r=1&v=tour&sc=4', {viewport:{width, height:1000}});
      try {
        await scene(view, 4);
        await view.locator('.s4 .semantic-heading div.s4-input').waitFor();
        for (const added of [[], [88]]) {
          if (added.length) {
            await view.locator('label.s4-pick[data-item="88"] input').check();
            await view.waitForFunction(() => document.querySelector('.s4 .traditional-heading li.s4-entry.is-new')?.dataset.item === '88');
          }
          const where = `${width} px, ${added.length ? 'after the pick' : 'before a pick'}`;
          // The window shows the last three positions; a pick moves it by one and its cell comes last.
          const rows = await inputs(view);
          assert.deepEqual(rows, expectedInputs(pair, root.history, added), where);
          assert.deepEqual(rows[0][3].map(([item]) => item), [...root.history, ...added].slice(-3), where);
          assert.deepEqual(rows.map(row => row[3].map(cell => cell[3])), Array(2).fill(added.length ? [false, false, true] : [false, false, false]), where);
          assert.equal(rows[0][2], `${root.history.length + added.length - 3} earlier`, where);
          const [[topA, left], [topB, right]] = await cells(view);
          assert.equal(left.length, 4, where);
          assert.equal(right.length, left.length, where);
          assert.ok(Math.abs(topA - topB) <= 1, `${where}: rows at ${topA} and ${topB}`);
          left.forEach(([x, w, h], i) => {
            const [x2, w2, h2] = right[i];
            assert.ok(Math.abs(x - x2) <= 1 && Math.abs(w - w2) <= 1 && Math.abs(h - h2) <= 1, `${where}, cell ${i}: ${[x, w, h]} vs ${[x2, w2, h2]}`);
          });
          assert.ok(left.every(([, , h]) => Math.abs(h - left[0][2]) <= 1), `${where}: cell heights ${left.map(([, , h]) => h)}`);
        }
      } finally {await view.close();}
    }
  });
  await check('scene 4: cards show item IDs and SIDs; the SID opens its panel', async () => {
    assert.deepEqual(await page.locator('.s4-shelves article[data-item] .id-pill').allTextContents(), [...root.traditional, ...root.shelves.one_cosine].map(card => `item ${card.item}`));
    assert.equal(await page.getByTestId('traditional-shelf').locator('.sid-pill').count(), 0);
    const pills = page.getByTestId('sid-shelf').locator('button.sid-pill');
    assert.deepEqual(await pills.allTextContents(), root.shelves.one_cosine.map(card => sidText(card.address)));
    assert.deepEqual(await pills.evaluateAll(list => list.map(button => [button.title, button.getAttribute('aria-label')])), root.shelves.one_cosine.map(card => [card.address.join('·'), `SID ${card.address.join('·')}`]));
    assert.equal(await page.locator('.tour .bucket-link').count(), 0);
    await pills.first().click();
    const panel = page.locator('.s4-code');
    await panel.waitFor();
    assert.equal(await panel.locator('h2').textContent(), 'One SID, 1,643 items');
    assert.equal(await panel.locator('.s4-code-pill').textContent(), `SID ${bucket.address.join('·')}`);
    await panel.getByRole('button', {name:'Close', exact:true}).click();
    await panel.waitFor({state:'detached'});
    const rpg = await openAt('#p=sasrec-rpg&r=1&v=tour&sc=4');
    try {
      await scene(rpg, 4);
      const start = await state('sasrec-rpg', seed);
      assert.deepEqual(await rpg.getByTestId('sid-shelf').locator('button.sid-pill').allTextContents(), Array(5).fill('32-part SID'));
      assert.deepEqual(await rpg.getByTestId('sid-shelf').locator('button.sid-pill').evaluateAll(list => list.map(button => button.title)), start.shelves.one_cosine.map(card => card.address.join('·')));
    } finally {await rpg.close();}
  });
  await check('scene 4: every purchase shown, full names in card titles', async () => {
    assert.equal(await page.locator('.s4 .journey-timeline li[data-item]:not([hidden])').count(), root.history.length);
    assert.equal(await page.locator('.strip-toggle').count(), 0);
    assert.equal(await page.locator('details.full-name').count(), 0);
    assert.equal(await page.getByText('Full name').count(), 0);
    const titled = await page.locator('.s4-shelves article[data-item]').evaluateAll(cards => cards.map(card => [Number(card.dataset.item), card.title]));
    // Explore keeps the All/Last 6 toggle and the Full name expanders, which name the same items.
    const view = await openAt('#v=explore');
    try {
      await at(view, 'Choice 1 of 2');
      const shown = () => view.locator('.journey-timeline li[data-item]:not([hidden])').count();
      assert.equal(await shown(), 6);
      await view.getByRole('button', {name:`All ${root.history.length}`, exact:true}).click();
      assert.equal(await shown(), root.history.length);
      await view.getByRole('button', {name:'Last 6', exact:true}).click();
      assert.equal(await shown(), 6);
      assert.equal(await view.locator('article[data-item] details.full-name').count(), 10);
      assert.equal(await view.locator('article[data-item][title]').count(), 0);
      const named = await view.locator('article[data-item]').evaluateAll(cards => cards.map(card => [Number(card.dataset.item), card.querySelector('.full-name p').textContent]));
      assert.deepEqual(titled, named);
      assert.deepEqual(titled.map(([item]) => item), [...ids(root.traditional), ...ids(root.shelves.one_cosine)]);
    } finally {await view.close();}
  });
  await check('scene 4: repeated short names show the full title', async () => {
    const cards = await page.locator('.s4-shelves article[data-item]').evaluateAll(list => list.map(card => [Number(card.dataset.item), card.querySelector('h3').textContent]));
    for (const [item, name] of cards) assert.equal(name, named(item), String(item));
    assert.ok(cards.some(([item, name]) => item === 2739 && name === 'Real Techniques Fine Liner Brush'));
    assert.deepEqual(await page.locator('.s4 .journey-timeline li[data-item] p').allTextContents(), root.history.map(named));
  });
  await check('scene 4: the SID model stays on one item per SID, most similar', async () => {
    assert.equal(await page.locator('.semantic-heading .s4-rule').textContent(), 'Resolver: one item per SID, most similar.');
    assert.deepEqual(await page.locator('.s4-shelves .shelf-heading h3').allTextContents(), ['Sequential model', 'Generative SID model']);
    const fresh = await openAt('#r=1&v=tour&sc=3');
    try {
      await scene(fresh, 3);
      await radio(fresh, 'Items per SID', 'All items per SID').check();
      await radio(fresh, 'Order within a SID', 'Most popular').check();
      await fresh.waitForFunction(() => location.hash.includes('s=expand_popularity&'));
      await fresh.getByRole('button', {name:'Next', exact:true}).click();
      await scene(fresh, 4);
      await fresh.getByRole('button', {name:'Choose items to add', exact:true}).click();
      assert.equal(await fresh.locator('.semantic-heading .s4-rule').textContent(), 'Resolver: one item per SID, most similar.');
      assert.deepEqual(await shelf(fresh, 'sid-shelf'), ids(root.shelves.one_cosine));
      await choose(fresh, 'sid-shelf');
      await steered(fresh, 1);
      const after = await state(pair.id, root.next[String(root.shelves.one_cosine[0].item)]);
      assert.deepEqual(await shelf(fresh, 'sid-shelf'), ids(after.shelves.one_cosine));
      assert.equal(await fresh.getByTestId('sid-shelf').locator('article.is-new').count(), shelfDiff(ids(root.shelves.one_cosine), ids(after.shelves.one_cosine)).newCount);
      assert.match(await fresh.evaluate(() => location.hash), /s=expand_popularity&/);
    } finally {await fresh.close();}
  });
  // The step-4 result line, recounted: `{trad}: … items changed. {sid}: … SIDs.`
  const itemsPhrase = diff => diff.newCount === 5 ? 'all 5 items changed' : diff.newCount ? `${diff.newCount} of 5 items changed` : diff.movedCount ? 'same items, new order' : 'same 5 items';
  const sidsPhrase = codes => codes.same ? `same ${codes.total} SIDs` : codes.newCount ? count(codes.newCount, 'new SID') : 'same SIDs, new order';
  await check('scene 4: an Add loads the stored next state', async () => {
    assert.equal(await page.locator('h1').textContent(), 'Add an item to the history and compare the new top 5.');
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(root.traditional));
    assert.deepEqual(await shelf(page, 'sid-shelf'), ids(root.shelves.one_cosine));
    assert.equal(await page.locator('.journey-timeline li[data-item]:not([hidden])').count(), root.history.length);
    assert.ok(await page.getByRole('button', {name:'Undo', exact:true}).isDisabled());
    assert.deepEqual(await page.getByTestId('traditional-shelf').locator('.choose-product').allTextContents(), Array(5).fill('Add '));
    const titles = await page.getByTestId('traditional-shelf').locator('article[data-item]').evaluateAll(cards => cards.map(card => card.title));
    assert.deepEqual(await page.getByTestId('traditional-shelf').locator('.choose-product').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), titles.map(title => `Add ${title}`));
    const begin = performance.now();
    await choose(page, 'traditional-shelf');
    await page.locator('.s4-change').filter({hasText:/SID/}).waitFor();
    choiceMs = performance.now() - begin;
    await steered(page, 1);
    assert.deepEqual(await history(page), next.history);
    assert.equal(next.history.at(-1), first);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(next.traditional));
    assert.deepEqual(await shelf(page, 'sid-shelf'), ids(next.shelves.one_cosine));
    assert.equal(await page.locator('.journey-timeline li[data-item]').last().locator('small').textContent(), 'Yours');
    assert.match(await page.evaluate(() => location.hash), /[#&]t=[^&,]+&/);
    assert.deepEqual(await inputs(page), expectedInputs(pair, root.history, [first]));
  });
  await check('scene 4: the result line matches a recount', async () => {
    const left = shelfDiff(ids(root.traditional), ids(next.traditional));
    const right = shelfDiff(ids(root.shelves.one_cosine), ids(next.shelves.one_cosine));
    assert.equal(await page.locator('.s4-change').textContent(), `SASRec: ${itemsPhrase(left)}. LETTER: ${sidsPhrase(codesDiff(root, next))}.`);
    assert.equal(await page.getByTestId('traditional-shelf').locator('article.is-new').count(), left.newCount);
    assert.equal(await page.getByTestId('sid-shelf').locator('article.is-new').count(), right.newCount);
  });
  // Everything the journey shows in phase 2, to compare before and after a visit to phase 1.
  const journey = target => target.evaluate(() => ({hash:location.hash,
    history:[...document.querySelectorAll('.s4 .journey-timeline li[data-item]')].map(element => element.dataset.item),
    shelves:[...document.querySelectorAll('.s4-shelves article[data-item]')].map(element => `${element.dataset.item} ${element.className}`),
    inputs:[...document.querySelectorAll('.s4 div.s4-input')].map(element => `${element.getAttribute('aria-label')} | ${element.textContent}`),
    line:document.querySelector('.s4 .s4-bar p').textContent}));
  await check('scene 4: back to phase 1 and forward again keeps the journey', async () => {
    const before = await journey(page);
    assert.equal(before.history.length, root.history.length + 1);
    await page.locator('.s4 > button.s4-back').click();
    await page.locator('.s4[data-phase="1"]').waitFor();
    assert.equal(await page.locator('h1').textContent(), 'How each model reads the history');
    // Phase 1 keeps the earlier pick and previews it against the original history.
    const preview = await state(pair.id, root.next['610']);
    assert.deepEqual(await items(page.locator('label.s4-pick.is-on')), [610]);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(preview.traditional));
    assert.deepEqual(await inputs(page), expectedInputs(pair, root.history, [610]));
    assert.equal(await page.locator('.s4 .journey-timeline').count(), 0);
    assert.equal(await page.evaluate(() => location.hash), before.hash);
    await page.getByRole('button', {name:'Choose items to add', exact:true}).click();
    await page.locator('.s4[data-phase="2"]').waitFor();
    assert.deepEqual(await journey(page), before);
    assert.ok(await page.locator('.s4').evaluate(element => element.classList.contains('is-back')));
  });
  await check('scene 4: re-entering with a journey in progress opens phase 2', async () => {
    const before = await journey(page);
    await page.getByRole('button', {name:'Back', exact:true}).click();
    await scene(page, 3);
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await scene(page, 4);
    assert.equal(await page.locator('.s4').getAttribute('data-phase'), '2');
    assert.equal(await page.locator('h1').textContent(), 'Add an item to the history and compare the new top 5.');
    assert.deepEqual(await journey(page), before);
  });
  await check('scene 4: Undo goes back to the start', async () => {
    await page.getByRole('button', {name:'Undo', exact:true}).click();
    await steered(page, 0);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(root.traditional));
    assert.equal(await page.locator('.s4-change').textContent(), '');
  });
  const probe = pair.same_bucket_probe;
  const swapped = await state(pair.id, root.next[String(probe.items[1])]);
  await check('scene 4: two items with one SID for every LETTER and DiffGRM pair and history', async () => {
    // Pairs and the sequential model's overlap k per history (145, 210, 2574, 21060, 21667, 8564).
    const pairs = {LETTER:[[88, 610], [88, 610], [88, 610], [88, 610], [88, 610], [88, 168]],
      DiffGRM:[[1294, 2737], [1390, 1805], [1355, 3611], [5107, 5971], [788, 790], [3250, 4070]]};
    const overlaps = {'sasrec-letter':[0, 0, 0, 0, 0, 0], 'bert-mlm-letter':[1, 0, 2, 3, 1, 2], 'sasrec-diffgrm':[0, 0, 1, 3, 3, 1], 'bert-mlm-diffgrm':[5, 3, 3, 5, 3, 2]};
    assert.deepEqual(pair.seeds.map(row => row.query_index), [145, 210, 2574, 21060, 21667, 8564]);
    for (const [id, ks] of Object.entries(overlaps)) {
      const row = manifest.pairs.find(entry => entry.id === id);
      for (const [i, entry] of pair.seeds.entries()) {
        const view = await openAt(`#p=${id}&h=${entry.id}&v=tour&sc=4`);
        try {
          await scene(view, 4);
          assert.deepEqual(await phaseOne(view, row, entry.id), {items:pairs[row.sid][i], common:ks[i], both:5}, `${id} ${entry.label}`);
        } finally {await view.close();}
      }
    }
  });
  await check('scene 4: RPG and TIGER have no two items with one SID', async () => {
    for (const row of manifest.pairs.filter(entry => ['RPG', 'TIGER'].includes(entry.sid)))
      for (const entry of row.seeds) assert.equal(samePair(row, entry.id, await state(row.id, entry.id)), null, `${row.id} ${entry.label}`);
    for (const [id, history] of [['sasrec-rpg', seed], ['bert-mlm-tiger', pair.seeds[3].id]]) {
      const view = await openAt(`#p=${id}&h=${history}&v=tour&sc=4`);
      try {
        await scene(view, 4);
        assert.equal(await phaseOne(view, manifest.pairs.find(entry => entry.id === id), history), null);
        await view.getByRole('button', {name:'Choose items to add', exact:true}).click();
        await view.locator('.s4[data-phase="2"]').waitFor();
      } finally {await view.close();}
    }
  });
  const [second] = ids(next.shelves.one_cosine);
  const last = await state(pair.id, next.next[String(second)]);
  await check('scene 4: two Adds give the recap and ten final suggestions', async () => {
    await choose(page, 'traditional-shelf');
    await steered(page, 1);
    assert.deepEqual(await history(page), next.history);
    await choose(page, 'sid-shelf');
    await steered(page, 2);
    assert.deepEqual(await history(page), last.history);
    // A SASRec-list item, then a LETTER-list item, both marked as added; their SIDs come from sids.json.
    assert.ok(ids(next.shelves.one_cosine).includes(second) && !ids(next.traditional).includes(second));
    assert.deepEqual(await inputs(page), expectedInputs(pair, root.history, [first, second]));
    const [x, y] = [[root, next], [next, last]].map(([a, b]) => shelfDiff(ids(a.traditional), ids(b.traditional)).newCount);
    const [one, two] = [codesDiff(root, next), codesDiff(next, last)].map(sidsPhrase);
    // The recap names the two added items as the strip and the cards do.
    const names = [first, second].map(labeler(root, [...last.history, ...ids(last.traditional), ...ids(last.shelves.one_cosine)]));
    assert.deepEqual(await page.locator('.s4 .journey-timeline li[data-item] p').evaluateAll(list => list.slice(-2).map(entry => entry.textContent)), names);
    assert.equal(await page.locator('.s4-bar .tour-takeaway').textContent(),
      `Added ${names[0]}, then ${names[1]}. SASRec: ${x}, then ${y} of 5 items changed. LETTER: ${one === two ? `${one} both times` : `${one}, then ${two}`}.`);
    assert.equal(await page.getByRole('button', {name:/^Final suggestion: /}).count(), 10);
    assert.equal(await page.locator('.choose-product:not(:disabled)').count(), 0);
  });
  await check('scene 5: the paper listing and the eight-pair chart', async () => {
    assert.deepEqual(benchmarks, [`/journeys/${pair.benchmark}`]);
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await scene(page, 5);
    assert.equal(await page.locator('h1').textContent(), 'The Cornac experiment behind this demo');
    assert.equal(await page.locator('.s5-listing').textContent(), listing);
    assert.ok(listing.includes('metrics=[Recall(k=5), NDCG(k=5)]'));
    const chart = page.locator('.recall-chart svg');
    await chart.waitFor();
    // One path per bar: SASRec and BERT4Rec item recall, three bars for each of the four SID models, then DIGER.
    assert.equal(await chart.locator('path').count(), 2 + 4 * 3 + 3);
    assert.deepEqual([...benchmarks].sort(), manifest.pairs.map(row => `/journeys/${row.benchmark}`).sort());
    assert.deepEqual(await page.locator('.chart-legend li').allTextContents(), ['Item-level', 'SID-level', 'CCE', 'Resolver: One item per SID, most similar']);
    assert.deepEqual(await page.locator('ol.s5-notes > li[data-mark]').evaluateAll(notes => notes.map(note => [note.dataset.mark, note.lastChild.textContent])), [
      ['1', 'One train/validation/test split and one evaluation protocol for all models.'],
      ['2', 'Sequential models (SASRec, BERT4Rec) and SID models (TIGER, LETTER) in one list.'],
      ['3', 'Reports item-level, SID-level and CCE metrics from the same predictions.']]);
    assert.equal(await page.locator('.s5-points').count(), 0);
    assert.equal(await page.getByRole('button', {name:'Next', exact:true}).count(), 0);
    assert.equal(await page.getByRole('button', {name:'Skip tour'}).count(), 0);
  });
  // Viewport box of the first element matching `selector`.
  const box = (target, selector) => target.locator(selector).first().evaluate(element => {const {top, bottom, left, right, height} = element.getBoundingClientRect(); return {top, bottom, left, right, height};});
  await check('scene 5: listing and captions side by side, chart below at full width', async () => {
    const [listing, notes, grid, chart] = await Promise.all(['.s5-grid > .s5-listing', '.s5-grid > ol.s5-notes', '.s5-grid', 'div.s5-chart > figure.recall-chart'].map(selector => box(page, selector)));
    assert.ok(Math.abs(listing.top - notes.top) <= 1 && Math.abs(listing.height - notes.height) <= 1, JSON.stringify({listing, notes}));
    assert.ok(notes.left > listing.right);
    // The three captions spread over the listing's height.
    const [one, three] = await Promise.all(['ol.s5-notes > li[data-mark="1"]', 'ol.s5-notes > li[data-mark="3"]'].map(selector => box(page, selector)));
    assert.ok(Math.abs(one.top - notes.top) <= 2 && Math.abs(three.bottom - notes.bottom) <= 2, JSON.stringify({one, three, notes}));
    assert.ok(chart.top >= grid.bottom);
    assert.ok(Math.abs(chart.left - grid.left) <= 1 && Math.abs(chart.right - grid.right) <= 1, JSON.stringify({chart, grid}));
    const phone = await openAt('#v=tour&sc=5', {viewport:{width:390, height:844}});
    try {
      await scene(phone, 5);
      await phone.locator('div.s5-chart svg').waitFor();
      const [small, below, chartBelow] = await Promise.all(['.s5-grid > .s5-listing', '.s5-grid > ol.s5-notes', 'div.s5-chart > figure.recall-chart'].map(selector => box(phone, selector)));
      assert.ok(below.top >= small.bottom && chartBelow.top >= below.bottom);
    } finally {await phone.close();}
  });
  const extra = (await json('extra-benchmarks.json')).models;
  // Row names with their value labels, top to bottom.
  const chartRows = target => target.locator('.recall-chart text.chart-label').evaluateAll(labels => labels.map(label =>
    [label.textContent, [...label.parentElement.querySelectorAll('.chart-value')].map(value => value.textContent)]));
  await check('scene 5: the chart ends with a DIGER row', async () => {
    assert.ok(requests.some(request => new URL(request).pathname === '/journeys/extra-benchmarks.json'));
    assert.deepEqual(extra.map(row => row.name), ['DIGER']);
    const rows = await chartRows(page);
    const names = [...new Set(manifest.pairs.map(row => row.traditional)), ...new Set(manifest.pairs.map(row => row.sid)), 'DIGER'];
    assert.deepEqual(rows.map(([name]) => name), names);
    const {metrics} = extra[0];
    assert.deepEqual(rows.at(-1)[1], [metrics.item, metrics.sid, metrics.cce].map(row => row.recall.toFixed(3)));
    assert.deepEqual(rows.at(-1)[1], ['0.042', '0.042', '0.042']);
  });
  await check('scene 5: how each SID model handles collisions', async () => {
    const block = page.locator('section.s5-block.s5-collisions');
    assert.equal(await block.locator('h2#s5-collisions-heading').textContent(), 'How each SID model handles collisions (items that share a SID)');
    assert.deepEqual(await block.locator('ul > li').allTextContents(), [
      'TIGER and DIGER give every item its own SID: when items share the first three tokens, a fourth token tells them apart, so the three scores are equal. In TIGER here, 1,617 items share their first three tokens with another item (722 groups, at most 8 items each).',
      'RPG uses long SIDs (32 tokens here) and no suffix: 71 of 12,068 items share a SID (at most 4 per SID), so its three scores differ by less than 0.001.',
      'LETTER reassigns the last token of colliding items (up to 20 passes) but keeps the collisions that remain: 3,421 items share 570 SIDs, one SID covers 1,643 items.',
      'DiffGRM keeps collisions: 3,629 items share 1,157 SIDs, at most 38 per SID.']);
    // The block sits under the chart.
    const [chart, notes] = await Promise.all(['div.s5-chart', 'section.s5-collisions'].map(selector => box(page, selector)));
    assert.ok(notes.top >= chart.bottom);
  });
  await check('scene 5: a caption lights up its part of the listing', async () => {
    const mark = n => page.locator(`.s5-mark[data-mark="${n}"]`);
    const block = (first, last) => {const from = listing.indexOf(first); return listing.slice(from, listing.indexOf(last, from) + last.length);};
    assert.equal((await mark(1).textContent()).trimEnd(), block('eval_method = ', '\n)'));
    assert.equal((await mark(2).textContent()).trimEnd(), block('models = [', '\n]'));
    assert.equal(await mark(3).textContent(), 'semantic_id_metrics=True');
    assert.equal(await page.locator('.s5-listing .s5-number').count(), 3);
    // Marks, captions and code numbers that are active, and whether the rest is dimmed.
    const lit = () => page.evaluate(() => ({
      marks:[...document.querySelectorAll('.s5-mark.is-active')].map(element => element.dataset.mark),
      notes:[...document.querySelectorAll('.s5-notes li.is-active')].map(element => element.dataset.mark),
      numbers:[...document.querySelectorAll('.s5-number.is-active')].map(element => element.dataset.number),
      dimmed:['.s5-listing', '.s5-notes'].map(selector => document.querySelector(selector).classList.contains('has-active'))}));
    const none = {marks:[], notes:[], numbers:[], dimmed:[false, false]};
    const only = n => ({marks:[n], notes:[n], numbers:[n], dimmed:[true, true]});
    await page.mouse.move(0, 0);
    assert.deepEqual(await lit(), none);
    await page.locator('ol.s5-notes > li[data-mark="2"]').hover();
    assert.deepEqual(await lit(), only('2'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.s5-notes li[data-mark="1"]')).opacity === '0.5');
    await page.mouse.move(0, 0);
    assert.deepEqual(await lit(), none);
    await page.locator('ol.s5-notes > li[data-mark="3"]').focus();
    assert.deepEqual(await lit(), only('3'));
    await page.evaluate(() => document.activeElement.blur());
    assert.deepEqual(await lit(), none);
    await page.locator('.s5-number[data-number="1"]').hover();
    assert.deepEqual(await lit(), only('1'));
    await page.mouse.move(0, 0);
    assert.deepEqual(await lit(), none);
  });
  await check('scene 5: Install Cornac copies the install line and links the repository', async () => {
    const get = page.locator('section.s5-get');
    assert.equal(await get.locator('h2').textContent(), 'Install Cornac');
    assert.equal(await get.locator('code.s5-pip').textContent(), 'pip install cornac');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin:new URL(url).origin});
    await get.getByRole('button', {name:'Copy', exact:true}).click();
    await get.getByRole('button', {name:'Copied', exact:true}).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'pip install cornac');
    assert.equal(await get.locator('a.s5-repo').textContent(), 'github.com/PreferredAI/cornac');
    assert.equal(await get.locator('a.s5-repo').getAttribute('href'), 'https://github.com/PreferredAI/cornac');
    await get.locator('.s5-qr svg').waitFor();
    assert.equal(await get.locator('.s5-qr').getAttribute('aria-label'), 'QR code for the Cornac repository on GitHub');
  });
  const action = name => page.locator(`section.s5-more button[data-action="${name}"]`);
  await check('scene 5: two buttons, no Share', async () => {
    assert.equal(await page.locator('section.s5-more h2').count(), 0);
    assert.deepEqual(await page.locator('section.s5-more button[data-action]').evaluateAll(buttons => buttons.map(button =>
      [button.dataset.action, button.textContent, document.getElementById(button.getAttribute('aria-describedby')).textContent])), [
      ['explore', 'Open the full workbench', 'All 8 model pairs, 6 histories and 4 resolvers, with save and replay.'],
      ['restart', 'Start over', 'Back to step 1.']]);
    assert.equal(await page.getByRole('button', {name:/Share/}).count(), 0);
  });
  const bare = new URL('/', url).href;
  await check('Open the full workbench, then Start over', async () => {
    await action('explore').click();
    await at(page, 'Journey complete');
    assert.equal(await page.locator('.tour').count(), 0);
    assert.match(await page.evaluate(() => location.hash), /&v=explore$/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'recommendations-heading');
    assert.equal(await page.getByRole('button', {name:/^Final suggestion: /}).count(), 10);
    assert.equal(await page.locator('.journey-recap').getByRole('button', {name:'Restart journey', exact:true}).count(), 1);
    const [x, y] = [[root, next], [next, last]].map(([a, b]) => shelfDiff(ids(a.traditional), ids(b.traditional)).newCount);
    const codes = [codesDiff(root, next), codesDiff(next, last)];
    assert.deepEqual(await page.locator('.journey-recap p').allTextContents(), [`Added ${short(first)}, then ${short(second)}.`,
      `SASRec: ${x}, then ${y} of 5 items changed.`, `LETTER: ${codes.every(entry => entry.same) ? 'same 5 SIDs both times' : codes.map(sidsPhrase).join(', then ')}.`,
      'Before you added items, LETTER ranked the next purchase #1.']);
    // Share moved off step 5; explore keeps it.
    await page.getByRole('button', {name:'Share', exact:true}).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.share-qr svg').waitFor();
    const link = await page.evaluate(() => location.href);
    assert.match(link, /#p=sasrec-letter&h=\w+&s=one_cosine&t=\w+,\w+&r=1&v=explore$/);
    assert.equal(await dialog.locator('input[readonly]').inputValue(), link);
    assert.ok(await dialog.getByRole('button', {name:'Copy link', exact:true}).isVisible());
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'detached'});
    await page.getByRole('button', {name:'Back to the tour', exact:true}).click();
    await scene(page, 5);
    await Promise.all([page.waitForEvent('load'), action('restart').click()]);
    await scene(page, 1);
    assert.equal(await page.evaluate(() => location.href), bare);
    await page.getByRole('button', {name:'Show the answer', exact:true}).waitFor();
    assert.equal(await page.getByText('Next purchase').count(), 0);
  });
  await check('index.html: title, description and link preview', async () => {
    const head = await page.evaluate(() => ({title:document.querySelector('head > title').textContent, document:document.title,
      meta:Object.fromEntries([...document.querySelectorAll('meta[name], meta[property]')].map(element => [element.getAttribute('name') || element.getAttribute('property'), element.content]))}));
    assert.deepEqual([head.title, head.document], ['Cornac Workbench', 'Cornac Workbench']);
    const site = 'https://cornac-workbench.preferred.ai/';
    assert.equal(head.meta.description, 'Compare a sequential recommender (SASRec or BERT4Rec) with a generative Semantic ID (SID) recommender (LETTER, TIGER, RPG or DiffGRM) on real Amazon Beauty purchase histories, with item-level, SID-level and CCE metrics from Cornac.');
    for (const [key, value] of [['og:site_name', 'Cornac Workbench'], ['og:title', 'Cornac Workbench'], ['og:url', site], ['og:image', `${site}og.png`],
      ['og:image:width', '1200'], ['og:image:height', '630'], ['twitter:card', 'summary_large_image'],
      ['og:description', "One user's purchase history, a sequential model and a generative SID model, and the Cornac experiment behind them."]]) assert.equal(head.meta[key], value, key);
    assert.ok(head.meta['og:image:alt']);
    // The preview image itself ships with the site at the size the tags give.
    const bytes = Buffer.from(await (await fetch(new URL('og.png', url))).arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [1200, 630]);
  });
  await check('branding: PreferredAI favicon, touch icon and header mark', async () => {
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map(link => [link.rel, link.getAttribute('href'), link.type])),
      [['icon', '/favicon.png', 'image/png'], ['apple-touch-icon', '/apple-touch-icon.png', '']]);
    for (const [file, size] of [['favicon.png', 512], ['apple-touch-icon.png', 180], ['brand-mark.png', 64]]) {
      const response = await fetch(new URL(file, url));
      assert.equal(response.status, 200, file);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file);
      assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [size, size], file);
    }
    const mark = page.locator('header.app-header img.brand-mark');
    await page.waitForFunction(() => document.querySelector('header.app-header img.brand-mark')?.complete);
    assert.deepEqual(await mark.evaluate(image => [new URL(image.src).pathname, image.naturalWidth, image.alt]), ['/brand-mark.png', 64, '']);
    assert.equal(await page.locator('header.app-header svg.brand-mark').count(), 0);
  });
  await check('header: Cornac Workbench and Start over reload the bare page', async () => {
    const other = pair.seeds[3].id;
    const fresh = await openAt(`#p=bert-mlm-letter&h=${other}&s=expand_cosine&r=1&v=tour&sc=3`);
    try {
      await scene(fresh, 3);
      const header = fresh.locator('header.app-header');
      const brand = header.locator('a.brand-home');
      assert.equal(await brand.textContent(), 'Cornac Workbench');
      assert.equal(await brand.getAttribute('href'), '/');
      await Promise.all([fresh.waitForEvent('load'), header.getByRole('button', {name:'Start over', exact:true}).click()]);
      await scene(fresh, 1);
      assert.equal(await fresh.evaluate(() => location.href), bare);
      assert.equal(await fresh.locator('h1').textContent(), `One user's purchase history: ${root.history.length} items from Amazon Beauty.`);
      assert.deepEqual(await items(fresh.locator('.tour-photos li[data-item]')), root.history);
      await fresh.getByRole('button', {name:'Skip tour', exact:true}).click();
      await at(fresh, 'Choice 1 of 2');
      assert.match(await fresh.evaluate(() => location.hash), new RegExp(`^#p=sasrec-letter&h=${seed}&s=one_cosine&v=explore$`));
      assert.equal(await header.getByRole('button', {name:'Start over', exact:true}).count(), 1);
      await Promise.all([fresh.waitForEvent('load'), brand.click()]);
      await scene(fresh, 1);
      assert.equal(await fresh.evaluate(() => location.href), bare);
    } finally {await fresh.close();}
    const kiosk = await openAt('#k=1&p=bert-mlm-letter&v=tour&sc=2', {init:() => {window.__kioskIdleMs = 60000;}});
    try {
      await scene(kiosk, 2);
      await Promise.all([kiosk.waitForEvent('load'), kiosk.locator('header.app-header').getByRole('button', {name:'Start over', exact:true}).click()]);
      await scene(kiosk, 1);
      assert.equal(await kiosk.evaluate(() => location.href), new URL('/#k=1', url).href);
    } finally {await kiosk.close();}
  });
  await check('footnote: pre-computed from step 4 on and in explore', async () => {
    const fresh = await openAt('#v=tour&sc=1');
    try {
      const footnote = () => fresh.locator('.journey-footnote').textContent();
      const plain = 'Purchase histories from Amazon Beauty (2014).', long = `${plain} Recommendations were pre-computed.`;
      for (const n of [1, 2, 3, 4, 5]) {
        if (n > 1) await fresh.getByRole('button', {name:'Next', exact:true}).click();
        await scene(fresh, n);
        assert.equal(await footnote(), n <= 3 ? plain : long, `step ${n}`);
      }
      await fresh.locator('section.s5-more button[data-action="explore"]').click();
      await at(fresh, 'Choice 1 of 2');
      assert.equal(await footnote(), long);
    } finally {await fresh.close();}
  });
  await check('Skip tour opens explore; Back to the tour returns', async () => {
    await page.getByRole('button', {name:'Skip tour', exact:true}).click();
    await at(page, 'Choice 1 of 2');
    assert.match(await page.evaluate(() => location.hash), /&v=explore$/);
    assert.equal(await page.getByTestId('sid-shelf').locator('article.is-target').getAttribute('data-item'), String(target));
    assert.equal(await page.locator('.journey-question').textContent(), `Purchase history: ${root.history.length} items. Which item did this user buy next?`);
    assert.equal(await page.locator('.reveal-line').textContent(), 'LETTER ranks the next purchase #1. SASRec does not have it in its top 5.');
    assert.equal(await page.locator('#recommendations-heading').textContent(), 'Add an item to the history and compare the new top 5.');
    assert.deepEqual(await page.locator('.shelf-heading h3').allTextContents(), ['Sequential model', 'Generative SID model']);
    await page.getByRole('button', {name:'Back to the tour', exact:true}).click();
    await scene(page, 1);
    assert.match(await page.evaluate(() => location.hash), /&v=tour&sc=1$/);
  });
  await check('hash v=tour&sc=N round trip', async () => {
    const fresh = await openAt('#v=tour&sc=2');
    try {
      await scene(fresh, 2);
      await fresh.getByRole('button', {name:'Next', exact:true}).click();
      await scene(fresh, 3);
      const hash = await fresh.evaluate(() => location.hash);
      assert.equal(hash, `#p=sasrec-letter&h=${seed}&s=one_cosine&r=1&v=tour&sc=3`);
      await fresh.reload();
      await scene(fresh, 3);
      assert.equal(await fresh.evaluate(() => location.hash), hash);
    } finally {await fresh.close();}
  });
  await page.getByRole('button', {name:'Skip tour', exact:true}).click();
  await at(page, 'Choice 1 of 2');
  const model = side => page.locator(`.${side}-heading .model-name`).textContent();
  // Re-selecting the current pair may not fire a change, so Restart stands in for it.
  async function pick(row) {
    if (await page.getByLabel('Model pair').inputValue() === row.id) await page.getByRole('button', {name:'Restart', exact:true}).click();
    else await page.getByLabel('Model pair').selectOption(row.id);
    await page.waitForFunction(name => document.querySelector('.semantic-heading .model-name')?.textContent === name, row.sid);
    await at(page, 'Choice 1 of 2');
  }
  await check('explore: eight pairs load with the policy menu', async () => {
    assert.equal(manifest.pairs.length, 8);
    for (const row of manifest.pairs) {
      await pick(row);
      const start = await state(row.id, row.seeds[0].id);
      assert.equal(await model('traditional'), row.traditional);
      assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(start.traditional));
      assert.deepEqual(await shelf(page, 'sid-shelf'), ids(start.shelves.one_cosine));
      const single = start.buckets.every(entry => entry.size === 1);
      assert.equal(await page.getByLabel('SID to item strategy').count(), single ? 0 : 1, row.id);
      assert.equal(await page.getByText('One item per SID', {exact:true}).count(), single ? 1 : 0, row.id);
    }
    await pick(pair);
    assert.deepEqual(await page.getByLabel('SID to item strategy').locator('option').allTextContents(),
      ['One item per SID, most popular', 'One item per SID, most similar', 'All items per SID, most popular', 'All items per SID, most similar']);
    for (const policy of manifest.strategies) {
      await page.getByLabel('SID to item strategy').selectOption(policy);
      assert.deepEqual(await shelf(page, 'sid-shelf'), ids(root.shelves[policy]));
      assert.deepEqual(await history(page), root.history);
    }
    await page.getByLabel('SID to item strategy').selectOption('one_cosine');
  });
  await check('explore: bucket Inspector', async () => {
    // Explore cards keep the SID link and show no item ID or SID pills.
    assert.deepEqual(await page.getByTestId('sid-shelf').locator('.bucket-link').allTextContents(), root.shelves.one_cosine.map(card => `SID #${card.sid_rank} · ${count(card.bucket_size, 'item')} ↗`));
    assert.equal(await page.locator('.journey-recommendations .id-pill, .journey-recommendations .sid-pill').count(), 0);
    await page.getByTestId('sid-shelf').locator('.bucket-link').first().click();
    await page.getByRole('heading', {name:'One SID, 1,643 items', exact:true}).waitFor();
    assert.equal(await page.locator('.journey-inspector .sid-code').textContent(), `SID ${bucket.address.join('·')}`);
    assert.equal(await page.locator('.journey-inspector .bucket-breakdown h3').textContent(), 'Categories in this SID');
    const counts = await page.locator('.journey-inspector .bucket-breakdown li strong').allTextContents();
    assert.equal(counts.reduce((sum, text) => sum + Number(text.replace(/\D/g, '')), 0), 1643);
    assert.deepEqual(await page.locator('.bucket-columns h3').allTextContents(), ['Most popular', 'Most similar']);
    assert.ok(await page.locator('.bucket-columns li').count() > 2);
    await page.getByRole('button', {name:'Close bucket inspector'}).click();
    assert.equal(await page.locator('.journey-inspector').count(), 0);
  });
  await check('explore: two items that share a SID', async () => {
    const step = page.getByTestId('same-sid-step');
    assert.equal(await step.locator('h2').textContent(), 'Two items, one SID');
    assert.equal(await step.locator('.code-pill').textContent(), `SID ${probe.address.join('·')} · 1,643 items`);
    assert.equal(await step.locator('p').textContent(), "Add either one. LETTER predicts the same 5 SIDs after either item; SASRec's top 5 differs between them.");
    await step.getByRole('button', {name:`Add ${short(probe.items[0])}`, exact:true}).click();
    await at(page, 'Choice 2 of 2');
    const picked = await state(pair.id, root.next[String(probe.items[0])]);
    assert.equal((await history(page)).at(-1), probe.items[0]);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(picked.traditional));
    await step.getByRole('button', {name:`Add ${short(probe.items[1])} instead`, exact:true}).click();
    await page.waitForFunction(item => document.querySelector('.journey-timeline li:last-child')?.dataset.item === item, String(probe.items[1]));
    await at(page, 'Choice 2 of 2');
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(swapped.traditional));
    assert.notDeepEqual(ids(swapped.traditional), ids(picked.traditional));
    assert.ok(codesDiff(picked, swapped).same);
    const result = `SASRec: ${itemsPhrase(shelfDiff(ids(root.traditional), ids(swapped.traditional)))}. LETTER: ${sidsPhrase(codesDiff(root, swapped))}.`;
    assert.equal(await step.locator('p').textContent(), result);
    assert.equal(await page.locator('.change-line > p').textContent(), result);
    await page.getByRole('button', {name:'Restart', exact:true}).click();
    await at(page, 'Choice 1 of 2');
  });
  await check('explore: Save and Replay; a tampered file is rejected', async () => {
    await choose(page, 'traditional-shelf');
    await at(page, 'Choice 2 of 2');
    const saved = await history(page);
    const waiting = page.waitForEvent('download'); await page.getByRole('button', {name:'Save journey', exact:true}).click();
    const download = await waiting; const file = path.join(output, download.suggestedFilename()); await download.saveAs(file);
    await page.getByRole('button', {name:'Restart', exact:true}).click();
    await at(page, 'Choice 1 of 2');
    await page.getByLabel('Journey replay file').setInputFiles(file);
    await page.getByRole('status').filter({hasText:/Journey restored/}).waitFor();
    await at(page, 'Choice 2 of 2');
    assert.deepEqual(await history(page), saved);
    const corrupted = JSON.parse(await readFile(file, 'utf8')); corrupted.history[0] = -1;
    const bad = path.join(output, 'tampered.json'); await writeFile(bad, JSON.stringify(corrupted));
    await page.getByLabel('Journey replay file').setInputFiles(bad);
    await page.getByRole('alert').filter({hasText:/Replay failed/}).waitFor();
    await page.getByLabel('Journey replay file').setInputFiles(file);
    await page.getByRole('alert').waitFor({state:'detached'});
    await page.getByRole('status').filter({hasText:/Journey restored/}).waitFor();
    assert.deepEqual(await history(page), saved);
  });
  await check('explore: Details shows the chart and the table', async () => {
    const toggle = page.getByRole('button', {name:'Details', exact:true});
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.journey-metrics').count(), 0);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    await page.getByRole('rowheader', {name:'LETTER · SID', exact:true}).waitFor();
    assert.ok(await page.locator('.journey-metrics').isVisible());
    await page.locator('.recall-chart svg').waitFor();
    assert.deepEqual(await page.locator('.chart-legend li').allTextContents(), ['Item', 'SID', 'CCE', 'SID models: One per SID · History cosine']);
    // DIGER appears on step 5 only.
    const rows = await chartRows(page);
    assert.equal(rows.length, 6);
    assert.ok(rows.every(([name]) => name !== 'DIGER'));
    assert.equal(await page.locator('.recall-chart svg path').count(), 2 + 4 * 3);
  });
  await check('every pair lists the same six histories', async () => {
    const seeds = pair.seeds.map(row => row.id);
    assert.equal(seeds.length, 6);
    assert.deepEqual(pair.seeds.slice(0, 2).map(row => row.query_index), [145, 210]);
    for (const row of manifest.pairs) {
      assert.deepEqual(row.seeds.map(entry => entry.id), seeds, `${row.id} lists other histories`);
      await pick(row);
      assert.deepEqual(await page.getByLabel('Starting history').locator('option').evaluateAll(options => options.map(option => option.value)), seeds, row.id);
    }
  });
  await check('sids.json gives every item in the SID model states its SID', async () => {
    const models = ['DiffGRM', 'LETTER', 'RPG', 'TIGER'];
    assert.deepEqual(Object.keys(sids.sids).sort(), models);
    assert.deepEqual(Object.keys(sids.source).sort(), models);
    for (const row of Object.values(sids.source)) assert.ok(row.file.endsWith('/sid_catalog.npz') && /^[0-9a-f]{64}$/.test(row.sha256));
    const missing = [], differ = [];
    for (const row of manifest.pairs) {
      const table = sids.sids[row.sid], folder = new URL(`../public/journeys/${row.id}/states/`, import.meta.url);
      const files = await readdir(folder);
      assert.equal(files.length, row.state_count, row.id);
      for (const file of files) {
        const node = JSON.parse(await readFile(new URL(file, folder), 'utf8'));
        const members = node.buckets.flatMap(entry => [...entry.cosine, ...entry.popularity].map(member => [member.item, entry.address]));
        const cards = Object.values(node.shelves).flat().map(card => [card.item, card.address]);
        for (const item of [...node.history, ...ids(node.traditional), ...Object.keys(node.next).map(Number), ...cards.map(([item]) => item), ...members.map(([item]) => item)])
          if (!table[String(item)]) missing.push(`${row.id} ${file} ${item}`);
        // Shelf cards and SID members carry the same SID as the table.
        for (const [item, address] of [...cards, ...members]) if (table[String(item)] && table[String(item)].join(',') !== address.join(',')) differ.push(`${row.id} ${file} ${item}`);
      }
    }
    assert.deepEqual(missing.slice(0, 5), []);
    assert.deepEqual(differ.slice(0, 5), []);
  });
  await check('catalog covers every shown item', async () => {
    // A missing catalog entry shows as `Item <index>`; product names, full names, strip captions and titles are checked.
    const names = () => page.evaluate(() => [
      ...[...document.querySelectorAll('article[data-item] h3, article[data-item] .full-name p:first-of-type, .journey-timeline li[data-item] p')].map(element => element.textContent),
      ...[...document.querySelectorAll('[data-item][title]')].map(element => element.title)]);
    for (const row of manifest.pairs) {
      await pick(row);
      for (const entry of row.seeds) {
        await page.getByLabel('Starting history').selectOption(entry.id);
        await at(page, 'Choice 1 of 2');
        const shown = await names();
        assert.ok(shown.length >= 30);
        assert.deepEqual(shown.filter(text => text.startsWith('Item ')), [], `${row.id} ${entry.id}`);
      }
    }
  });
  await check('kiosk captions play scenes 1-3 and stop on input', async () => {
    // The idle timer reads window.__kioskIdleMs when it (re)starts and keeps a preset value, so set it before load.
    const kiosk = await openAt('#k=1', {init:() => {window.__kioskIdleMs = 1000;}});
    try {
      const caption = kiosk.locator('.kiosk-caption');
      // The caption shows a frame before its scene change, so both are awaited together.
      const shown = (text, n) => kiosk.waitForFunction(([start, scene]) => document.querySelector('.kiosk-caption')?.textContent.startsWith(start)
        && document.querySelector('.tour')?.dataset.scene === scene, [text, String(n)], {timeout:10000});
      await shown("One user's purchase history.", 1);
      await shown(`Next purchase: ${named(target)}.`, 1);
      await kiosk.locator(`.tour-pick.is-target[data-item="${target}"]`).waitFor();
      await shown('SASRec and LETTER, same history.', 2);
      await shown('One SID, 1,643 items.', 3);
      await kiosk.waitForFunction(() => document.querySelector('.s3-row .s3-pick')?.dataset.item === '695', null, {timeout:10000});
      // A long idle spell after the input keeps the page with the visitor.
      await kiosk.evaluate(() => {window.__kioskIdleMs = 60000;});
      await kiosk.locator('body').dispatchEvent('pointerdown');
      await caption.waitFor({state:'detached', timeout:2000});
      const at3 = await kiosk.locator('.tour').getAttribute('data-scene');
      await kiosk.waitForTimeout(1500);
      assert.equal(await caption.count(), 0);
      assert.equal(await kiosk.locator('.tour').getAttribute('data-scene'), at3);
    } finally {await kiosk.close();}
  });
  await check('no visible text says "code", in the tour or in explore', async () => {
    // Item names come from the catalog (e.g. "Youth Code"); Python and "QR code" labels are not visible text.
    const titles = Object.values(await json('catalog.json')).map(row => row.title).filter(title => /\bcodes?\b/i.test(title));
    const found = [];
    const scan = async (target, where) => {
      const hits = await target.evaluate(titles => {
        const word = /\bcodes?\b/i, out = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) {
          const text = node.textContent.trim();
          if (word.test(text) && node.parentElement.checkVisibility() && !titles.some(title => title.includes(text) || text.includes(title))) out.push(text);
        }
        for (const element of document.querySelectorAll('[title]')) {
          const text = element.getAttribute('title');
          if (word.test(text) && !titles.includes(text)) out.push(`title: ${text}`);
        }
        return out;
      }, titles);
      found.push(...hits.map(text => `${where}: ${text}`));
    };
    const tour = await openAt('#v=tour&sc=1');
    try {
      await tour.locator('.tour-pick').first().waitFor();
      await scan(tour, 'step 1');
      await tour.getByRole('button', {name:'Show the answer', exact:true}).click();
      await scan(tour, 'step 1 revealed');
      const next = async n => {await tour.getByRole('button', {name:'Next', exact:true}).click(); await scene(tour, n);};
      await next(2);
      await scan(tour, 'step 2');
      await next(3);
      await tour.locator('.s3-how-button').first().click();
      await tour.locator('.s3-scores dd').nth(2).waitFor();
      await scan(tour, 'step 3');
      await next(4);
      await tour.locator('label.s4-pick input').first().check();
      await tour.waitForFunction(() => document.querySelector('p.s4-same-line')?.textContent);
      await scan(tour, 'step 4 phase 1');
      await tour.getByRole('button', {name:'Choose items to add', exact:true}).click();
      await choose(tour, 'traditional-shelf');
      await steered(tour, 1);
      await tour.getByTestId('sid-shelf').locator('button.sid-pill').first().click();
      await tour.locator('.s4-code').waitFor();
      await scan(tour, 'step 4 after an Add');
      await choose(tour, 'sid-shelf');
      await steered(tour, 2);
      await scan(tour, 'step 4 recap');
      await next(5);
      await tour.locator('.recall-chart svg').waitFor();
      await tour.locator('.s5-qr svg').waitFor();
      await scan(tour, 'step 5');
      await tour.locator('section.s5-more button[data-action="explore"]').click();
      await at(tour, 'Journey complete');
      await tour.getByRole('button', {name:'Why?', exact:true}).click();
      await tour.getByTestId('sid-shelf').locator('.bucket-link').first().click();
      await tour.locator('.journey-inspector').waitFor();
      await scan(tour, 'explore');
      await tour.getByRole('button', {name:'Share', exact:true}).click();
      await tour.getByRole('dialog').locator('.share-qr svg').waitFor();
      await scan(tour, 'explore share');
      await tour.keyboard.press('Escape');
      await tour.getByRole('button', {name:'Details', exact:true}).click();
      await tour.locator('.journey-metrics').waitFor();
      await scan(tour, 'explore details');
      await tour.getByRole('button', {name:'Details', exact:true}).click();
      await tour.locator('.journey-recap').getByRole('button', {name:'Restart journey', exact:true}).click();
      await at(tour, 'Choice 1 of 2');
      await tour.getByTestId('same-sid-step').getByRole('button', {name:`Add ${short(probe.items[0])}`, exact:true}).click();
      await at(tour, 'Choice 2 of 2');
      await scan(tour, 'explore same SID');
    } finally {await tour.close();}
    for (const hash of ['#p=sasrec-rpg&v=tour&sc=2', '#p=sasrec-rpg&v=tour&sc=3', '#p=sasrec-rpg&v=tour&sc=4',
      `#p=sasrec-diffgrm&h=${pair.seeds[1].id}&v=tour&sc=3`, `#p=sasrec-diffgrm&h=${pair.seeds[1].id}&v=tour&sc=4`]) {
      const other = await openAt(hash);
      try {
        await other.locator('.tour-scene h1').waitFor();
        await other.waitForLoadState('networkidle');
        await scan(other, hash);
      } finally {await other.close();}
    }
    assert.deepEqual(found, []);
  });
  await check('no horizontal overflow on scenes 1-5 at 1440, 1024 and 390', async () => {
    for (const [width, height] of [[1440,1000],[1024,768],[390,844]]) {
      const view = await openAt('#v=tour&sc=1', {viewport:{width, height}});
      try {
        await view.locator('.tour-pick').first().waitFor();
        if (width === 390) {
          await settle(view);
          await view.screenshot({path:figure('journeys-mobile.png'), fullPage:true, animations:'disabled'});
          await view.screenshot({path:figure('journeys-mobile-viewport.png'), fullPage:false, animations:'disabled'});
        }
        assert.ok(await fits(view), `${width} scene 1`);
        await view.getByRole('button', {name:'Show the answer', exact:true}).click();
        assert.ok(await fits(view), `${width} scene 1 revealed`);
        for (const n of [2, 3, 4, 5]) {
          await view.getByRole('button', {name:'Next', exact:true}).click();
          await scene(view, n);
          if (n === 3) {
            await view.getByRole('radio', {name:'Most popular'}).check(); await view.locator('.s3-scores').waitFor();
            await view.locator('.s3-how-button').first().click(); await view.locator('.s3-how .bucket-breakdown').waitFor();
          }
          if (n === 4) {
            await view.locator('label.s4-pick input').first().check();
            await view.waitForFunction(() => document.querySelector('p.s4-same-line')?.textContent);
            assert.ok(await fits(view), `${width} scene 4 phase 1`);
            await view.getByRole('button', {name:'Choose items to add', exact:true}).click();
            await view.locator('.s4[data-phase="2"]').waitFor();
            await view.getByTestId('traditional-shelf').getByRole('button', {name:/^Add /}).first().click();
            await view.waitForFunction(() => document.querySelectorAll('.s4 .traditional-heading .s4-entry.is-new').length === 1);
            await view.locator('.s4-shelves[aria-busy="false"]').waitFor();
          }
          if (n === 5) {await view.locator('.recall-chart svg').waitFor(); await view.locator('.s5-qr svg').waitFor(); await view.locator('.s5-collisions li').first().waitFor();}
          assert.ok(await fits(view), `${width} scene ${n}`);
        }
      } finally {await view.close();}
    }
  });
  await check('no API call, other-host request, failed response or console error', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(failed, []);
    assert.ok(requests.every(request => !request.includes('/api/')));
    assert.ok(requests.every(request => new URL(request).origin === new URL(url).origin));
  });
  // Receipt in the web-validation.json shape; hashes tie it to the reviewed sources and assets.
  const web = path.join(demo, 'web');
  // The build under test, web/dist unless the QA job built elsewhere.
  const dist = process.env.JOURNEY_DIST_DIR || path.join(web, 'dist');
  const tour = (await readdir(path.join(web, 'src/tour'))).filter(name => /\.(jsx|css)$/.test(name)).sort().map(name => `src/tour/${name}`);
  const hashed = [...['src/Journeys.jsx','src/journeyParts.jsx','src/journeyExtras.jsx','src/journeys.css',...tour,'src/main.jsx','index.html'].map(name=>path.join(web,name)),
    ...['index.html',...(await readdir(path.join(dist,'assets'))).map(name=>`assets/${name}`)].map(name=>path.join(dist,name)),
    path.join(web,'public/journeys/manifest.json'),path.join(dist,'journeys/manifest.json'),path.join(web,'public/journeys/media.json'),
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
    pairs:manifest.pairs.map(row=>row.id),files,
    scope:'Scripted browser checks of the five-scene tour and the explore screen of the static site with eight prepared Beauty model pairs; it is not a model benchmark or a user study.'},null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,firstRenderMs,choiceMs,receipt}));
} catch (error) {
  await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
  console.error(error,errors,failed); process.exitCode=1;
} finally {await browser.close();}
