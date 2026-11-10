import React, {useEffect, useRef, useState} from 'react';
import {Copy} from 'lucide-react';

// URL hash: #p=<pair>&h=<seed>&s=<strategy>&t=<state>,<state>&r=1&k=1. Trail ids are checked against `next` by the caller.
export function readHash(hash, manifest, fallbackStrategy) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const pair = manifest.pairs.find(row => row.id === params.get('p')) || manifest.pairs[0];
  const seed = pair.seeds.find(row => row.id === params.get('h'))?.id || pair.seeds[0].id;
  const steps = (params.get('t') || '').split(',').filter(Boolean);
  return {pair: pair.id, seed, strategy: manifest.strategies.includes(params.get('s')) ? params.get('s') : fallbackStrategy,
    steps: steps.length <= manifest.max_choices ? steps : [], revealed: params.get('r') === '1', kiosk: params.get('k') === '1'};
}
export const buildHash = ({pair, seed, strategy, trail, revealed, kiosk}) =>
  [`p=${pair}`, `h=${seed}`, `s=${strategy}`, trail.length > 1 && `t=${trail.slice(1).join(',')}`, revealed && 'r=1', kiosk && 'k=1'].filter(Boolean).join('&');

export function SharePanel({url, onClose}) {
  const dialog = useRef(null);
  const input = useRef(null);
  const [svg, setSvg] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
    let live = true;
    // The SVG string is generated locally from our own URL, so inserting it as HTML is safe.
    import('qrcode').then(({default: QRCode}) => QRCode.toString(url, {type: 'svg', margin: 1})).then(text => {if (live) setSvg(text);}).catch(() => {});
    return () => {live = false;};
  }, [url]);
  async function copy() {
    try {await navigator.clipboard.writeText(url); setCopied(true);} catch {input.current.select();}
  }
  return <dialog className="share-panel" ref={dialog} role="dialog" aria-labelledby="share-heading" onClose={onClose}
    onClick={event => {if (event.target === dialog.current) dialog.current.close();}}>
    <div className="share-body">
      <div className="share-title"><h2 id="share-heading">Share</h2><button className="button" onClick={() => dialog.current.close()}>Close</button></div>
      <div className="share-qr" role="img" aria-label="QR code of this journey's link" dangerouslySetInnerHTML={{__html: svg}}/>
      <p>Scan to take this journey with you.</p>
      <input ref={input} readOnly value={url} aria-label="Journey link" onFocus={event => event.target.select()}/>
      <button className="button primary" onClick={copy}><Copy size={14} aria-hidden="true"/>{copied ? 'Link copied' : 'Copy link'}</button>
    </div>
  </dialog>;
}

// Categorical slots 1-3 of the dataviz reference palette, validated on white; every bar also carries its value.
const series = {item: ['Item', '#2a78d6', 'Right product'], sid: ['SID', '#eb6834', 'Right code'], cce: ['CCE', '#1baf7a', 'Collision-corrected']};
const BAR = 12, GAP = 2, GROUP = 14, LABEL = 112, VALUE = 46, AXIS = 22;
function barPath(x, y, w, h) {
  const r = Math.min(4, w, h / 2);
  return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${r - w}z`;
}
function chartRows(pairs, data, strategy) {
  const models = new Map();
  pairs.forEach((pair, i) => {if (!models.has(pair.traditional)) models.set(pair.traditional, [['item', data[i].metrics.traditional.recall]]);});
  pairs.forEach((pair, i) => {
    const metrics = data[i].metrics;
    if (!models.has(pair.sid)) models.set(pair.sid, [['item', metrics[strategy].recall], ['sid', metrics.sid.recall], ['cce', metrics.cce.recall]]);
  });
  return [...models].map(([name, bars]) => ({name, bars}));
}

export function RecallChart({pairs, data, strategy, policy, current, showDetails = true}) {
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  const rows = chartRows(pairs, data, strategy);
  let y = 4;
  const placed = rows.map(row => {const top = y; y += row.bars.length * (BAR + GAP) - GAP + GROUP; return {...row, top};});
  const bottom = y - GROUP + 6;
  const max = Math.ceil(Math.max(...rows.flatMap(row => row.bars.map(([, value]) => value))) / 0.05) * 0.05;
  const plot = Math.max(80, width - LABEL - VALUE);
  const x = value => LABEL + value / max * plot;
  const ticks = Array.from({length: Math.round(max / 0.05) + 1}, (_, i) => i * 0.05);
  const summary = rows.map(row => `${row.name}: ${row.bars.map(([key, value]) => `${series[key][0]} ${value.toFixed(3)}`).join(', ')}`).join('. ');
  return <figure className="recall-chart">
    <ul className="chart-legend">{Object.values(series).map(([label, color, plain]) => <li key={label}><i style={{background: color}}/>{showDetails ? label : plain}</li>)}<li className="chart-policy">{showDetails ? 'SID models' : 'Code models'}: {policy}</li></ul>
    <div ref={box}>{width ? <svg width={width} height={bottom + AXIS} viewBox={`0 0 ${width} ${bottom + AXIS}`} role="img" aria-label={`Recall@5 by model. ${summary}.`}>
      <title>Recall@5 by model</title>
      {ticks.map(tick => <g key={tick}><line className={tick ? 'chart-grid' : 'chart-axis'} x1={x(tick)} x2={x(tick)} y1={0} y2={bottom}/>
        <text className="chart-tick" x={x(tick)} y={bottom + 15} textAnchor="middle">{tick ? tick.toFixed(2) : '0'}</text></g>)}
      {placed.map(row => <g key={row.name}>
        <text className={`chart-label${current.includes(row.name) ? ' is-current' : ''}`} x={LABEL - 10} y={row.top + (row.bars.length * (BAR + GAP) - GAP) / 2} dominantBaseline="central" textAnchor="end">{row.name}</text>
        {row.bars.map(([key, value], i) => {
          const top = row.top + i * (BAR + GAP);
          return <g key={key}><title>{`${row.name} · ${series[key][0]}: ${value.toFixed(4)}`}</title>
            <rect x={LABEL} y={top - GAP / 2} width={plot + VALUE} height={BAR + GAP} fill="transparent"/>
            <path d={barPath(LABEL, top, x(value) - LABEL, BAR)} fill={series[key][1]}/>
            <text className="chart-value" x={x(value) + 5} y={top + BAR / 2} dominantBaseline="central">{value.toFixed(3)}</text></g>;
        })}
      </g>)}
    </svg> : null}</div>
    <figcaption>Recall@5 on {data[0].query_count.toLocaleString()} held-out shoppers.</figcaption>
  </figure>;
}

export function BucketBreakdown({info, showDetails}) {
  if (!(info?.size > 12) || !info.categories?.length) return null;
  return <div className="bucket-breakdown"><h3>{showDetails ? 'Bucket categories' : "What's in this code"}</h3>
    <ul>{info.categories.map(([name, value]) => <li key={name}><span>{name}</span>
      <span className="breakdown-track" aria-hidden="true"><span style={{width: `${value / info.size * 100}%`}}/></span><strong>{value.toLocaleString()}</strong></li>)}</ul>
  </div>;
}
