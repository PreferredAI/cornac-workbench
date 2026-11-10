import React, {useEffect, useRef, useState} from 'react';
import {ArrowLeft, Check, Download, QrCode, RotateCcw, Upload} from 'lucide-react';
import {ChangeLine, DetailsToggle, HistoryStrip, ProductCard, Recap, SameCodeStep, addressesDiff, changeText, count, itemShort, itemTitle, plainLabels, revealText, shelfDiff, targetRank} from './journeyParts.jsx';
import {BucketBreakdown, RecallChart, SharePanel, buildHash, readHash} from './journeyExtras.jsx';
import Tour from './tour/Tour.jsx';
import {labeler} from './tour/Scene3.jsx';
import './journeys.css';

const labels = {
  one_popularity: 'One per SID · Popularity', one_cosine: 'One per SID · History cosine',
  expand_popularity: 'Expand buckets · Popularity', expand_cosine: 'Expand buckets · History cosine',
};
const requests = new Map();
const resolved = new Map();
function load(path) {
  if (!requests.has(path)) requests.set(path, fetch(`/journeys/${path}`).then(response => {
    if (!response.ok) throw new Error(`Could not load prepared journey (${response.status}).`);
    return response.json();
  }).then(data => {resolved.set(path, data); return data;}).catch(error => {requests.delete(path); throw error;}));
  return requests.get(path);
}
const statePath = (pair, id) => `${pair}/states/${id}.json`;
const number = value => Number(value).toFixed(4);
const items = cards => cards.map(card => card.item);

function Benchmark({data, all, pairs, pair, strategy}) {
  if (!data) return null;
  return <section className="journey-benchmark" aria-labelledby="benchmark-heading">
    <div className="section-caption"><div><h2 id="benchmark-heading">Evaluation <span className="model-tag semantic">Cornac 3.1</span></h2>
      <p>Scores on {data.query_count.toLocaleString()} test users. They do not score your choices.</p></div></div>
    {all ? <RecallChart pairs={pairs} data={all} strategy={strategy} policy={labels[strategy]} current={[pair.traditional, pair.sid]}/> : null}
    <div className="metric-table-wrap"><table className="journey-metrics"><thead><tr><th>Model / evaluation view</th><th>Recall@5</th><th>NDCG@5</th></tr></thead><tbody>
      {[[`${pair.traditional} · Item`, 'traditional'], [`${pair.sid} · SID`, 'sid'], [`${pair.sid} · CCE`, 'cce'], [`${pair.sid} · Item · ${labels[strategy]}`, strategy]].map(([label, key]) =>
        <tr key={key}><th scope="row">{label}</th><td>{number(data.metrics[key].recall)}</td><td>{number(data.metrics[key].ndcg)}</td></tr>)}
    </tbody></table></div>
    <details className="benchmark-contract"><summary>Metric definitions and protocol</summary>
      <p>{data.cohort}. {data.protocol}.</p><p>{data.semantics}.</p>
      <p>SID rewards the correct address; CCE averages item credit over uniformly ordered bucket members; Item evaluates the actual selected shelf. Model context limits: {Object.entries(data.contexts).map(([name, limit]) => `${name} ${limit} items`).join(' · ')}. Different recipes and context limits make this a system demonstration, not an architecture-controlled benchmark.</p>
    </details>
  </section>;
}

function Inspector({card, node, catalog, media, pair, showDetails, onClose}) {
  if (!card) return null;
  const bucket = node.buckets.find(row => row.address.join(',') === card.address.join(','));
  return <section className="journey-inspector" aria-labelledby="bucket-heading">
    <div className="inspector-title"><h2 id="bucket-heading">One SID, {count(bucket.size, 'item')}</h2>
      <button className="button" onClick={onClose} aria-label="Close bucket inspector">Close</button></div>
    <code className="sid-code">{showDetails ? `[${bucket.address.join(', ')}]` : `SID ${bucket.address.join('·')}`}</code>
    {showDetails ? <p>Native SID score: {number(bucket.score)}.</p> : null}
    <BucketBreakdown info={media?.buckets?.[pair.sid]?.[bucket.address.join(',')]} showDetails={showDetails}/>
    <div className="bucket-columns">{[['popularity', showDetails ? 'Training popularity' : 'Most popular'], ['cosine', showDetails ? 'Visible-history cosine' : 'Most similar']].map(([key, label]) =>
      <div key={key}><h3>{label}</h3><ol>{bucket[key].map(member => <li key={member.item} className={member.item === card.item ? 'chosen-member' : ''}>
        <span>{itemTitle(catalog, member.item)}{member.item === card.item ? <Check size={14} aria-label="Selected item"/> : null}</span>{showDetails ? <strong>{key === 'popularity' ? member.score.toLocaleString() : number(member.score)}</strong> : null}
      </li>)}</ol></div>)}</div>
    {showDetails ? <p className="subtle">Showing up to 12 leading members per resolver. Ties use the smallest catalog item index. Expanded mode exhausts each ordered bucket before moving to the next SID; one large bucket can fill the entire shelf.</p> : null}
  </section>;
}

