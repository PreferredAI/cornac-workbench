import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Paper figures: tour scene 2 after the reveal and scene 3 after one switch of the picking rule, for the default
// SASRec/LETTER journey (query 145), each cropped to the tour column from the H1 to the end of the scene.
// With --og, saves only the 1200x630 link preview of scene 1 before the pick to web/public/og.png.
const url = process.env.JOURNEY_URL || 'http://127.0.0.1:8110';
const evidence = process.env.JOURNEY_EVIDENCE_DIR || fileURLToPath(new URL('../../', import.meta.url));
const og = process.argv.includes('--og');
const PAD = 8;
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
// Page rows equal PNG rows (device scale factor 1); the crop keeps the scene's column from its H1 down.
async function capture(page, name) {
  await settle(page);
  const box = await page.evaluate(() => {
    const scene = document.querySelector('.tour-scene').getBoundingClientRect();
    const heading = document.querySelector('.tour-scene h1').getBoundingClientRect();
    return {x:scene.left, top:heading.top + scrollY, bottom:scene.bottom + scrollY, width:scene.width,
      page:[document.documentElement.scrollWidth, document.documentElement.scrollHeight]};
  });
  const clip = {x:Math.round(box.x - PAD), y:Math.round(box.top - PAD), width:Math.round(box.width + 2 * PAD), height:Math.round(box.bottom - box.top + 2 * PAD)};
  const file = path.join(evidence, 'figures', name);
  await page.screenshot({path:file, fullPage:true, clip, animations:'disabled'});
  const [width, height] = await pngSize(file);
  assert.deepEqual([width, height], [clip.width, clip.height]);
  console.log(`% ${name}: ${width}x${height} px; crop of the ${box.page.join('x')} page at x=${clip.x}, rows ${clip.y}-${clip.y + clip.height}`);
}
try {
  const page = await browser.newPage({viewport:og ? {width:1200,height:630} : {width:1536,height:1024}, deviceScaleFactor:1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.goto(url);
  await page.locator('.tour-pick').nth(3).waitFor();
  if (og) {
    const file = fileURLToPath(new URL('../public/og.png', import.meta.url));
    await settle(page);
    await page.screenshot({path:file, animations:'disabled'});
    console.log(`% ${path.basename(file)}: ${(await pngSize(file)).join('x')} px scene 1 before the pick`);
  } else {
    await mkdir(path.join(evidence, 'figures'), {recursive:true});
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await page.locator('.tour[data-scene="2"] .tour-scene h1').waitFor();
    await page.getByTestId('tour-semantic-list').getByText('They bought this', {exact:true}).waitFor();
    assert.match(await page.evaluate(() => location.hash), /^#p=sasrec-letter&h=c38261d27a225339b377&s=one_cosine&/);
    await capture(page, 'journeys-paper-scene2.png');
    await page.getByRole('button', {name:'Next', exact:true}).click();
    await page.locator('.tour[data-scene="3"] .tour-scene h1').waitFor();
    await page.getByRole('radio', {name:'Most popular'}).check();
    await page.locator('.s3-scores dd').nth(2).waitFor();
    assert.deepEqual(await page.locator('.s3-scores dd').allTextContents(), ['0.196', '0.017', '0.004']);
    await capture(page, 'journeys-paper-scene3.png');
  }
  assert.deepEqual(errors, []);
} finally {await browser.close();}
