import React, {useEffect, useRef, useState} from 'react';
import {Compass, Copy, RotateCcw} from 'lucide-react';
import {plainLabels} from '../journeyParts.jsx';
import {Qr, RecallChart, demoUrl} from '../journeyExtras.jsx';
import '../journeys.css';
import './scenes.css';

const repository = 'https://github.com/PreferredAI/cornac';
const detailLabels = {one_popularity: 'One per SID · Popularity', one_cosine: 'One per SID · History cosine',
  expand_popularity: 'Expand buckets · Popularity', expand_cosine: 'Expand buckets · History cosine'};
// Copied from the verbatim block in paper.tex.
const listing = `from cornac import Experiment
from cornac.data import FeatureModality
from cornac.eval_methods import NextItemEvaluation
from cornac.metrics import Recall, NDCG
from cornac.models import SASRec, TransformerRec, TIGER, LETTER
eval_method = NextItemEvaluation.from_splits(
    train_data=train, val_data=val, test_data=test,
    item_feature=FeatureModality(features=emb, ids=item_ids),
    fmt="USIT", mode="last", semantic_id_metrics=True,
)
models = [
    SASRec(embedding_dim=128, loss="bce", max_len=50),
    TransformerRec(backbone="bert", objective="mlm", loss="ce"),
    TIGER(rqvae_codebook_size=256, n_beams=20),
    LETTER(rqvae_codebook_size=256, n_beams=20,
           cf_embeddings=cf_emb, cf_embedding_ids=item_ids),
]
Experiment(eval_method=eval_method, models=models,
           metrics=[Recall(k=5), NDCG(k=5)]).run()`;
const lines = listing.split('\n');
const block = (first, last) => {const from = lines.indexOf(first); return [from, lines.indexOf(last, from)];};
// Each highlight marks a run of lines or one token of the listing.
const notes = [
  {id: 1, lines: block('eval_method = NextItemEvaluation.from_splits(', ')'), text: 'One train/validation/test split and one evaluation protocol for all models.'},
  {id: 2, lines: block('models = [', ']'), text: 'Sequential models (SASRec, BERT4Rec) and SID models (TIGER, LETTER) in one list.'},
  {id: 3, token: 'semantic_id_metrics=True', text: 'Reports item-level, SID-level and CCE metrics from the same predictions.'},
];

