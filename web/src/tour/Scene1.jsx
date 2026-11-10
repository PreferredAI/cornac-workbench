import React, {useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {Thumb, itemShort, itemTitle} from '../journeyParts.jsx';
import {labeler} from './Scene3.jsx';

// Decoys: the first items of the traditional top-5, then the SID model's cosine and popularity top-5, that the
// shopper never bought, preferring short names not already on a card.
function pickCards(root, target, name) {
  const candidates = [...root.traditional, ...root.shelves.one_cosine, ...root.shelves.one_popularity].map(card => card.item)
    .filter((item, i, all) => item !== target && !root.history.includes(item) && all.indexOf(item) === i);
  const decoys = [];
  for (const item of candidates) if (decoys.length < 3 && ![target, ...decoys].some(other => name(other) === name(item))) decoys.push(item);
  for (const item of candidates) if (decoys.length < 3 && !decoys.includes(item)) decoys.push(item);
  return [target, ...decoys].sort((a, b) => a - b);
}

export default function Scene1({pair, seed, nodes, catalog, media, revealed, onReveal, guess, onGuess, onSeed}) {
  const root = nodes[0];
  const [allPhotos, setAllPhotos] = useState(false);
  const target = media?.targets[seed.id];
  const name = item => itemShort(media, catalog, item);
  const cards = target == null ? [] : pickCards(root, target, name);
  const label = labeler(media, catalog, root, cards);
  function pick(item) {
    if (revealed) return;
    onGuess(item); onReveal();
  }
  return <>
    <h1>One user's purchase history: {root.history.length} items from Amazon Beauty.</h1>
    {/* Phones show the last 8 purchases until the visitor asks for all of them. */}
    <ol className={`tour-photos${allPhotos ? ' is-open' : ''}`}>{root.history.map((item, i) =>
      <li key={`${i}-${item}`} data-item={item} title={itemTitle(catalog, item)} className={i < root.history.length - 8 ? 'is-early' : undefined}>
        <Thumb media={media} item={item} size={120} eager/><span className="tour-index">{i + 1}</span><p>{label(item)}</p>
      </li>)}</ol>
    {root.history.length > 8 ? <button className="button small strip-toggle tour-photos-toggle" aria-expanded={allPhotos} onClick={() => setAllPhotos(open => !open)}>
      {allPhotos ? 'Last 8' : `All ${root.history.length}`}<ChevronDown size={14} aria-hidden="true"/></button> : null}
    <label className="tour-shopper"><span>History</span>
      <select aria-label="History" value={seed.id} onChange={event => onSeed(event.target.value)}>
        {pair.seeds.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
      </select></label>
    {target == null ? null : <>
      <div className="tour-ask"><p className="tour-body">Which item did this user buy next? Pick one.</p>
        {revealed ? null : <button className="text-button" onClick={onReveal}>Show the answer</button>}</div>
      <div className={`tour-picks${revealed ? ' is-revealed' : ''}`}>{cards.map(item =>
        <button key={item} data-item={item} title={itemTitle(catalog, item)} aria-disabled={revealed} onClick={() => pick(item)}
          className={['tour-pick', revealed && item === target && 'is-target', revealed && item === guess && 'is-guess'].filter(Boolean).join(' ')}>
          <Thumb media={media} item={item} size={180} eager/>
          <span className="tour-pick-name">{label(item)}</span>
          {revealed && (item === target || item === guess) ? <span className="tour-pick-pills">
            {item === target ? <span className="status-pill target-pill">Next purchase</span> : null}
            {item === guess ? <span className="status-pill guess-pill">Your guess</span> : null}
          </span> : null}
        </button>)}</div>
    </>}
  </>;
}
