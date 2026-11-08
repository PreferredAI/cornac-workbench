import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Paper figure: the default SASRec/LETTER journey (query 145) after the reveal, with Details on.
// With --og, saves only the 1200x630 link preview of the opening screen to web/public/og.png.
const url = process.env.JOURNEY_URL || 'http://127.0.0.1:8110';
const evidence = process.env.JOURNEY_EVIDENCE_DIR || fileURLToPath(new URL('../../', import.meta.url));
const og = process.argv.includes('--og');
const file = og ? fileURLToPath(new URL('../public/og.png', import.meta.url)) : path.join(evidence, 'figures/journeys-paper-desktop.png');
await mkdir(path.dirname(file), {recursive:true});
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:og ? {width:1200,height:630} : {width:1536,height:1024}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.goto(url);
  await page.getByTestId('traditional-shelf').getByRole('button', {name:/^Guess /}).first().waitFor();
  if (!og) {
    await page.getByRole('button', {name:'Just show me', exact:true}).click();
    await page.getByRole('button', {name:'Details', exact:true}).click();
    assert.equal(await page.getByLabel('Journey model pair').inputValue(), 'sasrec-letter');
    assert.equal(await page.getByLabel('Starting story').inputValue(), 'c38261d27a225339b377');
    assert.equal(await page.getByLabel('SID to item strategy').inputValue(), 'one_cosine');
    await page.getByRole('rowheader',{name:'LETTER · SID',exact:true}).waitFor();
    // The Recall@5 chart loads after Details opens and sets the page height, so the bottom crop row.
    await page.locator('.recall-chart svg').waitFor();
  }
  await page.evaluate(async ()=>{
    document.activeElement?.blur(); scrollTo(0,document.documentElement.scrollHeight);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    scrollTo(0,0); await document.fonts.ready;
  });
  await page.waitForFunction(() => [...document.images].filter(image => image.checkVisibility()).every(image => image.complete));
  await page.screenshot({path:file,fullPage:!og,animations:'disabled'});
  assert.deepEqual(errors,[]);
  if (og) console.log(`% ${path.basename(file)}: 1200x630 px opening screen`);
  else {
    // Page rows equal PNG rows (device scale factor 1). Default crop keeps the history card through both shelves.
    const sections = await page.evaluate(() => Object.fromEntries(['app-header','journey-intro','journey-context',
      'journey-recommendations','same-sid-step','journey-benchmark'].map(name => {
      const box = document.querySelector(`.${name}`).getBoundingClientRect();
      return [name, [Math.round(box.top + scrollY), Math.round(box.bottom + scrollY)]];
    })));
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const top = sections['journey-context'][0] - 8, bottom = height - (sections['journey-recommendations'][1] + 8);
    console.log(`% ${path.basename(file)}: 1536x${height} px; crop rows T=${top} B=${bottom} ` +
      `(keeps the history card through both shelves). Sections [top,bottom]: ${JSON.stringify(sections)}`);
    console.log(`% \\includegraphics[width=\\textwidth,trim=0 ${bottom} 0 ${top},clip]{figures/${path.basename(file)}}`);
  }
} finally {await browser.close();}
