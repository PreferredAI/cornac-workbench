export async function getJson(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
export function endpoint(path, params) {
  return `/api/${path}?${new URLSearchParams(params)}`;
}
export function metric(value) {
  return value > 0 && value < 0.0001 ? value.toExponential(3) : Number(value).toFixed(4);
}
export function itemName(items, index) {
  return items[String(index)]?.title || `Item ${index}`;
}
export const policyLabels = {popularity: 'Training popularity', history_cosine: 'Training-history cosine'};
export function caseLabel(row) {
  if (row.history_cosine_hit > row.popularity_hit) return 'Cosine wins';
  if (row.popularity_hit > row.history_cosine_hit) return 'Popularity wins';
  if (row.sid_hit && !row.popularity_hit && !row.history_cosine_hit) return 'SID hit · item miss';
  return row.categories.includes('neutral_evenly_spaced') ? 'Neutral sample' : 'Diagnostic case';
}
export function caseTone(row) {
  if (row.history_cosine_hit > row.popularity_hit) return 'tone-cosine';
  if (row.popularity_hit > row.history_cosine_hit) return 'tone-pop';
  if (row.sid_hit && !row.popularity_hit && !row.history_cosine_hit) return 'tone-warn';
  return 'tone-neutral';
}
export const walkthroughTasks = [
  {
    id: 'task-1',
    step: 'Task 1',
    title: 'Apparent SID Hit → Item Miss',
    subtitle: 'Query #7 · LETTER · 1,643-item bucket',
    query: 7,
    model: 'letter-openai-2025',
    cutoff: 10,
    policy: 'history_cosine',
  },
  {
    id: 'task-2a',
    step: 'Task 2A',
    title: 'History Cosine Wins',
    subtitle: 'Query #145 · LETTER · Brush vs. Sunscreen',
    query: 145,
    model: 'letter-openai-2025',
    cutoff: 10,
    policy: 'history_cosine',
  },
  {
    id: 'task-2b',
    step: 'Task 2B',
    title: 'Popularity Wins',
    subtitle: 'Query #210 · LETTER · Opposite reversal',
    query: 210,
    model: 'letter-openai-2025',
    cutoff: 10,
    policy: 'popularity',
  },
  {
    id: 'task-3',
    step: 'Task 3',
    title: 'Injective TIGER Control',
    subtitle: 'Query #145 · TIGER · 1 item per SID',
    query: 145,
    model: 'tiger-openai-2025',
    cutoff: 10,
    policy: 'history_cosine',
  },
];
export function buildPythonSnippet({model, cutoff, policy, query}) {
  const isTiger = model.startsWith('tiger');
  const sidClass = isTiger ? 'TIGER' : 'LETTER';
  const sidInit = isTiger
    ? `TIGER(name="TIGER-Beauty", rqvae_codebook_size=256, n_beams=20, seed=2025)`
    : `LETTER(name="LETTER-Beauty", rqvae_codebook_size=256, cf_weight=0.02, n_beams=20, seed=2025)`;
  return `from cornac import Experiment
from cornac.data import FeatureModality
from cornac.eval_methods import NextItemEvaluation
from cornac.metrics import NDCG, Recall
from cornac.models import SASRec, TransformerRec, ${sidClass}

# Training workflow; supply USIT splits and aligned item features.
# Browser resolver choices are separate from model evaluation policies.
eval_method = NextItemEvaluation.from_splits(
    train_data=train_sequences, val_data=val_sequences, test_data=test_sequences,
    item_feature=FeatureModality(features=item_embeddings, ids=item_ids),
    fmt="USIT", mode="last", semantic_id_metrics=True,  # browser case: ${policy}, query #${query}
)

models = [
    SASRec(name="SASRec", embedding_dim=64, num_blocks=2, max_len=50, loss="bce"),
    TransformerRec(name="BERT4Rec-CE", backbone="bert", objective="mlm", loss="ce"),
    ${sidInit},
]

Experiment(
    eval_method=eval_method,
    models=models,
    metrics=[Recall(k=${cutoff}), NDCG(k=${cutoff})],
).run()`;
}
