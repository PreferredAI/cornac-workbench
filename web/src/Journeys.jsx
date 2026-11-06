import React, {useEffect, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, Check, Download, RotateCcw, ScanLine} from 'lucide-react';
import './journeys.css';

const labels = {
  one_popularity: 'One per SID · Popularity', one_cosine: 'One per SID · History cosine',
  expand_popularity: 'Expand buckets · Popularity', expand_cosine: 'Expand buckets · History cosine',
};
const requests = new Map();
function load(path) {
  if (!requests.has(path)) requests.set(path, fetch(`/journeys/${path}`).then(response => {
    if (!response.ok) throw new Error(`Could not load prepared journey (${response.status}).`);
    return response.json();
  }).catch(error => {requests.delete(path); throw error;}));
  return requests.get(path);
}
const statePath = (pair, id) => `${pair}/states/${id}.json`;
const number = value => Number(value).toFixed(4);
const itemTitle = (catalog, item) => catalog[String(item)]?.title || `Item ${item}`;

function Product({card, catalog, terminal, onChoose, onInspect, prepare, tone}) {
  const title = itemTitle(catalog, card.item);
  return <article className={`journey-product ${tone}`}>
    <span className="product-monogram" aria-hidden="true">{title.replace(/[^a-zA-Z ]/g, '').split(' ').filter(Boolean).slice(0, 2).map(word => word[0]).join('')}</span>
    <div className="product-info"><h3>{title}</h3>
    {card.address ? <button className="bucket-link" onClick={() => onInspect(card)}>
      SID #{card.sid_rank} · {card.bucket_size.toLocaleString()} {card.bucket_size === 1 ? 'item' : 'items'} <span aria-hidden="true">↗</span>
    </button> : null}</div>
    <button className="choose-product" disabled={terminal} onPointerEnter={prepare} onFocus={prepare} onClick={() => onChoose(card.item)}
      aria-label={terminal ? `Final suggestion: ${title}` : `Choose ${title}`}>
      {terminal ? 'Final suggestion' : <>Choose <ArrowRight size={14} aria-hidden="true"/></>}
    </button>
  </article>;
}

