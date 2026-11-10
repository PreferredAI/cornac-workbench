import React, {useEffect, useState} from 'react';
import {Compass, RotateCcw, Share2} from 'lucide-react';
import {plainLabels} from '../journeyParts.jsx';
import {RecallChart, SharePanel, buildHash} from '../journeyExtras.jsx';
import '../journeys.css';
import './scenes.css';

const repository = 'https://github.com/PreferredAI/cornac';
const detailLabels = {one_popularity: 'One per SID · Popularity', one_cosine: 'One per SID · History cosine',
  expand_popularity: 'Expand buckets · Popularity', expand_cosine: 'Expand buckets · History cosine'};
// Copied from the verbatim block in paper.tex.
const listing = `from cornac import Experiment
from cornac.data import FeatureModality
from cornac.eval_methods import NextItemEvaluation
from cornac.metrics import Recall, NDCG
from cornac.models import SASRec, TransformerRec, TIGER, LETTER
eval_method = NextItemEvaluation.from_splits(
    train_data=train, val_data=val, test_data=test,
    item_feature=FeatureModality(features=emb, ids=item_ids),
    fmt="USIT", mode="last", semantic_id_metrics=True,
)
models = [
    SASRec(embedding_dim=64, loss="bce", max_len=50),
    TransformerRec(backbone="bert", objective="mlm", loss="ce"),
    TIGER(rqvae_codebook_size=256, n_beams=20),
    LETTER(rqvae_codebook_size=256, cf_weight=0.02, n_beams=20),
]
Experiment(eval_method=eval_method, models=models,
           metrics=[Recall(k=10), NDCG(k=10)]).run()`;

export default function Scene5({pair, seed, trail, strategy, revealed, showDetails, onExplore, load}) {
  const [all, setAll] = useState(null);
  const [qr, setQr] = useState('');
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    let live = true;
    load('manifest.json').then(manifest => Promise.all(manifest.pairs.map(row => load(row.benchmark)))
      .then(data => {if (live) setAll({pairs: manifest.pairs, data});})).catch(() => {});
    // The SVG string is generated locally from a fixed URL, so inserting it as HTML is safe.
    import('qrcode').then(({default: QRCode}) => QRCode.toString(repository, {type: 'svg', margin: 1}))
      .then(text => {if (live) setQr(text);}).catch(() => {});
    return () => {live = false;};
  }, []);
  function startOver() {
    history.replaceState(history.state, '', '#v=tour&sc=1');
    location.reload();
  }
  const shareUrl = new URL(`#${buildHash({pair: pair.id, seed: seed.id, strategy, trail, revealed, kiosk: false})}`, location.href).href;

  return <>
    <h1>Everything you saw came from one Cornac experiment.</h1>
    <div className="s5-grid">
      <pre className="s5-listing" tabIndex={0} aria-label="Cornac experiment in Python"><code>{listing}</code></pre>
      {all ? <RecallChart pairs={all.pairs} data={all.data} strategy={strategy} policy={(showDetails ? detailLabels : plainLabels)[strategy]}
        current={[pair.traditional, pair.sid]} showDetails={showDetails}/>
        : <div className="s5-chart-wait" aria-hidden="true"/>}
    </div>
    <div className="s5-end">
      <ul className="s5-points">
        <li>9 models, one data split, one metric suite.</li>
        <li>Three views of a code model: right code, right product, collision-corrected.</li>
        <li>Every state here was computed ahead of time and checked against the models.</li>
      </ul>
      <div className="s5-get">
        <code className="s5-pip">pip install cornac</code>
        <div className="s5-buttons">
          <button className="button primary" onClick={onExplore}><Compass size={14} aria-hidden="true"/>Explore freely</button>
          <button className="button" onClick={() => setSharing(true)}><Share2 size={14} aria-hidden="true"/>Share this journey</button>
          <button className="button" onClick={startOver}><RotateCcw size={14} aria-hidden="true"/>Start over</button>
        </div>
      </div>
      <figure className="s5-qr">
        <div role="img" aria-label="QR code for the Cornac repository on GitHub" dangerouslySetInnerHTML={{__html: qr}}/>
        <figcaption><a href={repository} target="_blank" rel="noreferrer">github.com/PreferredAI/cornac</a></figcaption>
      </figure>
    </div>
    {sharing ? <SharePanel url={shareUrl} onClose={() => setSharing(false)}/> : null}
  </>;
}
