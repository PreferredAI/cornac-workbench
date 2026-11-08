import React, {useState} from 'react';
import {ArrowRight, ChevronDown, Download, ExternalLink, Eye, ImageOff, RotateCcw} from 'lucide-react';

export const plainLabels = {
  one_popularity: 'Most popular', one_cosine: 'Closest to this history',
  expand_popularity: 'Fill from the top code, most popular', expand_cosine: 'Fill from the top code, closest',
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
  if (!sidRank && !traditionalRank) return 'Neither list had it.';
  return [[pair.sid, sidRank], [pair.traditional, traditionalRank]].map(([name, rank]) => rank ? `${name} had it at #${rank}.` : `${name} didn't list it.`).join(' ');
}
const codesText = codes => codes.same ? 'same codes' : codes.newCount ? count(codes.newCount, 'new code') : 'reordered codes';

export function Thumb({media, item, size, eager}) {
  const [failed, setFailed] = useState(false);
  const image = media?.items[String(item)]?.image;
  return image && !failed ? <img className="thumb" src={`/journeys/${image}`} width={size} height={size} loading={eager ? 'eager' : 'lazy'} decoding="async" alt="" onError={() => setFailed(true)}/>
    : <span className="thumb thumb-empty" aria-hidden="true"><ImageOff size={18}/></span>;
}

export function ProductCard({card, catalog, media, tone, phase, change, isTarget, isGuess, follow, disabled, showDetails, onPick, onInspect, prepare}) {
  const title = itemTitle(catalog, card.item);
  const info = media?.items[String(card.item)];
  const extra = [info?.brand, info?.price != null ? `$${info.price.toFixed(2)}` : null].filter(Boolean).join(' · ');
  const status = change && change.status !== 'same' ? change.status : '';
  return <article className={['journey-product', tone, status && `is-${status}`, isTarget && 'is-target'].filter(Boolean).join(' ')} data-item={card.item}>
    <Thumb media={media} item={card.item} size={80} eager/>
    <div className="product-info"><h3>{itemShort(media, catalog, card.item)}</h3>
      <div className="card-meta">
        {isTarget ? <span className="status-pill target-pill">They bought this</span> : null}
        {isGuess ? <span className="status-pill guess-pill">Your guess</span> : null}
        {status ? <span className="status-pill change-pill">{status === 'new' ? 'new' : `${change.from > change.rank ? 'up' : 'down'} from #${change.from}`}</span> : null}
        {card.address && phase !== 'hook' ? <button className="bucket-link" onClick={() => onInspect(card)}>
          {showDetails ? `SID #${card.sid_rank} · ${count(card.bucket_size, 'item')}` : `code #${card.sid_rank} · ${count(card.bucket_size, 'product')}`} <span aria-hidden="true">↗</span>
        </button> : null}
        <details className="full-name"><summary>Full name</summary><p>{title}</p>{extra ? <p>{extra}</p> : null}</details>
      </div></div>
    {phase === 'hook' ? <button className="guess-product" onClick={() => onPick(card.item)} aria-label={`Guess ${title}`}/>
      : <button className={`choose-product${follow ? ' follow' : ''}`} disabled={disabled || phase === 'recap'} onPointerEnter={prepare} onFocus={prepare} onClick={() => onPick(card.item)}
        aria-label={phase === 'recap' ? `Final suggestion: ${title}` : `Choose ${title}`}>
        {phase === 'recap' ? 'Final suggestion' : <>{follow ? 'Follow the shopper' : 'Choose'} <ArrowRight size={14} aria-hidden="true"/></>}
      </button>}
  </article>;
}