function Benchmark({data, pair, strategy}) {
  if (!data) return null;
  return <section className="journey-benchmark" aria-labelledby="benchmark-heading">
    <div className="section-caption"><div><h2 id="benchmark-heading">Evaluation <span className="model-tag semantic">Cornac 3.1</span></h2>
      <p>{data.query_count.toLocaleString()} held-out queries. These metrics do not score your choices.</p></div></div>
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

function Inspector({card, node, catalog, onClose}) {
  if (!card) return null;
  const bucket = node.buckets.find(row => row.address.join(',') === card.address.join(','));
  return <section className="journey-inspector" aria-labelledby="bucket-heading">
    <div className="inspector-title"><h2 id="bucket-heading">One SID, {bucket.size.toLocaleString()} {bucket.size === 1 ? 'item' : 'items'}</h2>
      <button className="button" onClick={onClose} aria-label="Close bucket inspector">Close</button></div>
    <code className="sid-code">[{bucket.address.join(', ')}]</code>
    <p>Native SID score: {number(bucket.score)}.</p>
    <div className="bucket-columns">{[['popularity', 'Training popularity'], ['cosine', 'Visible-history cosine']].map(([key, label]) =>
      <div key={key}><h3>{label}</h3><ol>{bucket[key].map(member => <li key={member.item} className={member.item === card.item ? 'chosen-member' : ''}>
        <span>{itemTitle(catalog, member.item)}{member.item === card.item ? <Check size={14} aria-label="Selected item"/> : null}</span><strong>{key === 'popularity' ? member.score.toLocaleString() : number(member.score)}</strong>
      </li>)}</ol></div>)}</div>
    <p className="subtle">Showing up to 12 leading members per resolver. Ties use the smallest catalog item index. Expanded mode exhausts each ordered bucket before moving to the next SID; one large bucket can fill the entire shelf.</p>
  </section>;
}

export default function Journeys() {
  const [manifest, setManifest] = useState(null);
  const [catalog, setCatalog] = useState({});
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
  const requestVersion = useRef(0);
  const replayFile = useRef(null);
  const timeline = useRef(null);
  const heading = useRef(null);
  const pair = manifest?.pairs.find(row => row.id === pairId);
  const seed = pair?.seeds.find(row => row.id === seedId);
  const depth = Math.max(0, trail.length - 1);
  const terminal = Boolean(manifest && depth === manifest.max_choices);

  useEffect(() => {
    document.title = 'Cornac Workbench · Beauty recommendation journeys';
    Promise.all([load('manifest.json'), load('catalog.json')]).then(([data, items]) => {
      setManifest(data); setCatalog(items);
      setPairId(data.pairs[0].id); setSeedId(data.pairs[0].seeds[0].id); setTrail([data.pairs[0].seeds[0].id]);
    }).catch(e => setError(e.message));
  }, []);

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

  function reset(nextPair, nextSeed) {
    ++requestVersion.current;
    setBusy(true); setNode(null);
    setPairId(nextPair); setSeedId(nextSeed); setTrail([nextSeed]); setNotice('New journey started.');
  }
  async function choose(item) {
    const id = node.next[String(item)];
    if (!id || busy) return;
    const version = requestVersion.current;
    setBusy(true);
    try {
      await load(statePath(pairId, id));
      if (version !== requestVersion.current) return;
      setTrail(previous => [...previous, id]);
      setNotice(`Added ${itemTitle(catalog, item)}. Recommendations updated for the same history.`);
      heading.current?.focus({preventScroll: true});
    } catch (e) {if (version === requestVersion.current) {setError(e.message); setBusy(false);}}
  }
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
      setPairId(saved.pair); setSeedId(saved.seed); setTrail(saved.state_ids); setStrategy(saved.strategy);
      setNotice('Replay verified. Your prepared journey has been restored.'); setError('');
    } catch (e) {if (version === requestVersion.current) {setError(`Replay failed: ${e.message}`); setBusy(false);}}
    event.target.value = '';
  }

  return <>
    <a className="skip-link" href="#journey-main">Skip to shopping journey</a>
    <header className="app-header"><div className="brand"><ScanLine className="brand-mark" size={25} aria-hidden="true"/>
      <span>Cornac <span className="brand-workbench">Workbench</span></span><a className="preferred-signature" href="https://preferred.ai/" target="_blank" rel="noreferrer">by <strong>PreferredAI<span>.</span></strong></a></div>
      <div className="header-actions"><input type="file" accept=".json,application/json" ref={replayFile} onChange={replay} hidden aria-label="Journey replay file"/>
        <button className="button" disabled={!manifest || busy} onClick={() => replayFile.current.click()}><RotateCcw size={14}/>Replay journey</button>
        {globalThis.CORNAC_DIAGNOSTICS ? <a className="button" href="?view=diagnostics">Open diagnostic workbench</a> : null}</div></header>
    <main className="journey-main" id="journey-main" tabIndex={-1}>
      <div className="journey-intro"><div><p className="eyebrow">Amazon Beauty</p><h1>Compare recommendations</h1></div><span className="offline-badge">Precomputed outputs</span></div>
      {error ? <div className="message error" role="alert">{error}<button className="button" onClick={() => location.reload()}>Reload journey</button></div> : null}
      {!manifest || !node || !pair ? <p role="status" className="loading">Preparing your Beauty journey…</p> : <>
        <section className="journey-setup" aria-label="Journey setup">
          <label>Model pair<select aria-label="Journey model pair" value={pairId} onChange={event => {const selected = manifest.pairs.find(p => p.id === event.target.value); reset(selected.id, selected.seeds[0].id);}}>
            {manifest.pairs.map(row => <option key={row.id} value={row.id}>{row.traditional} + {row.sid}</option>)}
          </select></label>
          <label>Starting history<select aria-label="Starting story" value={seedId} onChange={event => reset(pairId, event.target.value)}>
            {pair.seeds.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
          </select></label>
        </section>
        <section className="journey-context" aria-labelledby="history-heading">
          <div className="section-caption"><h2 id="history-heading">History</h2></div>
          <ol className="journey-timeline" ref={timeline}>{node.history.map((item, index) => <li key={`${index}-${item}`} className={index >= node.history.length - depth ? 'attendee-choice' : ''}>
            <span>{index + 1}</span><p>{itemTitle(catalog, item)}</p>{index >= node.history.length - depth ? <small>Your choice</small> : null}
          </li>)}</ol>
          <div className="journey-controls"><span className="progress-label">{terminal ? 'Journey complete' : `Choice ${depth + 1} of ${manifest.max_choices}`}<span className="progress-dots" aria-hidden="true">{Array.from({length: manifest.max_choices}, (_, i) => <i key={i} className={i < depth ? 'done' : ''}/>)}</span></span>
            <button className="button" disabled={!depth || busy} onClick={() => {setTrail(previous => previous.slice(0, -1)); setNotice('Choice undone. Explore another direction.');}}><ArrowLeft size={14}/>Undo</button>
            <button className="button" disabled={busy} onClick={() => reset(pairId, seedId)}><RotateCcw size={14}/>Restart</button>
            <button className="button" disabled={busy} onClick={download}><Download size={14}/>Save journey</button>
          </div>
          <details className="context-contract"><summary>About this example</summary><p>{seed.selection}. {manifest.execution}. Native context limits: {Object.entries(pair.contexts).map(([name, limit]) => `${name} ${limit} items`).join(' · ')}. Resolver cosine uses the entire visible history. No live model training or inference runs in your browser.</p></details>
          {pair.same_bucket_probe?.seed === seedId && depth === 0 ? <details className="context-contract"><summary>Try two products with the same SID</summary>
            <p>These alternatives share SID [{pair.same_bucket_probe.address.join(', ')}]. Offline verification confirms LETTER produces the same next native SID predictions after either choice. The item-based model and cosine resolver still receive different products. Choose one, then undo to try the other.</p>
            {pair.same_bucket_probe.items.map(item => <button key={item} className="button" disabled={busy} onClick={() => choose(item)}>{itemTitle(catalog, item)}</button>)}
          </details> : null}
        </section>
        <div className="journey-live" role="status" aria-live="polite">{busy ? 'Updating recommendations…' : notice}</div>
        <section className={`journey-recommendations ${busy ? 'is-busy' : ''}`} aria-labelledby="recommendations-heading" aria-busy={busy}>
          <div className="section-caption"><h2 id="recommendations-heading" ref={heading} tabIndex={-1}>{terminal ? 'Final recommendations' : 'Choose the next item'}</h2></div>
          <div className="recommendation-columns">
          <div className="shelf-heading traditional-heading"><div><span className="model-tag traditional">Cornac 2.0</span><h3>{pair.traditional}</h3></div><p>Direct item ranking</p></div>
          <div className="product-shelf" data-testid="traditional-shelf">{node.traditional.map(card => <Product key={card.item} card={card} catalog={catalog} terminal={terminal || busy} tone="traditional" onChoose={choose}
            prepare={() => node.next[String(card.item)] && load(statePath(pairId, node.next[String(card.item)])).catch(() => {})}/>)}</div>
          <div className="shelf-heading semantic-heading"><div><span className="model-tag semantic">Cornac 3.0</span><h3>{pair.sid}</h3></div>
            <label><span className="sr-only">SID → item strategy</span><select aria-label="SID to item strategy" value={strategy} onChange={event => {setStrategy(event.target.value); setInspected(null);}}>
              {manifest.strategies.map(value => <option key={value} value={value}>{labels[value]}</option>)}
            </select></label></div>
          <div className="product-shelf" data-testid="sid-shelf">{node.shelves[strategy].map(card => <Product key={card.item} card={card} catalog={catalog} terminal={terminal || busy} tone="semantic" onChoose={choose} onInspect={setInspected}
            prepare={() => node.next[String(card.item)] && load(statePath(pairId, node.next[String(card.item)])).catch(() => {})}/>)}</div>
          </div>
          <details className="context-contract"><summary>Resolver details</summary><p>{strategy.startsWith('expand') ? 'Expand members in SID order, then take five items. A large bucket can fill the list.' : 'Select one representative from each generated SID bucket.'} {strategy.endsWith('cosine') ? 'Cosine uses the visible history.' : 'Popularity uses training purchases only.'}</p></details>
        </section>
        <Inspector card={inspected} node={node} catalog={catalog} onClose={() => setInspected(null)}/>
        <Benchmark data={benchmark} pair={pair} strategy={strategy}/>
      </>}
    </main>
  </>;
}
