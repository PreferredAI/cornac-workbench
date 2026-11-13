import React, {useEffect, useRef, useState} from 'react';
import {ArrowLeft, ChevronDown} from 'lucide-react';
import {plainLabels, revealText, targetRank} from './journeyParts.jsx';
import {RecallChart} from './journeyExtras.jsx';
import Scene4 from './tour/Scene4.jsx';
import './explore.css';

const lower = text => text.charAt(0).toLowerCase() + text.slice(1);
// Rows for models outside the pairs (DIGER), as on step 5; the chart shows the pairs alone if the file is missing.
const extraRows = extra => extra?.models.map(({name, metrics}) => ({name, bars: ['item', 'sid', 'cce'].map(key => [key, metrics[key].recall])}));

function Select({label, value, options, onChange}) {
  return <label className="wb-select"><span>{label}</span>
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  </label>;
}

function More({title, children}) {
  return <details className="wb-more"><summary>{title}<ChevronDown size={16} aria-hidden="true"/></summary><div>{children}</div></details>;
}

function Scores({pair, data, all, pairs, strategy}) {
  const rows = [
    [pair.traditional, 'traditional', 'Item-level', 'traditional'],
    [pair.sid, 'semantic', 'Item-level', strategy, 'with the resolver above'],
    [pair.sid, 'semantic', 'SID-level', 'sid'],
    [pair.sid, 'semantic', 'CCE', 'cce'],
  ];
  return <section className="wb-scores" aria-labelledby="wb-scores-heading">
    <h2 id="wb-scores-heading">Scores for this pair</h2>
    <p>Recall@5 on {data ? data.query_count.toLocaleString() : '…'} test users. They do not score the items you add.</p>
    <dl className="wb-tiles">{rows.map(([model, tone, level, key, note]) => <div key={key} data-metric={key}>
      <dt><span className={`model-name ${tone}`}>{model}</span><span className="wb-tile-level">{level}</span>{note ? <span className="wb-tile-note">{note}</span> : null}</dt>
      <dd>{data ? data.metrics[key].recall.toFixed(3) : '…'}</dd>
    </div>)}</dl>
    <More title="All models">{all ? <RecallChart pairs={pairs} data={all.data} strategy={strategy} policy={plainLabels[strategy]}
      current={[pair.traditional, pair.sid]} showDetails={false} extra={all.extra}/> : null}</More>
    <More title="Recall and NDCG">
      <table className="wb-table">
        <thead><tr><th scope="col">Model</th><th scope="col">Level</th><th scope="col">Recall@5</th><th scope="col">NDCG@5</th></tr></thead>
        <tbody>{rows.map(([model, , level, key]) => <tr key={key}>
          <th scope="row">{model}</th><td>{key === strategy ? `${level}, ${lower(plainLabels[strategy])}` : level}</td>
          <td>{data ? data.metrics[key].recall.toFixed(4) : '…'}</td><td>{data ? data.metrics[key].ndcg.toFixed(4) : '…'}</td>
        </tr>)}</tbody>
      </table>
    </More>
  </section>;
}

// The full workbench: step 4's add-items view with settings for the models, history and resolver.
export default function Explore({manifest, pair, seed, node, nodes, trail, catalog, media, benchmark, strategy,
  setStrategy, choose, undo, load, onPair, onSeed, onTour}) {
  const heading = useRef(null);
  const [all, setAll] = useState(null);
  useEffect(() => {heading.current?.focus({preventScroll: true});}, []);
  useEffect(() => {
    let live = true;
    Promise.all([load('extra-benchmarks.json').catch(() => null), ...manifest.pairs.map(row => load(row.benchmark))])
      .then(([extra, ...data]) => {if (live) setAll({data, extra: extraRows(extra)});}).catch(() => {});
    return () => {live = false;};
  }, [manifest]);

  const names = key => [...new Set(manifest.pairs.map(row => row[key]))].map(name => [name, name]);
  function switchModel(traditional, sid) {
    const next = manifest.pairs.find(row => row.traditional === traditional && row.sid === sid);
    if (next) onPair(next.id);
  }
  const target = media?.targets[seed.id];
  const reveal = trail.length === 1 && target != null ? revealText(pair, targetRank(node.shelves[strategy], target), targetRank(node.traditional, target)) : '';
  // The container clears its benchmark while a new pair loads; the preloaded set fills the gap.
  const data = benchmark || all?.data[manifest.pairs.indexOf(pair)];

  return <div className="wb">
    <div className="wb-title">
      <h1 ref={heading} tabIndex={-1}>Compare any two models on any history.</h1>
      <button className="button" onClick={onTour}><ArrowLeft size={16} aria-hidden="true"/>Back to the tour</button>
    </div>
    <section className="wb-settings" role="group" aria-label="Settings">
      <div className="wb-selects">
        <Select label="Sequential model" value={pair.traditional} options={names('traditional')} onChange={name => switchModel(name, pair.sid)}/>
        <Select label="Generative SID model" value={pair.sid} options={names('sid')} onChange={name => switchModel(pair.traditional, name)}/>
        <Select label="History" value={seed.id} options={pair.seeds.map(row => [row.id, row.label])} onChange={onSeed}/>
        <Select label="Resolver" value={strategy} options={manifest.strategies.map(key => [key, plainLabels[key]])} onChange={setStrategy}/>
      </div>
      {node.buckets.every(row => row.size === 1) ? <p className="wb-single">Each of these {pair.sid} SIDs belongs to one item, so the resolver does not change the list.</p> : null}
    </section>
    {reveal ? <p className="wb-reveal">{reveal}</p> : null}
    <Scene4 workbench rule={strategy} key={pair.id + seed.id} pair={pair} seed={seed} node={node} nodes={nodes} trail={trail}
      catalog={catalog} media={media} choose={choose} undo={undo} revealed showDetails={false} load={load}/>
    <Scores pair={pair} data={data} all={all} pairs={manifest.pairs} strategy={strategy}/>
  </div>;
}
