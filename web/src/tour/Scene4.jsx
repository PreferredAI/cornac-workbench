import React, {useEffect, useRef, useState} from 'react';
import {ArrowLeft} from 'lucide-react';
import {HistoryStrip, ProductCard, Thumb, addressesDiff, count, itemTitle, plainLabels, shelfDiff} from '../journeyParts.jsx';
import {BucketBreakdown} from '../journeyExtras.jsx';
import {labeler} from './Scene3.jsx';
import '../journeys.css';
import './scenes.css';

const items = cards => cards.map(card => card.item);
const sidKey = bucket => bucket.address.join(',');
// Long SIDs (RPG has 32 parts) may wrap after any dot.
const dotted = address => address.map((part, i) => <React.Fragment key={i}>{i ? <>·<wbr/></> : null}{part}</React.Fragment>);
const sidLabel = address => <>SID {dotted(address)}</>;
// SIDs over 8 tokens read `32-token SID`, as on steps 2 and 3.
const sidText = address => address.length > 8 ? `${address.length}-token SID` : address.join('·');

const itemsPhrase = (left, picks) => left.newCount === picks ? `all ${picks} items changed` : left.newCount ? `${left.newCount} of ${picks} items changed`
  : left.movedCount ? 'same items, new order' : `same ${picks} items`;
const sidsPhrase = codes => codes.same ? `same ${codes.total} SIDs` : codes.newCount ? count(codes.newCount, 'new SID') : 'same SIDs, new order';

const changeLine = (pair, left, codes, picks) => `${pair.traditional}: ${itemsPhrase(left, picks)}. ${pair.sid}: ${sidsPhrase(codes)}.`;

function recapLine(pair, names, changed, codes, picks) {
  const [first, second] = codes.map(sidsPhrase);
  return `Added ${names[0]}, then ${names[1]}. ${pair.traditional}: ${changed[0]}, then ${changed[1]} of ${picks} items changed. ${pair.sid}: ${first === second ? `${first} both times` : `${first}, then ${second}`}.`;
}

// Two items with one SID: the manifest's probe on its history, otherwise the two lowest item ids of the
// first SID (by rank) with at least two items on the root's lists that have next states.
function sameSid(pair, seed, root) {
  const probe = pair.same_bucket_probe;
  if (probe?.seed === seed.id) return probe;
  const cards = Object.values(root.shelves).flat().filter(card => root.next[String(card.item)]);
  for (const bucket of root.buckets) {
    const found = [...new Set(cards.filter(card => sidKey(card) === sidKey(bucket)).map(card => card.item))].sort((a, b) => a - b);
    if (found.length > 1) return {items: found.slice(0, 2), address: bucket.address};
  }
  return null;
}

// The line under the columns once an item is picked, from both items' next states.
function sameLine(pair, [a, b], after) {
  const [left, right] = after.map(state => items(state.traditional));
  const [first, second] = after.map(state => state.buckets.map(sidKey));
  const k = left.filter(item => right.includes(item)).length;
  const m = first.filter(code => second.includes(code)).length;
  const sids = m === first.length && m === second.length ? `After item ${a} or item ${b}, ${pair.sid} reads the same input and predicts the same ${m} SIDs.`
    : `${pair.sid}'s two SID lists share ${m} of ${first.length} SIDs.`;
  return `${sids} ${pair.traditional} reads two different item IDs; ${k === left.length
    ? 'here its two top-5 lists happen to be the same.' : `its two top-5 lists share ${k} of ${left.length} items.`}`;
}

// Two items with one SID. Picking one previews its next state; nothing is added.
function Picker({same, pair, catalog, media, picked, onPick, name}) {
  return <section className="s4-same" data-testid="same-sid-step">
    <p id="s4-same-intro">Items {same.items[0]} and {same.items[1]} have the same {pair.sid} SID. Pick one to see what each model reads and recommends.</p>
    <div className="s4-picker" role="radiogroup" aria-label="Item to add">{same.items.map(item =>
      <label key={item} className={`s4-pick${item === picked ? ' is-on' : ''}`} data-item={item} title={itemTitle(catalog, item)}>
        <input type="radio" name="s4-item" checked={item === picked} onChange={() => onPick(item)}/>
        <Thumb media={media} item={item} size={72}/>
        <div><p>{name(item)}</p><span className="tour-id">item {item}</span><code className="s3-pill" title={same.address.join('·')}>{sidText(same.address)}</code></div>
      </label>)}</div>
  </section>;
}

