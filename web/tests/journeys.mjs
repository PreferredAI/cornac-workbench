import {chromium} from 'playwright';
import QRCode from 'qrcode';
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
const sids = await json('sids.json');
const prefixes = await json('prefixes.json');
const pair = manifest.pairs[0], seed = pair.seeds[0].id;
// The public address the QR codes carry, also when the site runs locally.
const demoUrl = 'https://cornac-workbench.preferred.ai/';
const resolvers = {one_popularity:'One item per SID, most popular', one_cosine:'One item per SID, most similar',
  expand_popularity:'All items per SID, most popular', expand_cosine:'All items per SID, most similar'};
const lower = text => text.charAt(0).toLowerCase() + text.slice(1);
const root = await state(pair.id, seed);
const target = media.targets[seed];
const short = item => media.items[String(item)].short;
// The paper colours its listing with \PK{...}-style macros; strip them (they nest) to get the plain text.
const plainListing = text => {for (let next; (next = text.replace(/\\P[KSNAM]\{([^{}]*)\}/g, '$1')) !== text;) text = next; return text;};
const listing = plainListing((await readFile(path.join(demo, 'paper.tex'), 'utf8')).match(/\\begin\{Verbatim\}\[[^\n]*\]\n([\s\S]*?)\n\\end\{Verbatim\}/)[1]);
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
// The workbench showing `row` (and `history`, when given) with both input rows drawn, the score tiles filled and no
// request in flight.
async function bench(target, row = pair, history = null) {
  await target.waitForFunction(([traditional, sid, history]) => document.querySelector('.wb .traditional-heading .model-name')?.textContent === traditional
    && document.querySelector('.wb .semantic-heading .model-name')?.textContent === sid
    && (!history || [...document.querySelectorAll('.wb .journey-timeline li[data-item]')].map(li => li.dataset.item).join() === history.join()), [row.traditional, row.sid, history]);
  await target.locator('.wb .s4-shelves[aria-busy="false"] .semantic-heading div.s4-input').waitFor();
  await target.waitForFunction(() => !document.querySelector('.journey-live')?.textContent.startsWith('Updating')
    && [...document.querySelectorAll('.wb-tiles dd')].every(value => value.textContent !== '…'));
}
const select = (target, label) => target.locator(`.wb-settings select[aria-label="${label}"]`);
// Switches the workbench to `row` with the two model selects, one at a time.
async function pickPair(target, row) {
  for (const [label, key, otherLabel, otherKey] of [['Sequential model', 'traditional', 'Generative SID model', 'sid'], ['Generative SID model', 'sid', 'Sequential model', 'traditional']]) {
    if (await select(target, label).inputValue() === row[key]) continue;
    const kept = await select(target, otherLabel).inputValue();
    await select(target, label).selectOption(row[key]);
    await bench(target, manifest.pairs.find(entry => entry[key] === row[key] && entry[otherKey] === kept));
  }
}
const params = target => target.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.slice(1))));
// A QR on screen encodes `text` when its modules are those qrcode draws for `text` with the page's settings.
async function encodes(locator, text) {
  const shown = await locator.locator('svg').evaluate(svg => [svg.getAttribute('viewBox'), svg.querySelector('path[stroke]').getAttribute('d')]);
  const drawn = await QRCode.toString(text, {type:'svg', margin:1});
  assert.deepEqual(shown, [drawn.match(/viewBox="([^"]+)"/)[1], drawn.match(/<path stroke="[^"]*" d="([^"]+)"/)[1]], text);
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
      assert.equal(await fresh.locator('h1').textContent(), 'A sequential model and a generative SID model recommend from the same history.');
      assert.deepEqual(await items(fresh.getByTestId('tour-semantic-list').locator('li[data-item]')), ids(start.shelves.expand_popularity));
    } finally {await fresh.close();}
  });
  const current = () => page.locator('.tour-steps [aria-current="step"]').textContent();
  await check('stepper: five steps, Next and Back', async () => {
    assert.deepEqual(await page.locator('.tour-steps button').allTextContents(), steps);
    assert.equal(await current(), 'Shopper');
    // Step 1 offers Preliminaries where the later steps have Back.
    assert.equal(await page.getByRole('button', {name:'Back', exact:true}).count(), 0);
    assert.ok(await page.getByRole('button', {name:'Preliminaries', exact:true}).isVisible());
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await scene(page, 2);
    assert.equal(await current(), 'Two recommenders');
    assert.equal(await page.getByText('Step 2 of 5', {exact:true}).count(), 1);
    assert.equal(await page.locator('.tour-steps li.is-reached').count(), 2);
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H1');
    assert.match(await page.evaluate(() => location.hash), /&v=tour&sc=2$/);
    assert.equal(await page.getByRole('button', {name:'Preliminaries', exact:true}).count(), 0);
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
  const basicsTitle = "Two ways to predict a user's next purchase";
  await check('step 0: Preliminaries on step 1, arrow keys and the hash', async () => {
    const view = await openAt('#v=tour&sc=1');
    try {
      await scene(view, 1);
      const sides = view.locator('nav.tour-bar > .tour-bar-side');
      // A text button, without an icon.
      assert.deepEqual(await sides.first().locator('button').evaluateAll(list => list.map(button => [button.textContent, button.querySelectorAll('svg').length])), [['Preliminaries', 0]]);
      await sides.first().getByRole('button', {name:'Preliminaries', exact:true}).click();
      await scene(view, 0);
      assert.match(await view.evaluate(() => location.hash), /&v=tour&sc=0$/);
      assert.equal(await view.locator('.tour-scene h1').textContent(), basicsTitle);
      assert.equal(await view.locator('section.tour-scene').getAttribute('aria-label'), 'Preliminaries');
      assert.equal(await view.locator('p.tour-eyebrow').textContent(), 'Preliminaries');
      assert.deepEqual(await view.evaluate(() => [document.activeElement.tagName, document.activeElement.textContent]), ['H1', basicsTitle]);
      // The five dots stay, none current or reached; the left side of the bar is empty.
      assert.deepEqual(await view.locator('.tour-steps button').allTextContents(), steps);
      assert.equal(await view.locator('.tour-steps [aria-current]').count(), 0);
      assert.equal(await view.locator('.tour-steps li.is-reached').count(), 0);
      assert.equal(await sides.first().evaluate(side => side.childElementCount), 0);
      assert.deepEqual(await sides.last().locator('button').allTextContents(), ['Next', 'Skip tour']);
      // ← does nothing on step 0; → opens step 1 and ← comes back.
      await view.keyboard.press('ArrowLeft');
      await view.waitForTimeout(300);
      assert.equal(await view.locator('.tour').getAttribute('data-scene'), '0');
      await view.keyboard.press('ArrowRight');
      await scene(view, 1);
      assert.match(await view.evaluate(() => location.hash), /&v=tour&sc=1$/);
      await view.keyboard.press('ArrowLeft');
      await scene(view, 0);
      await view.getByRole('button', {name:'Try it on a real history', exact:true}).click();
      await scene(view, 1);
      assert.equal(await view.locator('.tour-steps [aria-current="step"]').textContent(), 'Shopper');
      assert.match(await view.evaluate(() => location.hash), /&v=tour&sc=1$/);
    } finally {await view.close();}
    // `sc=0` opens step 0 on load and after a reload; without `sc` the tour opens on step 1.
    const direct = await openAt('#v=tour&sc=0');
    try {
      await scene(direct, 0);
      await direct.reload();
      await scene(direct, 0);
      assert.equal(await direct.locator('p.tour-eyebrow').textContent(), 'Preliminaries');
    } finally {await direct.close();}
    const plain = await openAt('#v=tour');
    try {
      await scene(plain, 1);
      assert.equal(await plain.locator('p.tour-eyebrow').textContent(), 'Step 1 of 5');
    } finally {await plain.close();}
  });
  // Step 0's TIGER side from the data, whatever the pair. The example is a history item whose TIGER SID is not the
  // generated one and whose first-token group has at least 8 items, by the share of the group's top category, then
  // group size, then later in the history (otherwise the last item). Each prefix panel lists the example, then the
  // group's members by index without the next purchase and the items on the pair's root lists.
  const ahead = (key, other) => {const k = key.findIndex((value, n) => value !== other[n]); return k >= 0 && key[k] > other[k];};
  const groups = prefixes.prefixes.TIGER;
  const percent = value => `${Math.round(value * 100)}%`;
  const statsLine = `Across TIGER's SIDs for all ${prefixes.stats.items.toLocaleString()} items, two items that share the first token are in the same top-level category ${
    percent(prefixes.stats.first_token_same_top)} of the time; two random items, ${percent(prefixes.stats.random_same_top)}.`;
  async function basicsOf(row, history) {
    const tiger = manifest.pairs.find(entry => entry.sid === 'TIGER' && entry.traditional === row.traditional);
    const generated = (await state(tiger.id, history)).buckets[0].address;
    const start = await state(row.id, history), table = sids.sids.TIGER;
    let best = null;
    start.history.forEach((item, i) => {
      const sid = table[String(item)], group = groups[String(sid[0])];
      if (group.size < 8 || sid.join() === generated.join()) return;
      const key = [group.top[0][1] / group.size, group.size, i];
      if (!best || ahead(key, best.key)) best = {item, key};
    });
    const item = best ? best.item : start.history.at(-1), sid = table[String(item)];
    const hidden = new Set([media.targets[history], ...[...start.traditional, ...Object.values(start.shelves).flat()].map(card => card.item)]);
    const keys = [1, 2, 3].map(k => sid.slice(0, k));
    const name = labeler(start, keys.flatMap(prefix => groups[prefix.join(',')].members));
    const rows = keys.map(prefix => {
      const key = prefix.join(','), {size, top:[[category, inTop]], members} = groups[key];
      const shown = [item, ...members.filter(member => member !== item && !hidden.has(member))];
      return {key, cells:[key, prefix.join('·'), count(size, 'item'), `${inTop === size ? 'All' : percent(inTop / size)} ${category.toLowerCase()}`],
        items:shown.map(member => [member, titles[String(member)], name(member), member === item ? 'This item' : null]),
        more:size > shown.length ? `+ ${count(size - shown.length, 'more item')}` : null, dropped:members.filter(member => member !== item && hidden.has(member))};
    });
    return {start, item, sid, generated, rows};
  }
  // Step 0 as shown, panel by panel.
  const basics = target => target.evaluate(() => {
    const all = (root, selector) => [...root.querySelectorAll(selector)];
    const texts = (root, selector) => all(root, selector).map(element => element.textContent);
    const chips = list => all(list, ':scope > li').map(chip => [chip.textContent, chip.className]);
    const [task, sequential, sid, prefix] = all(document, 'div.s0 > section.s0-panel');
    const example = sid.querySelector('div.s0-example');
    return {
      panels:all(document, 'div.s0 > section').map(panel => panel.className),
      heads:[task, sequential, sid, prefix].map(panel => panel.querySelector('h2').textContent),
      tags:[sequential, sid].map(panel => [...panel.querySelectorAll('.tour-column-head > *')].map(element => `${element.tagName} ${element.className} ${element.textContent}`)),
      sequence:all(task, 'ol.s0-sequence > li').map(li => [li.className, li.dataset.item ? Number(li.dataset.item) : null, li.textContent, li.title, li.querySelectorAll('img.thumb').length]),
      lines:[task, sequential, sid, prefix].map(panel => texts(panel, ':scope > p.s0-line')),
      // Each numbered step: its text and the first class of each part.
      steps:[sequential, sid].map(panel => all(panel, ':scope > ol.s0-steps > li').map(li => [li.querySelector(':scope > p.s0-step').textContent, [...li.children].map(child => child.classList[0])])),
      ids:all(sequential, 'ol.s0-ids > li').map(li => [Number(li.dataset.item), li.textContent]),
      scores:all(sequential, 'ol.s0-scores > li').map(li => [li.textContent, li.querySelector('i').getBoundingClientRect().width]),
      more:sequential.querySelector('p.s0-scores-more').textContent,
      example:[Number(example.dataset.item), example.title, example.querySelectorAll('img.thumb').length, example.querySelector('p').textContent,
        example.querySelector('ol.s0-tokens').title, chips(example.querySelector('ol.s0-tokens')), example.querySelector('p.s0-caption').textContent],
      sids:all(sid, 'ol.s0-sids > li').map(li => [Number(li.dataset.item), li.textContent]),
      generate:[sid.querySelector('div.s0-generate').className, chips(sid.querySelector('div.s0-generate > ol.s0-tokens'))],
      delays:all(sid, 'div.s0-generate li.s0-token').map(chip => parseFloat(getComputedStyle(chip).animationDelay)),
      rows:all(prefix, ':scope > ol.s0-prefix-rows > li').map(li => [li.className, li.dataset.prefix, li.querySelector('code.s0-prefix-pill').textContent,
        li.querySelector('div.s0-prefix-about > span.s0-prefix-size').textContent, li.querySelector('div.s0-prefix-about > span.s0-prefix-top').textContent,
        ...(button => [button.textContent, button.getAttribute('aria-expanded'), button.getAttribute('aria-controls')])(li.querySelector('button.s0-show'))]),
      open:all(prefix, '.s0-prefix-items').map(panel => panel.id),
      tops:[sequential, sid].map(panel => Math.round(panel.getBoundingClientRect().top)),
      go:[...document.querySelectorAll('.tour-scene button.s0-go')].map(button => `${button.className} ${button.textContent}`),
      gone:document.querySelectorAll('div.s0-prefix, ul.s0-members, p.s0-similar, .is-shared, p.s0-label, ul.s0-examples').length,
    };
  });
  // An open prefix panel: its items as [item, title, name, `This item`] and its `+ n more items` line.
  const prefixPanel = (target, key) => target.locator(`li.s0-prefix-row[data-prefix="${key}"] > div.s0-prefix-items`).evaluate(panel => ({
    items:[...panel.querySelectorAll(':scope > ul > li[data-item]')].map(li => [Number(li.dataset.item), li.title, li.querySelector('p').textContent,
      li.classList.contains('is-example') ? li.querySelector('span.s0-this')?.textContent ?? 'no label' : li.querySelector('span.s0-this') ? 'stray label' : null]),
    more:panel.querySelector(':scope > p.s0-prefix-more')?.textContent ?? null}));
  // Open step 0 and wait for the TIGER side and the generated SID to be drawn.
  async function openBasics(hash, options) {
    const view = await openAt(hash, options);
    await scene(view, 0);
    await view.locator('.s0-sid div.s0-example').waitFor();
    await view.locator('.s0-generate').scrollIntoViewIfNeeded();
    await view.locator('.s0-generate.is-on li.s0-token').first().waitFor();
    return view;
  }
  await check('step 0: two pipelines and TIGER\'s prefix rows, recounted from the data', async () => {
    // Every history on the default pair, plus pairs with another SID model or sequential model.
    const cases = [...pair.seeds.map(entry => [pair.id, entry.id]), ['sasrec-rpg', seed], ['bert-mlm-diffgrm', pair.seeds[2].id]];
    const seen = {};
    for (const [id, history] of cases) {
      const row = manifest.pairs.find(entry => entry.id === id), want = await basicsOf(row, history), {start} = want;
      const where = `${id} ${history}`, last3 = start.history.slice(-3), earlier = start.history.length - 3;
      const view = await openBasics(`#p=${id}&h=${history}&v=tour&sc=0`);
      try {
        const shown = await basics(view);
        assert.equal(await view.locator('.tour-scene h1').textContent(), basicsTitle);
        assert.deepEqual(shown.panels, ['s0-panel s0-task', 's0-panel s0-sequential', 's0-panel s0-sid', 's0-panel s0-prefix'], where);
        assert.deepEqual(shown.heads, ['Next-item recommendation', 'Sequential model', 'Generative SID model', 'Similar items share the first tokens'], where);
        assert.deepEqual(shown.tags, [['H2  Sequential model', `SPAN model-name traditional ${row.traditional}`], ['H2  Generative SID model', 'SPAN model-name semantic TIGER']], where);
        assert.deepEqual(shown.lines, [["It reads one user's purchases in order and ranks the items the user is likely to buy next."], ['Reads each purchase as its item ID.'],
          ['Translates each item into a few semantic tokens, from general to specific: its Semantic ID (SID).'], [statsLine]], where);
        // Row 1: `{n} earlier`, the last three photos numbered by position, then the `?` tile.
        assert.deepEqual(shown.sequence, [['s0-more', null, `${earlier} earlier`, '', 0],
          ...last3.map((item, i) => ['s0-photo', item, String(earlier + i + 1), titles[String(item)], 1]), ['s0-next', null, '?next', '', 0]], where);
        // Row 2: the two numbered pipelines.
        assert.deepEqual(shown.steps, [
          [['Reads the item IDs', ['s0-step', 's0-ids']], ['Scores all 12,068 items', ['s0-step', 's0-scores', 's0-scores-more']], ['Recommends the 5 highest scores', ['s0-step']]],
          [["Translates the item's text into an SID", ['s0-step', 's0-example']], ['Reads the history as SIDs', ['s0-step', 's0-sids']],
            ['Generates the next SID one token at a time', ['s0-step', 's0-generate']], ['Looks up the item with that SID', ['s0-step']]]], where);
        assert.deepEqual(shown.ids, last3.map(item => [item, String(item)]), where);
        assert.deepEqual(shown.scores.map(([text]) => text), ['#1', '#2', '#3', '#4', '#5']);
        assert.ok(shown.scores.every(([, width], i) => !i || width < shown.scores[i - 1][1]), JSON.stringify(shown.scores));
        assert.equal(shown.more, '… 12,063 more');
        assert.deepEqual(shown.example, [want.item, titles[String(want.item)], 1, short(want.item), want.sid.join('·'),
          want.sid.map(token => [String(token), 's0-token']), 'general → specific'], where);
        assert.deepEqual(shown.sids, last3.map(item => [item, sids.sids.TIGER[String(item)].join('·')]), where);
        assert.deepEqual(shown.generate, ['s0-generate is-on', want.generated.map(token => [String(token), 's0-token'])], where);
        assert.ok(shown.delays.every((delay, i) => !i || Math.abs(delay - shown.delays[i - 1] - .45) < .01), `${where} ${shown.delays}`);
        // Row 3: one row per prefix of the example's SID, none open.
        assert.deepEqual(shown.rows, want.rows.map(({key, cells}) => ['s0-prefix-row', ...cells, 'Show items', 'false', null]), where);
        assert.deepEqual(shown.open, [], where);
        assert.deepEqual(shown.go, ['button primary s0-go Try it on a real history']);
        assert.equal(shown.gone, 0, where);
        assert.equal(shown.tops[0], shown.tops[1], where);
        // Show items opens one panel at a time; a second click closes it.
        const buttons = view.locator('ol.s0-prefix-rows > li > button.s0-show');
        for (const [i, {key, items: listed, more}] of want.rows.entries()) {
          await buttons.nth(i).click();
          await view.locator(`li.s0-prefix-row[data-prefix="${key}"] > div.s0-prefix-items`).waitFor();
          const now = await basics(view);
          assert.deepEqual(now.open, [`s0-prefix-${key}`], `${where} ${key}`);
          assert.deepEqual(now.rows.map(entry => [entry[0], entry[6], entry[7]]), want.rows.map((other, j) =>
            [`s0-prefix-row${i === j ? ' is-open' : ''}`, String(i === j), i === j ? `s0-prefix-${key}` : null]), `${where} ${key}`);
          assert.deepEqual(await prefixPanel(view, key), {items:listed, more}, `${where} ${key}`);
          seen[`${id} ${history} ${key}`] = await prefixPanel(view, key);
        }
        await buttons.nth(want.rows.length - 1).click();
        await view.locator('.s0-prefix-items').waitFor({state:'detached'});
        assert.equal(await view.locator('li.s0-prefix-row.is-open').count(), 0);
        seen[where] = {shown, want};
        if (id === pair.id && history === seed) {
          // Under reduced motion the tokens stand still and stay readable.
          await view.emulateMedia({reducedMotion:'reduce'});
          const still = await view.locator('div.s0-generate li.s0-token').evaluateAll(chips => chips.map(chip => [getComputedStyle(chip).animationName, getComputedStyle(chip).color]));
          assert.ok(still.every(([name, color]) => name === 'none' && color !== 'rgba(0, 0, 0, 0)'), JSON.stringify(still));
        }
      } finally {await view.close();}
    }
    // The values the round-8c notes record, as a cross-check of the recount.
    assert.equal(statsLine, "Across TIGER's SIDs for all 12,068 items, two items that share the first token are in the same top-level category 84% of the time; two random items, 23%.");
    const at = (history, id = pair.id) => seen[`${id} ${history}`];
    assert.deepEqual([at(seed).shown.example[0], at(seed).shown.rows.map(entry => entry.slice(2, 5)), at(seed).shown.generate[1].map(([text]) => text).join('·')],
      [1052, [['116', '117 items', '99% mascara'], ['116·163', '6 items', 'All mascara'], ['116·163·184', '5 items', 'All mascara']], '5·104·60·0']);
    assert.equal(at(seed).shown.example[3], 'Maybelline mascara');
    // 1052 reads its short name in the pipeline and its full title in the panels.
    assert.deepEqual(at(`${seed} 116`).items[0], [1052, titles['1052'], titles['1052'].charAt(0).toUpperCase() + titles['1052'].slice(1), 'This item']);
    const [skin, fragrance] = ['Skin care, 8 purchases', 'Fragrance, 11 purchases'].map(label => pair.seeds.find(row => row.label === label).id);
    for (const [history, left] of [[skin, [704, 2752]], [fragrance, [357, 1895, 2539]]]) {
      assert.deepEqual([...new Set(at(history).want.rows.flatMap(entry => entry.dropped))].sort((a, b) => a - b), left, history);
      const listed = Object.entries(seen).filter(([key]) => key.startsWith(`${pair.id} ${history} `)).flatMap(([, panel]) => panel.items.map(([item]) => item));
      assert.deepEqual(listed.filter(item => left.includes(item)), [], history);
    }
    // On another SID model the TIGER side is the same.
    const rpg = at(seed, 'sasrec-rpg').shown, letter = at(seed).shown;
    assert.deepEqual([rpg.tags[1], rpg.example, rpg.sids, rpg.generate, rpg.rows], [letter.tags[1], letter.example, letter.sids, letter.generate, letter.rows]);
  });
  await check('step 0: no spoiler; photos from the history and the prefix panels only', async () => {
    for (const entry of pair.seeds) {
      const view = await openAt(`#h=${entry.id}&v=tour&sc=1`);
      try {
        await view.locator('.tour-pick').first().waitFor();
        // Step 1's guess cards hold the next purchase and items from the lists that the user did not buy.
        const picks = await view.locator('.tour-pick').evaluateAll(cards => cards.map(card => [Number(card.dataset.item), card.querySelector('.tour-pick-name').textContent, card.title]));
        await view.getByRole('button', {name:'Preliminaries', exact:true}).click();
        await scene(view, 0);
        await view.locator('.s0-sid div.s0-example').waitFor();
        const start = await state(pair.id, entry.id), next = media.targets[entry.id];
        assert.ok(picks.some(([item]) => item === next) && !start.history.includes(next), entry.label);
        // Closed, step 0 shows history items only: photos, item IDs, the example and its SID cells.
        const fromHistory = await items(view.locator('.tour-scene [data-item]'));
        assert.equal(fromHistory.length, 3 + 3 + 1 + 3, entry.label);
        assert.deepEqual(fromHistory.filter(item => !start.history.includes(item)), [], entry.label);
        // No guess card's name or title appears.
        const text = await view.locator('.tour-scene').textContent();
        for (const [item, name] of picks) assert.ok(!text.includes(name), `${entry.label}: ${item} ${name}`);
        // Each prefix panel adds the example and catalog items, never the next purchase, a guess card or a list item.
        const listed = [...start.traditional, ...Object.values(start.shelves).flat()].map(card => card.item);
        const example = Number(await view.locator('.s0-sid div.s0-example').getAttribute('data-item'));
        const buttons = view.locator('ol.s0-prefix-rows > li > button.s0-show');
        for (let i = 0; i < await buttons.count(); i++) {
          await buttons.nth(i).click();
          const panel = view.locator('li.s0-prefix-row.is-open > div.s0-prefix-items');
          await panel.waitFor();
          const members = await items(panel.locator('li[data-item]'));
          assert.equal(members[0], example, entry.label);
          assert.deepEqual(members.slice(1).filter(item => item === next || listed.includes(item) || picks.some(([pick]) => pick === item)), [], entry.label);
          const shownTitles = await view.locator('.tour-scene [title]').evaluateAll(list => list.map(element => element.title));
          for (const [item, , title] of picks) assert.ok(!shownTitles.includes(title), `${entry.label}: ${item}`);
        }
        assert.equal(await view.getByText('Next purchase', {exact:true}).count(), 0);
      } finally {await view.close();}
    }
  });
  await check('scene 2: two lists of five, the next purchase on the SID side', async () => {
    assert.equal(await page.locator('h1').textContent(), 'A sequential model and a generative SID model recommend from the same history.');
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
      assert.deepEqual(await rpg.locator('.tour-code').allTextContents(), Array(5).fill('32-token SID'));
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
      assert.deepEqual(await rpg.locator('.s3-row code.s3-pill').allTextContents(), Array(5).fill('32-token SID'));
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
  await check('one name per item in steps 1-4 and the workbench', async () => {
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
      // The workbench names items as the tour does.
      await view.getByRole('button', {name:'Skip tour', exact:true}).click();
      await bench(view);
      await read('workbench list', '.wb [data-testid="sid-shelf"] article[data-item="2739"] h3');
      await read('workbench strip', '.wb .journey-timeline li[data-item="1294"] p');
      assert.deepEqual(seen.filter(([, item, text]) => text !== want[item]), []);
      assert.equal(seen.length, 10);
    } finally {await view.close();}
  });
  let choiceMs;
  const [first] = ids(root.traditional);
  const next = await state(pair.id, root.next[String(first)]);
  const sidText = address => address.length > 8 ? `${address.length}-token SID` : address.join('·');
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
      assert.deepEqual(await rpg.getByTestId('sid-shelf').locator('button.sid-pill').allTextContents(), Array(5).fill('32-token SID'));
      assert.deepEqual(await rpg.getByTestId('sid-shelf').locator('button.sid-pill').evaluateAll(list => list.map(button => button.title)), start.shelves.one_cosine.map(card => card.address.join('·')));
    } finally {await rpg.close();}
  });
  await check('scene 4: every purchase shown, full names in card titles', async () => {
    assert.equal(await page.locator('.s4 .journey-timeline li[data-item]:not([hidden])').count(), root.history.length);
    assert.equal(await page.locator('.strip-toggle').count(), 0);
    assert.equal(await page.locator('details.full-name').count(), 0);
    assert.equal(await page.getByText('Full name').count(), 0);
    const titled = await page.locator('.s4-shelves article[data-item]').evaluateAll(cards => cards.map(card => [Number(card.dataset.item), card.title]));
    assert.deepEqual(titled, [...ids(root.traditional), ...ids(root.shelves.one_cosine)].map(item => [item, titles[String(item)]]));
    // The workbench shows the same cards, titles and whole history, also without a toggle or expanders.
    const view = await openAt('#v=explore');
    try {
      await bench(view);
      assert.equal(await view.locator('.wb .journey-timeline li[data-item]:not([hidden])').count(), root.history.length);
      assert.equal(await view.locator('.strip-toggle, details.full-name').count(), 0);
      assert.deepEqual(await view.locator('.wb .s4-shelves article[data-item]').evaluateAll(cards => cards.map(card => [Number(card.dataset.item), card.title])), titled);
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
  // The recap after those two Adds, for the workbench checks.
  const recap = (() => {
    const [x, y] = [[root, next], [next, last]].map(([a, b]) => shelfDiff(ids(a.traditional), ids(b.traditional)).newCount);
    const [one, two] = [codesDiff(root, next), codesDiff(next, last)].map(sidsPhrase);
    const names = [first, second].map(labeler(root, [...last.history, ...ids(last.traditional), ...ids(last.shelves.one_cosine)]));
    return `Added ${names[0]}, then ${names[1]}. SASRec: ${x}, then ${y} of 5 items changed. LETTER: ${one === two ? `${one} both times` : `${one}, then ${two}`}.`;
  })();
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
    assert.deepEqual(await get.locator('h2').allTextContents(), ['Install Cornac', 'Try the demo!']);
    assert.equal(await get.locator('code.s5-pip').textContent(), 'pip install cornac');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin:new URL(url).origin});
    await get.getByRole('button', {name:'Copy', exact:true}).click();
    await get.getByRole('button', {name:'Copied', exact:true}).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'pip install cornac');
    assert.equal(await get.locator('a.s5-repo').textContent(), 'github.com/PreferredAI/cornac');
    assert.equal(await get.locator('a.s5-repo').getAttribute('href'), 'https://github.com/PreferredAI/cornac');
    await get.locator('.s5-qr svg').waitFor();
    assert.equal(await get.locator('.s5-qr').getAttribute('aria-label'), 'QR code for the Cornac repository on GitHub');
    await encodes(get.locator('.s5-qr'), 'https://github.com/PreferredAI/cornac');
  });
  await check('scene 5: Try the demo! next to Install Cornac', async () => {
    const get = page.locator('section.s5-get');
    assert.equal(await get.getAttribute('aria-labelledby'), null);
    const parts = get.locator(':scope > div.s5-get-part');
    assert.deepEqual(await parts.evaluateAll(list => list.map(part => part.className)), ['s5-get-part', 's5-get-part s5-phone']);
    const phone = parts.nth(1);
    assert.equal(await phone.locator('h2').textContent(), 'Try the demo!');
    const link = phone.locator('a.s5-demo');
    assert.deepEqual([await link.textContent(), await link.getAttribute('href')], ['cornac-workbench.preferred.ai', demoUrl]);
    const qr = phone.locator('div.qr.s5-demo-qr');
    assert.deepEqual([await qr.getAttribute('role'), await qr.getAttribute('aria-label')], ['img', 'QR code for the Cornac Workbench']);
    await qr.locator('svg').waitFor();
    await encodes(qr, demoUrl);
    // The repository's link and QR stay unique on the page.
    assert.deepEqual([await page.locator('a.s5-repo').count(), await page.locator('.s5-qr').count()], [1, 1]);
    // Side by side here, stacked on a phone.
    const blocks = target => target.locator('section.s5-get > div.s5-get-part').evaluateAll(list => list.map(part => {const {top, bottom, left, right} = part.getBoundingClientRect(); return {top, bottom, left, right};}));
    const [install, demo] = await blocks(page);
    assert.ok(Math.abs(install.top - demo.top) <= 1 && demo.left >= install.right, JSON.stringify({install, demo}));
    const small = await openAt('#v=tour&sc=5', {viewport:{width:390, height:844}});
    try {
      await scene(small, 5);
      await small.locator('.s5-demo-qr svg').waitFor();
      const [above, below] = await blocks(small);
      assert.ok(below.top >= above.bottom, JSON.stringify({above, below}));
    } finally {await small.close();}
  });
  const action = name => page.locator(`section.s5-more button[data-action="${name}"]`);
  await check('scene 5: two buttons, no Share', async () => {
    assert.equal(await page.locator('section.s5-more h2').count(), 0);
    assert.deepEqual(await page.locator('section.s5-more button[data-action]').evaluateAll(buttons => buttons.map(button =>
      [button.dataset.action, button.textContent, document.getElementById(button.getAttribute('aria-describedby')).textContent])), [
      ['explore', 'Open the full workbench', 'All 8 model pairs, 6 histories and 4 resolvers.'],
      ['restart', 'Start over', 'Back to step 1.']]);
    assert.equal(await page.getByRole('button', {name:/Share/}).count(), 0);
  });
  const bare = new URL('/', url).href;
  const heading = 'Compare any two models on any history.';
  const focused = target => target.evaluate(() => [document.activeElement.tagName, document.activeElement.textContent]);
  await check('Open the full workbench keeps the journey in its address; Back; Start over', async () => {
    await action('explore').click();
    await bench(page, pair, last.history);
    assert.equal(await page.locator('.tour').count(), 0);
    assert.match(await page.evaluate(() => location.hash), /&v=explore$/);
    assert.deepEqual(await focused(page), ['H1', heading]);
    // The two Adds from step 4 carry over: recap, ten final suggestions and no reveal line.
    assert.equal(await page.locator('.wb .s4-bar .tour-takeaway').textContent(), recap);
    assert.equal(await page.getByRole('button', {name:/^Final suggestion: /}).count(), 10);
    assert.equal(await page.locator('.wb .choose-product:not(:disabled)').count(), 0);
    assert.equal(await page.locator('p.wb-reveal').count(), 0);
    // The address records the journey: pair, history, resolver, the two added items and the view.
    assert.match(await page.evaluate(() => location.hash), new RegExp(`^#p=sasrec-letter&h=${seed}&s=one_cosine&t=${root.next[String(first)]},${next.next[String(second)]}&r=1&v=explore$`));
    await page.getByRole('button', {name:'Back to the tour', exact:true}).click();
    await scene(page, 5);
    assert.match(await page.evaluate(() => location.hash), /&v=tour&sc=5$/);
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
      await bench(fresh);
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
  // Whether the bottom-right demo card is showing; it hides with `visibility`.
  const cardShown = target => target.locator('aside.demo-qr > div.demo-qr-card').evaluate(card => getComputedStyle(card).visibility === 'visible');
  const cardIs = (target, open) => target.waitForFunction(open => getComputedStyle(document.querySelector('aside.demo-qr > div.demo-qr-card')).visibility === (open ? 'visible' : 'hidden'), open);
  await check('header: Start over only, no QR', async () => {
    for (const [hash, ready] of [['#v=tour&sc=0', view => scene(view, 0)], ['#v=tour&sc=3', view => scene(view, 3)], ['#v=explore', view => bench(view)]]) {
      const view = await openAt(hash);
      try {
        await ready(view);
        assert.deepEqual(await view.locator('header.app-header .header-actions > *').evaluateAll(list => list.map(element => element.textContent.trim())), ['Start over'], hash);
        assert.equal(await view.locator('header.app-header .qr, .header-qr, .phone-button, dialog.phone-panel, .kiosk-qr').count(), 0, hash);
      } finally {await view.close();}
    }
  });
  await check('demo QR card: collapsed, opens on hover, a click pins it, Esc or a second click unpins, Tab opens it', async () => {
    const view = await openAt('#v=tour&sc=1');
    try {
      await scene(view, 1);
      const aside = view.getByRole('complementary', {name:'Try the demo!', exact:true});
      assert.ok(await aside.evaluate(element => element.matches('aside.demo-qr')));
      const tab = aside.locator('button.demo-qr-tab'), card = aside.locator('div.demo-qr-card#demo-qr-card');
      assert.deepEqual(await tab.evaluate(button => [button.textContent, button.getAttribute('aria-expanded'), button.getAttribute('aria-controls')]), ['Try the demo!', 'false', 'demo-qr-card']);
      // The card's QR carries the demo address, 260 px wide here; the link names it.
      const qr = card.locator('div.qr');
      assert.deepEqual([await qr.getAttribute('role'), await qr.getAttribute('aria-label')], ['img', 'QR code for the Cornac Workbench']);
      await qr.locator('svg').waitFor({state:'attached'});
      await encodes(qr, demoUrl);
      const link = card.locator('a');
      assert.deepEqual([await link.textContent(), await link.getAttribute('href')], ['cornac-workbench.preferred.ai', demoUrl]);
      // Bottom-right corner, collapsed at first; the hidden card does not catch the pointer.
      const corner = await tab.evaluate(button => {const box = button.getBoundingClientRect(); return [innerWidth - box.right, innerHeight - box.bottom];});
      assert.ok(corner.every(gap => gap >= 16 && gap <= 32), String(corner));
      assert.equal(await cardShown(view), false);
      assert.equal(await aside.evaluate(element => element.classList.contains('is-open')), false);
      const hit = await card.evaluate(element => {const box = element.getBoundingClientRect();
        return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('.demo-qr') ? 'card' : 'page';});
      assert.equal(hit, 'page');
      // Hover opens it and it stays open while the pointer crosses the gap onto the card; leaving closes it.
      await tab.hover();
      await cardIs(view, true);
      const box = await card.boundingBox();
      assert.ok(Math.abs((await qr.boundingBox()).width - 260) <= 1);
      await view.mouse.move(box.x + box.width / 2, box.y + box.height + 4);
      await view.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps:4});
      await view.waitForTimeout(300);
      assert.ok(await cardShown(view), 'open over the card');
      await view.mouse.move(100, 400);
      await cardIs(view, false);
      // A click pins it; Esc unpins it and moves focus off the tab.
      await tab.click();
      await view.mouse.move(100, 400);
      await view.waitForTimeout(300);
      assert.ok(await cardShown(view), 'pinned');
      assert.deepEqual([await tab.getAttribute('aria-expanded'), await aside.evaluate(element => element.classList.contains('is-open'))], ['true', true]);
      await view.keyboard.press('Escape');
      await cardIs(view, false);
      assert.deepEqual([await tab.getAttribute('aria-expanded'), await view.evaluate(() => document.querySelector('.demo-qr').contains(document.activeElement))], ['false', false]);
      // A second click unpins it too.
      await tab.click();
      await tab.click();
      await view.mouse.move(100, 400);
      await cardIs(view, false);
      assert.equal(await tab.getAttribute('aria-expanded'), 'false');
      // Tab from the control before it opens it, and the card's link is reachable; a mouse click alone does not open it.
      await view.evaluate(() => {
        const tab = document.querySelector('.demo-qr-tab');
        const before = [...document.querySelectorAll('a[href], button, input, select, [tabindex]:not([tabindex="-1"])')].filter(element => !element.closest('.demo-qr')
          && element.checkVisibility({visibilityProperty:true}) && !element.disabled && element.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING);
        before.at(-1).focus();
      });
      await view.keyboard.press('Tab');
      assert.equal(await view.evaluate(() => document.activeElement.className), 'demo-qr-tab');
      await cardIs(view, true);
      await view.keyboard.press('Shift+Tab');
      assert.equal(await view.evaluate(() => document.activeElement.closest('.demo-qr-card') ? document.activeElement.textContent : null), 'cornac-workbench.preferred.ai');
      assert.ok(await cardShown(view), 'open while its link has focus');
      await view.evaluate(() => document.activeElement.blur());
      await cardIs(view, false);
    } finally {await view.close();}
    // The workbench has the same card.
    const bench0 = await openAt('#v=explore');
    try {
      await bench(bench0);
      await encodes(bench0.locator('aside.demo-qr .qr'), demoUrl);
      assert.equal(await cardShown(bench0), false);
      await bench0.locator('button.demo-qr-tab').hover();
      await cardIs(bench0, true);
    } finally {await bench0.close();}
    // Below 900 px the card and its tab are hidden.
    for (const width of [390, 899]) {
      const small = await openAt('#v=tour&sc=1', {viewport:{width, height:844}});
      try {
        await scene(small, 1);
        assert.equal(await small.locator('aside.demo-qr').count(), 1, String(width));
        assert.equal(await small.locator('aside.demo-qr').isVisible(), false, String(width));
      } finally {await small.close();}
    }
  });
  await check('footnote: pre-computed from step 4 on and in the workbench', async () => {
    const fresh = await openAt('#v=tour&sc=0');
    try {
      const footnote = () => fresh.locator('.journey-footnote').textContent();
      const plain = 'Purchase histories from Amazon Beauty (2014).', long = `${plain} Recommendations were pre-computed.`;
      await scene(fresh, 0);
      assert.equal(await footnote(), plain, 'step 0');
      for (const n of [1, 2, 3, 4, 5]) {
        await fresh.getByRole('button', {name:'Next', exact:true}).click();
        await scene(fresh, n);
        assert.equal(await footnote(), n <= 3 ? plain : long, `step ${n}`);
      }
      await fresh.locator('section.s5-more button[data-action="explore"]').click();
      await bench(fresh);
      assert.equal(await footnote(), long);
    } finally {await fresh.close();}
  });
  await check('Skip tour opens the workbench with its H1 focused; Back to the tour returns', async () => {
    await page.getByRole('button', {name:'Skip tour', exact:true}).click();
    await bench(page, pair, root.history);
    assert.match(await page.evaluate(() => location.hash), /&v=explore$/);
    assert.deepEqual(await focused(page), ['H1', heading]);
    // Top to bottom: title row, settings, the reveal line, step 4's add-items view, scores.
    assert.deepEqual(await page.locator('.wb > *').evaluateAll(list => list.map(element => `${element.tagName.toLowerCase()}${element.className ? `.${element.className}` : ''}`)),
      ['div.wb-title', 'section.wb-settings', 'p.wb-reveal', 'h2', 'div.s4', 'section.wb-scores']);
    assert.deepEqual(await page.locator('.wb-title > *').evaluateAll(list => list.map(element => [element.tagName, element.textContent])), [['H1', heading], ['BUTTON', 'Back to the tour']]);
    assert.equal(await page.getByRole('group', {name:'Settings', exact:true}).count(), 1);
    assert.deepEqual(await page.locator('section.wb-settings > div.wb-selects > label.wb-select').evaluateAll(labels => labels.map(label =>
      [label.querySelector('span').textContent, label.querySelector('select').getAttribute('aria-label'), label.querySelector('select').value])),
      [['Sequential model', 'Sequential model', 'SASRec'], ['Generative SID model', 'Generative SID model', 'LETTER'], ['History', 'History', seed], ['Resolver', 'Resolver', 'one_cosine']]);
    assert.equal(await page.locator('p.wb-reveal').textContent(), 'LETTER ranks the next purchase #1. SASRec does not have it in its top 5.');
    assert.equal(await page.locator('.wb > h2').textContent(), 'Add an item to the history and compare the new top 5.');
    assert.equal(await page.locator('.wb .s4').getAttribute('data-phase'), '2');
    assert.deepEqual(await page.locator('.wb .shelf-heading h3').allTextContents(), ['Sequential model', 'Generative SID model']);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(root.traditional));
    assert.deepEqual(await shelf(page, 'sid-shelf'), ids(root.shelves.one_cosine));
    assert.equal(await page.getByTestId('sid-shelf').locator('article.is-target').getAttribute('data-item'), String(target));
    assert.equal(await page.locator('.wb .s4-rule').textContent(), 'Resolver: one item per SID, most similar.');
    assert.deepEqual(await inputs(page), expectedInputs(pair, root.history, []));
    assert.ok(await page.getByRole('button', {name:'Undo', exact:true}).isDisabled());
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
  await bench(page, pair, root.history);
  const benchmarksOf = Object.fromEntries(await Promise.all(manifest.pairs.map(async row => [row.id, await json(row.benchmark)])));
  // The line above the lists: where each model ranks the next purchase of `history`.
  function revealLine(row, start, history, strategy = 'one_cosine') {
    const next = media.targets[history];
    const [s, t] = [start.shelves[strategy], start.traditional].map(cards => ids(cards).indexOf(next) + 1);
    return s && t ? `${row.sid} ranks the next purchase #${s}. ${row.traditional} ranks it #${t}.`
      : s ? `${row.sid} ranks the next purchase #${s}. ${row.traditional} does not have it in its top 5.`
      : t ? `${row.traditional} ranks the next purchase #${t}. ${row.sid} does not have it in its top 5.` : 'Neither model has the next purchase in its top 5.';
  }
  // The four score tiles as [metric, `class:text` of each part of the label, value].
  const tiles = target => target.locator('section.wb-scores > dl.wb-tiles > div').evaluateAll(list => list.map(tile =>
    [tile.dataset.metric, [...tile.querySelector('dt').children].map(part => `${part.className}:${part.textContent}`), tile.querySelector('dd').textContent]));
  const tilesOf = (row, metrics, strategy) => [['traditional', [`model-name traditional:${row.traditional}`, 'wb-tile-level:Item-level']],
    [strategy, [`model-name semantic:${row.sid}`, 'wb-tile-level:Item-level', 'wb-tile-note:with the resolver above']],
    ['sid', [`model-name semantic:${row.sid}`, 'wb-tile-level:SID-level']], ['cce', [`model-name semantic:${row.sid}`, 'wb-tile-level:CCE']]]
    .map(([key, label]) => [key, label, metrics[key].recall.toFixed(3)]);
  const undo = () => page.getByRole('button', {name:'Undo', exact:true}).click();
  await check('workbench: eight pairs via the two model selects, with their scores', async () => {
    assert.equal(manifest.pairs.length, 8);
    const options = label => select(page, label).locator('option').evaluateAll(list => list.map(option => [option.value, option.textContent]));
    assert.deepEqual(await options('Sequential model'), [...new Set(manifest.pairs.map(row => row.traditional))].map(name => [name, name]));
    assert.deepEqual(await options('Generative SID model'), [...new Set(manifest.pairs.map(row => row.sid))].map(name => [name, name]));
    const singles = [];
    for (const row of manifest.pairs) {
      await pickPair(page, row);
      const start = await state(row.id, seed), {metrics, query_count} = benchmarksOf[row.id];
      const {p, h, s, t, v} = await params(page);
      assert.deepEqual([p, h, s, t, v], [row.id, seed, 'one_cosine', undefined, 'explore'], row.id);
      assert.deepEqual([await select(page, 'Sequential model').inputValue(), await select(page, 'Generative SID model').inputValue()], [row.traditional, row.sid]);
      assert.deepEqual(await page.locator('.wb .shelf-heading .model-name').allTextContents(), [row.traditional, row.sid]);
      assert.deepEqual(await history(page), root.history, row.id);
      assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(start.traditional), row.id);
      assert.deepEqual(await shelf(page, 'sid-shelf'), ids(start.shelves.one_cosine), row.id);
      assert.deepEqual(await inputs(page), expectedInputs(row, start.history, []), row.id);
      // The single-item note, only where every SID holds one item; there the four resolvers give the same list.
      const single = start.buckets.every(entry => entry.size === 1);
      if (single) singles.push(row.sid);
      assert.deepEqual(await page.locator('section.wb-settings > p.wb-single').allTextContents(),
        single ? [`Each of these ${row.sid} SIDs belongs to one item, so the resolver does not change the list.`] : [], row.id);
      if (single) for (const key of manifest.strategies) assert.deepEqual(ids(start.shelves[key]), ids(start.shelves.one_cosine), `${row.id} ${key}`);
      assert.equal(await page.locator('p.wb-reveal').textContent(), revealLine(row, start, seed), row.id);
      assert.equal(await page.locator('section.wb-scores > h2#wb-scores-heading').textContent(), 'Scores for this pair');
      assert.equal(await page.locator('section.wb-scores > p').textContent(), `Recall@5 on ${query_count.toLocaleString()} test users. They do not score the items you add.`);
      assert.deepEqual(await tiles(page), tilesOf(row, metrics, 'one_cosine'), row.id);
    }
    assert.deepEqual(singles, ['RPG', 'TIGER', 'RPG', 'TIGER']);
    await pickPair(page, pair);
  });
  const hair = pair.seeds.find(row => row.label === 'Hair care, 9 purchases');
  const hairRoot = await state(pair.id, hair.id);
  await check('workbench: the History select keeps the pair and the resolver', async () => {
    const picker = select(page, 'History');
    assert.deepEqual(await picker.locator('option').evaluateAll(list => list.map(option => [option.value, option.textContent])), pair.seeds.map(row => [row.id, row.label]));
    assert.equal(await picker.inputValue(), seed);
    await picker.selectOption({label:hair.label});
    await bench(page, pair, hairRoot.history);
    const {p, h, s, t, v} = await params(page);
    assert.deepEqual([p, h, s, t, v], [pair.id, hair.id, 'one_cosine', undefined, 'explore']);
    assert.equal(hairRoot.history.length, 9);
    assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(hairRoot.traditional));
    assert.deepEqual(await shelf(page, 'sid-shelf'), ids(hairRoot.shelves.one_cosine));
    assert.deepEqual(await inputs(page), expectedInputs(pair, hairRoot.history, []));
    assert.equal(await page.locator('p.wb-reveal').textContent(), revealLine(pair, hairRoot, hair.id));
    assert.equal(await page.locator('.wb-title > h1').textContent(), heading);
  });
  await check('workbench: a model change keeps h= and drops t=', async () => {
    await choose(page, 'traditional-shelf');
    await page.waitForFunction(n => document.querySelectorAll('.wb .journey-timeline li[data-item]').length === n, hairRoot.history.length + 1);
    await bench(page, pair);
    assert.match(await page.evaluate(() => location.hash), new RegExp(`[#&]h=${hair.id}&s=one_cosine&t=[^&,]+&`));
    assert.equal(await page.locator('p.wb-reveal').count(), 0);
    for (const [label, id] of [['Generative SID model', 'sasrec-diffgrm'], ['Sequential model', 'bert-mlm-diffgrm']]) {
      const row = manifest.pairs.find(entry => entry.id === id), start = await state(id, hair.id);
      await select(page, label).selectOption(label === 'Sequential model' ? row.traditional : row.sid);
      await bench(page, row, hairRoot.history);
      const {p, h, s, t, v} = await params(page);
      assert.deepEqual([p, h, s, t, v], [id, hair.id, 'one_cosine', undefined, 'explore'], id);
      assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(start.traditional), id);
      assert.deepEqual(await shelf(page, 'sid-shelf'), ids(start.shelves.one_cosine), id);
      assert.equal(await page.locator('p.wb-reveal').textContent(), revealLine(row, start, hair.id), id);
      assert.ok(await page.getByRole('button', {name:'Undo', exact:true}).isDisabled(), id);
    }
    await pickPair(page, pair);
    await select(page, 'History').selectOption(seed);
    await bench(page, pair, root.history);
  });
  await check('workbench: the Resolver select changes the SID list and the resolver line', async () => {
    const picker = select(page, 'Resolver');
    assert.deepEqual(await picker.locator('option').evaluateAll(list => list.map(option => [option.value, option.textContent])), manifest.strategies.map(key => [key, resolvers[key]]));
    assert.equal(await picker.inputValue(), 'one_cosine');
    const {metrics} = benchmarksOf[pair.id];
    for (const key of [...manifest.strategies.filter(key => key !== 'one_cosine'), 'one_cosine']) {
      await picker.selectOption(key);
      await page.waitForFunction(([text, key]) => document.querySelector('.wb .s4-rule')?.textContent === text && location.hash.includes(`&s=${key}&`), [`Resolver: ${lower(resolvers[key])}.`, key]);
      assert.equal((await params(page)).s, key);
      assert.deepEqual(await shelf(page, 'sid-shelf'), ids(root.shelves[key]), key);
      assert.deepEqual(await page.getByTestId('sid-shelf').locator('button.sid-pill').allTextContents(), root.shelves[key].map(card => card.address.join('·')), key);
      assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(root.traditional), key);
      assert.deepEqual(await history(page), root.history, key);
      assert.equal(await page.locator('p.wb-reveal').textContent(), revealLine(pair, root, seed, key), key);
      assert.deepEqual(await tiles(page), tilesOf(pair, metrics, key), key);
      if (key !== 'expand_popularity') continue;
      // After an Add the SID list still follows the resolver.
      const [item] = ids(root.shelves[key]), after = await state(pair.id, root.next[String(item)]);
      await choose(page, 'sid-shelf');
      await steered(page, 1);
      assert.deepEqual(await history(page), [...root.history, item]);
      assert.deepEqual(await shelf(page, 'sid-shelf'), ids(after.shelves[key]));
      assert.deepEqual(await shelf(page, 'traditional-shelf'), ids(after.traditional));
      assert.equal(await page.getByTestId('sid-shelf').locator('article.is-new').count(), shelfDiff(ids(root.shelves[key]), ids(after.shelves[key])).newCount);
      await undo();
      await steered(page, 0);
    }
  });
  await check('workbench: a SID pill opens the SID panel under the lists', async () => {
    const pills = page.getByTestId('sid-shelf').locator('button.sid-pill');
    assert.deepEqual(await pills.allTextContents(), root.shelves.one_cosine.map(card => sidText(card.address)));
    await pills.first().click();
    const panel = page.locator('.wb .s4 > .s4-shelves + .s4-code');
    await panel.waitFor();
    assert.equal(await panel.locator('h2').textContent(), 'One SID, 1,643 items');
    assert.equal(await panel.locator('.s4-code-pill').textContent(), `SID ${bucket.address.join('·')}`);
    assert.equal(await panel.locator('.bucket-breakdown h3').textContent(), 'Categories in this SID');
    const rows = await panel.locator('.bucket-breakdown li').evaluateAll(lis => lis.map(li => [li.querySelector('span').textContent, Number(li.querySelector('strong').textContent.replace(/\D/g, ''))]));
    assert.deepEqual(rows, media.buckets[pair.sid][bucket.address.join(',')].categories);
    // It scrolls into view instead of opening at the bottom of the page.
    await page.waitForFunction(() => {const box = document.querySelector('.wb .s4-code').getBoundingClientRect(); return box.top >= -1 && box.bottom <= innerHeight + 1;});
    const card = root.shelves.one_cosine[1], size = root.buckets.find(entry => entry.address.join() === card.address.join()).size;
    await pills.nth(1).click();
    await page.waitForFunction(text => document.querySelector('.wb .s4-code .s4-code-pill')?.textContent === text, `SID ${card.address.join('·')}`);
    assert.equal(await panel.locator('h2').textContent(), `One SID, ${count(size, 'item')}`);
    await panel.getByRole('button', {name:'Close', exact:true}).click();
    await panel.waitFor({state:'detached'});
  });
  await check('workbench: no two-items-one-SID comparison, no save, replay or share, none of the old controls', async () => {
    const gone = ['.s4-back', '[data-testid="same-sid-step"]', '.s4-go', '.s4-same-line', '.s4-same-none', '.s4-picker', 'label.s4-pick',
      '.bucket-link', 'details.full-name', '.strip-toggle', '.journey-inspector', '.journey-recap', '.journey-question',
      '.wb-actions', '.s4-prefixes', 'input[type="file"]', '.share-qr'];
    for (const row of [pair, ...['sasrec-rpg', 'bert-mlm-diffgrm'].map(id => manifest.pairs.find(entry => entry.id === id))]) {
      await pickPair(page, row);
      assert.deepEqual(await Promise.all(gone.map(selector => page.locator(selector).count())), gone.map(() => 0), row.id);
      for (const text of ['Two items, one SID', 'How each model reads the history', 'Choose items to add', 'Details', 'Why?', 'Restart', 'Try another model', 'Full name',
        'Save journey', 'Replay journey', 'Share'])
        assert.equal(await page.getByText(text, {exact:true}).count(), 0, `${row.id}: ${text}`);
      assert.equal(await page.getByText(/^Choice \d of \d$/).count(), 0, row.id);
      assert.equal(await page.locator('h1').count(), 1, row.id);
      assert.equal(await page.locator('.wb .s4').getAttribute('data-phase'), '2', row.id);
    }
    await pickPair(page, pair);
  });
  await check('workbench: two Adds give the recap and ten final suggestions; the reveal line only at depth 0', async () => {
    const reveal = page.locator('p.wb-reveal');
    assert.equal(await reveal.textContent(), revealLine(pair, root, seed));
    await choose(page, 'traditional-shelf');
    await steered(page, 1);
    assert.equal(await reveal.count(), 0);
    assert.deepEqual(await history(page), next.history);
    assert.equal(await page.locator('.wb .s4-change').textContent(), `SASRec: ${itemsPhrase(shelfDiff(ids(root.traditional), ids(next.traditional)))}. LETTER: ${sidsPhrase(codesDiff(root, next))}.`);
    assert.deepEqual(await inputs(page), expectedInputs(pair, root.history, [first]));
    assert.match(await page.evaluate(() => location.hash), /[#&]t=[^&,]+&/);
    await choose(page, 'sid-shelf');
    await steered(page, 2);
    assert.equal(await reveal.count(), 0);
    assert.deepEqual(await history(page), last.history);
    assert.equal(await page.locator('.wb .s4-bar .tour-takeaway').textContent(), recap);
    assert.equal(await page.getByRole('button', {name:/^Final suggestion: /}).count(), 10);
    assert.equal(await page.locator('.wb .choose-product:not(:disabled)').count(), 0);
    for (const depth of [1, 0]) {
      await undo();
      await steered(page, depth);
      assert.equal(await reveal.count(), depth ? 0 : 1);
    }
    assert.equal(await reveal.textContent(), revealLine(pair, root, seed));
  });
  await check('workbench: a reload or a link with the journey in its address restores it', async () => {
    await choose(page, 'traditional-shelf');
    await steered(page, 1);
    await choose(page, 'sid-shelf');
    await steered(page, 2);
    const hash = await page.evaluate(() => location.hash);
    assert.match(hash, new RegExp(`^#p=${pair.id}&h=${seed}&s=one_cosine&t=${root.next[String(first)]},${next.next[String(second)]}&(r=1&)?v=explore$`));
    await page.reload();
    await bench(page, pair, last.history);
    assert.equal(await page.evaluate(() => location.hash), hash);
    assert.deepEqual(await focused(page), ['H1', heading]);
    assert.deepEqual(await inputs(page), expectedInputs(pair, root.history, [first, second]));
    assert.equal(await page.locator('.wb .s4-bar .tour-takeaway').textContent(), recap);
    assert.equal(await page.getByRole('button', {name:/^Final suggestion: /}).count(), 10);
    // The same address without `v` opens the workbench too; a step that is not in the data falls back to the history.
    const link = await openAt(hash.replace(/&v=explore$/, ''));
    try {
      await bench(link, pair, last.history);
      assert.equal(await link.locator('.wb .s4-bar .tour-takeaway').textContent(), recap);
    } finally {await link.close();}
    const broken = await openAt(`#p=${pair.id}&h=${seed}&s=one_cosine&t=${root.next[String(first)]},0000&v=explore`);
    try {
      await bench(broken, pair, root.history);
      assert.equal(await broken.locator('p.wb-reveal').textContent(), revealLine(pair, root, seed));
    } finally {await broken.close();}
    for (const depth of [1, 0]) {
      await undo();
      await steered(page, depth);
    }
  });
  await check('workbench: All models chart with the DIGER row; Recall and NDCG table', async () => {
    const panels = page.locator('section.wb-scores > details.wb-more');
    assert.deepEqual(await panels.locator('summary').allTextContents(), ['All models', 'Recall and NDCG']);
    assert.deepEqual(await panels.evaluateAll(list => list.map(element => element.open)), [false, false]);
    await panels.nth(0).locator('summary').click();
    const chart = panels.nth(0).locator('.recall-chart svg');
    await chart.waitFor();
    // One row per model with its Recall@5 values, as on step 5: item-level for the sequential models, then item-level
    // under the current resolver, SID-level and CCE for each SID model, then DIGER.
    const chartOf = strategy => {
      const rows = new Map();
      for (const row of manifest.pairs) if (!rows.has(row.traditional)) rows.set(row.traditional, [benchmarksOf[row.id].metrics.traditional]);
      for (const row of manifest.pairs) if (!rows.has(row.sid)) rows.set(row.sid, [strategy, 'sid', 'cce'].map(key => benchmarksOf[row.id].metrics[key]));
      rows.set('DIGER', ['item', 'sid', 'cce'].map(key => extra[0].metrics[key]));
      return [...rows].map(([name, values]) => [name, values.map(value => value.recall.toFixed(3))]);
    };
    assert.deepEqual(await chartRows(page), chartOf('one_cosine'));
    assert.equal(await chart.locator('path').count(), 2 + 4 * 3 + 3);
    assert.deepEqual(await panels.nth(0).locator('.chart-legend li').allTextContents(), ['Item-level', 'SID-level', 'CCE', 'Resolver: One item per SID, most similar']);
    assert.deepEqual(await panels.nth(0).locator('.chart-label.is-current').allTextContents(), ['SASRec', 'LETTER']);
    await panels.nth(1).locator('summary').click();
    const table = panels.nth(1).locator('table.wb-table');
    await table.waitFor();
    const read = () => table.locator('tr').evaluateAll(rows => rows.map(row => [...row.children].map(cell => cell.textContent)));
    const {metrics} = benchmarksOf[pair.id];
    const tableOf = key => [['Model', 'Level', 'Recall@5', 'NDCG@5'], ...[['traditional', pair.traditional, 'Item-level'],
      [key, pair.sid, `Item-level, ${lower(resolvers[key])}`], ['sid', pair.sid, 'SID-level'], ['cce', pair.sid, 'CCE']]
      .map(([metric, model, level]) => [model, level, metrics[metric].recall.toFixed(4), metrics[metric].ndcg.toFixed(4)])];
    assert.deepEqual(await read(), tableOf('one_cosine'));
    // Both follow the resolver.
    await select(page, 'Resolver').selectOption('expand_cosine');
    await page.waitForFunction(() => document.querySelector('.wb-scores .chart-policy')?.textContent === 'Resolver: All items per SID, most similar');
    assert.deepEqual(await chartRows(page), chartOf('expand_cosine'));
    assert.deepEqual(await read(), tableOf('expand_cosine'));
    await select(page, 'Resolver').selectOption('one_cosine');
    await page.waitForFunction(() => document.querySelector('.wb-scores .chart-policy')?.textContent === 'Resolver: One item per SID, most similar');
    // Plain words: none of the old protocol text.
    assert.doesNotMatch(await page.locator('section.wb-scores').textContent(), /frozen|study|compact|distinct|complete SIDs|protocol/i);
    for (const summary of await panels.locator('summary').all()) await summary.click();
  });
  // Whether a page has fetched prefixes.json so far.
  const fetchedPrefixes = target => target.evaluate(() => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname === '/journeys/prefixes.json'));
  // A resource timing buffer large enough for every request of a long walk.
  const timing = () => performance.setResourceTimingBufferSize(5000);
  await check('workbench: the SID panel has no prefix list; prefixes.json loads on step 0 only', async () => {
    for (const id of ['sasrec-letter', 'sasrec-tiger', 'sasrec-rpg', 'sasrec-diffgrm']) {
      const row = manifest.pairs.find(entry => entry.id === id), start = await state(id, seed);
      const view = await openAt(`#p=${id}&v=explore`, {init:timing});
      try {
        await bench(view, row, start.history);
        const pills = view.getByTestId('sid-shelf').locator('button.sid-pill');
        for (const [i, card] of start.shelves.one_cosine.entries()) {
          await pills.nth(i).click();
          await view.waitForFunction(text => document.querySelector('.wb .s4-code .s4-code-pill')?.textContent === text, `SID ${card.address.join('·')}`);
          assert.equal(await view.locator('.s4-prefixes, .s0-prefix-rows').count(), 0, `${id} ${card.item}`);
        }
        assert.equal(await fetchedPrefixes(view), false, id);
      } finally {await view.close();}
    }
    // Steps 1-5 with step 4's SID panel open do not load it; step 0 does.
    const tour = await openAt('#r=1&v=tour&sc=1', {init:timing});
    try {
      await scene(tour, 1);
      for (const n of [2, 3, 4, 5]) {
        await tour.getByRole('button', {name:'Next', exact:true}).click();
        await scene(tour, n);
        if (n !== 4) continue;
        await tour.getByRole('button', {name:'Choose items to add', exact:true}).click();
        await tour.getByTestId('sid-shelf').locator('button.sid-pill').first().click();
        await tour.locator('.s4-code .bucket-breakdown').waitFor();
        assert.equal(await tour.locator('.s4-prefixes').count(), 0);
      }
      assert.equal(await fetchedPrefixes(tour), false);
      await tour.locator('.tour-steps button', {hasText:'Shopper'}).click();
      await scene(tour, 1);
      await tour.getByRole('button', {name:'Preliminaries', exact:true}).click();
      await scene(tour, 0);
      await tour.locator('ol.s0-prefix-rows > li').first().waitFor();
      assert.equal(await fetchedPrefixes(tour), true);
    } finally {await tour.close();}
  });
  await check('every pair lists the same six histories', async () => {
    const seeds = pair.seeds.map(row => row.id);
    assert.equal(seeds.length, 6);
    assert.deepEqual(pair.seeds.slice(0, 2).map(row => row.query_index), [145, 210]);
    for (const row of manifest.pairs) {
      assert.deepEqual(row.seeds.map(entry => entry.id), seeds, `${row.id} lists other histories`);
      await pickPair(page, row);
      assert.deepEqual(await select(page, 'History').locator('option').evaluateAll(options => options.map(option => option.value)), seeds, row.id);
    }
  });
  await check('prefixes.json: every 1-3 token prefix of the TIGER SIDs, with the measured statistic and the files it names', async () => {
    assert.deepEqual(Object.keys(prefixes).sort(), ['prefixes', 'source', 'stats']);
    assert.deepEqual(Object.keys(prefixes.prefixes), ['TIGER']);
    assert.deepEqual(Object.keys(prefixes.source).sort(), ['TIGER', 'metadata']);
    // Paths are relative to the Cornac checkout; the SID table is the one sids.json names.
    const checkout = path.join(demo, '../..');
    for (const [name, {file, sha256}] of Object.entries(prefixes.source))
      assert.equal(createHash('sha256').update(await readFile(path.join(checkout, file))).digest('hex'), sha256, name);
    assert.deepEqual(prefixes.source.TIGER, sids.source.TIGER);
    // Step 0's statistic is the one measured over all items.
    const similarity = JSON.parse(await readFile(path.join(checkout, 'runs/www2027-demo-journeys-2026-11-09/tour-r8/prefix/prefix_similarity.json'), 'utf8'));
    const first = similarity.models.tiger.rows.find(row => row.prefix === 1);
    assert.deepEqual(prefixes.stats, {items:similarity.items, first_token_same_top:first.top, random_same_top:similarity.random.top});
    assert.deepEqual([prefixes.stats.items, percent(prefixes.stats.first_token_same_top), percent(prefixes.stats.random_same_top)], [12068, '84%', '23%']);
    const table = sids.sids.TIGER;
    const pictured = Object.keys(media.items).map(Number).filter(item => media.items[String(item)].image).sort((a, b) => a - b);
    const prefixOf = (item, k) => table[String(item)].slice(0, k).join(',');
    // Shown items per prefix, from sids.json.
    const shown = {};
    for (const sid of Object.values(table)) for (const k of [1, 2, 3]) {const key = sid.slice(0, k).join(','); shown[key] = (shown[key] ?? 0) + 1;}
    assert.deepEqual(Object.keys(groups).sort(), Object.keys(shown).sort());
    // Sizes count the whole catalog: at least the shown items, never more than the shorter prefix. Up to three
    // categories, largest first, within the size; members are the first 12 pictured items with the prefix.
    const bad = [];
    for (const [key, row] of Object.entries(groups)) {
      const k = key.split(',').length, parent = key.split(',').slice(0, -1).join(','), counts = row.top.map(([, n]) => n);
      const members = pictured.filter(item => prefixOf(item, k) === key).slice(0, 12);
      if (row.size < shown[key] || (parent && row.size > groups[parent].size) || !counts.length || counts.length > 3
        || counts.some((n, i) => n < 1 || (i && n > counts[i - 1])) || counts.reduce((a, b) => a + b, 0) > row.size
        || JSON.stringify(row.members) !== JSON.stringify(members)) bad.push(key);
    }
    assert.deepEqual(bad.slice(0, 5), []);
    assert.equal(Object.keys(groups).length, 4316);
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
      await pickPair(page, row);
      for (const entry of row.seeds) {
        if (await select(page, 'History').inputValue() !== entry.id) await select(page, 'History').selectOption(entry.id);
        await bench(page, row, (await state(row.id, entry.id)).history);
        const shown = await names();
        assert.ok(shown.length >= 30);
        assert.deepEqual(shown.filter(text => text.startsWith('Item ')), [], `${row.id} ${entry.id}`);
      }
    }
  });
  await check('kiosk captions play scenes 1-3 with the demo card open and stop on input', async () => {
    // The idle timer reads window.__kioskIdleMs when it (re)starts and keeps a preset value, so set it before load.
    const kiosk = await openAt('#k=1', {init:() => {window.__kioskIdleMs = 1000;}});
    try {
      const caption = kiosk.locator('.kiosk-caption'), aside = kiosk.locator('aside.demo-qr');
      // The caption shows a frame before its scene change, so both are awaited together.
      const shown = (text, n) => kiosk.waitForFunction(([start, scene]) => document.querySelector('.kiosk-caption')?.textContent.startsWith(start)
        && document.querySelector('.tour')?.dataset.scene === scene, [text, String(n)], {timeout:10000});
      await shown("One user's purchase history.", 1);
      // While the loop plays, the demo card is open.
      await cardIs(kiosk, true);
      assert.deepEqual([await aside.evaluate(element => element.classList.contains('is-open')), await aside.locator('button.demo-qr-tab').getAttribute('aria-expanded')], [true, 'true']);
      await encodes(aside.locator('.qr'), demoUrl);
      await shown(`Next purchase: ${named(target)}.`, 1);
      await kiosk.locator(`.tour-pick.is-target[data-item="${target}"]`).waitFor();
      await shown('SASRec and LETTER, same history.', 2);
      await shown('One SID, 1,643 items.', 3);
      await kiosk.waitForFunction(() => document.querySelector('.s3-row .s3-pick')?.dataset.item === '695', null, {timeout:10000});
      assert.ok(await cardShown(kiosk), 'open through the loop');
      // A long idle spell after the input keeps the page with the visitor; the card closes with the loop.
      await kiosk.evaluate(() => {window.__kioskIdleMs = 60000;});
      await kiosk.locator('body').dispatchEvent('pointerdown');
      await caption.waitFor({state:'detached', timeout:2000});
      await cardIs(kiosk, false);
      assert.equal(await aside.locator('button.demo-qr-tab').getAttribute('aria-expanded'), 'false');
      const at3 = await kiosk.locator('.tour').getAttribute('data-scene');
      await kiosk.waitForTimeout(1500);
      assert.equal(await caption.count(), 0);
      assert.equal(await kiosk.locator('.tour').getAttribute('data-scene'), at3);
    } finally {await kiosk.close();}
    // Below 900 px the loop plays without the card.
    const small = await openAt('#k=1', {viewport:{width:390, height:844}, init:() => {window.__kioskIdleMs = 1000;}});
    try {
      await small.locator('.kiosk-caption').waitFor({timeout:10000});
      assert.equal(await small.locator('aside.demo-qr').isVisible(), false);
    } finally {await small.close();}
  });
  await check('no visible text says "code", in the tour or in the workbench', async () => {
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
    const tour = await openBasics('#v=tour&sc=0');
    try {
      await tour.locator('ol.s0-prefix-rows > li > button.s0-show').first().click();
      await tour.locator('.s0-prefix-items li[data-item]').first().waitFor();
      await scan(tour, 'step 0');
      await tour.getByRole('button', {name:'Try it on a real history', exact:true}).click();
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
      await bench(tour, pair, last.history);
      await tour.getByTestId('sid-shelf').locator('button.sid-pill').first().click();
      await tour.locator('.wb .s4-code').waitFor();
      for (const summary of await tour.locator('details.wb-more > summary').all()) await summary.click();
      await tour.locator('.wb-scores .recall-chart svg').waitFor();
      await tour.locator('.wb-scores table.wb-table').waitFor();
      await scan(tour, 'workbench recap');
      await tour.locator('button.demo-qr-tab').click();
      await cardIs(tour, true);
      await scan(tour, 'demo card');
      await tour.keyboard.press('Escape');
      await tour.mouse.move(0, 0);
      await cardIs(tour, false);
      for (const depth of [1, 0]) {await tour.getByRole('button', {name:'Undo', exact:true}).click(); await steered(tour, depth);}
      await scan(tour, 'workbench start');
    } finally {await tour.close();}
    for (const hash of ['#p=sasrec-rpg&v=tour&sc=0', '#p=sasrec-rpg&v=tour&sc=2', '#p=sasrec-rpg&v=tour&sc=3', '#p=sasrec-rpg&v=tour&sc=4',
      `#p=sasrec-diffgrm&h=${pair.seeds[1].id}&v=tour&sc=3`, `#p=sasrec-diffgrm&h=${pair.seeds[1].id}&v=tour&sc=4`, '#p=sasrec-rpg&v=explore', `#p=sasrec-diffgrm&h=${pair.seeds[1].id}&v=explore`]) {
      const other = await openAt(hash);
      try {
        await other.locator('.tour-scene h1, .wb-title h1').first().waitFor();
        await other.waitForLoadState('networkidle');
        await scan(other, hash);
      } finally {await other.close();}
    }
    assert.deepEqual(found, []);
  });
  await check('no horizontal overflow on steps 0-5 and the workbench at 1440, 1024 and 390', async () => {
    for (const [width, height] of [[1440,1000],[1024,768],[390,844]]) {
      // Step 0 on two histories (the longest group line on Fragrance); panels 2 and 3 sit side by side down to 900 px.
      for (const hash of ['#v=tour&sc=0', `#h=${pair.seeds[5].id}&v=tour&sc=0`]) {
        const basics = await openBasics(hash, {viewport:{width, height}});
        try {
          assert.ok(await fits(basics), `${width} step 0 ${hash}`);
          // The first-token panel holds the most items.
          await basics.locator('ol.s0-prefix-rows > li > button.s0-show').first().click();
          await basics.locator('.s0-prefix-items li[data-item]').first().waitFor();
          assert.ok(await fits(basics), `${width} step 0 ${hash} panel open`);
          const [left, right] = await Promise.all(['section.s0-sequential', 'section.s0-sid'].map(selector => box(basics, selector)));
          assert.ok(width > 900 ? Math.abs(left.top - right.top) <= 1 : right.top >= left.bottom, `${width} step 0 panels ${JSON.stringify({left, right})}`);
        } finally {await basics.close();}
      }
      // The workbench at the start, with both score panels open, then after two Adds with the SID panel open.
      const bench0 = await openAt('#v=explore', {viewport:{width, height}});
      try {
        await bench(bench0, pair, root.history);
        assert.ok(await fits(bench0), `${width} workbench`);
        for (const summary of await bench0.locator('details.wb-more > summary').all()) await summary.click();
        await bench0.locator('.wb-scores .recall-chart svg').waitFor();
        await bench0.locator('.wb-scores table.wb-table').waitFor();
        assert.ok(await fits(bench0), `${width} workbench scores`);
        await choose(bench0, 'traditional-shelf');
        await steered(bench0, 1);
        await choose(bench0, 'sid-shelf');
        await steered(bench0, 2);
        await bench0.getByTestId('sid-shelf').locator('button.sid-pill').first().click();
        await bench0.locator('.wb .s4-code').waitFor();
        assert.ok(await fits(bench0), `${width} workbench after two Adds`);
      } finally {await bench0.close();}
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
  await check('video page: the one-minute tour, muted and looping, with its captions track', async () => {
    await page.goto(new URL('video/', url).href);
    const video = await page.locator('main video').evaluate(element => ({muted:element.muted, loop:element.loop, autoplay:element.autoplay,
      poster:element.getAttribute('poster'), sources:[...element.querySelectorAll('source')].map(source => [source.getAttribute('src'), source.type]),
      tracks:[...element.querySelectorAll('track')].map(track => [track.kind, track.getAttribute('src'), track.srclang, track.default])}));
    assert.deepEqual(video, {muted:true, loop:true, autoplay:true, poster:'poster.jpg', sources:[['cornac-workbench-tour.mp4', 'video/mp4']],
      tracks:[['captions', 'cornac-workbench-tour.vtt', 'en', false]]});
    assert.equal(await page.getByRole('link', {name:'Open the demo'}).getAttribute('href'), '/');
    // Playwright's Chromium has no H.264 decoder, so the duration comes from the MP4's movie header.
    const mp4 = Buffer.from(await (await fetch(new URL('video/cornac-workbench-tour.mp4', url))).arrayBuffer());
    const at = mp4.indexOf('mvhd');
    const seconds = mp4[at + 4] === 1 ? Number(mp4.readBigUInt64BE(at + 28)) / mp4.readUInt32BE(at + 24) : mp4.readUInt32BE(at + 20) / mp4.readUInt32BE(at + 16);
    assert.ok(seconds > 55 && seconds < 65, `video lasts ${seconds} s`);
    assert.ok(mp4.includes('avc1') && at < mp4.indexOf('mdat'), 'H.264 with the movie header first');
    const vtt = await (await fetch(new URL('video/cornac-workbench-tour.vtt', url))).text();
    assert.ok(vtt.startsWith('WEBVTT') && vtt.includes("But 1,643 items share LETTER's SID."));
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
  const hashed = [...['src/Journeys.jsx','src/journeyParts.jsx','src/journeyExtras.jsx','src/journeys.css','src/Explore.jsx','src/explore.css',...tour,'src/main.jsx','index.html'].map(name=>path.join(web,name)),
    ...['index.html',...(await readdir(path.join(dist,'assets'))).map(name=>`assets/${name}`)].map(name=>path.join(dist,name)),
    path.join(web,'public/journeys/manifest.json'),path.join(dist,'journeys/manifest.json'),path.join(web,'public/journeys/media.json'),path.join(web,'public/journeys/prefixes.json'),
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
    scope:'Scripted browser checks of the tour (step 0 and the five steps) and the workbench of the static site with eight prepared Beauty model pairs; it is not a model benchmark or a user study.'},null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,firstRenderMs,choiceMs,receipt}));
} catch (error) {
  await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
  console.error(error,errors,failed); process.exitCode=1;
} finally {await browser.close();}
