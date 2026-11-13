import {chromium} from 'playwright';
import QRCode from 'qrcode';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, rm, stat, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

// The guided tour as a ~60 s captioned video: steps 1-5 on the default pair and history, between a title card and
// an end card with the demo QR. Captions, pointer and cards are page overlays, so the CDP screencast burns them in;
// the frames become a 30 fps H.264 MP4 and the cues a WebVTT file with the same times.
// Env: JOURNEY_URL (default http://127.0.0.1:8350), OUT (default /tmp/cornac-tour-video), FFMPEG (optional).
const url = process.env.JOURNEY_URL || 'http://127.0.0.1:8350';
const out = process.env.OUT || '/tmp/cornac-tour-video';
const demoUrl = 'https://cornac-workbench.preferred.ai/';
const name = 'cornac-workbench-tour';
// Device scale 1: the screencast delivers frames at CSS-pixel size whatever the scale, so text is rasterized at the
// video's own resolution and no frame is resampled.
const WIDTH = 1920, HEIGHT = 1080, FPS = 30;
// Viewport rows under the caption and its scrim; targets are scrolled above them, and the page gets as much extra room.
const CAPTION_ROOM = 180;
const title = ['Cornac Workbench', 'A sequential and a generative SID recommender on one purchase history'];
const ending = ['Try the demo!', 'cornac-workbench.preferred.ai', 'pip install cornac'];

function findFfmpeg() {
  const candidates = [process.env.FFMPEG, 'ffmpeg'];
  try {candidates.push(createRequire(import.meta.url)('ffmpeg-static'));} catch {}
  const found = candidates.find(bin => bin && spawnSync(bin, ['-hide_banner', '-version']).status === 0);
  if (!found) {
    console.error('No ffmpeg found: set FFMPEG, put ffmpeg on PATH (brew install ffmpeg), or run npm install --no-save ffmpeg-static.');
    process.exit(1);
  }
  return found;
}

