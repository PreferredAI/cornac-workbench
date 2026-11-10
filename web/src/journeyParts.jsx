import React, {useState} from 'react';
import {ArrowRight, ChevronDown, Download, ExternalLink, Eye, ImageOff, RotateCcw} from 'lucide-react';

export const plainLabels = {
  one_popularity: 'One item per SID, most popular', one_cosine: 'One item per SID, most similar',
  expand_popularity: 'All items per SID, most popular', expand_cosine: 'All items per SID, most similar',
};
const decoded = new Map();
export function decodeTitle(title) {
  if (!decoded.has(title)) {
    const area = document.createElement('textarea');
    area.innerHTML = title;
    decoded.set(title, area.value);
  }
  return decoded.get(title);
}
export const itemTitle = (catalog, item) => decodeTitle(catalog[String(item)]?.title || `Item ${item}`);
export const itemShort = (media, catalog, item) => media?.items[String(item)]?.short || itemTitle(catalog, item).split(/\s+/).slice(0, 5).join(' ');
export const count = (value, word) => `${value.toLocaleString()} ${word}${value === 1 ? '' : 's'}`;
export const targetRank = (cards, target) => cards.findIndex(card => card.item === target) + 1;

export function shelfDiff(before, after) {
  const rows = after.map((item, i) => {
    const p = before.indexOf(item);
    return {item, rank: i + 1, from: p + 1, status: p < 0 ? 'new' : p === i ? 'same' : 'moved'};
  });
  return {rows, newCount: rows.filter(row => row.status === 'new').length, movedCount: rows.filter(row => row.status === 'moved').length};
}
export function addressesDiff(prev, node) {
  const before = prev.buckets.map(bucket => bucket.address.join(',')), after = node.buckets.map(bucket => bucket.address.join(','));
  return {same: before.join('|') === after.join('|'), newCount: after.filter(address => !before.includes(address)).length, total: after.length};
}
export const changeText = (left, right) => left.newCount || right.newCount || left.movedCount || right.movedCount
  ? `${left.newCount} new on the left, ${right.newCount} on the right.` : 'Nothing changed.';
export function revealText(pair, sidRank, traditionalRank) {
  if (!sidRank && !traditionalRank) return 'Neither model has the next purchase in its top 5.';
  if (sidRank && traditionalRank) return `${pair.sid} ranks the next purchase #${sidRank}. ${pair.traditional} ranks it #${traditionalRank}.`;
  const [found, missed] = sidRank ? [pair.sid, pair.traditional] : [pair.traditional, pair.sid];
  return `${found} ranks the next purchase #${sidRank || traditionalRank}. ${missed} does not have it in its top 5.`;
}
const itemsText = diff => diff.newCount === diff.rows.length ? `all ${diff.rows.length} items changed`
  : diff.newCount ? `${diff.newCount} of ${diff.rows.length} items changed` : diff.movedCount ? 'same items, new order' : `same ${diff.rows.length} items`;
const codesText = codes => codes.same ? `same ${codes.total} SIDs` : codes.newCount ? count(codes.newCount, 'new SID') : 'same SIDs, new order';
// The step-4 result line, from the traditional shelfDiff and the SID model's addressesDiff.
const resultText = (pair, left, codes) => `${pair.traditional}: ${itemsText(left)}. ${pair.sid}: ${codesText(codes)}.`;

export function Thumb({media, item, size, eager}) {
  const [failed, setFailed] = useState(false);
  const image = media?.items[String(item)]?.image;
  return image && !failed ? <img className="thumb" src={`/journeys/${image}`} width={size} height={size} loading={eager ? 'eager' : 'lazy'} decoding="async" alt="" onError={() => setFailed(true)}/>
    : <span className="thumb thumb-empty" aria-hidden="true"><ImageOff size={18}/></span>;
}

export function ProductCard({card, catalog, media, tone, phase, change, isTarget, isGuess, follow, disabled, showDetails, onPick, onInspect, prepare, fullName = true, label, ids}) {
  const title = itemTitle(catalog, card.item);
  const info = media?.items[String(card.item)];
  const extra = [info?.brand, info?.price != null ? `$${info.price.toFixed(2)}` : null].filter(Boolean).join(' · ');
  const status = change && change.status !== 'same' ? change.status : '';
  return <article className={['journey-product', tone, status && `is-${status}`, isTarget && 'is-target'].filter(Boolean).join(' ')} data-item={card.item} title={fullName ? undefined : title}>
    <Thumb media={media} item={card.item} size={80} eager/>
    <div className="product-info"><h3>{label ?? itemShort(media, catalog, card.item)}</h3>
      <div className="card-meta">
        {isTarget ? <span className="status-pill target-pill">Next purchase</span> : null}
        {isGuess ? <span className="status-pill guess-pill">Your guess</span> : null}
        {status ? <span className="status-pill change-pill">{status === 'new' ? 'new' : `${change.from > change.rank ? 'up' : 'down'} from #${change.from}`}</span> : null}
        {ids ? <span className="id-pill">item {card.item}</span> : null}
        {ids && card.address ? <button className="sid-pill" title={card.address.join('·')} aria-label={card.address.length > 8 ? undefined : `SID ${card.address.join('·')}`} onClick={() => onInspect(card)}>
          {card.address.length > 8 ? `${card.address.length}-part SID` : card.address.join('·')}
        </button> : card.address && phase !== 'hook' ? <button className="bucket-link" onClick={() => onInspect(card)}>
          SID #{card.sid_rank} · {count(card.bucket_size, 'item')} <span aria-hidden="true">↗</span>
        </button> : null}
        {fullName ? <details className="full-name"><summary>Full name</summary><p>{title}</p>{extra ? <p>{extra}</p> : null}</details> : null}
      </div></div>
    {phase === 'hook' ? <button className="guess-product" onClick={() => onPick(card.item)} aria-label={`Guess ${title}`}/>
      : phase === 'preview' ? null : <button className={`choose-product${follow ? ' follow' : ''}`} disabled={disabled || phase === 'recap'} onPointerEnter={prepare} onFocus={prepare} onClick={() => onPick(card.item)}
        aria-label={phase === 'recap' ? `Final suggestion: ${title}` : `Add ${title}`}>
        {phase === 'recap' ? 'Final suggestion' : <>Add <ArrowRight size={14} aria-hidden="true"/></>}
      </button>}
  </article>;
}