export default function Journeys() {
  const [manifest, setManifest] = useState(null);
  const [catalog, setCatalog] = useState({});
  const [media, setMedia] = useState(null);
  const [benchmark, setBenchmark] = useState(null);
  const [pairId, setPairId] = useState('');
  const [seedId, setSeedId] = useState('');
  const [trail, setTrail] = useState([]);
  const [node, setNode] = useState(null);
  const [strategy, setStrategy] = useState('one_cosine');
  const [inspected, setInspected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revealedOnce, setRevealed] = useState(false);
  const [guess, setGuess] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [why, setWhy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [benchmarks, setBenchmarks] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [kiosk, setKiosk] = useState(false);
  const [kioskStep, setKioskStep] = useState(-1);
  const [mode, setMode] = useState('tour');
  const [scene, setScene] = useState(1);
  const written = useRef('');
  const home = useRef(null);
  const requestVersion = useRef(0);
  const replayFile = useRef(null);
  const timeline = useRef(null);
  const heading = useRef(null);
  const pairSelect = useRef(null);
  const toExplore = useRef(false);
  const pair = manifest?.pairs.find(row => row.id === pairId);
  const depth = Math.max(0, trail.length - 1);
  const terminal = Boolean(manifest && depth === manifest.max_choices);
  const target = media?.targets[seedId];
  const revealed = mode === 'explore' || revealedOnce || target == null;
  const phase = terminal ? 'recap' : revealed ? 'explore' : 'hook';
  const synced = Boolean(node) && resolved.get(statePath(pairId, trail[trail.length - 1])) === node;
  const nodes = synced ? trail.map(id => resolved.get(statePath(pairId, id))) : [];
  const parent = nodes[depth - 1];
  const left = parent && shelfDiff(items(parent.traditional), items(node.traditional));
  const right = parent && shelfDiff(items(parent.shelves[strategy]), items(node.shelves[strategy]));
  const isTarget = item => revealed && item === target;
  const question = node && `Purchase history: ${node.history.length - depth} items. Which item did this user buy next?`;
  const revealLine = synced && phase === 'explore' && !depth && target != null ? revealText(pair, targetRank(node.shelves[strategy], target), targetRank(node.traditional, target)) : '';
  const probe = pair?.same_bucket_probe;
  const picked = synced && depth ? node.history[node.history.length - 1] : null;
  const probeStep = probe?.seed === seedId && phase === 'explore' && synced && (!depth || (depth === 1 && probe.items.includes(picked)));
  // The tour reads the trail from the cache: choices load the next state before the trail grows.
  const trailNodes = pairId ? trail.map(id => resolved.get(statePath(pairId, id))) : [];
  const ready = trailNodes.length > 0 && trailNodes.every(Boolean);
  const view = mode === 'tour' ? `v=tour&sc=${scene}` : 'v=explore';

  useEffect(() => {
    document.title = 'Cornac Workbench';
    (async () => {
      const [data, items, images] = await Promise.all([load('manifest.json'), load('catalog.json'), load('media.json').catch(() => null)]);
      const start = readHash(location.hash, data, strategy);
      let path = [start.seed];
      let from = start.steps.length ? await load(statePath(start.pair, start.seed)) : null;
      for (const id of start.steps) {
        if (!Object.values(from.next).includes(id)) {path = [start.seed]; break;}
        from = await load(statePath(start.pair, id)); path.push(id);
      }
      const shown = start.revealed || path.length > 1;
      // v=tour&sc=N or v=explore; without v, a trail opens explore and anything else opens the tour.
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      const startMode = params.get('v') === 'explore' || (params.get('v') !== 'tour' && path.length > 1) ? 'explore' : 'tour';
      const startScene = Math.min(5, Math.max(1, Math.trunc(Number(params.get('sc'))) || 1));
      // The address bar keeps its URL until the visitor changes something.
      written.current = `${buildHash({pair: start.pair, seed: start.seed, strategy: start.strategy, trail: path, revealed: shown, kiosk: start.kiosk})}&${startMode === 'tour' ? `v=tour&sc=${startScene}` : 'v=explore'}`;
      home.current = [start.pair, start.seed, start.strategy];
      if (start.kiosk) window.__kioskIdleMs ??= 60000;
      setManifest(data); setCatalog(items); setMedia(images);
      setPairId(start.pair); setSeedId(start.seed); setTrail(path); setStrategy(start.strategy); setRevealed(shown); setKiosk(start.kiosk);
      setMode(startMode); setScene(startScene);
    })().catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    if (!pairId) return;
    const hash = `${buildHash({pair: pairId, seed: seedId, strategy, trail, revealed: revealedOnce, kiosk})}&${view}`;
    if (hash !== written.current) {written.current = hash; history.replaceState(history.state, '', `#${hash}`);}
  }, [pairId, seedId, strategy, trail, revealedOnce, kiosk, view]);

  useEffect(() => {
    if (!showDetails || !manifest || benchmarks) return;
    Promise.all(manifest.pairs.map(row => load(row.benchmark))).then(setBenchmarks).catch(() => {});
  }, [showDetails, manifest, benchmarks]);

  // Attract loop (k=1): starts after an idle spell; any pointer or key input stops it and restarts the idle timer.
  useEffect(() => {
    if (!kiosk || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer;
    const wake = () => {setKioskStep(-1); clearTimeout(timer); timer = setTimeout(() => setKioskStep(0), window.__kioskIdleMs ?? 60000);};
    wake();
    for (const type of ['pointerdown', 'keydown']) addEventListener(type, wake, true);
    return () => {clearTimeout(timer); for (const type of ['pointerdown', 'keydown']) removeEventListener(type, wake, true);};
  }, [kiosk]);

  useEffect(() => {
    if (kioskStep < 0) return;
    const advance = () => setKioskStep(step => step < 0 ? step : (step + 1) % loop.length);
    if (loop[kioskStep].action() === false) {advance(); return;}
    const timer = setTimeout(advance, loop[kioskStep].ms);
    return () => clearTimeout(timer);
  }, [kioskStep]);

  useEffect(() => {
    if (!pair) return;
    let current = true;
    setBenchmark(null);
    load(pair.benchmark).then(data => {if (current) setBenchmark(data);})
      .catch(e => {if (current) setError(e.message);});
    return () => {current = false;};
  }, [pair]);

  useEffect(() => {
    if (!pairId || !trail.length) return;
    const version = ++requestVersion.current;
    setBusy(true); setError(''); setInspected(null);
    load(statePath(pairId, trail[trail.length - 1])).then(data => {
      if (version !== requestVersion.current) return;
      setNode(data); setBusy(false);
      // Start immediate successor fetches together; choices then resolve from memory.
      for (const id of new Set(Object.values(data.next))) load(statePath(pairId, id)).catch(() => {});
    }).catch(e => {if (version === requestVersion.current) {setError(e.message); setBusy(false);}});
  }, [pairId, trail]);

  useEffect(() => {
    if (timeline.current) timeline.current.scrollLeft = timeline.current.scrollWidth;
  }, [node]);

  useEffect(() => {
    if (revealedOnce) (document.querySelector('.is-target .choose-product:not(:disabled)') || heading.current)?.focus();
  }, [revealedOnce]);

  useEffect(() => {
    if (mode === 'explore' && toExplore.current) {toExplore.current = false; heading.current?.focus({preventScroll: true});}
  }, [mode]);

  function reset(nextPair, nextSeed) {
    ++requestVersion.current;
    setBusy(true); setNode(null); setWhy(false); setHistoryOpen(false); setGuess(null);
    setPairId(nextPair); setSeedId(nextSeed); setTrail([nextSeed]); setNotice('New journey started.');
  }
  async function choose(item, base = trail) {
    const from = resolved.get(statePath(pairId, base[base.length - 1]));
    const id = from?.next[String(item)];
    if (!id || busy) return;
    const version = requestVersion.current;
    setBusy(true);
    try {
      const next = await load(statePath(pairId, id));
      if (version !== requestVersion.current) return;
      setTrail([...base, id]);
      setNotice(changeText(shelfDiff(items(from.traditional), items(next.traditional)), shelfDiff(items(from.shelves[strategy]), items(next.shelves[strategy]))));
      heading.current?.focus({preventScroll: true});
    } catch (e) {if (version === requestVersion.current) {setError(e.message); setBusy(false);}}
  }
  function undo() {
    if (trail.length < 2 || busy) return;
    setTrail(previous => previous.slice(0, -1)); setNotice('Choice undone. Explore another direction.');
  }
  const nextScene = () => setScene(step => Math.min(5, step + 1));
  // Another history for the tour. The state loads first so the tour stays on screen while it switches.
  function startSeed(id) {
    load(statePath(pairId, id)).then(() => {setRevealed(false); setScene(1); reset(pairId, id);}).catch(e => setError(e.message));
  }
  function explore() {toExplore.current = true; setMode('explore'); scrollTo(0, 0);}
  // Start over reloads the page without its hash; a kiosk keeps its attract loop.
  const restartUrl = `${location.pathname}${location.search}${kiosk ? '#k=1' : ''}`;
  function startOver(event) {
    event.preventDefault(); scrollTo(0, 0);
    history.replaceState(history.state, '', restartUrl);
    location.reload();
  }
  // Attract loop: tour scenes 1-3 (flipping scene 3's picking rule once), then start again.
  const firstCode = trailNodes[0]?.buckets[0];
  const codeCaption = firstCode ? `One SID, ${count(firstCode.size, 'item')}.` : '';
  const loop = [
    {caption: "One user's purchase history.", ms: 4000, action: () => {
      setShowDetails(false); setShareOpen(false); setRevealed(false); setMode('tour'); setScene(1); setStrategy(home.current[2]); scrollTo(0, 0); reset(home.current[0], home.current[1]);
    }},
    {caption: `Next purchase: ${target != null && trailNodes[0] ? labeler(media, catalog, trailNodes[0], [])(target) : ''}.`, ms: 5000, action: () => target != null && ready ? setRevealed(true) : false},
    {caption: `${pair?.traditional} and ${pair?.sid}, same history.`, ms: 5000, action: () => setScene(2)},
    {caption: codeCaption, ms: 4000, action: () => setScene(3)},
    {caption: codeCaption, ms: 5000, action: () => firstCode?.size > 1 ? setStrategy(value => value === 'one_cosine' ? 'one_popularity' : 'one_cosine') : false},
  ];
  function download() {
    const result = {schema_version: 1, pair: pairId, seed: seedId, state_ids: trail, history: node.history,
      strategy, provenance: pair.provenance, execution: manifest.execution};
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'cornac-beauty-journey.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function replay(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const version = ++requestVersion.current;
    setBusy(true);
    try {
      const saved = JSON.parse(await file.text());
      if (version !== requestVersion.current) return;
      const savedPair = manifest.pairs.find(row => row.id === saved.pair);
      if (saved.schema_version !== 1 || !savedPair?.seeds.some(row => row.id === saved.seed)
          || !manifest.strategies.includes(saved.strategy)
          || JSON.stringify(saved.provenance) !== JSON.stringify(savedPair.provenance)
          || !Array.isArray(saved.state_ids) || saved.state_ids[0] !== saved.seed
          || saved.state_ids.length < 1 || saved.state_ids.length > manifest.max_choices + 1) throw new Error('Journey identity or provenance differs.');
      const nodes = await Promise.all(saved.state_ids.map(id => load(statePath(saved.pair, id))));
      if (version !== requestVersion.current) return;
      for (let i = 1; i < nodes.length; i++) {
        const previous = nodes[i - 1]; const next = nodes[i];
        const selected = next.history[next.history.length - 1];
        if (previous.next[String(selected)] !== saved.state_ids[i]
            || JSON.stringify(next.history.slice(0, -1)) !== JSON.stringify(previous.history)) throw new Error('Journey contains an unsupported transition.');
      }
      if (JSON.stringify(saved.history) !== JSON.stringify(nodes[nodes.length - 1].history)) throw new Error('Saved history differs from prepared predictions.');
      setPairId(saved.pair); setSeedId(saved.seed); setTrail(saved.state_ids); setStrategy(saved.strategy); setRevealed(true);
      setNotice('Journey restored.'); setError('');
    } catch (e) {if (version === requestVersion.current) {setError(`Replay failed: ${e.message}`); setBusy(false);}}
    event.target.value = '';
  }

  const card = tone => (row, i) => <ProductCard key={row.item} card={row} catalog={catalog} media={media} tone={tone} phase={phase} showDetails={showDetails}
    change={(tone === 'traditional' ? left : right)?.rows[i]} isTarget={isTarget(row.item)} isGuess={!depth && revealed && guess === row.item} follow={!depth && isTarget(row.item)}
    disabled={busy} onPick={choose} onInspect={setInspected}
    prepare={() => node.next[String(row.item)] && load(statePath(pairId, node.next[String(row.item)])).catch(() => {})}/>;
  const single = node?.buckets.every(bucket => bucket.size === 1);
  return <>
    <a className="skip-link" href="#journey-main">Skip to shopping journey</a>
    <header className="app-header"><div className="brand"><img className="brand-mark" src="/brand-mark.png" width={26} height={26} alt=""/>
      <span><a className="brand-home" href={restartUrl} title="Start over" onClick={startOver}>Cornac <span className="brand-workbench">Workbench</span></a></span><a className="preferred-signature" href="https://preferred.ai/" target="_blank" rel="noreferrer">by <strong>PreferredAI<span>.</span></strong></a></div>
      <input type="file" accept=".json,application/json" ref={replayFile} onChange={replay} hidden aria-label="Journey replay file"/>
      <div className="header-actions"><button className="button" onClick={startOver}><RotateCcw size={14} aria-hidden="true"/>Start over</button>
        {globalThis.CORNAC_DIAGNOSTICS ? <a className="button" href="?view=diagnostics">Open diagnostic workbench</a> : null}</div></header>
    <main className={`journey-main${mode === 'tour' ? ' tour-main' : ''}`} id="journey-main" tabIndex={-1}>
      {error ? <div className="message error" role="alert">{error}<button className="button" onClick={() => location.reload()}>Reload journey</button></div> : null}
      {mode === 'tour' ? manifest && pair && ready ? <Tour scene={scene} onScene={setScene}
        pair={pair} seed={pair.seeds.find(row => row.id === seedId)} node={trailNodes[trailNodes.length - 1]} nodes={trailNodes} trail={trail}
        catalog={catalog} media={media} benchmark={benchmark} strategy={strategy} setStrategy={setStrategy} choose={choose} undo={undo}
        revealed={revealed} onReveal={() => setRevealed(true)} guess={guess} onGuess={setGuess} showDetails={showDetails}
        kiosk={kioskStep >= 0} onNext={nextScene} onExplore={explore} onSeed={startSeed} load={load}/>
        : <p role="status" className="loading">Preparing your Beauty journey…</p>
      : !manifest || !node || !pair ? <p role="status" className="loading">Preparing your Beauty journey…</p> : <>
        <div className="journey-intro">{revealLine ? <><p className="journey-question" id="journey-question">{question}</p><h1 className="reveal-line">{revealLine}</h1></> : <h1 id="journey-question">{question}</h1>}</div>
        <section className="journey-context" aria-labelledby="journey-question">
          <HistoryStrip history={node.history} depth={depth} catalog={catalog} media={media} open={historyOpen} onToggle={() => setHistoryOpen(open => !open)} stripRef={timeline}/>
          <div className="journey-controls"><span className="progress-label">{terminal ? 'Journey complete' : `Choice ${depth + 1} of ${manifest.max_choices}`}<span className="progress-dots" aria-hidden="true">{Array.from({length: manifest.max_choices}, (_, i) => <i key={i} className={i < depth ? 'done' : ''}/>)}</span></span>
            <button className="button" disabled={!depth || busy} onClick={undo}><ArrowLeft size={14}/>Undo</button>
            {terminal ? null : <><button className="button" disabled={busy} onClick={() => reset(pairId, seedId)}><RotateCcw size={14}/>Restart</button>
              <button className="button" disabled={busy} onClick={download}><Download size={14}/>Save journey</button></>}
            <button className="button" disabled={busy} onClick={() => replayFile.current.click()}><Upload size={14}/>Replay journey</button>
            <button className="button" onClick={() => setShareOpen(true)}><QrCode size={14} aria-hidden="true"/>Share</button>
          </div>
        </section>
        <section className={`journey-recommendations ${busy ? 'is-busy' : ''}`} aria-labelledby="recommendations-heading" aria-busy={busy}>
          <div className="section-caption"><h2 id="recommendations-heading" ref={heading} tabIndex={-1}>{terminal ? 'Final recommendations' : 'Add an item to the history and compare the new top 5.'}</h2>
            <div className="explore-actions"><DetailsToggle on={showDetails} onToggle={() => setShowDetails(on => !on)}/><button className="button" onClick={() => setMode('tour')}>Back to the tour</button></div></div>
          {left ? <ChangeLine pair={pair} left={left} right={right} codes={addressesDiff(parent, node)} open={why} onToggle={() => setWhy(open => !open)}/> : null}
          {terminal && synced ? <Recap pair={pair} picks={node.history.slice(-2).map(item => itemShort(media, catalog, item))}
            left={nodes.slice(1).map((step, i) => shelfDiff(items(nodes[i].traditional), items(step.traditional)).newCount)} codes={nodes.slice(1).map((step, i) => addressesDiff(nodes[i], step))}
            rank={target != null ? targetRank(nodes[0].shelves[strategy], target) : 0} onAnother={() => pairSelect.current?.focus()} onRestart={() => reset(pairId, seedId)} onSave={download}/> : null}
          <div className="recommendation-columns">
          <div className="shelf-heading traditional-heading"><div><h3>Sequential model</h3><span className="model-name traditional">{pair.traditional}</span></div></div>
          <div className="product-shelf" data-testid="traditional-shelf">{node.traditional.map(card('traditional'))}</div>
          <div className="shelf-heading semantic-heading"><div><h3>Generative SID model</h3><span className="model-name semantic">{pair.sid}</span></div>
            {single ? <p className="single-code">One item per SID</p>
              : <label><span className="sr-only">SID → item strategy</span><select aria-label="SID to item strategy" value={strategy} onChange={event => {setStrategy(event.target.value); setInspected(null);}}>
                {manifest.strategies.map(value => <option key={value} value={value}>{(showDetails ? labels : plainLabels)[value]}</option>)}
              </select></label>}</div>
          <div className="product-shelf" data-testid="sid-shelf">{node.shelves[strategy].map(card('semantic'))}</div>
          </div>
          {showDetails ? <details className="context-contract"><summary>Resolver details</summary><p>{strategy.startsWith('expand') ? 'Expand members in SID order, then take five items. A large bucket can fill the list.' : 'Select one representative from each generated SID bucket.'} {strategy.endsWith('cosine') ? 'Cosine uses the visible history.' : 'Popularity uses training purchases only.'}</p></details> : null}
          <div className="journey-setup" role="group" aria-labelledby="setup-heading"><h3 id="setup-heading">Try another model</h3>
            <label>Model pair<select ref={pairSelect} aria-label="Model pair" value={pairId} onChange={event => {const selected = manifest.pairs.find(p => p.id === event.target.value); reset(selected.id, selected.seeds[0].id);}}>
              {manifest.pairs.map(row => <option key={row.id} value={row.id}>{row.traditional} + {row.sid}</option>)}
            </select></label>
            <label>Starting history<select aria-label="Starting history" value={seedId} onChange={event => reset(pairId, event.target.value)}>
              {pair.seeds.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
            </select></label>
          </div>
        </section>
        {probeStep ? <SameCodeStep probe={probe} size={nodes[0].buckets.find(bucket => bucket.address.join(',') === probe.address.join(',')).size} pair={pair} catalog={catalog} media={media}
          picked={picked} result={depth ? {left, codes: addressesDiff(parent, node)} : null} busy={busy}
          onChoose={(item, swap) => choose(item, swap ? trail.slice(0, 1) : trail)}/> : null}
        <Inspector card={inspected} node={node} catalog={catalog} media={media} pair={pair} showDetails={showDetails} onClose={() => setInspected(null)}/>
        {showDetails ? <Benchmark data={benchmark} all={benchmarks} pairs={manifest.pairs} pair={pair} strategy={strategy}/> : null}
        {shareOpen ? <SharePanel url={new URL(`#${buildHash({pair: pairId, seed: seedId, strategy, trail, revealed: revealedOnce, kiosk: false})}&${view}`, location.href).href} onClose={() => setShareOpen(false)}/> : null}
      </>}
      <div className="journey-live" role="status" aria-live="polite">{busy ? 'Updating recommendations…' : notice}</div>
      {kioskStep >= 0 ? <p className="kiosk-caption" aria-live="off">{loop[kioskStep].caption}</p> : null}
      <p className="journey-footnote">Purchase histories from Amazon Beauty (2014).{mode === 'tour' && scene <= 3 ? '' : ' Recommendations were pre-computed.'}</p>
    </main>
  </>;
}