// Runs in the page: the overlay styles and elements, and window.__rec to drive them.
function install({qr, title, ending, room}) {
  const style = document.createElement('style');
  style.textContent = `
    aside.demo-qr {display:none !important;}
    body {padding-bottom:${room}px;}
    #rec-caption {position:fixed; left:50%; bottom:36px; z-index:2147483600; width:max-content; min-width:1180px; max-width:1600px; padding:16px 34px;
      border-radius:16px; background:#142b3b; color:#fff; font-size:34px; font-weight:650; line-height:1.28; letter-spacing:-.4px;
      text-align:center; pointer-events:none; box-shadow:0 10px 30px #142b3b40; transform:translateX(-50%); opacity:0; transition:opacity .3s;}
    #rec-scrim {position:fixed; left:0; right:0; bottom:0; height:${room}px; z-index:2147483599; pointer-events:none;
      background:linear-gradient(#f7f9fa00, #f7f9fa 40%); opacity:0; transition:opacity .3s;}
    #rec.has-caption #rec-caption, #rec.has-caption #rec-scrim {opacity:1;}
    #rec-caption span {display:block; animation:rec-in .35s ease-out;}
    @keyframes rec-in {from {opacity:0; transform:translateY(8px);} to {opacity:1; transform:none;}}
    #rec-pointer {position:fixed; left:0; top:0; z-index:2147483646; width:28px; height:42px; pointer-events:none; opacity:0;
      transition:opacity .3s; will-change:transform; filter:drop-shadow(0 2px 4px #00000059);}
    #rec-pointer.is-on {opacity:1;}
    #rec-pointer svg {display:block; width:100%; height:100%; transform-origin:2px 2px; transition:transform .12s;}
    #rec-pointer.is-down svg {transform:scale(.84);}
    .rec-ripple {position:fixed; z-index:2147483645; width:72px; height:72px; margin:-36px 0 0 -36px; border-radius:50%;
      border:3px solid #087e78; background:#087e7829; pointer-events:none; animation:rec-ripple .6s ease-out forwards;}
    @keyframes rec-ripple {from {transform:scale(.15); opacity:1;} to {transform:scale(1); opacity:0;}}
    .rec-card {position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center;
      background:#f7f9fa; color:#142b3b; opacity:0; visibility:hidden; transition:opacity .6s, visibility .6s;}
    .rec-card.is-on {opacity:1; visibility:visible;}
    #rec-title {text-align:center;}
    #rec-title .rec-name {font-size:128px; font-weight:700; line-height:1.05; letter-spacing:-4px;}
    #rec-title .rec-name span {font-weight:500;}
    #rec-title i {display:block; width:0; height:8px; margin:48px auto; border-radius:4px; background:#087e78; animation:rec-rule .9s .2s ease-out forwards;}
    @keyframes rec-rule {to {width:128px;}}
    #rec-title .rec-sub {max-width:1240px; font-size:48px; font-weight:500; line-height:1.3; letter-spacing:-.8px; text-wrap:balance;}
    #rec-end .rec-end {display:flex; align-items:center; gap:104px;}
    #rec-end .rec-qr {width:520px; height:520px; padding:30px; background:#fff; border-radius:30px; box-shadow:0 18px 50px #142b3b24;}
    #rec-end .rec-qr svg {display:block; width:100%; height:100%; shape-rendering:crispEdges;}
    #rec-end .rec-try {font-size:104px; font-weight:700; line-height:1.05; letter-spacing:-3px;}
    #rec-end .rec-url {margin-top:30px; font-size:48px; font-weight:650; letter-spacing:-.8px; color:#055e5a;}
    #rec-end code {display:inline-block; margin-top:56px; padding:18px 30px; border-radius:14px; background:#0f2233; color:#e8f1fa;
      font:500 40px/1.2 "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;}`;
  document.head.append(style);
  const layer = document.createElement('div');
  layer.id = 'rec';
  layer.setAttribute('aria-hidden', 'true');
  // The scrim fades the page out under the caption, so no text shows around or below it.
  layer.innerHTML = `<div id="rec-scrim"></div><div id="rec-caption"></div>
    <div id="rec-pointer"><svg viewBox="0 0 24 36"><path d="M2 2v27.5l6.6-6.3 4.5 10.6 4.7-2-4.4-10.4H22z" fill="#142b3b" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></div>
    <div class="rec-card is-on" id="rec-title"><div><div class="rec-name"></div><i></i><div class="rec-sub"></div></div></div>
    <div class="rec-card" id="rec-end"><div class="rec-end"><div class="rec-qr">${qr}</div>
      <div><div class="rec-try"></div><div class="rec-url"></div><code></code></div></div></div>`;
  document.body.append(layer);
  const [brand, ...rest] = title[0].split(' ');
  layer.querySelector('.rec-name').append(`${brand} `, Object.assign(document.createElement('span'), {textContent: rest.join(' ')}));
  layer.querySelector('.rec-sub').textContent = title[1];
  ['.rec-try', '.rec-url', 'code'].forEach((selector, i) => {layer.querySelector(selector).textContent = ending[i];});

  const caption = layer.querySelector('#rec-caption'), pointer = layer.querySelector('#rec-pointer');
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const ease = t => t < .5 ? 4 * t * t * t : 1 - (2 - 2 * t) ** 3 / 2;
  async function tween(ms, step) {
    const start = performance.now();
    for (let t = 0; t < 1;) {await frame(); t = Math.min(1, (performance.now() - start) / ms); step(ease(t));}
  }
  let px = 1240, py = 760;
  const place = (x, y) => {pointer.style.transform = `translate(${x - 2}px, ${y - 2}px)`;};
  place(px, py);
  window.__rec = {
    say(lines) {
      if (lines) caption.replaceChildren(...lines.map(line => Object.assign(document.createElement('span'), {textContent: line})));
      layer.classList.toggle('has-caption', Boolean(lines));
      return Date.now();
    },
    card(id, on) {layer.querySelector(`#${id}`).classList.toggle('is-on', on); return Date.now();},
    // Eased, along a slight arc, slower over longer distances.
    async move(x, y) {
      pointer.classList.add('is-on');
      const [x0, y0] = [px, py], d = Math.hypot(x - x0, y - y0);
      if (d < 1) return;
      const bow = Math.min(50, d * .08), nx = (y0 - y) / d, ny = (x - x0) / d;
      await tween(Math.min(1100, 450 + d * .5), e => place(x0 + (x - x0) * e + nx * bow * Math.sin(Math.PI * e), y0 + (y - y0) * e + ny * bow * Math.sin(Math.PI * e)));
      [px, py] = [x, y];
    },
    press(x, y) {
      const ripple = Object.assign(document.createElement('div'), {className: 'rec-ripple'});
      Object.assign(ripple.style, {left: `${x}px`, top: `${y}px`});
      layer.append(ripple);
      pointer.classList.add('is-down');
      setTimeout(() => pointer.classList.remove('is-down'), 160);
      setTimeout(() => ripple.remove(), 700);
    },
    async scroll(y, ms = Math.min(1200, 500 + Math.abs(y - scrollY) * .6)) {
      const y0 = scrollY;
      if (y === y0) return;
      if (!ms) {scrollTo(0, y); return;}
      await tween(ms, e => scrollTo(0, y0 + (y - y0) * e));
    },
  };
}

