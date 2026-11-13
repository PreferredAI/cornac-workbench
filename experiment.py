"""Run the Cornac experiment from Section 2.1 of the paper on Amazon Beauty.

The paper's listing appears below unchanged. Around it, the script loads the
5-core Amazon Beauty 2014 reviews, embeds each item's text with Sentence-T5, holds
out each user's last purchase for testing and the one before it for validation,
and trains a small SASRec whose item vectors LETTER uses as collaborative
embeddings, as in the LETTER paper.

Needs Cornac 3.1 or later, torch, transformers and sentence-transformers. The
paper's settings train SASRec and BERT4Rec on the CPU and TIGER and LETTER on a
GPU when one is available; the whole run takes several hours.
"""

from collections import defaultdict

import torch
from sentence_transformers import SentenceTransformer

from cornac import Experiment
from cornac.data import FeatureModality
from cornac.datasets import amazon_review
from cornac.eval_methods import NextItemEvaluation
from cornac.metrics import Recall, NDCG
from cornac.models import SASRec, TransformerRec, TIGER, LETTER

device = "cuda" if torch.cuda.is_available() else "cpu"

reviews = amazon_review.load_feedback(category="beauty")
texts, item_ids = amazon_review.load_text(category="beauty")
emb = SentenceTransformer("sentence-t5-base", device=device).encode(texts, batch_size=64)

# Each user's purchases in time order form one session (user ID = session ID).
purchases = defaultdict(list)
for user, item, _, timestamp in reviews:
    purchases[user].append((float(timestamp), item, timestamp))
train, val, test = [], [], []
for user, events in purchases.items():
    events.sort(key=lambda event: event[0])
    sequence = [(user, user, item, timestamp) for _, item, timestamp in events]
    train += sequence[:-2]
    val += sequence[:-1]
    test += sequence

eval_method = NextItemEvaluation.from_splits(
    train_data=train, val_data=val, test_data=test,
    item_feature=FeatureModality(features=emb, ids=item_ids),
    fmt="USIT", mode="last", semantic_id_metrics=True,
)

# LETTER's collaborative embeddings: 32-dimensional SASRec item vectors, one row
# per entry of item_ids.
cf_model = SASRec(embedding_dim=32, loss="bce", max_len=50, device=device)
cf_model.fit(eval_method.train_set, eval_method.val_set)
vectors = cf_model.model.item_emb.weight.detach().cpu().numpy()
cf_emb = vectors[[eval_method.global_iid_map[item] for item in item_ids]]

models = [
    SASRec(embedding_dim=128, loss="bce", max_len=50),
    TransformerRec(backbone="bert", objective="mlm", loss="ce"),
    TIGER(rqvae_codebook_size=256, n_beams=20),
    LETTER(rqvae_codebook_size=256, n_beams=20,
           cf_embeddings=cf_emb, cf_embedding_ids=item_ids),
]
Experiment(eval_method=eval_method, models=models,
           metrics=[Recall(k=5), NDCG(k=5)]).run()
