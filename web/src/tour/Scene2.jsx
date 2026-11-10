import React, {useEffect} from 'react';
import {Thumb, itemShort, itemTitle, revealText, targetRank} from '../journeyParts.jsx';

function takeawayText(pair, target, sidHit, traditionalRank) {
  if (target == null) return `Now look at ${pair.sid}'s first code.`;
  if (sidHit?.sid_rank === 1) return `${pair.sid}'s first code was right. Now look at that code.`;
  if (sidHit) return `${pair.sid}'s code #${sidHit.sid_rank} was right. Now look at its first code.`;
  if (traditionalRank) return `${pair.sid} missed it this time. Still, look at its first code.`;
  return `Neither list has it. Still, look at ${pair.sid}'s first code.`;
}

function Column({tone, title, model, line, cards, target, media, label}) {
  return <section className={`tour-column ${tone}`} aria-label={`${title}, ${model}`}>
    <div className="tour-column-head"><h2>{title}</h2><span className={`model-name ${tone}`}>{model}</span></div>
    <p className="tour-column-line">{line}</p>
    <ol className="tour-list" data-testid={`tour-${tone}-list`}>{cards.map((card, i) =>
      <li key={card.item} data-item={card.item} className={card.item === target ? 'is-target' : undefined}>
        <span className="tour-rank">#{i + 1}</span><Thumb media={media} item={card.item} size={80} eager/>
        <div><p>{label(card.item)}</p>{card.item === target ? <span className="status-pill target-pill">They bought this</span> : null}</div>
      </li>)}</ol>
  </section>;
}

export default function Scene2({pair, seed, nodes, catalog, media, strategy, revealed, onReveal}) {
  const root = nodes[0];
  const target = media?.targets[seed.id];
  const left = root.traditional, right = root.shelves[strategy];
  const traditionalRank = target == null ? 0 : targetRank(left, target);
  // Products that share a short name with another product in either list show their full title instead.
  const shown = [...new Set([...left, ...right].map(card => card.item))];
  const name = item => itemShort(media, catalog, item);
  const cap = text => text.charAt(0).toUpperCase() + text.slice(1);
  const label = item => shown.some(other => other !== item && name(other) === name(item)) ? cap(itemTitle(catalog, item)) : name(item);
  // This scene shows the answer, so scene 1 shows it too from now on.
  useEffect(() => {if (target != null && !revealed) onReveal();}, []);
  return <>
    <h1>Two models saw the same {root.history.length} purchases.</h1>
    {target == null ? null : <p className="tour-body tour-reveal">{revealText(pair, targetRank(right, target), traditionalRank)}</p>}
    <div className="tour-columns">
      <Column tone="traditional" title="Ranks products" model={pair.traditional} line="Ranks all 12,068 products directly."
        cards={left} target={target} media={media} label={label}/>
      <Column tone="semantic" title="Predicts a code first" model={pair.sid}
        line="Predicts a short code, like a shelf label shared by similar products, then picks a product with that code."
        cards={right} target={target} media={media} label={label}/>
    </div>
    <p className="tour-takeaway">{takeawayText(pair, target, right.find(card => card.item === target), traditionalRank)}</p>
  </>;
}