export function HistoryStrip({history, depth, catalog, media, open, onToggle, stripRef}) {
  const firstShown = open ? 0 : history.length - 6;
  return <div className="journey-strip">
    <ol className={`journey-timeline${open ? ' is-open' : ''}`} ref={stripRef}>{history.map((item, index) => {
      const chosen = index >= history.length - depth;
      return <li key={`${index}-${item}`} data-item={item} hidden={index < firstShown} title={itemTitle(catalog, item)}
        className={chosen ? `attendee-choice${index === history.length - 1 ? ' just-added' : ''}` : undefined}>
        <Thumb media={media} item={item} size={72} eager={index >= firstShown}/><span className="strip-index">{index + 1}</span>
        <p>{itemShort(media, catalog, item)}</p>{chosen ? <small>Yours</small> : null}
      </li>;
    })}</ol>
    {history.length > 6 ? <button className="button small strip-toggle" aria-expanded={open} onClick={onToggle}>{open ? 'Last 6' : `All ${history.length}`}<ChevronDown size={14} aria-hidden="true"/></button> : null}
  </div>;
}

function whyRight(sid, codes, right) {
  if (codes.same) return right.newCount || right.movedCount ? `${sid} predicted the same ${codes.total} codes. Only the pick inside each code moved.` : `${sid} predicted the same ${codes.total} codes, so its products stayed.`;
  return codes.newCount ? `${sid} predicted ${count(codes.newCount, 'new code')}.` : `${sid} predicted the same ${codes.total} codes in a new order.`;
}
export function ChangeLine({pair, left, right, codes, open, onToggle}) {
  return <div className="change-line"><p>{changeText(left, right)}</p>
    <button className="text-button" aria-expanded={open} onClick={onToggle}>Why?</button>
    {open ? <div className="why"><p>{pair.traditional} re-ranks every product from the whole history.</p><p>{whyRight(pair.sid, codes, right)}</p></div> : null}
  </div>;
}

export function SameCodeStep({probe, size, pair, catalog, media, picked, result, busy, onChoose}) {
  const name = item => itemShort(media, catalog, item);
  const other = probe.items.find(item => item !== picked);
  return <section className="same-sid-step" data-testid="same-sid-step" aria-labelledby="same-sid-heading">
    <h2 id="same-sid-heading">Two products, one code.</h2>
    <div className="same-sid-pair">
      {probe.items.map(item => <figure key={item} className={item === picked ? 'is-picked' : undefined}><Thumb media={media} item={item} size={72}/><figcaption>{name(item)}</figcaption></figure>)}
      <span className="code-pill">code {probe.address.join('·')} · {count(size, 'product')}</span>
    </div>
    {result ? <><p>{result.same ? 'Same codes on the right. ' : ''}{result.newCount} new on the left.</p>
      <div className="same-sid-actions"><button className="button" disabled={busy} onClick={() => onChoose(other, true)}>Try {name(other)} instead</button></div></>
      : <><p>Pick either one. {pair.sid}'s next codes stay the same; {pair.traditional}'s list doesn't.</p>
      <div className="same-sid-actions">{probe.items.map(item => <button key={item} className="button" disabled={busy} onClick={() => onChoose(item)}>Choose {name(item)}</button>)}</div></>}
  </section>;
}

export function Recap({pair, picks, left, codes, rank, onAnother, onRestart, onSave}) {
  return <section className="journey-recap" aria-labelledby="recap-heading"><h3 id="recap-heading">What happened</h3>
    <p>You picked {picks[0]}, then {picks[1]}.</p>
    <p>{pair.traditional}: {left[0]} then {left[1]} new.</p>
    <p>{pair.sid}: {codesText(codes[0])}, then {codesText(codes[1])}.</p>
    {rank ? <p>Before you started, {pair.sid} already had the real purchase at #{rank}.</p> : null}
    <div className="recap-actions">
      <button className="button" onClick={onAnother}>Another model</button>
      <button className="button" onClick={onRestart}><RotateCcw size={14}/>Start over</button>
      <button className="button" onClick={onSave}><Download size={14}/>Save journey</button>
      <a className="button primary" href="https://github.com/PreferredAI/cornac" target="_blank" rel="noreferrer">Get Cornac<ExternalLink size={14} aria-hidden="true"/></a>
    </div>
  </section>;
}

export const DetailsToggle = ({on, onToggle}) => <button className={`button details-toggle${on ? ' active-btn' : ''}`} aria-pressed={on} onClick={onToggle}><Eye size={14} aria-hidden="true"/>Details</button>;