// Light Python colouring: strings, keywords, numbers and keyword arguments.
const syntax = /("[^"\n]*"|'[^'\n]*')|\b(and|as|def|else|for|from|if|import|in|is|lambda|not|or|return|with|True|False|None)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)(?==[^=])/g;
const kinds = ['string', 'keyword', 'number', 'argument'];
function colour(text, at) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(syntax)) {
    parts.push(text.slice(last, match.index));
    parts.push(<span key={at + match.index} className={`py-${kinds[match.findIndex((group, i) => i && group) - 1]}`}>{match[0]}</span>);
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

// The numbers sit in the gutter as CSS text, so the code's text stays exactly the listing.
function Listing({active, onActive}) {
  const mark = id => `s5-mark${active === id ? ' is-active' : ''}`;
  const number = id => <span className={`s5-number${active === id ? ' is-active' : ''}`} data-number={id} aria-hidden="true"
    onMouseEnter={() => onActive(id)} onMouseLeave={() => onActive(0)}/>;
  const line = i => {
    const text = i < lines.length - 1 ? `${lines[i]}\n` : lines[i];
    const note = notes.find(row => row.token && text.includes(row.token));
    if (!note) return colour(text, `${i}-`);
    const start = text.indexOf(note.token), end = start + note.token.length;
    return [...colour(text.slice(0, start), `${i}-`), <React.Fragment key={`${i}-mark`}>{number(note.id)}
      <span className={mark(note.id)} data-mark={note.id}>{colour(note.token, `${i}-${start}-`)}</span></React.Fragment>, ...colour(text.slice(end), `${i}-${end}-`)];
  };
  const code = [];
  for (let i = 0; i < lines.length; i++) {
    const note = notes.find(row => row.lines?.[0] === i);
    if (!note) {code.push(...line(i)); continue;}
    const [, last] = note.lines;
    code.push(<span key={`mark-${note.id}`} className={`${mark(note.id)} is-lines`} data-mark={note.id}>{number(note.id)}
      {Array.from({length: last - i + 1}, (_, j) => line(i + j))}</span>);
    i = last;
  }
  return <pre className={`s5-listing${active ? ' has-active' : ''}`} tabIndex={0} aria-label="Cornac experiment in Python"><code>{code}</code></pre>;
}

const collisions = [
  'TIGER and DIGER give every item its own SID: when items share the first three tokens, a fourth token tells them apart, so the three scores are equal. In TIGER here, 1,617 items share their first three tokens with another item (722 groups, at most 8 items each).',
  'RPG uses long SIDs (32 tokens here) and no suffix: 71 of 12,068 items share a SID (at most 4 per SID), so its three scores differ by less than 0.001.',
  'LETTER reassigns the last token of colliding items (up to 20 passes) but keeps the collisions that remain: 3,421 items share 570 SIDs, one SID covers 1,643 items.',
  'DiffGRM keeps collisions: 3,629 items share 1,157 SIDs, at most 38 per SID.',
];

// Rows for models outside the pairs (DIGER); the chart shows the pairs alone if the file is missing.
const extraRows = extra => extra?.models.map(({name, metrics}) => ({name, bars: ['item', 'sid', 'cce'].map(key => [key, metrics[key].recall])}));

export default function Scene5({pair, strategy, showDetails, onExplore, load}) {
  const [all, setAll] = useState(null);
  const [qr, setQr] = useState('');
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const pip = useRef(null);
  useEffect(() => {
    let live = true;
    load('manifest.json').then(manifest => Promise.all([load('extra-benchmarks.json').catch(() => null), ...manifest.pairs.map(row => load(row.benchmark))])
      .then(([extra, ...data]) => {if (live) setAll({pairs: manifest.pairs, data, extra: extraRows(extra)});})).catch(() => {});
    // The SVG string is generated locally from a fixed URL, so inserting it as HTML is safe.
    import('qrcode').then(({default: QRCode}) => QRCode.toString(repository, {type: 'svg', margin: 1}))
      .then(text => {if (live) setQr(text);}).catch(() => {});
    return () => {live = false;};
  }, []);
  // A fresh page load starts at step 1 with the default pair, history and rule; the attract loop setting stays.
  function startOver() {
    const kiosk = new URLSearchParams(location.hash.replace(/^#/, '')).get('k') === '1';
    history.replaceState(history.state, '', `${location.pathname}${location.search}${kiosk ? '#k=1' : ''}`);
    location.reload();
  }
  async function copy() {
    try {await navigator.clipboard.writeText('pip install cornac'); setCopied(true);} catch {getSelection().selectAllChildren(pip.current);}
  }
  const actions = [
    ['explore', 'Open the full workbench', 'All 8 model pairs, 6 histories and 4 resolvers.', Compass, onExplore],
    ['restart', 'Start over', 'Back to step 1.', RotateCcw, startOver],
  ];

  return <>
    <h1>The Cornac experiment behind this demo</h1>
    <div className="s5-grid">
      <Listing active={active} onActive={setActive}/>
      <ol className={`s5-notes${active ? ' has-active' : ''}`} aria-label="What the code does">{notes.map(note =>
        <li key={note.id} data-mark={note.id} className={active === note.id ? 'is-active' : undefined} tabIndex={0}
          onMouseEnter={() => setActive(note.id)} onMouseLeave={() => setActive(0)} onFocus={() => setActive(note.id)} onBlur={() => setActive(0)}>
          <span className="s5-note-number" aria-hidden="true">{note.id}</span>{note.text}</li>)}</ol>
    </div>
    <div className="s5-chart">
      {all ? <RecallChart pairs={all.pairs} data={all.data} strategy={strategy} policy={(showDetails ? detailLabels : plainLabels)[strategy]}
        current={[pair.traditional, pair.sid]} showDetails={showDetails} extra={all.extra}/>
        : <div className="s5-chart-wait" aria-hidden="true"/>}
    </div>
    <section className="s5-block s5-collisions" aria-labelledby="s5-collisions-heading">
      <h2 id="s5-collisions-heading">How each SID model handles collisions (items that share a SID)</h2>
      <ul>{collisions.map(text => <li key={text}>{text}</li>)}</ul>
    </section>
    <section className="s5-block s5-get">
      <div className="s5-get-part">
        <div className="s5-get-text">
          <h2 id="s5-get-heading">Install Cornac</h2>
          <div className="s5-install"><code className="s5-pip" ref={pip}>pip install cornac</code>
            <button className="button" onClick={copy}><Copy size={14} aria-hidden="true"/>{copied ? 'Copied' : 'Copy'}</button></div>
          <a className="s5-repo" href={repository} target="_blank" rel="noreferrer">github.com/PreferredAI/cornac</a>
        </div>
        <div className="s5-qr" role="img" aria-label="QR code for the Cornac repository on GitHub" dangerouslySetInnerHTML={{__html: qr}}/>
      </div>
      <div className="s5-get-part s5-phone">
        <div className="s5-get-text">
          <h2>Try the demo!</h2>
          <a className="s5-demo" href={demoUrl} target="_blank" rel="noreferrer">cornac-workbench.preferred.ai</a>
        </div>
        <Qr url={demoUrl} label="QR code for the Cornac Workbench" className="s5-demo-qr"/>
      </div>
    </section>
    <section className="s5-block s5-more">
      <ul className="s5-actions">{actions.map(([key, text, about, Icon, onClick], i) => <li key={key}>
        <button className={`button${i ? '' : ' primary'}`} data-action={key} aria-describedby={`s5-about-${key}`} onClick={onClick}><Icon size={15} aria-hidden="true"/>{text}</button>
        <p id={`s5-about-${key}`}>{about}</p>
      </li>)}</ul>
    </section>
  </>;
}
