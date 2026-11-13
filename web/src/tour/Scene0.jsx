import React, {useEffect, useRef, useState} from 'react';
import {ArrowRight, ChevronDown} from 'lucide-react';
import {Thumb, count, itemShort, itemTitle} from '../journeyParts.jsx';
import {labeler} from './Scene3.jsx';

// A schematic top 5: bars of decreasing width, no scores or items.
const bars = [100, 84, 71, 61, 53];
// SIDs may wrap after any dot on narrow screens.
const dotted = sid => sid.map((token, i) => <React.Fragment key={i}>{i ? <>·<wbr/></> : null}{token}</React.Fragment>);

// The history item that shows a first-token group best: its SID is not the generated one and its group has at
// least 8 items; highest share of the group's top category, then the larger group, then later in the history.
function example(history, sids, groups, generated) {
  let best = null;
  history.forEach(item => {
    const sid = sids[String(item)], group = sid && groups[String(sid[0])];
    if (!group || group.size < 8 || sid.join() === generated.join()) return;
    const share = group.top[0][1] / group.size;
    if (!best || share > best.share || (share === best.share && group.size >= best.size)) best = {item, share, size: group.size};
  });
  return best ? best.item : history[history.length - 1];
}

function Tokens({sid}) {
  return <ol className="s0-tokens" title={sid.join('·')}>
    {sid.map((token, i) => <li key={i} className="s0-token" style={{'--i': i}}>{token}</li>)}
  </ol>;
}

// The tokens fill in left to right once they are on screen, so a visitor who scrolls down on a phone still sees them.
function Generate({sid}) {
  const box = useRef(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {if (entry.isIntersecting) {setOn(true); observer.disconnect();}}, {threshold: .6});
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={box} className={`s0-generate${on ? ' is-on' : ''}`}>{sid ? <Tokens sid={sid}/> : null}</div>;
}

// One prefix of the example's SID, as a row of step 3: the items whose SID starts with it, shown on request. The
// example comes first, since a group's listed members need not include it.
function PrefixRow({prefix, group, item, hidden, open, onOpen, catalog, media, label}) {
  const key = prefix.join(',');
  const [category, inTop] = group.top[0];
  const members = [item, ...group.members.filter(member => member !== item && !hidden.has(member))];
  const more = group.size - members.length;
  return <li className={`s0-prefix-row${open ? ' is-open' : ''}`} data-prefix={key}>
    <code className="s0-prefix-pill">{prefix.join('·')}</code>
    <div className="s0-prefix-about"><span className="s0-prefix-size">{count(group.size, 'item')}</span>
      <span className="s0-prefix-top">{inTop === group.size ? 'All' : `${Math.round(inTop / group.size * 100)}%`} {category.toLowerCase()}</span></div>
    <button className="button s0-show" aria-expanded={open} aria-controls={open ? `s0-prefix-${key}` : undefined} onClick={onOpen}>Show items<ChevronDown size={14} aria-hidden="true"/></button>
    {open ? <div className="s0-prefix-items" id={`s0-prefix-${key}`}>
      <ul>{members.map(member => <li key={member} data-item={member} title={itemTitle(catalog, member)} className={member === item ? 'is-example' : undefined}>
        <Thumb media={media} item={member} size={48}/>
        <div><p>{label(member)}</p>{member === item ? <span className="s0-this">This item</span> : null}</div>
      </li>)}</ul>
      {more > 0 ? <p className="s0-prefix-more">+ {count(more, 'more item')}</p> : null}
    </div> : null}
  </li>;
}