const ffmpeg = findFfmpeg();
const frameDir = path.join(out, `.${name}-frames`);
await rm(frameDir, {recursive: true, force: true});
await mkdir(frameDir, {recursive: true});
const browser = await chromium.launch({headless: true});
try {
  const context = await browser.newContext({viewport: {width: WIDTH, height: HEIGHT}, deviceScaleFactor: 1});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.goto(new URL('#v=tour&sc=1', url).href);
  await page.locator('.tour-pick').nth(3).waitFor();

  const rec = (method, ...args) => page.evaluate(([method, args]) => window.__rec[method](...args), [method, args]);
  const hold = ms => page.waitForTimeout(ms);
  const text = selector => page.locator(selector).first().textContent();
  const ready = () => page.waitForFunction(() => document.fonts.status === 'loaded'
    && [...document.images].filter(image => image.checkVisibility()).every(image => image.complete));
  const cues = [];
  async function say(lines) {
    const at = await rec('say', lines);
    if (cues.at(-1)) cues.at(-1).end ??= at;
    if (lines) cues.push({lines, start: at});
  }
  async function point(target, fx = .5, fy = .5) {
    const box = await (typeof target === 'string' ? page.locator(target).first() : target).boundingBox();
    assert.ok(box, String(target));
    const [x, y] = [box.x + box.width * fx, box.y + box.height * fy];
    await rec('move', x, y);
    await page.mouse.move(x, y);
    return [x, y];
  }
  async function click(target, fx, fy) {
    const [x, y] = await point(target, fx, fy);
    await hold(200);
    await rec('press', x, y);
    await page.mouse.click(x, y);
  }
  // Scrolls the least that puts every match of `selectors` between the sticky tour bar and the caption (top first),
  // and never stops with the page header half shown.
  async function reveal(selectors, ms) {
    const y = await page.evaluate(([selectors, room]) => {
      const boxes = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).map(element => element.getBoundingClientRect());
      const top = Math.min(...boxes.map(box => box.top)) + scrollY, bottom = Math.max(...boxes.map(box => box.bottom)) + scrollY;
      const bar = document.querySelector('.tour-bar').offsetHeight + 20;
      let y = Math.max(scrollY, bottom - (innerHeight - room));
      if (top - y < bar) y = top - bar;
      if (y > 0) y = Math.max(y, document.querySelector('.app-header').offsetHeight);
      return Math.round(Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, y)));
    }, [selectors, CAPTION_ROOM]);
    await rec('scroll', y, ms);
  }
  const next = '.tour-bar .tour-bar-side.is-end .button.primary';
  async function step(n) {
    await click(next, .65, .7);
    await page.locator(`.tour[data-scene="${n}"] .tour-scene h1`).waitFor();
  }

  // Step 1 facts, then the overlays over the loaded page.
  assert.equal(await text('.tour-scene h1'), "One user's purchase history: 16 items from Amazon Beauty.");
  const brush = '.tour-pick[data-item="2739"]';
  assert.equal(await text(`${brush} .tour-pick-name`), 'Real Techniques Fine Liner Brush');
  const qr = await QRCode.toString(demoUrl, {type: 'svg', margin: 1, color: {dark: '#142b3b', light: '#ffffff'}});
  await page.evaluate(install, {qr, title, ending, room: CAPTION_ROOM});
  await ready();

  const cdp = await context.newCDPSession(page);
  const frames = [], writes = [];
  cdp.on('Page.screencastFrame', ({data, metadata, sessionId}) => {
    cdp.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
    const file = path.join(frameDir, `${String(frames.length).padStart(5, '0')}.jpg`);
    frames.push({file, t: metadata.timestamp ?? Date.now() / 1000});
    writes.push(writeFile(file, Buffer.from(data, 'base64')));
  });
  await cdp.send('Page.startScreencast', {format: 'jpeg', quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1});
  const start = Date.now();
  cues.push({lines: title, start});

  // Title card; behind it, step 1 scrolls to show the history and the four cards.
  await reveal(['.tour-photos', '.tour-picks'], 0);
  await hold(3800);
  await say(["One user's purchase history from Amazon Beauty.", 'Which item did they buy next?']);
  await rec('card', 'rec-title', false);
  await hold(4300);
  await click(brush, .5, .4);
  await page.locator(`${brush} .target-pill`).waitFor();
  await say(['They bought a fine-liner brush.']);
  await reveal([brush]);
  await hold(2200);

  // Step 2: the two lists.
  await step(2);
  await page.getByTestId('tour-semantic-list').getByText('Next purchase', {exact: true}).waitFor();
  assert.match(await page.evaluate(() => location.hash), /^#p=sasrec-letter&h=c38261d27a225339b377&s=one_cosine&/);
  assert.equal(await text('.tour-reveal'), 'LETTER ranks the next purchase #1. SASRec does not have it in its top 5.');
  assert.deepEqual(await page.locator('.tour-column-head .model-name').allTextContents(), ['SASRec', 'LETTER']);
  assert.equal(await page.getByTestId('tour-semantic-list').locator('li[data-item]').first().getAttribute('data-item'), '2739');
  assert.equal(await page.getByTestId('tour-traditional-list').locator('li[data-item="2739"]').count(), 0);
  await ready();
  await say(['A sequential model scores every item.', 'A generative SID model generates Semantic IDs (SIDs).']);
  await reveal(['.tour-columns']);
  await point('[data-testid="tour-traditional-list"] li:first-child .tour-id', .85, .85);
  await hold(2200);
  await point('[data-testid="tour-semantic-list"] li:first-child .tour-code', .85, .85);
  await hold(3000);
  await say(['LETTER ranks the brush #1. SASRec does not list it.']);
  await point('[data-testid="tour-semantic-list"] li[data-item="2739"] .thumb', .7, .6);
  await hold(3000);

  // Step 3: one SID, 1,643 items, and the resolver.
  await step(3);
  const row = 'ol.s3-rows > li.s3-row:first-child';
  const first = item => page.waitForFunction(value => document.querySelector('.s3-row .s3-pick')?.dataset.item === value, item);
  assert.equal(await text('.tour-scene h1'), "LETTER predicted the next purchase's SID, but 1,643 items share it.");
  assert.equal(await text(`${row} .s3-size`), '1,643 items');
  await first('2739');
  await ready();
  await say(["But 1,643 items share LETTER's SID."]);
  await point(`${row} .s3-size`, .95, 1);
  await hold(2000);
  await click(`${row} .s3-how-button`, .8, .75);
  await page.locator('#s3-how-1 .bucket-breakdown').waitFor();
  await page.locator('.s3-scores dd').nth(2).waitFor();
  assert.equal(await text('.s3-scores > p'), 'Cornac evaluates SID models at three levels (LETTER, Recall@5, 22,363 test users):');
  assert.deepEqual(await page.locator('.s3-scores dd').allTextContents(), ['0.196', '0.017', '0.004']);
  await ready();
  await reveal(['.s3-controls', row, '#s3-how-1 .s3-members']);
  await hold(600);
  const order = '.s3-segmented[aria-label="Order within a SID"]';
  await say(['A resolver picks the item:', 'most similar gives the brush, most popular a sunscreen.']);
  await click(`${order} label:nth-child(2)`, .75, .75);
  await first('695');
  assert.match(await page.locator('.s3-row .s3-pick').first().getAttribute('title'), /Sunscreen/);
  await hold(3600);
  // Back to the default resolver, which step 5's chart also uses.
  await click(`${order} label:nth-child(1)`, .75, .75);
  await first('2739');
  await hold(1000);

  // Step 4: two items with one SID.
  await step(4);
  await page.locator('.s4[data-phase="1"]').waitFor();
  assert.deepEqual(await page.locator('label.s4-pick[data-item]').evaluateAll(cards => cards.map(card => card.dataset.item)), ['88', '610']);
  assert.equal(await text('#s4-same-intro'), 'Items 88 and 610 have the same LETTER SID. Pick one to see what each model reads and recommends.');
  await ready();
  await say(['Two items with the same SID give LETTER the same input', "and the same five SIDs. SASRec's two lists share none."]);
  await reveal(['.tour-scene h1', '.s4-shelves']);
  for (const item of ['88', '610']) {
    await click(`label.s4-pick[data-item="${item}"]`, .3, .5);
    await page.waitForFunction(value => document.querySelector('.s4 .semantic-heading li.s4-entry.is-new')?.dataset.item === value
      && document.querySelector('p.s4-same-line')?.textContent, item);
    await ready();
    await hold(item === '88' ? 2800 : 3600);
  }
  assert.equal(await text('p.s4-same-line'), 'After item 88 or item 610, LETTER reads the same input and predicts the same 5 SIDs. '
    + 'SASRec reads two different item IDs; its two top-5 lists share 0 of 5 items.');

  // Step 5: the experiment and the chart.
  await step(5);
  await page.locator('.recall-chart svg').waitFor();
  assert.match(await page.locator('.recall-chart svg').getAttribute('aria-label'), /\bLETTER: Item-level 0\.017, SID-level 0\.196, CCE 0\.004\b/);
  assert.equal(await text('.chart-legend .chart-policy'), 'Resolver: One item per SID, most similar');
  await ready();
  await say(['Cornac scores SID models at three levels.', 'LETTER, Recall@5: SID 0.196, item 0.017, CCE 0.004.']);
  await point('ol.s5-notes li[data-mark="3"]', .3, .5);
  await hold(2200);
  await reveal(['div.s5-chart']);
  await point(page.locator('.recall-chart text.chart-value', {hasText: '0.196'}), .15, 1.25);
  await hold(3400);

  // End card.
  await say(null);
  cues.push({lines: ending, start: await rec('card', 'rec-end', true)});
  await hold(5400);
  const end = Date.now();
  cues.at(-1).end = end;
  await cdp.send('Page.stopScreencast');
  await Promise.all(writes);
  assert.deepEqual(errors, []);
  assert.ok(frames.length > 1, 'no screencast frames');

  // Frame timestamps (s) and cue times (ms) share the wall clock; video time 0 is the first frame. A cue starts with
  // the first frame drawn after its change.
  const t0 = frames[0].t, total = end / 1000 - t0;
  assert.ok(Math.abs(t0 * 1000 - start) < 2000, `screencast timestamps are not on the wall clock (${t0})`);
  const shown = ms => (frames.find(frame => frame.t >= ms / 1000)?.t ?? ms / 1000) - t0;
  const list = ['ffconcat version 1.0'];
  frames.forEach((frame, i) => list.push(`file '${path.basename(frame.file)}'`, `duration ${Math.max(0, (frames[i + 1]?.t ?? end / 1000) - frame.t).toFixed(6)}`));
  list.push(`file '${path.basename(frames.at(-1).file)}'`);
  await writeFile(path.join(frameDir, 'frames.ffconcat'), list.join('\n') + '\n');
  const mp4 = path.join(out, `${name}.mp4`), vtt = path.join(out, `${name}.vtt`);
  const encode = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(frameDir, 'frames.ffconcat'),
    '-vf', `fps=${FPS},scale=${WIDTH}:${HEIGHT}:out_color_matrix=bt709:out_range=tv,format=yuv420p`, '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', mp4], {stdio: 'inherit'});
  assert.equal(encode.status, 0, 'ffmpeg failed');

  const stamp = seconds => {
    const ms = Math.round(seconds * 1000);
    return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':')
      + '.' + String(ms % 1000).padStart(3, '0');
  };
  const timed = cues.map(cue => ({lines: cue.lines, start: cue.start === start ? 0 : shown(cue.start), end: cue.end === end ? total : shown(cue.end)}));
  await writeFile(vtt, 'WEBVTT\n\n' + timed.map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.lines.join('\n')}\n`).join('\n'));

  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', mp4, '-map', '0:v:0', '-f', 'null', '-'], {encoding: 'utf8'}).stderr;
  const frameCount = Number([...probe.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1]);
  const [, h, m, s] = probe.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = Number(h) * 3600 + Number(m) * 60 + Number(s);
  const size = (await stat(mp4)).size;
  for (const cue of timed) console.log(`${stamp(cue.start)} --> ${stamp(cue.end)}  ${cue.lines.join(' / ')}`);
  console.log(`video: ${mp4}\ncaptions: ${vtt}`);
  console.log(`${duration.toFixed(2)} s, ${frameCount} frames at ${FPS} fps, ${(size / 1e6).toFixed(1)} MB, ${WIDTH}x${HEIGHT}`);
  console.log(`Recorded the tour (steps 1-5) in ${duration.toFixed(1)} s from ${frames.length} screencast frames, with ${timed.length} cues.`);
} finally {
  await browser.close();
  await rm(frameDir, {recursive: true, force: true});
}