// A model's input as cells: a count of the earlier positions, then the last three, numbered as in the history
// strip; the last `added` are the items added here.
function InputRow({model, input, added, sids}) {
  const from = Math.max(0, input.length - 3);
  const shown = input.slice(from);
  const text = item => sids ? sidText(sids[String(item)]) : String(item);
  const label = `${model} reads ${sids ? 'SIDs' : 'item IDs'}`;
  return <div className="s4-input" role="group" aria-label={`${label}: ${shown.map(text).join(', ')}`}>
    <p className="s4-input-label">{label}</p>
    <ol className="s4-seq">
      {from ? <li className="s4-more">{from} earlier</li> : null}
      {shown.map((item, i) => {
        const position = from + i + 1, isNew = position > input.length - added, sid = sids?.[String(item)];
        return <li key={position} data-item={item} className={['s4-entry', sid && 's4-sid', isNew && 'is-new'].filter(Boolean).join(' ')} title={sid?.join('·')}>
          <small>{isNew ? `${position} · added` : position}</small><span>{sid && sid.length <= 8 ? dotted(sid) : text(item)}</span>
        </li>;
      })}
    </ol>
  </div>;
}

// The tour keeps the resolver fixed, so both lists react to the new item alone. The workbench passes its own
// resolver and shows only the add-items view.
export default function Scene4({pair, seed, node, nodes, trail, catalog, media, choose, undo, revealed, showDetails, load, workbench = false, rule = 'one_cosine'}) {
  // Phase 1 previews one item of a same-SID pair; phase 2 is the journey. A journey in progress opens phase 2.
  const [phase, setPhase] = useState(workbench || trail.length > 1 ? 2 : 1);
  const moved = useRef(false);
  // The journey replays no entry animations when it comes back unchanged.
  const [back, setBack] = useState(null);
  const [inspected, setInspected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(null);
  const [after, setAfter] = useState(null);
  const [sids, setSids] = useState(null);
  const codePanel = useRef(null);
  const heading = useRef(null);
  const said = useRef(null);
  const root = nodes[0];
  const same = workbench ? null : sameSid(pair, seed, root);
  const synced = nodes.length === trail.length && nodes[nodes.length - 1] === node;
  const depth = trail.length - 1;
  const terminal = !Object.keys(node.next).length;
  const parent = synced && depth ? nodes[depth - 1] : null;
  // Phase 1 shows the original history, or the picked item's next state against it.
  const preview = phase === 1 && picked != null && after ? after[same.items.indexOf(picked)] : null;
  const shown = phase === 1 ? preview || root : node;
  const base = phase === 1 ? preview && root : parent;
  const added = phase === 1 ? preview ? [picked] : [] : node.history.slice(root.history.length);
  const left = base && shelfDiff(items(base.traditional), items(shown.traditional));
  const right = base && shelfDiff(items(base.shelves[rule]), items(shown.shelves[rule]));
  const target = revealed ? media?.targets[seed.id] : null;
  const bucket = inspected && shown.buckets.find(row => sidKey(row) === sidKey(inspected));
  // Phase 1 names come from the pair and every list it can show, so an item keeps one name while switching picks.
  const label = labeler(media, catalog, root, phase === 1 ? [...(same ? same.items : []), ...(after || []).flatMap(state => items([...state.traditional, ...state.shelves[rule]]))]
    : [...node.history, ...items([...node.traditional, ...node.shelves[rule]])]);

  useEffect(() => {
    let live = true;
    load('sids.json').then(data => {if (live) setSids(data.sids[pair.sid]);}).catch(() => {});
    if (same) Promise.all(same.items.map(item => load(`${pair.id}/states/${root.next[String(item)]}.json`)))
      .then(states => {if (live) setAfter(states);}).catch(() => {});
    return () => {live = false;};
  }, [pair, root]);
  function pick(item) {
    setBusy(true);
    Promise.resolve(choose(item)).catch(() => {}).then(() => setBusy(false));
  }
  useEffect(() => {
    setBusy(false); setInspected(null);
    // Undo at the start and the last choice disable the button that had focus; keep keyboard users in place.
    const active = document.activeElement;
    if (!active || active === document.body || active.disabled) (said.current?.textContent ? said.current : heading.current)?.focus({preventScroll: true});
  }, [node]);
  useEffect(() => {if (inspected) codePanel.current?.scrollIntoView({block: 'nearest', behavior: 'smooth'});}, [inspected]);
  useEffect(() => {if (moved.current) {scrollTo(0, 0); heading.current?.focus({preventScroll: true});}}, [phase]);
  function show(next) {
    moved.current = true;
    if (next === 2) setBack(node);
    setInspected(null);
    setPhase(next);
  }

  let line = '';
  if (phase === 2 && terminal && synced && depth >= 2) {
    const steps = nodes.slice(1).map((step, i) => [shelfDiff(items(nodes[i].traditional), items(step.traditional)).newCount, addressesDiff(nodes[i], step)]);
    line = recapLine(pair, node.history.slice(-2).map(label), steps.map(([changed]) => changed), steps.map(([, codes]) => codes), node.traditional.length);
  } else if (phase === 2 && left) line = changeLine(pair, left, addressesDiff(parent, node), node.traditional.length);

  const card = (tone, diff) => (row, i) => <ProductCard key={row.item} card={row} catalog={catalog} media={media} tone={tone} phase={phase === 1 ? 'preview' : terminal ? 'recap' : 'explore'}
    showDetails={showDetails} change={diff?.rows[i]} isTarget={row.item === target} disabled={busy} onPick={pick} onInspect={setInspected} fullName={false} label={label(row.item)} ids
    prepare={() => node.next[String(row.item)] && load(`${pair.id}/states/${node.next[String(row.item)]}.json`).catch(() => {})}/>;
  const input = [...root.history, ...added];
  const Heading = workbench ? 'h2' : 'h1';
  const resolver = plainLabels[rule];

  return <>
    <Heading ref={heading} tabIndex={-1}>{phase === 1 ? 'How each model reads the history' : 'Add an item to the history and compare the new top 5.'}</Heading>
    <div className={`s4${phase === 2 && back === node ? ' is-back' : ''}`} data-phase={phase}>
      {phase === 1 ? same ? <Picker same={same} pair={pair} catalog={catalog} media={media} picked={picked} onPick={item => {setPicked(item); setInspected(null);}} name={label}/>
        : <p className="s4-same-none">Each of the {root.buckets.length} {pair.sid} SIDs here belongs to one item, so there are no two items with the same SID to compare.</p>
        : <>
          {workbench ? null : <button className="text-button s4-back" onClick={() => show(1)}>How each model reads the history</button>}
          <div className="s4-history">
            <HistoryStrip history={node.history} depth={depth} catalog={catalog} media={media} collapsible={false} label={label}/>
            <button className="button" disabled={!depth || busy} onClick={undo}><ArrowLeft size={14} aria-hidden="true"/>Undo</button>
          </div>
          <div className="s4-bar">
            <p className={terminal && depth >= 2 ? 'tour-takeaway' : 's4-change'} role="status" aria-live="polite" ref={said} tabIndex={-1}>{line}</p>
          </div>
        </>}
      <div className={`recommendation-columns s4-shelves${busy ? ' is-busy' : ''}`} aria-busy={busy}>
        <div className="shelf-heading traditional-heading"><div><h3>Sequential model</h3><span className="model-name traditional">{pair.traditional}</span>
          <InputRow model={pair.traditional} input={input} added={added.length}/></div></div>
        <div className="product-shelf" data-testid="traditional-shelf">{shown.traditional.map(card('traditional', left))}</div>
        <div className="shelf-heading semantic-heading"><div><h3>Generative SID model</h3><span className="model-name semantic">{pair.sid}</span>
          {sids ? <InputRow model={pair.sid} input={input} added={added.length} sids={sids}/> : null}
          <p className="s4-rule">{`Resolver: ${resolver.charAt(0).toLowerCase()}${resolver.slice(1)}.`}</p></div></div>
        <div className="product-shelf" data-testid="sid-shelf">{shown.shelves[rule].map(card('semantic', right))}</div>
      </div>
      {bucket ? <div className="s4-code" ref={codePanel}>
        <div className="s4-code-title"><h2>{`One SID, ${count(bucket.size, 'item')}`}</h2><button className="button" onClick={() => setInspected(null)}>Close</button></div>
        <code className="s4-code-pill">{showDetails ? `[${bucket.address.join(', ')}]` : sidLabel(bucket.address)}</code>
        <BucketBreakdown info={media?.buckets?.[pair.sid]?.[bucket.address.join(',')]} showDetails={showDetails}/>
      </div> : null}
      {phase === 1 ? <>
        {same ? <p className="s4-same-line" role="status">{picked != null && after ? sameLine(pair, same.items, after) : ''}</p> : null}
        <button className="button primary s4-go" onClick={() => show(2)}>Choose items to add</button>
      </> : null}
    </div>
  </>;
}
