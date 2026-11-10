import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Paper figures for the default SASRec/LETTER journey (query 145) at 1000x1100, device scale 2, cropped to the tour
// column: step 2 after the reveal (H1 to list row 3), step 3 under the default resolver with row 1's ranking open
// (H1 to its sixth member and category bars), and step 4 phase 1 with item 88 picked (picker box to list row 3).
// With --og, saves only the 1200x630 link preview of step 2 after the reveal, header included, to web/public/og.png.
const url = process.env.JOURNEY_URL || 'http://127.0.0.1:8110';
const evidence = process.env.JOURNEY_EVIDENCE_DIR || fileURLToPath(new URL('../../', import.meta.url));
const og = process.argv.includes('--og');
const PAD = 8, SCALE = og ? 1 : 2;
const browser = await chromium.launch({headless:true});
const pngSize = async file => {const bytes = await readFile(file); return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];};
async function settle(page) {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    document.activeElement?.blur(); scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    scrollTo(0, 0); await document.fonts.ready;
  });
  await page.waitForFunction(() => [...document.images].filter(image => image.checkVisibility()).every(image => image.complete));
}
// Crops the scene's column from the top of `from` to the lowest bottom among `to` (page coordinates, CSS pixels);
// PNG pixels are SCALE times the crop.
async function capture(page, name, from, to) {
  await settle(page);
  const box = await page.evaluate(([from, to]) => {
    const scene = document.querySelector('.tour-scene').getBoundingClientRect();
    const ends = [...document.querySelectorAll(to)].map(element => element.getBoundingClientRect().bottom);
    return {x:scene.left, width:scene.width, top:document.querySelector(from).getBoundingClientRect().top + scrollY, bottom:Math.max(...ends) + scrollY,
      ends:ends.length, page:[document.documentElement.scrollWidth, document.documentElement.scrollHeight]};
  }, [from, to]);
  assert.ok(box.ends > 0, to);
  const clip = {x:Math.round(box.x - PAD), y:Math.round(box.top - PAD), width:Math.round(box.width + 2 * PAD), height:Math.round(box.bottom - box.top + 2 * PAD)};
  const file = path.join(evidence, 'figures', name);
  await page.screenshot({path:file, fullPage:true, clip, animations:'disabled'});
  const [width, height] = await pngSize(file);
  assert.deepEqual([width, height], [clip.width * SCALE, clip.height * SCALE]);
  console.log(`% ${name}: ${width}x${height} px; crop of the ${box.page.join('x')} page at x=${clip.x}, rows ${clip.y}-${clip.y + clip.height}, scale ${SCALE}`);
}
try {
  const page = await browser.newPage({viewport:og ? {width:1200,height:630} : {width:1000,height:1100}, deviceScaleFactor:SCALE});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.goto(url);
  await page.locator('.tour-pick').nth(3).waitFor();
  await page.getByRole('button', {name:'Next', exact:true}).click();
  await page.locator('.tour[data-scene="2"] .tour-scene h1').waitFor();
  await page.getByTestId('tour-semantic-list').getByText('Next purchase', {exact:true}).waitFor();
  assert.match(await page.evaluate(() => location.hash), /^#p=sasrec-letter&h=c38261d27a225339b377&s=one_cosine&/);
  if (og) {
    const file = fileURLToPath(new URL('../public/og.png', import.meta.url));
    await settle(page);
    await page.screenshot({path:file, animations:'disabled'});
    console.log(`% ${path.basename(file)}: ${(await pngSize(file)).join('x')} px; step 2 after the reveal, whole viewport`);
  } else {
    await mkdir(path.join(evidence, 'figures'), {recursive:true});
    const third = '.tour-list > li:nth-child(3)';
    await capture(page, 'journeys-paper-scene2.png', '.tour-scene h1', third);
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await page.locator('.tour[data-scene="3"] .tour-scene h1').waitFor();
    await page.locator('.s3-row').first().getByRole('button', {name:'Show ranking', exact:true}).click();
    const panel = page.locator('#s3-how-1');
    await panel.locator('.bucket-breakdown').waitFor();
    assert.equal(await panel.locator('ol.s3-members > li[data-item]').count(), 12);
    assert.equal(await panel.locator('p.s3-more').textContent(), '+ 1,631 more items');
    await page.locator('.s3-scores dd').nth(2).waitFor();
    assert.match(await page.evaluate(() => location.hash), /&s=one_cosine&/);
    assert.deepEqual(await page.locator('.s3-scores dd').allTextContents(), ['0.196', '0.017', '0.004']);
    await capture(page, 'journeys-paper-scene3.png', '.tour-scene h1', '#s3-how-1 ol.s3-members > li:nth-child(6), #s3-how-1 .bucket-breakdown');
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await page.locator('.tour[data-scene="4"] .s4[data-phase="1"]').waitFor();
    await page.locator('label.s4-pick[data-item="88"] input').check();
    await page.waitForFunction(() => document.querySelector('.s4 .semantic-heading li.s4-entry.is-new')?.dataset.item === '88'
      && document.querySelector('p.s4-same-line')?.textContent);
    await capture(page, 'journeys-paper-scene4.png', 'section.s4-same', '.s4-shelves .product-shelf > article:nth-child(3)');
  }
  assert.deepEqual(errors, []);
} finally {await browser.close();}
