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
await mkdir(output, {recursive:true});
await mkdir(path.join(evidence, 'figures'), {recursive:true});
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page = await context.newPage();
const errors = [], requests = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
page.on('request', request => requests.push(request.url()));
async function check(name, fn) {await fn(); checks.push({name,status:'passed'}); console.log(`PASS ${name}`);}
const started = performance.now();
try {
  await page.goto(url);
  await page.getByTestId('traditional-shelf').getByRole('button', {name:/Choose /}).first().waitFor();
  const firstRenderMs = performance.now() - started;
  await check('static page identity, meaningful content, no framework overlay', async () => {
    assert.match(await page.title(), /Beauty recommendation journeys/);
    assert.ok(await page.getByRole('heading',{name:'Compare recommendations'}).isVisible());
    assert.equal(await page.locator('vite-error-overlay').count(),0);
    assert.equal(await page.getByTestId('traditional-shelf').locator('article').count(),5);
    assert.equal(await page.getByTestId('sid-shelf').locator('article').count(),5);
  });
  await check('desktop comparison uses equal side-by-side columns with aligned product rows', async () => {
    const traditional = await page.getByTestId('traditional-shelf').boundingBox();
    const sid = await page.getByTestId('sid-shelf').boundingBox();
    assert.ok(Math.abs(traditional.y - sid.y) < 1);
    assert.ok(Math.abs(traditional.width - sid.width) < 1);
    assert.ok(sid.x >= traditional.x + traditional.width);
    for (let i = 0; i < 5; i++) {
      const left = await page.getByTestId('traditional-shelf').locator('article').nth(i).boundingBox();
      const right = await page.getByTestId('sid-shelf').locator('article').nth(i).boundingBox();
      assert.ok(Math.abs(left.y - right.y) < 1);
      assert.ok(Math.abs(left.height - right.height) < 1);
    }
  });
  const initialHistory = await page.locator('.journey-timeline li p').allTextContents();
  await check('four resolver policies change products without changing shared history', async () => {
    const shelves = [];
    for (const policy of ['one_popularity','one_cosine','expand_popularity','expand_cosine']) {
      await page.getByLabel('SID to item strategy').selectOption(policy);
      shelves.push(await page.getByTestId('sid-shelf').locator('h3').allTextContents());
      assert.deepEqual(await page.locator('.journey-timeline li p').allTextContents(),initialHistory);
    }
    assert.notDeepEqual(shelves[0],shelves[1]);
    assert.notDeepEqual(shelves[1],shelves[3]);
  });
  await check('bucket inspection shows real alternatives and scores', async () => {
    await page.getByTestId('sid-shelf').locator('.bucket-link').first().click();
    await page.getByRole('heading',{name:/One SID,/}).waitFor();
    assert.equal(await page.locator('.bucket-columns h3').count(),2);
    assert.ok(await page.locator('.bucket-columns li').count()>2);
    await page.getByRole('button',{name:'Close bucket inspector'}).click();
    assert.equal(await page.locator('.journey-inspector').count(),0);
  });
  const fixedMetrics = await page.locator('.journey-metrics').innerText();
  let choiceMs;
  await check('selecting an item updates both shelves and preserves fixed heldout metrics', async () => {
    const selected = await page.getByTestId('traditional-shelf').locator('h3').first().textContent();
    const begin = performance.now();
    await page.getByTestId('traditional-shelf').getByRole('button',{name:/Choose /}).first().click();
    await page.getByText('Choice 2 of 2',{exact:true}).waitFor();
    await page.getByRole('status').filter({hasText:/Added /}).waitFor();
    choiceMs=performance.now()-begin;
    const history = await page.locator('.journey-timeline li p').allTextContents();
    assert.deepEqual(history,[...initialHistory,selected]);
    assert.equal(await page.locator('.journey-metrics').innerText(),fixedMetrics);
    assert.equal(await page.getByTestId('traditional-shelf').locator('article').count(),5);
    assert.equal(await page.getByTestId('sid-shelf').locator('article').count(),5);
  });
  await check('second choice reaches terminal recommendations and undo restores prior state', async () => {
    const previous = await page.getByTestId('sid-shelf').locator('h3').allTextContents();
    await page.getByTestId('sid-shelf').getByRole('button',{name:/Choose /}).first().click();
    await page.getByRole('heading',{name:'Final recommendations',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:/^Final suggestion:/}).count(),10);
    assert.equal(await page.locator('.choose-product:not(:disabled)').count(),0);
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    await page.getByText('Choice 2 of 2',{exact:true}).waitFor();
    assert.deepEqual(await page.getByTestId('sid-shelf').locator('h3').allTextContents(),previous);
  });
  await check('download and replay restore the verified path and reject tampering', async () => {
    const waiting=page.waitForEvent('download'); await page.getByRole('button',{name:'Save journey',exact:true}).click();
    const download=await waiting; const file=path.join(output,download.suggestedFilename()); await download.saveAs(file);
    await page.getByRole('button',{name:'Restart',exact:true}).click();
    await page.getByText('Choice 1 of 2',{exact:true}).waitFor();
    await page.getByLabel('Journey replay file').setInputFiles(file);
    await page.getByRole('status').filter({hasText:/Replay verified/}).waitFor();
    assert.ok(await page.getByText('Choice 2 of 2',{exact:true}).isVisible());
    const corrupted=JSON.parse(await readFile(file,'utf8')); corrupted.history[0]=-1;
    const bad=path.join(output,'tampered.json'); await writeFile(bad,JSON.stringify(corrupted));
    await page.getByLabel('Journey replay file').setInputFiles(bad);
    await page.getByRole('alert').filter({hasText:/Replay failed/}).waitFor();
    await page.getByLabel('Journey replay file').setInputFiles(file);
    await page.getByRole('status').filter({hasText:/Replay verified/}).waitFor();
    assert.equal(await page.getByRole('alert').count(),0);
  });
  await check('changing story restarts and keyboard selection works', async () => {
    await page.getByLabel('Starting story').selectOption({index:1});
    await page.getByText('Choice 1 of 2',{exact:true}).waitFor();
    assert.equal(await page.locator('.attendee-choice').count(),0);
    await page.getByTestId('traditional-shelf').getByRole('button',{name:/Choose /}).first().focus();
    await page.keyboard.press('Enter');
    await page.getByText('Choice 2 of 2',{exact:true}).waitFor();
  });
  await check('changing story cancels an in-flight choice without mixing histories', async () => {
    const manifest = JSON.parse(await readFile(new URL('../public/journeys/manifest.json', import.meta.url), 'utf8'));
    const roots = manifest.pairs[0].seeds.map(seed => seed.id);
    const racePage = await context.newPage();
    let release;
    const pending = new Promise(resolve => {release = resolve;});
    await racePage.route('**/states/*.json', async route => {
      const id = new URL(route.request().url()).pathname.split('/').pop().replace('.json', '');
      if (!roots.includes(id)) await pending;
      await route.continue();
    });
    try {
      await racePage.goto(url);
      await racePage.getByTestId('traditional-shelf').getByRole('button', {name:/Choose /}).first().click();
      await racePage.getByRole('status').filter({hasText:'Updating recommendations…'}).waitFor();
      await racePage.getByLabel('Starting story').selectOption(roots[1]);
      await racePage.getByText('Choice 1 of 2', {exact:true}).waitFor();
      const expected = await racePage.locator('.journey-timeline li p').allTextContents();
      release();
      await racePage.waitForLoadState('networkidle');
      assert.deepEqual(await racePage.locator('.journey-timeline li p').allTextContents(), expected);
      assert.equal(await racePage.locator('.attendee-choice').count(), 0);
      assert.ok(await racePage.getByText('Choice 1 of 2', {exact:true}).isVisible());
    } finally {release(); await racePage.close();}
  });
  await check('same-bucket alternatives are selectable and distinguish item-based context', async () => {
    const manifest = JSON.parse(await readFile(new URL('../public/journeys/manifest.json', import.meta.url), 'utf8'));
    const probed = manifest.pairs.filter(pair => pair.same_bucket_probe);
    assert.deepEqual(probed.map(pair => pair.id), ['sasrec-letter','bert-mlm-letter']);
    for (const pair of probed) {
      const probe = pair.same_bucket_probe;
      assert.ok(probe.native_addresses_equal);
      assert.equal(probe.traditional_top5_equal, false);
      await page.getByLabel('Journey model pair').selectOption(pair.id);
      await page.getByLabel('Starting story').selectOption(probe.seed);
      await page.getByText('Choice 1 of 2', {exact:true}).waitFor();
      const panel = page.locator('details').filter({has:page.locator('summary', {hasText:'Try two products with the same SID'})});
      if (!(await panel.evaluate(element=>element.open))) await panel.locator('summary').click();
      await panel.getByRole('button').first().click();
      await page.getByText('Choice 2 of 2', {exact:true}).waitFor();
      const first = await page.getByTestId('traditional-shelf').locator('h3').allTextContents();
      await page.getByRole('button',{name:'Undo',exact:true}).click();
      await page.getByText('Choice 1 of 2', {exact:true}).waitFor();
      if (!(await panel.evaluate(element=>element.open))) await panel.locator('summary').click();
      await panel.getByRole('button').nth(1).click();
      await page.getByText('Choice 2 of 2', {exact:true}).waitFor();
      assert.notDeepEqual(await page.getByTestId('traditional-shelf').locator('h3').allTextContents(), first);
    }
  });
  await check('each qualified model pair restarts and loads its own metric evidence', async () => {
    const manifest = JSON.parse(await readFile(new URL('../public/journeys/manifest.json', import.meta.url), 'utf8'));
    for (const pair of manifest.pairs) {
      await page.getByLabel('Journey model pair').selectOption(pair.id);
      await page.getByRole('button',{name:'Restart',exact:true}).click();
      await page.getByText('Choice 1 of 2', {exact:true}).waitFor();
      await page.getByRole('rowheader',{name:`${pair.sid} · SID`,exact:true}).waitFor();
      assert.equal(await page.locator('.traditional-heading h3').textContent(),pair.traditional);
      assert.equal(await page.locator('.attendee-choice').count(),0);
      assert.equal(await page.getByTestId('traditional-shelf').locator('article').count(),5);
      assert.equal(await page.getByTestId('sid-shelf').locator('article').count(),5);
      await page.getByTestId('sid-shelf').getByRole('button',{name:/Choose /}).first().click();
      await page.getByText('Choice 2 of 2', {exact:true}).waitFor();
    }
  });
  await check('a newly trained BERT4Rec/TIGER journey saves and replays on the generic provenance schema', async () => {
    await page.getByLabel('Journey model pair').selectOption('bert-mlm-tiger');
    await page.getByRole('button',{name:'Restart',exact:true}).click();
    await page.getByText('Choice 1 of 2',{exact:true}).waitFor();
    await page.getByRole('rowheader',{name:'TIGER · SID',exact:true}).waitFor();
    await page.getByTestId('sid-shelf').getByRole('button',{name:/Choose /}).first().click();
    await page.getByText('Choice 2 of 2',{exact:true}).waitFor();
    const history = await page.locator('.journey-timeline li p').allTextContents();
    const waiting=page.waitForEvent('download'); await page.getByRole('button',{name:'Save journey',exact:true}).click();
    const file=path.join(output,'bert-mlm-tiger-journey.json'); await (await waiting).saveAs(file);
    assert.equal(JSON.parse(await readFile(file,'utf8')).provenance.traditional_model,'BERT4Rec (MLM)');
    await page.getByRole('button',{name:'Restart',exact:true}).click();
    await page.getByText('Choice 1 of 2',{exact:true}).waitFor();
    await page.getByLabel('Journey replay file').setInputFiles(file);
    await page.getByRole('status').filter({hasText:/Replay verified/}).waitFor();
    assert.ok(await page.getByText('Choice 2 of 2',{exact:true}).isVisible());
    assert.deepEqual(await page.locator('.journey-timeline li p').allTextContents(),history);
    assert.equal(await page.getByRole('alert').count(),0);
  });
  await page.getByLabel('Journey model pair').selectOption('bert-mlm-letter');
  await page.getByText('Choice 1 of 2',{exact:true}).waitFor();
  await page.getByRole('rowheader',{name:'BERT4Rec (MLM) · Item',exact:true}).waitFor();
  await page.evaluate(()=>{document.activeElement?.blur(); scrollTo(0,0);});
  await page.screenshot({path:figure('journeys-desktop-bert-mlm.png'),fullPage:true});
  await page.getByLabel('Journey model pair').selectOption('sasrec-letter');
  await page.getByText('Choice 1 of 2',{exact:true}).waitFor();
  await page.getByRole('rowheader',{name:'SASRec · Item',exact:true}).waitFor();
  await page.getByRole('rowheader',{name:'LETTER · SID',exact:true}).waitFor();
  await page.evaluate(()=>{document.activeElement?.blur(); scrollTo(0,0);});
  await page.screenshot({path:figure('journeys-desktop.png'),fullPage:true});
  await check('desktop, tablet and mobile have no horizontal overflow', async () => {
    for (const [width,height] of [[1440,1000],[1024,768],[390,844]]) {
      await page.setViewportSize({width,height});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const traditional = await page.getByTestId('traditional-shelf').boundingBox();
      const sid = await page.getByTestId('sid-shelf').boundingBox();
      if (width >= 1024) assert.ok(Math.abs(traditional.y - sid.y) < 1);
      else assert.ok(sid.y >= traditional.y + traditional.height);
    }
    const alternatives = page.locator('details').filter({has:page.locator('summary', {hasText:'Try two products with the same SID'})});
    await alternatives.locator('summary').click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await alternatives.locator('summary').click();
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:figure('journeys-mobile.png'),fullPage:true});
    await page.screenshot({path:figure('journeys-mobile-viewport.png'),fullPage:false});
  });
  await check('no inference API, external request, or console error', async () => {
    assert.deepEqual(errors,[]);
    assert.ok(requests.every(request=>!request.includes('/api/')));
    assert.ok(requests.every(request=>new URL(request).origin===new URL(url).origin));
  });
  // Receipt in the web-validation.json shape; hashes tie it to the reviewed sources and assets.
  const manifest = JSON.parse(await readFile(new URL('../public/journeys/manifest.json', import.meta.url), 'utf8'));
  const web = path.join(demo, 'web');
  const hashed = [...['src/Journeys.jsx','src/journeys.css','src/main.jsx','index.html','dist/index.html',
    ...(await readdir(path.join(web,'dist/assets'))).map(name=>`dist/assets/${name}`),
    'public/journeys/manifest.json','dist/journeys/manifest.json'].map(name=>path.join(web,name)),
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
    pairs:manifest.pairs.map(pair=>pair.id),files,
    scope:'Eight prepared Beauty model pairs served as static files; scripted checks, not a model-quality benchmark or participant usability study'},null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,firstRenderMs,choiceMs,receipt}));
} catch (error) {
  await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
  console.error(error,errors); process.exitCode=1;
} finally {await browser.close();}
