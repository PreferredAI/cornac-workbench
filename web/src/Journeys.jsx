import React, {useEffect, useRef, useState} from 'react';
import {RotateCcw} from 'lucide-react';
import {changeText, count, shelfDiff} from './journeyParts.jsx';
import {DemoQr, buildHash, readHash} from './journeyExtras.jsx';
import Explore from './Explore.jsx';
import Tour from './tour/Tour.jsx';
import {labeler} from './tour/Scene3.jsx';
import './journeys.css';

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
const items = cards => cards.map(card => card.item);

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revealedOnce, setRevealed] = useState(false);
  const [guess, setGuess] = useState(null);
  const [kiosk, setKiosk] = useState(false);
  const [kioskStep, setKioskStep] = useState(-1);
  const [mode, setMode] = useState('tour');
  const [scene, setScene] = useState(1);
  const written = useRef('');
  const home = useRef(null);
  const requestVersion = useRef(0);
  const pair = manifest?.pairs.find(row => row.id === pairId);
  const target = media?.targets[seedId];
  const revealed = mode === 'explore' || revealedOnce || target == null;
  // The tour and the workbench read the trail from the cache: choices load the next state before the trail grows.
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
      // Step 0 (basics) opens only when asked for; no or an unreadable `sc` means step 1.
      const startScene = /^\d+$/.test(params.get('sc') ?? '') ? Math.min(5, Number(params.get('sc'))) : 1;
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
    setBusy(true); setError('');
    load(statePath(pairId, trail[trail.length - 1])).then(data => {
      if (version !== requestVersion.current) return;
      setNode(data); setBusy(false);
      // Start immediate successor fetches together; choices then resolve from memory.
      for (const id of new Set(Object.values(data.next))) load(statePath(pairId, id)).catch(() => {});
    }).catch(e => {if (version === requestVersion.current) {setError(e.message); setBusy(false);}});
  }, [pairId, trail]);

  function reset(nextPair, nextSeed) {
    ++requestVersion.current;
    setBusy(true); setNode(null); setGuess(null);
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
  // The workbench keeps the history when a model changes, so the two models can be compared on it.
  function switchPair(id) {
    load(statePath(id, seedId)).then(() => reset(id, seedId)).catch(e => setError(e.message));
  }
  function switchSeed(id) {
    load(statePath(pairId, id)).then(() => reset(pairId, id)).catch(e => setError(e.message));
  }
  function explore() {setMode('explore'); scrollTo(0, 0);}
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
      setRevealed(false); setMode('tour'); setScene(1); setStrategy(home.current[2]); scrollTo(0, 0); reset(home.current[0], home.current[1]);
    }},
    {caption: `Next purchase: ${target != null && trailNodes[0] ? labeler(media, catalog, trailNodes[0], [])(target) : ''}.`, ms: 5000, action: () => target != null && ready ? setRevealed(true) : false},
    {caption: `${pair?.traditional} and ${pair?.sid}, same history.`, ms: 5000, action: () => setScene(2)},
    {caption: codeCaption, ms: 4000, action: () => setScene(3)},
    {caption: codeCaption, ms: 5000, action: () => firstCode?.size > 1 ? setStrategy(value => value === 'one_cosine' ? 'one_popularity' : 'one_cosine') : false},
  ];
  return <>
    <a className="skip-link" href="#journey-main">Skip to shopping journey</a>
    <header className="app-header"><div className="brand"><img className="brand-mark" src="/brand-mark.png" width={26} height={26} alt=""/>
      <span><a className="brand-home" href={restartUrl} title="Start over" onClick={startOver}>Cornac <span className="brand-workbench">Workbench</span></a></span><a className="preferred-signature" href="https://preferred.ai/" target="_blank" rel="noreferrer">by <strong>PreferredAI<span>.</span></strong></a></div>
      <div className="header-actions"><button className="button" onClick={startOver}><RotateCcw size={14} aria-hidden="true"/>Start over</button>
        {globalThis.CORNAC_DIAGNOSTICS ? <a className="button" href="?view=diagnostics">Open diagnostic workbench</a> : null}</div></header>
    <main className={`journey-main${mode === 'tour' ? ' tour-main' : ''}`} id="journey-main" tabIndex={-1}>
      {error ? <div className="message error" role="alert">{error}<button className="button" onClick={() => location.reload()}>Reload journey</button></div> : null}
      {manifest && pair && ready ? mode === 'tour' ? <Tour scene={scene} onScene={setScene}
        pair={pair} seed={pair.seeds.find(row => row.id === seedId)} node={trailNodes[trailNodes.length - 1]} nodes={trailNodes} trail={trail}
        catalog={catalog} media={media} benchmark={benchmark} strategy={strategy} setStrategy={setStrategy} choose={choose} undo={undo}
        revealed={revealed} onReveal={() => setRevealed(true)} guess={guess} onGuess={setGuess} showDetails={false}
        kiosk={kioskStep >= 0} onNext={nextScene} onExplore={explore} onSeed={startSeed} load={load}/>
        : <Explore manifest={manifest} pair={pair} seed={pair.seeds.find(row => row.id === seedId)} node={trailNodes[trailNodes.length - 1]} nodes={trailNodes} trail={trail}
          catalog={catalog} media={media} benchmark={benchmark} strategy={strategy} setStrategy={setStrategy} choose={choose} undo={undo} load={load}
          onPair={switchPair} onSeed={switchSeed} onTour={() => setMode('tour')}/>
        : <p role="status" className="loading">Preparing your Beauty journey…</p>}
      <div className="journey-live" role="status" aria-live="polite">{busy ? 'Updating recommendations…' : notice}</div>
      {kioskStep >= 0 ? <p className="kiosk-caption" aria-live="off">{loop[kioskStep].caption}</p> : null}
      <DemoQr open={kioskStep >= 0}/>
      <p className="journey-footnote">Purchase histories from Amazon Beauty (2014).{mode === 'tour' && scene <= 3 ? '' : ' Recommendations were pre-computed.'}</p>
    </main>
  </>;
}