export function HistoryStrip({history, depth, catalog, media, open, onToggle, stripRef, collapsible = true, label}) {
  const all = open || !collapsible;
  const firstShown = all ? 0 : history.length - 6;
  return <div className="journey-strip">
    <ol className={`journey-timeline${all ? ' is-open' : ''}`} ref={stripRef}>{history.map((item, index) => {
      const chosen = index >= history.length - depth;
      return <li key={`${index}-${item}`} data-item={item} hidden={index < firstShown} title={itemTitle(catalog, item)}
        className={chosen ? `attendee-choice${index === history.length - 1 ? ' just-added' : ''}` : undefined}>
        <Thumb media={media} item={item} size={72} eager={index >= firstShown}/><span className="strip-index">{index + 1}</span>
        <p>{label ? label(item) : itemShort(media, catalog, item)}</p>{chosen ? <small>Yours</small> : null}
      </li>;
    })}</ol>
    {collapsible && history.length > 6 ? <button className="button small strip-toggle" aria-expanded={open} onClick={onToggle}>{open ? 'Last 6' : `All ${history.length}`}<ChevronDown size={14} aria-hidden="true"/></button> : null}
  </div>;
}

function whyRight(sid, codes, right) {
  if (codes.same) return right.newCount || right.movedCount ? `${sid} predicted the same ${codes.total} SIDs; the resolver chose different items from them.` : `${sid} predicted the same ${codes.total} SIDs, so its items did not change.`;
  return codes.newCount ? `${sid} predicted ${count(codes.newCount, 'new SID')}.` : `${sid} predicted the same ${codes.total} SIDs in a new order.`;
}
export function ChangeLine({pair, left, right, codes, open, onToggle}) {
  return <div className="change-line"><p>{resultText(pair, left, codes)}</p>
    <button className="text-button" aria-expanded={open} onClick={onToggle}>Why?</button>
    {open ? <div className="why"><p>{pair.traditional} re-ranks every item from the whole history.</p><p>{whyRight(pair.sid, codes, right)}</p></div> : null}
  </div>;
}

export function SameCodeStep({probe, size, pair, catalog, media, picked, result, busy, onChoose}) {
  const name = item => itemShort(media, catalog, item);
  const other = probe.items.find(item => item !== picked);
  return <section className="same-sid-step" data-testid="same-sid-step" aria-labelledby="same-sid-heading">
    <h2 id="same-sid-heading">Two items, one SID</h2>
    <div className="same-sid-pair">
      {probe.items.map(item => <figure key={item} className={item === picked ? 'is-picked' : undefined}><Thumb media={media} item={item} size={72}/><figcaption>{name(item)}</figcaption></figure>)}
      <span className="code-pill">SID {probe.address.join('·')} · {count(size, 'item')}</span>
    </div>
    {result ? <><p>{resultText(pair, result.left, result.codes)}</p>
      <div className="same-sid-actions"><button className="button" disabled={busy} onClick={() => onChoose(other, true)}>Add {name(other)} instead</button></div></>
      : <><p>Add either one. {pair.sid} predicts the same 5 SIDs after either item; {pair.traditional}'s top 5 differs between them.</p>
      <div className="same-sid-actions">{probe.items.map(item => <button key={item} className="button" disabled={busy} onClick={() => onChoose(item)}>Add {name(item)}</button>)}</div></>}
  </section>;
}

export function Recap({pair, picks, left, codes, rank, onAnother, onRestart, onSave}) {
  return <section className="journey-recap" aria-labelledby="recap-heading"><h3 id="recap-heading">What happened</h3>
    <p>Added {picks[0]}, then {picks[1]}.</p>
    <p>{pair.traditional}: {left[0]}, then {left[1]} of 5 items changed.</p>
    <p>{pair.sid}: {codes.every(step => step.same) ? `same ${codes[0].total} SIDs both times` : `${codesText(codes[0])}, then ${codesText(codes[1])}`}.</p>
    {rank ? <p>Before you added items, {pair.sid} ranked the next purchase #{rank}.</p> : null}
    <div className="recap-actions">
      <button className="button" onClick={onAnother}>Another model</button>
      <button className="button" onClick={onRestart}><RotateCcw size={14}/>Restart journey</button>
      <button className="button" onClick={onSave}><Download size={14}/>Save journey</button>
      <a className="button primary" href="https://github.com/PreferredAI/cornac" target="_blank" rel="noreferrer">Get Cornac<ExternalLink size={14} aria-hidden="true"/></a>
    </div>
  </section>;
}

export const DetailsToggle = ({on, onToggle}) => <button className={`button details-toggle${on ? ' active-btn' : ''}`} aria-pressed={on} onClick={onToggle}><Eye size={14} aria-hidden="true"/>Details</button>;
