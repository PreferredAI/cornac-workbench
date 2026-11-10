import React, {useEffect, useRef, useState} from 'react';
import {ArrowLeft} from 'lucide-react';
import {HistoryStrip, ProductCard, SameCodeStep, addressesDiff, count, itemShort, shelfDiff} from '../journeyParts.jsx';
import {BucketBreakdown} from '../journeyExtras.jsx';
import '../journeys.css';
import './scenes.css';

const items = cards => cards.map(card => card.item);
// Long codes (RPG has 32 parts) may wrap after any dot.
const codeLabel = address => <>code {address.map((part, i) => <React.Fragment key={i}>{i ? <>·<wbr/></> : null}{part}</React.Fragment>)}</>;

function changeLine(pair, left, codes, picks) {
  const traditional = left.newCount === picks ? `${pair.traditional} rewrote all ${picks} of its picks.`
    : left.newCount ? `${pair.traditional} rewrote ${left.newCount} of its ${picks} picks.`
    : left.movedCount ? `${pair.traditional} kept the same picks in a new order.` : `${pair.traditional} kept the same ${picks} picks.`;
  const sid = codes.same ? `${pair.sid} kept the same ${codes.total} codes.`
    : codes.newCount ? `${pair.sid} predicted ${count(codes.newCount, 'new code')}.` : `${pair.sid} kept the same codes in a new order.`;
  return `${traditional} ${sid}`;
}

const codesPhrase = codes => codes.same ? 'kept the same codes' : codes.newCount ? `predicted ${count(codes.newCount, 'new code')}` : 'reordered its codes';

function recapLine(pair, names, changed, codes) {
  const [first, second] = codes.map(codesPhrase);
  return `You picked ${names[0]}, then ${names[1]}. ${pair.traditional} changed ${changed[0]} then ${changed[1]} picks; ${pair.sid} ${first === second ? `${first} both times` : `${first}, then ${second}`}.`;
}

export default function Scene4({pair, seed, node, nodes, trail, catalog, media, strategy, choose, undo, revealed, showDetails, load}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sameOpen, setSameOpen] = useState(false);
  const [inspected, setInspected] = useState(null);
  const [busy, setBusy] = useState(false);
  const codePanel = useRef(null);
  const strip = useRef(null);
  const heading = useRef(null);
  const said = useRef(null);
  const synced = nodes.length === trail.length && nodes[nodes.length - 1] === node;
  const depth = trail.length - 1;
  const terminal = !Object.keys(node.next).length;
  const parent = synced && depth ? nodes[depth - 1] : null;
  const left = parent && shelfDiff(items(parent.traditional), items(node.traditional));
  const right = parent && shelfDiff(items(parent.shelves[strategy]), items(node.shelves[strategy]));
  const target = revealed ? media?.targets[seed.id] : null;
  const probe = pair.same_bucket_probe;
  const picked = depth ? node.history[node.history.length - 1] : null;
  const canProbe = probe?.seed === seed.id && synced;
  const probeStep = sameOpen && canProbe && (!depth || (depth === 1 && probe.items.includes(picked)));
  const bucket = inspected && node.buckets.find(row => row.address.join(',') === inspected.address.join(','));

  // `base` replaces the trail the choice extends; the same-code step uses it to swap the first choice.
  function pick(item, base) {
    setBusy(true);
    Promise.resolve(choose(item, base)).catch(() => {}).then(() => setBusy(false));
  }
  useEffect(() => {
    setBusy(false); setInspected(null);
    if (strip.current) strip.current.scrollLeft = strip.current.scrollWidth;
    // Undo at the start and the last choice disable the button that had focus; keep keyboard users in place.
    const active = document.activeElement;
    if (!active || active === document.body || active.disabled) (said.current?.textContent ? said.current : heading.current)?.focus({preventScroll: true});
  }, [node]);
  useEffect(() => {if (inspected) codePanel.current?.scrollIntoView({block: 'nearest', behavior: 'smooth'});}, [inspected]);

  let line = '';
  if (terminal && synced && depth >= 2) {
    const steps = nodes.slice(1).map((step, i) => [shelfDiff(items(nodes[i].traditional), items(step.traditional)).newCount, addressesDiff(nodes[i], step)]);
    line = recapLine(pair, node.history.slice(-2).map(item => itemShort(media, catalog, item)), steps.map(([changed]) => changed), steps.map(([, codes]) => codes));
  } else if (left) line = changeLine(pair, left, addressesDiff(parent, node), node.traditional.length);

  const card = (tone, diff) => (row, i) => <ProductCard key={row.item} card={row} catalog={catalog} media={media} tone={tone} phase={terminal ? 'recap' : 'explore'}
    showDetails={showDetails} change={diff?.rows[i]} isTarget={row.item === target} disabled={busy} onPick={pick} onInspect={setInspected}
    prepare={() => node.next[String(row.item)] && load(`${pair.id}/states/${node.next[String(row.item)]}.json`).catch(() => {})}/>;

  return <>
    <h1 ref={heading} tabIndex={-1}>Add a purchase and watch both lists.</h1>
    <div className="s4">
      <div className="s4-history">
        <HistoryStrip history={node.history} depth={depth} catalog={catalog} media={media} open={historyOpen} onToggle={() => setHistoryOpen(open => !open)} stripRef={strip}/>
        <button className="button" disabled={!depth || busy} onClick={undo}><ArrowLeft size={14} aria-hidden="true"/>Undo</button>
      </div>
      <div className="s4-bar">
        {canProbe && !depth && !sameOpen ? <button className="s4-chip" onClick={() => setSameOpen(true)}>Try two products that share a code</button> : null}
        <p className={terminal && depth >= 2 ? 'tour-takeaway' : 's4-change'} role="status" aria-live="polite" ref={said} tabIndex={-1}>{line}</p>
      </div>
      {probeStep ? <SameCodeStep probe={probe} size={nodes[0].buckets.find(row => row.address.join(',') === probe.address.join(','))?.size ?? 0} pair={pair}
        catalog={catalog} media={media} picked={picked} result={depth ? {same: addressesDiff(parent, node).same, newCount: left.newCount} : null} busy={busy}
        onChoose={(item, swap) => pick(item, swap ? trail.slice(0, 1) : undefined)}/> : null}
      <div className={`recommendation-columns s4-shelves${busy ? ' is-busy' : ''}`} aria-busy={busy}>
        <div className="shelf-heading traditional-heading"><div><h3>Ranks products</h3><span className="model-name traditional">{pair.traditional}</span></div></div>
        <div className="product-shelf" data-testid="traditional-shelf">{node.traditional.map(card('traditional', left))}</div>
        <div className="shelf-heading semantic-heading"><div><h3>Predicts a code first</h3><span className="model-name semantic">{pair.sid}</span></div></div>
        <div className="product-shelf" data-testid="sid-shelf">{node.shelves[strategy].map(card('semantic', right))}</div>
      </div>
      {bucket ? <div className="s4-code" ref={codePanel}>
        <div className="s4-code-title"><h2>{`One code, ${count(bucket.size, 'product')}`}</h2><button className="button" onClick={() => setInspected(null)}>Close</button></div>
        <code className="s4-code-pill">{showDetails ? `[${bucket.address.join(', ')}]` : codeLabel(bucket.address)}</code>
        <BucketBreakdown info={media?.buckets?.[pair.sid]?.[bucket.address.join(',')]} showDetails={showDetails}/>
      </div> : null}
    </div>
  </>;
}
