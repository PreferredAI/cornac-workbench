import React, {useEffect} from 'react';
import {Thumb, revealText, targetRank} from '../journeyParts.jsx';
import {labeler} from './Scene3.jsx';

// RPG's 32-token SIDs share long prefixes, so a cut-off SID would make different SIDs look alike.
function CodePill({card}) {
  const code = card.address.join('·');
  const shown = card.address.length > 8 ? `${card.address.length}-token SID` : code;
  return <span className="tour-code" title={code}>{shown}</span>;
}

function Column({tone, title, model, line, cards, target, media, label}) {
  return <section className={`tour-column ${tone}`} aria-label={`${title}, ${model}`}>
    <div className="tour-column-head"><h2>{title}</h2><span className={`model-name ${tone}`}>{model}</span></div>
    <p className="tour-column-line">{line}</p>
    <ol className="tour-list" data-testid={`tour-${tone}-list`}>{cards.map((card, i) =>
      <li key={card.item} data-item={card.item} className={card.item === target ? 'is-target' : undefined}>
        <span className="tour-rank">#{i + 1}</span><Thumb media={media} item={card.item} size={80} eager/>
        <div><p>{label(card.item)}</p>{card.address ? <CodePill card={card}/> : <span className="tour-id">item {card.item}</span>}
          {card.item === target ? <span className="status-pill target-pill">Next purchase</span> : null}</div>
      </li>)}</ol>
  </section>;
}

export default function Scene2({pair, seed, nodes, catalog, media, strategy, revealed, onReveal}) {
  const root = nodes[0];
  const target = media?.targets[seed.id];
  const left = root.traditional, right = root.shelves[strategy];
  const single = root.buckets.every(bucket => bucket.size === 1);
  const traditionalRank = target == null ? 0 : targetRank(left, target);
  const label = labeler(media, catalog, root, [...left, ...right].map(card => card.item));
  // This scene shows the answer, so scene 1 shows it too from now on.
  useEffect(() => {if (target != null && !revealed) onReveal();}, []);
  return <>
    <h1><span className="tour-keep">A sequential model and a generative SID model</span> <span className="tour-keep">recommend from the same history.</span></h1>
    {target == null ? null : <p className="tour-body tour-reveal">{revealText(pair, targetRank(right, target), traditionalRank)}</p>}
    <div className="tour-columns">
      <Column tone="traditional" title="Sequential model" model={pair.traditional} line="Scores all 12,068 items and shows the top 5."
        cards={left} target={target} media={media} label={label}/>
      <Column tone="semantic" title="Generative SID model" model={pair.sid}
        line={`Generates 5 Semantic IDs (SIDs), short token sequences computed from item text${single ? '. Each of these SIDs belongs to one item.' : '; several items can share one SID.'}`}
        cards={right} target={target} media={media} label={label}/>
    </div>
  </>;
}
