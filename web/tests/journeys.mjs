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
const steps = ['Shopper', 'Two recommenders', 'One code', 'You steer', 'Made with Cornac'];
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
const choose = (target, id) => target.getByTestId(id).getByRole('button', {name:/^Choose /}).first().click();
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
  await check('scene 1 shows the 16 purchases with photos', async () => {
    assert.match(await page.title(), /Beauty recommendation journeys/);
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.equal(await page.locator('h1').textContent(), `A real shopper bought these ${root.history.length} beauty products.`);
    assert.equal(await page.getByText('Step 1 of 5', {exact:true}).count(), 1);
    assert.deepEqual(await items(page.locator('.tour-photos li[data-item]')), root.history);
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
    assert.ok(await page.getByRole('button', {name:'Just show me', exact:true}).isVisible());
    assert.equal(await page.getByText('They bought this').count(), 0);
  });
  await check('a wrong guess shows both badges and the takeaway', async () => {
    const decoy = cards.find(item => item !== target);
    await page.locator(`.tour-pick[data-item="${decoy}"]`).click();
    const real = page.locator(`.tour-pick[data-item="${target}"]`);
    await real.getByText('They bought this', {exact:true}).waitFor();
    assert.equal(await page.getByText('They bought this', {exact:true}).count(), 1);
    assert.equal(await page.locator(`.tour-pick[data-item="${decoy}"]`).getByText('Your guess', {exact:true}).count(), 1);
    assert.equal(await page.getByText('Your guess', {exact:true}).count(), 1);
    const name = await real.locator('.tour-pick-name').textContent();
    assert.equal(name, short(target));
    assert.equal(await page.locator('.tour-takeaway').textContent(), `It was the ${name}. Hard to guess. Recommenders try this for millions of shoppers.`);
    assert.equal(await page.getByRole('button', {name:'Just show me'}).count(), 0);
  });
  await check('Just show me reveals without a guess', async () => {
    const fresh = await openAt('#v=tour&sc=1');
    try {
      await fresh.getByRole('button', {name:'Just show me', exact:true}).click();
      await fresh.locator(`.tour-pick.is-target[data-item="${target}"]`).getByText('They bought this', {exact:true}).waitFor();
      assert.equal(await fresh.getByText('Your guess').count(), 0);
      assert.match(await fresh.locator('.tour-takeaway').textContent(), /^It was the .+\. Hard to guess\. /);
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
    await page.locator('.tour-steps button', {hasText:'One code'}).click();
    await scene(page, 3);
    assert.equal(await current(), 'One code');
    await page.locator('.tour-steps button', {hasText:'Two recommenders'}).click();
    await scene(page, 2);
  });
  await check('scene 2: two lists of five, the real purchase on the code side', async () => {
    assert.equal(await page.locator('h1').textContent(), `Two models saw the same ${root.history.length} purchases.`);
    assert.equal(await page.locator('.tour-reveal').textContent(), "LETTER had it at #1. SASRec didn't list it.");
    const left = page.getByTestId('tour-traditional-list'), right = page.getByTestId('tour-semantic-list');
    assert.deepEqual(await items(left.locator('li[data-item]')), ids(root.traditional));
    assert.deepEqual(await items(right.locator('li[data-item]')), ids(root.shelves.one_cosine));
    assert.equal(await right.getByText('They bought this', {exact:true}).count(), 1);
    assert.equal(await right.locator('li.is-target').getAttribute('data-item'), String(target));
    assert.equal(await left.getByText('They bought this').count(), 0);
    assert.deepEqual(await page.locator('.tour-column-head h2').allTextContents(), ['Ranks products', 'Predicts a code first']);
    assert.deepEqual(await page.locator('.tour-column-head .model-name').allTextContents(), ['SASRec', 'LETTER']);
    assert.equal(await page.locator('.tour-takeaway').textContent(), "LETTER's first code was right. Now look at that code.");
  });
  await settle(page);
  await page.screenshot({path:figure('journeys-desktop.png'), fullPage:true, animations:'disabled'});
  const bert = await openAt('#p=bert-mlm-letter&v=tour&sc=2');
  try {
    await scene(bert, 2);
    await bert.getByTestId('tour-semantic-list').getByText('They bought this', {exact:true}).waitFor();
    assert.deepEqual(await bert.locator('.tour-column-head .model-name').allTextContents(), ['BERT4Rec (MLM)', 'LETTER']);
    await settle(bert);
    await bert.screenshot({path:figure('journeys-desktop-bert-mlm.png'), fullPage:true, animations:'disabled'});
  } finally {await bert.close();}
  const bucket = root.buckets[0];
  const card = () => page.locator('.s3-card').getAttribute('data-item');
  await check('scene 3: one code, 1,643 products in six categories', async () => {
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await scene(page, 3);
    assert.equal(bucket.size, 1643);
    assert.equal(await page.locator('h1').textContent(), 'One code, 1,643 products.');
    assert.equal(await page.locator('.s3-code').textContent(), `code ${bucket.address.join('·')}`);
    assert.equal(await page.getByRole('heading', {name:"What's in this code", exact:true}).count(), 1);
    const rows = await page.locator('.bucket-breakdown li').evaluateAll(lis => lis.map(li => [li.querySelector('span').textContent, Number(li.querySelector('strong').textContent.replace(/\D/g, ''))]));
    assert.deepEqual(rows, media.buckets[pair.sid][bucket.address.join(',')].categories);
    assert.equal(rows.length, 6);
    assert.equal(rows.reduce((sum, [, value]) => sum + value, 0), 1643);
    assert.equal(await card(), String(bucket.cosine[0].item));
    assert.equal(await page.locator('.s3-card').getByText('They bought this').count(), 1);
    assert.equal(await page.locator('.tour-takeaway').count(), 0);
  });
  await check('scene 3: the picking rule swaps 695 and 2739', async () => {
    assert.deepEqual([bucket.popularity[0].item, bucket.cosine[0].item], [695, 2739]);
    await page.getByRole('radio', {name:'Most popular'}).check();
    await page.waitForFunction(() => document.querySelector('.s3-card')?.dataset.item === '695');
    assert.match(await page.evaluate(() => location.hash), /s=one_popularity/);
    assert.equal(await page.locator('.tour-takeaway').textContent(), 'That is why Cornac scores code models three ways.');
    const metrics = (await json(pair.benchmark)).metrics;
    const scores = await page.locator('.s3-scores dd').allTextContents();
    assert.deepEqual(scores, ['0.196', '0.017', '0.004']);
    assert.deepEqual(scores, [metrics.sid, metrics.one_cosine, metrics.cce].map(row => row.recall.toFixed(3)));
    assert.deepEqual(await page.locator('.s3-scores dt').allTextContents(), ['Right code', 'Right product', 'Collision-corrected']);
    for (const [key, item] of [['ArrowRight', '2739'], ['ArrowLeft', '695'], ['ArrowRight', '2739']]) {
      await page.keyboard.press(key);
      await page.waitForFunction(value => document.querySelector('.s3-card')?.dataset.item === value, item);
    }
    assert.equal(await page.locator('.tour').getAttribute('data-scene'), '3');
    assert.match(await page.evaluate(() => location.hash), /s=one_cosine/);
  });
  await check('scene 3 on RPG: one code, one product', async () => {
    const rpg = await openAt('#p=sasrec-rpg&v=tour&sc=3');
    try {
      await scene(rpg, 3);
      assert.equal(await rpg.locator('h1').textContent(), 'One code, one product.');
      assert.equal(await rpg.locator('.tour-body').textContent(), 'Every code here names exactly one product, so the three scores agree.');
      assert.equal(await rpg.getByRole('radiogroup').count(), 0);
      assert.equal(await rpg.locator('.bucket-breakdown').count(), 0);
      await rpg.locator('.s3-scores dd').nth(2).waitFor();
    } finally {await rpg.close();}
  });
  let choiceMs;
  const [first] = ids(root.traditional);
  const next = await state(pair.id, root.next[String(first)]);
  await check('scene 4: a choice loads the stored next state', async () => {
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await scene(page, 4);
    assert.equal(await page.locator('h1').textContent(), 'Add a purchase and watch both lists.');
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(root.traditional));
    assert.deepEqual(await shelf(page, 'sid-shelf'), ids(root.shelves.one_cosine));
    assert.equal(await page.locator('.journey-timeline li[data-item]:not([hidden])').count(), 6);
    assert.ok(await page.getByRole('button', {name:'Undo', exact:true}).isDisabled());
    const begin = performance.now();
    await choose(page, 'traditional-shelf');
    await page.locator('.s4-change').filter({hasText:/rewrote|kept/}).waitFor();
    choiceMs = performance.now() - begin;
    await steered(page, 1);
    assert.deepEqual(await history(page), next.history);
    assert.equal(next.history.at(-1), first);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(next.traditional));
    assert.deepEqual(await shelf(page, 'sid-shelf'), ids(next.shelves.one_cosine));
    assert.equal(await page.locator('.journey-timeline li[data-item]').last().locator('small').textContent(), 'Yours');
    assert.match(await page.evaluate(() => location.hash), /[#&]t=[^&,]+&/);
  });
  await check('scene 4: the change line matches a recount', async () => {
    const left = shelfDiff(ids(root.traditional), ids(next.traditional));
    const right = shelfDiff(ids(root.shelves.one_cosine), ids(next.shelves.one_cosine));
    const codes = codesDiff(root, next);
    const traditional = left.newCount === 5 ? 'SASRec rewrote all 5 of its picks.' : left.newCount ? `SASRec rewrote ${left.newCount} of its 5 picks.`
      : left.movedCount ? 'SASRec kept the same picks in a new order.' : 'SASRec kept the same 5 picks.';
    const sid = codes.same ? `LETTER kept the same ${codes.total} codes.` : codes.newCount ? `LETTER predicted ${count(codes.newCount, 'new code')}.` : 'LETTER kept the same codes in a new order.';
    assert.equal(await page.locator('.s4-change').textContent(), `${traditional} ${sid}`);
    assert.equal(await page.getByTestId('traditional-shelf').locator('article.is-new').count(), left.newCount);
    assert.equal(await page.getByTestId('sid-shelf').locator('article.is-new').count(), right.newCount);
  });
  await check('scene 4: Undo goes back to the start', async () => {
    await page.getByRole('button', {name:'Undo', exact:true}).click();
    await steered(page, 0);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(root.traditional));
    assert.equal(await page.locator('.s4-change').textContent(), '');
  });
  const probe = pair.same_bucket_probe;
  const swapped = await state(pair.id, root.next[String(probe.items[1])]);
  await check('scene 4: two products that share a code', async () => {
    await page.getByRole('button', {name:'Try two products that share a code', exact:true}).click();
    const step = page.getByTestId('same-sid-step');
    assert.equal(await step.locator('.code-pill').textContent(), `code ${probe.address.join('·')} · 1,643 products`);
    await step.getByRole('button', {name:`Choose ${short(probe.items[0])}`, exact:true}).click();
    await steered(page, 1);
    const picked = await state(pair.id, root.next[String(probe.items[0])]);
    assert.equal((await history(page)).at(-1), probe.items[0]);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(picked.traditional));
    await step.getByRole('button', {name:`Try ${short(probe.items[1])} instead`, exact:true}).click();
    await page.waitForFunction(item => document.querySelector('.journey-timeline li:last-child')?.dataset.item === item, String(probe.items[1]));
    await steered(page, 1);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(swapped.traditional));
    assert.notDeepEqual(ids(swapped.traditional), ids(picked.traditional));
    assert.ok(codesDiff(picked, swapped).same);
    const result = codesDiff(root, swapped).same ? 'Same codes on the right. ' : '';
    assert.equal(await step.locator('p').textContent(), `${result}${shelfDiff(ids(root.traditional), ids(swapped.traditional)).newCount} new on the left.`);
  });
  await check('scene 4: second choice gives the recap and ten final suggestions', async () => {
    const [second] = ids(swapped.shelves.one_cosine);
    const last = await state(pair.id, swapped.next[String(second)]);
    await choose(page, 'sid-shelf');
    await steered(page, 2);
    assert.deepEqual(await history(page), last.history);
    const changed = [[root, swapped], [swapped, last]].map(([a, b]) => shelfDiff(ids(a.traditional), ids(b.traditional)).newCount);
    const phrase = codes => codes.same ? 'kept the same codes' : codes.newCount ? `predicted ${count(codes.newCount, 'new code')}` : 'reordered its codes';
    const [one, two] = [codesDiff(root, swapped), codesDiff(swapped, last)].map(phrase);
    assert.equal(await page.locator('.s4-bar .tour-takeaway').textContent(),
      `You picked ${short(probe.items[1])}, then ${short(second)}. SASRec changed ${changed[0]} then ${changed[1]} picks; LETTER ${one === two ? `${one} both times` : `${one}, then ${two}`}.`);
    assert.equal(await page.getByRole('button', {name:/^Final suggestion: /}).count(), 10);
    assert.equal(await page.locator('.choose-product:not(:disabled)').count(), 0);
  });
  await check('scene 5: the paper listing and the eight-pair chart', async () => {
    assert.deepEqual(benchmarks, [`/journeys/${pair.benchmark}`]);
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await scene(page, 5);
    assert.equal(await page.locator('h1').textContent(), 'Everything you saw came from one Cornac experiment.');
    assert.equal(await page.locator('.s5-listing').textContent(), listing);
    const chart = page.locator('.recall-chart svg');
    await chart.waitFor();
    // One path per bar: SASRec and BERT4Rec item recall, then three bars for each of the four code models.
    assert.equal(await chart.locator('path').count(), 2 + 4 * 3);
    assert.deepEqual([...benchmarks].sort(), manifest.pairs.map(row => `/journeys/${row.benchmark}`).sort());
    assert.deepEqual(await page.locator('.chart-legend li').allTextContents(), ['Right product', 'Right code', 'Collision-corrected', 'Code models: Closest to this history']);
    assert.equal(await page.locator('.s5-pip').textContent(), 'pip install cornac');
    assert.equal(await page.getByRole('button', {name:'Next', exact:true}).count(), 0);
    assert.equal(await page.getByRole('button', {name:'Skip tour'}).count(), 0);
  });
  await check('scene 5: QR code and Share this journey', async () => {
    await page.locator('.s5-qr svg').waitFor();
    assert.equal(await page.locator('.s5-qr a').getAttribute('href'), 'https://github.com/PreferredAI/cornac');
    await page.getByRole('button', {name:'Share this journey', exact:true}).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.share-qr svg').waitFor();
    const link = await page.evaluate(() => location.href.replace(/&v=tour&sc=5$/, ''));
    assert.match(link, /#p=sasrec-letter&h=\w+&s=one_cosine&t=\w+,\w+&r=1$/);
    assert.equal(await dialog.locator('input[readonly]').inputValue(), link);
    assert.ok(await dialog.getByRole('button', {name:'Copy link', exact:true}).isVisible());
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'detached'});
  });
  await check('Explore freely, then Start over', async () => {
    await page.getByRole('button', {name:'Explore freely', exact:true}).click();
    await at(page, 'Journey complete');
    assert.equal(await page.locator('.tour').count(), 0);
    assert.match(await page.evaluate(() => location.hash), /&v=explore$/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'recommendations-heading');
    assert.equal(await page.getByRole('button', {name:/^Final suggestion: /}).count(), 10);
    await page.getByRole('button', {name:'Back to the tour', exact:true}).click();
    await scene(page, 5);
    await page.getByRole('button', {name:'Start over', exact:true}).click();
    await scene(page, 1);
    assert.equal(await page.evaluate(() => location.hash), '#v=tour&sc=1');
    await page.getByRole('button', {name:'Just show me', exact:true}).waitFor();
    assert.equal(await page.getByText('They bought this').count(), 0);
  });
  await check('Skip tour opens explore; Back to the tour returns', async () => {
    await page.getByRole('button', {name:'Skip tour', exact:true}).click();
    await at(page, 'Choice 1 of 2');
    assert.match(await page.evaluate(() => location.hash), /&v=explore$/);
    assert.equal(await page.getByTestId('sid-shelf').locator('article.is-target').getAttribute('data-item'), String(target));
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
    if (await page.getByLabel('Journey model pair').inputValue() === row.id) await page.getByRole('button', {name:'Restart', exact:true}).click();
    else await page.getByLabel('Journey model pair').selectOption(row.id);
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
      assert.equal(await page.getByText('One product per code', {exact:true}).count(), single ? 1 : 0, row.id);
    }
    await pick(pair);
    for (const policy of manifest.strategies) {
      await page.getByLabel('SID to item strategy').selectOption(policy);
      assert.deepEqual(await shelf(page, 'sid-shelf'), ids(root.shelves[policy]));
      assert.deepEqual(await history(page), root.history);
    }
    await page.getByLabel('SID to item strategy').selectOption('one_cosine');
  });
  await check('explore: bucket Inspector', async () => {
    await page.getByTestId('sid-shelf').locator('.bucket-link').first().click();
    await page.getByRole('heading', {name:'One code, 1,643 products', exact:true}).waitFor();
    assert.equal(await page.locator('.journey-inspector .sid-code').textContent(), `code ${bucket.address.join('·')}`);
    const counts = await page.locator('.journey-inspector .bucket-breakdown li strong').allTextContents();
    assert.equal(counts.reduce((sum, text) => sum + Number(text.replace(/\D/g, '')), 0), 1643);
    assert.deepEqual(await page.locator('.bucket-columns h3').allTextContents(), ['Most popular', 'Closest to this history']);
    assert.ok(await page.locator('.bucket-columns li').count() > 2);
    await page.getByRole('button', {name:'Close bucket inspector'}).click();
    assert.equal(await page.locator('.journey-inspector').count(), 0);
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
  });
  await check('every pair lists the same six histories', async () => {
    const seeds = pair.seeds.map(row => row.id);
    assert.equal(seeds.length, 6);
    assert.deepEqual(pair.seeds.slice(0, 2).map(row => row.query_index), [145, 210]);
    for (const row of manifest.pairs) {
      assert.deepEqual(row.seeds.map(entry => entry.id), seeds, `${row.id} lists other histories`);
      await pick(row);
      assert.deepEqual(await page.getByLabel('Starting story').locator('option').evaluateAll(options => options.map(option => option.value)), seeds, row.id);
    }
  });
  await check('catalog covers every shown item', async () => {
    // A missing catalog entry shows as `Item <index>`; product names, full names, strip captions and titles are checked.
    const names = () => page.evaluate(() => [
      ...[...document.querySelectorAll('article[data-item] h3, article[data-item] .full-name p:first-of-type, .journey-timeline li[data-item] p')].map(element => element.textContent),
      ...[...document.querySelectorAll('.journey-timeline li[data-item]')].map(element => element.title)]);
    for (const row of manifest.pairs) {
      await pick(row);
      for (const entry of row.seeds) {
        await page.getByLabel('Starting story').selectOption(entry.id);
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
      await shown('A real shopper bought these products.', 1);
      await shown(`They bought the ${short(target)}.`, 1);
      await kiosk.locator(`.tour-pick.is-target[data-item="${target}"]`).waitFor();
      await shown('Two recommenders, one history.', 2);
      await shown('One code, 1,643 products.', 3);
      await kiosk.waitForFunction(() => document.querySelector('.s3-card')?.dataset.item === '695', null, {timeout:10000});
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
        await view.getByRole('button', {name:'Just show me', exact:true}).click();
        assert.ok(await fits(view), `${width} scene 1 revealed`);
        for (const n of [2, 3, 4, 5]) {
          await view.getByRole('button', {name:'Next', exact:true}).click();
          await scene(view, n);
          if (n === 3) {await view.getByRole('radio', {name:'Most popular'}).check(); await view.locator('.s3-scores').waitFor();}
          if (n === 5) {await view.locator('.recall-chart svg').waitFor(); await view.locator('.s5-qr svg').waitFor();}
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
  const tour = (await readdir(path.join(web, 'src/tour'))).filter(name => /\.(jsx|css)$/.test(name)).sort().map(name => `src/tour/${name}`);
  const hashed = [...['src/Journeys.jsx','src/journeyParts.jsx','src/journeyExtras.jsx','src/journeys.css',...tour,'src/main.jsx','index.html','dist/index.html',
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
    pairs:manifest.pairs.map(row=>row.id),files,
    scope:'Scripted browser checks of the five-scene tour and the explore screen of the static site with eight prepared Beauty model pairs; it is not a model benchmark or a user study.'},null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,firstRenderMs,choiceMs,receipt}));
} catch (error) {
  await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
  console.error(error,errors,failed); process.exitCode=1;
} finally {await browser.close();}
