import React, {useRef, useState} from 'react';
import {Thumb, itemShort, plainLabels} from '../journeyParts.jsx';
import {BucketBreakdown} from '../journeyExtras.jsx';
import '../journeys.css';
import './scenes.css';

const rules = [['one_popularity', 'popularity'], ['one_cosine', 'cosine']];
// Long codes (RPG has 32 parts) may wrap after any dot.
const codeLabel = address => <>code {address.map((part, i) => <React.Fragment key={i}>{i ? <>·<wbr/></> : null}{part}</React.Fragment>)}</>;

function BigCard({item, catalog, media, tag, isTarget, from}) {
  const info = media?.items[String(item)];
  const extra = [info?.brand, info?.price != null ? `$${info.price.toFixed(2)}` : null].filter(Boolean).join(' · ');
  return <article className={['s3-card', from && `s3-from-${from}`, isTarget && 's3-target'].filter(Boolean).join(' ')} data-item={item}>
    <Thumb media={media} item={item} size={200} eager/>
    <div className="s3-card-info">
      <span className="model-name semantic">{tag}</span>
      <h2>{itemShort(media, catalog, item)}</h2>
      {extra ? <p>{extra}</p> : null}
      {isTarget ? <span className="status-pill target-pill">They bought this</span> : null}
    </div>
  </article>;
}

function Scores({benchmark, model, showDetails}) {
  if (!benchmark) return null;
  const {sid, one_cosine, cce} = benchmark.metrics;
  return <div className="s3-scores">
    <p><span className="model-name semantic">{model}</span>Recall@5 on {benchmark.query_count.toLocaleString()} held-out shoppers.</p>
    <dl>{[['Right code', 'SID', sid], ['Right product', 'Item', one_cosine], ['Collision-corrected', 'CCE', cce]].map(([label, term, value]) =>
      <div key={label}><dt>{label}{showDetails ? <small>{term}</small> : null}</dt><dd>{value.recall.toFixed(3)}</dd></div>)}</dl>
  </div>;
}

export default function Scene3({pair, seed, node, catalog, media, benchmark, strategy, setStrategy, revealed, showDetails}) {
  const bucket = node.buckets[0];
  const single = node.buckets.every(row => row.size === 1);
  const selected = strategy.endsWith('popularity') ? 0 : 1;
  // The rule can also change from outside (the attract loop), so the swap follows `strategy`, not the click.
  const initial = useRef(selected);
  const [moved, setMoved] = useState(false);
  if (!moved && selected !== initial.current) setMoved(true);
  const item = bucket[rules[selected][1]][0].item;
  const target = revealed ? media?.targets[seed.id] : null;

  return <>
    <h1>{single ? 'One code, one product.' : `One code, ${bucket.size.toLocaleString()} products.`}</h1>
    <div className="s3">
      <code className="s3-code">{showDetails ? `[${bucket.address.join(', ')}]` : codeLabel(bucket.address)}</code>
      <p className="tour-body">{single ? 'Every code here names exactly one product, so the three scores agree.' : 'Any of these would count as the right code. Which product you see depends on a picking rule.'}</p>
      <div className={`s3-block${single ? ' is-single' : ''}`}>
        {single ? null : <BucketBreakdown info={media?.buckets?.[pair.sid]?.[bucket.address.join(',')]} showDetails={showDetails}/>}
        <div className="s3-picker">
          {single ? null : <div className="s3-segmented" role="radiogroup" aria-label="Picking rule">
            {rules.map(([value], index) => <label key={value} className={index === selected ? 'is-on' : undefined}>
              <input type="radio" name="s3-rule" value={value} checked={index === selected} onChange={() => setStrategy(value)}/>{plainLabels[value]}
            </label>)}
          </div>}
          <div className="s3-stage" aria-live="polite">
            <BigCard key={item} item={item} catalog={catalog} media={media} tag={pair.sid} isTarget={item === target} from={moved ? (selected ? 'right' : 'left') : ''}/>
          </div>
        </div>
      </div>
      {moved && !single ? <p className="tour-takeaway">That is why Cornac scores code models three ways.</p> : null}
      {moved || single ? <Scores benchmark={benchmark} model={pair.sid} showDetails={showDetails}/> : null}
    </div>
  </>;
}
