import React, {useEffect, useRef, useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {Thumb, count, itemShort, itemTitle} from '../journeyParts.jsx';
import {BucketBreakdown} from '../journeyExtras.jsx';
import '../journeys.css';
import './scenes.css';

// The strategy is `${per}_${order}`, e.g. one_cosine or expand_popularity.
const groups = [
  ['per', 'Items per SID', [['one', 'One item per SID'], ['expand', 'All items per SID']]],
  ['order', 'Order within a SID', [['cosine', 'Most similar'], ['popularity', 'Most popular']]],
];

export function Choices({name, label, options, value, onChange}) {
  return <div className="s3-segmented" role="radiogroup" aria-label={label}>
    {options.map(([key, text]) => <label key={key} className={key === value ? 'is-on' : undefined}>
      <input type="radio" name={`s3-${name}`} value={key} checked={key === value} onChange={() => onChange(key)}/>{text}
    </label>)}
  </div>;
}

function Segmented(props) {
  return <div className="s3-control">
    <span className="s3-control-label">{props.label}</span>
    <Choices {...props}/>
  </div>;
}

// One naming rule for steps 1-4: an item whose short name repeats among the history, the root's lists and the
// scene's own `items` shows its full title instead, so an item keeps its name from step to step.
export function labeler(media, catalog, root, items) {
  const pool = [...new Set([...root.history, ...[...root.traditional, ...root.shelves.one_cosine, ...root.shelves.one_popularity].map(card => card.item), ...items])];
  const name = item => itemShort(media, catalog, item);
  const cap = text => text.charAt(0).toUpperCase() + text.slice(1);
  return item => pool.some(other => other !== item && name(other) === name(item)) ? cap(itemTitle(catalog, item)) : name(item);
}

// Products that replace another after the first render slide in; the ones already on screen stay put.
function Pick({item, catalog, media, isTarget, live, label}) {
  const [fresh] = useState(live.current);
  return <li className={['s3-pick', fresh && 'is-fresh', isTarget && 'is-target'].filter(Boolean).join(' ')} data-item={item} title={itemTitle(catalog, item)}>
    <Thumb media={media} item={item} size={64} eager/>
    <div><p>{label(item)}</p>{isTarget ? <span className="status-pill target-pill">Next purchase</span> : null}</div>
  </li>;
}

function How({id, bucket, order, shelf, sid, catalog, media, showDetails, label}) {
  const members = bucket[order];
  const more = bucket.size - members.length;
  return <div className="s3-how" id={id}>
    <div className="s3-how-list">
      <ol className="s3-members">{members.map((row, i) => <li key={row.item} data-item={row.item} className={shelf.has(row.item) ? 'is-shown' : undefined} title={itemTitle(catalog, row.item)}>
        <span className="s3-member-rank">{i + 1}</span><Thumb media={media} item={row.item} size={48}/>
        <div><p>{label(row.item)}</p><small>{order === 'cosine' ? `similarity ${row.score.toFixed(3)}` : count(row.score, 'purchase')}</small></div>
      </li>)}</ol>
      {more > 0 ? <p className="s3-more">+ {count(more, 'more item')}</p> : null}
    </div>
    <BucketBreakdown info={media?.buckets?.[sid]?.[bucket.address.join(',')]} showDetails={showDetails}/>
  </div>;
}

const tiles = [
  ['SID-level', "next item's SID in the top 5 SIDs"],
  ['Item-level', 'next item in the 5 items shown; depends on the resolver'],
  ['CCE', 'each SID expanded into all its items in random order; expected item-level score'],
];

// Item-level follows the resolver on screen; SID-level and CCE don't depend on it.
function Scores({benchmark, model, strategy}) {
  if (!benchmark) return null;
  const {sid, cce, [strategy]: item} = benchmark.metrics;
  return <div className="s3-scores">
    <p>Cornac evaluates SID models at three levels ({model}, Recall@5, {benchmark.query_count.toLocaleString()} test users):</p>
    <dl>{tiles.map(([label, note], i) => <div key={label}>
      <dt><span className="s3-score-label">{label}</span><span className="s3-score-note">{note}</span></dt>
      <dd>{[sid, item, cce][i].recall.toFixed(3)}</dd></div>)}</dl>
  </div>;
}

// Step 3 picks up step 2's result: the next purchase's SID, found in any of the stored lists so the
// heading does not change with the resolver toggles.
function opening(sid, node, target, single) {
  if (single) return ['Each of these SIDs belongs to one item.', 'So the resolver does not change the list.'];
  const body = `Which item ${sid} shows from each SID is decided by a resolver:`;
  const card = ['one_cosine', 'one_popularity', 'expand_cosine', 'expand_popularity'].map(key => node.shelves[key].find(row => row.item === target)).find(Boolean);
  if (card?.bucket_size > 1) return [`${sid} predicted the next purchase's SID, but ${card.bucket_size.toLocaleString()} items share it.`, `It is ${sid}'s #${card.sid_rank} SID. ${body}`];
  if (node.buckets[0].size > 1) return [`${sid}'s top SID is shared by ${count(node.buckets[0].size, 'item')}.`, body];
  return [`${sid}'s SIDs here are shared by up to ${count(Math.max(...node.buckets.map(row => row.size)), 'item')}.`, body];
}

export default function Scene3({pair, seed, node, nodes, catalog, media, benchmark, strategy, setStrategy, revealed, showDetails}) {
  const single = node.buckets.every(row => row.size === 1);
  const [per, order] = strategy.split('_');
  const cards = node.shelves[strategy];
  const shelf = new Set(cards.map(card => card.item));
  // One naming rule for every item this step can show (rows and all ranking panels), so an item keeps its name.
  const label = labeler(media, catalog, nodes[0], [...Object.values(node.shelves).flat().map(card => card.item),
    ...node.buckets.flatMap(row => [...row.cosine, ...row.popularity].map(member => member.item))]);
  const target = revealed ? media?.targets[seed.id] : null;
  const [heading, lead] = opening(pair.sid, node, media?.targets[seed.id], single);
  const [open, setOpen] = useState(0);
  // The strategy can also change from outside (the attract loop), so render from `strategy`, not from the click.
  const initial = useRef(strategy);
  const [acted, setActed] = useState(false);
  if (!acted && strategy !== initial.current) setActed(true);
  const live = useRef(false);
  useEffect(() => {live.current = true;}, []);
  const change = (group, value) => setStrategy(group === 'per' ? `${value}_${order}` : `${per}_${value}`);

  return <>
    <h1>{heading}</h1>
    <div className="s3">
      <p className="tour-body">{lead}</p>
      {single ? null : <div className="s3-controls">{groups.map(([group, label, options]) =>
        <Segmented key={group} name={group} label={label} options={options} value={group === 'per' ? per : order} onChange={value => change(group, value)}/>)}
        <p className="s3-note">Most similar: cosine similarity between the item and the history. Most popular: purchases in the training data.</p></div>}
      <ol className="s3-rows">{node.buckets.map((bucket, i) => {
        const k = i + 1, code = bucket.address.join(','), full = bucket.address.join('·');
        // RPG's 32-part SIDs share long prefixes, so a cut-off SID would make different SIDs look alike.
        const shown = bucket.address.length > 8 ? `${bucket.address.length}-part SID` : full;
        const picks = cards.filter(card => card.sid_rank === k);
        return <li key={code} className={['s3-row', !picks.length && 'is-unused', open === k && 'is-open'].filter(Boolean).join(' ')} data-code={code}>
          <span className="s3-rank">#{k}</span>
          <div className="s3-code"><code className="s3-pill" title={full}>{shown}</code><span className="s3-size">{count(bucket.size, 'item')}</span></div>
          <div className="s3-take" aria-live="polite">{picks.length
            ? <ul className="s3-picks">{picks.map(card => <Pick key={card.item} item={card.item} catalog={catalog} media={media} isTarget={card.item === target} live={live} label={label}/>)}</ul>
            : <p className="s3-unused">Not used</p>}</div>
          <button className="button s3-how-button" aria-expanded={open === k} aria-controls={open === k ? `s3-how-${k}` : undefined}
            onClick={() => {setOpen(open === k ? 0 : k); setActed(true);}}>Show ranking<ChevronDown size={14} aria-hidden="true"/></button>
          {open === k ? <How id={`s3-how-${k}`} bucket={bucket} order={order} shelf={shelf} sid={pair.sid} catalog={catalog} media={media} showDetails={showDetails} label={label}/> : null}
        </li>;
      })}</ol>
      {acted || single ? <Scores benchmark={benchmark} model={pair.sid} strategy={strategy}/> : null}
    </div>
  </>;
}