export default function Scene0({pair, seed, nodes, catalog, media, load, onNext}) {
  const root = nodes[0];
  // Step 0 explains SIDs with TIGER whatever the pair, because TIGER's first token groups similar items.
  const [tiger, setTiger] = useState(null);
  const [open, setOpen] = useState('');
  useEffect(() => {
    let live = true;
    const state = load('manifest.json').then(manifest =>
      load(`${manifest.pairs.find(row => row.sid === 'TIGER' && row.traditional === pair.traditional).id}/states/${seed.id}.json`));
    Promise.all([load('sids.json'), load('prefixes.json'), state])
      .then(([sids, prefixes, tigerRoot]) => {if (live) setTiger({sids: sids.sids.TIGER, groups: prefixes.prefixes.TIGER, stats: prefixes.stats, generated: tigerRoot.buckets[0].address});})
      .catch(() => {});
    return () => {live = false;};
  }, [pair, seed]);
  const last = root.history.slice(-3);
  const earlier = root.history.length - last.length;
  const chosen = tiger && example(root.history, tiger.sids, tiger.groups, tiger.generated);
  const sid = tiger?.sids[String(chosen)];
  const prefixes = sid ? [1, 2, 3].map(n => sid.slice(0, n)).filter(prefix => tiger.groups[prefix.join(',')]) : [];
  // No spoiler: the prefix panels leave out the next purchase and every item on the pair's lists.
  const hidden = new Set([media?.targets[seed.id], ...[...root.traditional, ...Object.values(root.shelves).flat()].map(card => card.item)]);
  // One naming rule for every item the prefix panels can show; the example above keeps its short name.
  const label = labeler(media, catalog, root, prefixes.flatMap(prefix => tiger.groups[prefix.join(',')].members));
  const percent = value => `${Math.round(value * 100)}%`;

  return <>
    <h1>Two ways to predict a user's next purchase</h1>
    <div className="s0">
      <section className="s0-panel s0-task">
        <h2>Next-item recommendation</h2>
        <ol className="s0-sequence">
          {earlier ? <li className="s0-more">{earlier} earlier</li> : null}
          {last.map((item, i) => <li key={i} className="s0-photo" data-item={item} title={itemTitle(catalog, item)}>
            <Thumb media={media} item={item} size={96} eager/><span className="tour-index">{earlier + i + 1}</span>
          </li>)}
          <li className="s0-next"><span className="s0-ask" aria-hidden="true">?</span><span className="s0-next-label">next</span></li>
        </ol>
        <p className="s0-line">It reads one user's purchases in order and ranks the items the user is likely to buy next.</p>
      </section>
      <section className="s0-panel s0-sequential">
        <div className="tour-column-head"><h2>Sequential model</h2><span className="model-name traditional">{pair.traditional}</span></div>
        <p className="s0-line">Reads each purchase as its item ID.</p>
        <ol className="s0-steps">
          <li><p className="s0-step">Reads the item IDs</p>
            <ol className="s0-ids">{last.map((item, i) => <li key={i} data-item={item}>{item}</li>)}</ol></li>
          <li><p className="s0-step">Scores all 12,068 items</p>
            <ol className="s0-scores">{bars.map((width, i) => <li key={i}><span>#{i + 1}</span><i style={{width: `${width}%`}}/></li>)}</ol>
            <p className="s0-scores-more">… 12,063 more</p></li>
          <li><p className="s0-step">Recommends the 5 highest scores</p></li>
        </ol>
      </section>
      <section className="s0-panel s0-sid">
        <div className="tour-column-head"><h2>Generative SID model</h2><span className="model-name semantic">TIGER</span></div>
        <p className="s0-line">Translates each item into a few semantic tokens, from general to specific: its Semantic ID (SID).</p>
        <ol className="s0-steps">
          <li><p className="s0-step">Translates the item's text into an SID</p>
            {sid ? <div className="s0-example" data-item={chosen} title={itemTitle(catalog, chosen)}>
              <Thumb media={media} item={chosen} size={64} eager/>
              <div><p>{itemShort(media, catalog, chosen)}</p><Tokens sid={sid}/><p className="s0-caption">general → specific</p></div>
            </div> : null}</li>
          <li><p className="s0-step">Reads the history as SIDs</p>
            {tiger ? <ol className="s0-sids">{last.map((item, i) => <li key={i} data-item={item}>{dotted(tiger.sids[String(item)])}</li>)}</ol> : null}</li>
          <li><p className="s0-step">Generates the next SID one token at a time</p><Generate sid={tiger?.generated}/></li>
          <li><p className="s0-step">Looks up the item with that SID</p></li>
        </ol>
      </section>
      {tiger ? <section className="s0-panel s0-prefix">
        <h2>Similar items share the first tokens</h2>
        <p className="s0-line">Across TIGER's SIDs for all {tiger.stats.items.toLocaleString()} items, two items that share the first token are in the same top-level category {percent(tiger.stats.first_token_same_top)} of the time; two random items, {percent(tiger.stats.random_same_top)}.</p>
        <ol className="s0-prefix-rows">{prefixes.map(prefix => {
          const key = prefix.join(',');
          return <PrefixRow key={key} prefix={prefix} group={tiger.groups[key]} item={chosen} hidden={hidden} open={open === key}
            onOpen={() => setOpen(open === key ? '' : key)} catalog={catalog} media={media} label={label}/>;
        })}</ol>
      </section> : null}
    </div>
    <button className="button primary s0-go" onClick={onNext}>Try it on a real history<ArrowRight size={16} aria-hidden="true"/></button>
  </>;
}
