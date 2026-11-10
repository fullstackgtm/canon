"""Step 3 of corpus tagging: a local "student" model trained on Jev's labels.

    python3 scripts/tag/student.py train     # fit on teacher labels, report holdout agreement
    python3 scripts/tag/student.py predict   # tag every company -> tags/student/*.parquet

Inputs (written by the TypeScript steps):
    ~/.fullstackgtm/data/tags/teacher/*.parquet    domain, archetype, p, second, p2  (Jev)
    ~/.fullstackgtm/data/tags/features/*/*.parquet domain, industry, size_band, country, title, description, text

Model: hashed word 1-2grams (+ industry/size/TLD tokens) -> TF-IDF -> linear
classifier with log loss (SGD). It costs nothing per company; Jev stays the
source of truth, and the companies it is least sure of go back to Jev (step 4).
"""
import glob
import os
import pickle
import re
import sys
import time

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.parquet as pq
from sklearn.feature_extraction.text import HashingVectorizer, TfidfTransformer
from sklearn.linear_model import SGDClassifier

DATA = os.path.expanduser("~/.fullstackgtm/data/tags")
MODEL = f"{DATA}/student.pkl"
OUT = f"{DATA}/student"
MIN_TEACHER_P = 0.3  # drop labels Jev itself was unsure of
HOLDOUT = 0.1


def doc(r):
    dom = r["domain"] or ""
    parts = re.split(r"[.\-]", dom)
    toks = " ".join(parts[:-1]) + f" tld_{parts[-1]}" if parts else ""
    ind = (r["industry"] or "none").replace(" ", "_")
    size = (r["size_band"] or "unknown").replace("-", "_").replace("+", "plus")
    return f"{toks} ind_{ind} ind_{ind} size_{size} | {r['title'] or ''} | {r['description'] or ''} | {(r['text'] or '')[:1000]}"


VEC = HashingVectorizer(n_features=2**21, ngram_range=(1, 2), alternate_sign=False, norm=None,
                        token_pattern=r"(?u)\b\w[\w']+\b", lowercase=True, dtype=np.float32)


def features(domains=None):
    dset = ds.dataset(glob.glob(f"{DATA}/features/*/*.parquet"), format="parquet")
    cols = ["domain", "industry", "size_band", "title", "description", "text"]
    if domains is None:
        return dset.to_table(columns=cols)
    return dset.to_table(columns=cols, filter=pc.field("domain").isin(pa.array(domains)))


def train():
    t0 = time.time()
    lab = pq.read_table(glob.glob(f"{DATA}/teacher/*.parquet")).to_pandas()
    lab = lab[lab["archetype"].notna() & (lab["p"] >= MIN_TEACHER_P)]
    feats = features(lab["domain"].tolist()).to_pandas()
    df = lab.merge(feats, on="domain")
    rng = np.random.default_rng(7)
    test_mask = rng.random(len(df)) < HOLDOUT
    docs = [doc(r) for r in df.to_dict("records")]
    X = VEC.transform(docs)
    tfidf = TfidfTransformer(sublinear_tf=True).fit(X[~test_mask])
    X = tfidf.transform(X)
    y = df["archetype"].to_numpy()
    # modified_huber beat log loss and LinearSVC on the holdout (top-1 0.66, Jev label in top-4 0.88 at 33K labels).
    clf = SGDClassifier(loss="modified_huber", alpha=1e-5, max_iter=20, tol=1e-4, n_jobs=-1, random_state=7)
    clf.fit(X[~test_mask], y[~test_mask], sample_weight=df["p"].to_numpy()[~test_mask])
    proba = clf.predict_proba(X[test_mask])
    pred = clf.classes_[proba.argmax(1)]
    conf = proba.max(1)
    truth = y[test_mask]
    second = df["second"].to_numpy()[test_mask]
    group = lambda a: np.array([s.split("/")[0] for s in a])
    print(f"train {(~test_mask).sum():,}  holdout {test_mask.sum():,}  classes {len(clf.classes_)}  {time.time() - t0:.0f}s")
    top4 = clf.classes_[np.argsort(-proba, 1)[:, :4]]
    print(f"holdout agreement with Jev top-1: {(pred == truth).mean():.3f}   Jev label in model top-4: {(top4 == truth[:, None]).any(1).mean():.3f}   same group: {(group(pred) == group(truth)).mean():.3f}")
    for lo in (0.0, 0.3, 0.5, 0.7, 0.9):
        m = conf >= lo
        print(f"  confidence >= {lo:.1f}: {m.mean():6.1%} of companies, agreement {(pred[m] == truth[m]).mean():.3f}")
    with open(MODEL, "wb") as f:
        pickle.dump({"tfidf": tfidf, "clf": clf}, f)


def predict(worker=0, workers=1):
    """Tag shards worker, worker+workers, ... (run one process per core); skips shards already written."""
    with open(MODEL, "rb") as f:
        m = pickle.load(f)
    os.makedirs(OUT, exist_ok=True)
    for shard in sorted(glob.glob(f"{DATA}/features/*/"))[worker::workers]:
        name = os.path.basename(shard.rstrip("/"))
        if os.path.exists(f"{OUT}/{name}.parquet"):
            continue
        t0 = time.time()
        t = ds.dataset(glob.glob(f"{shard}*.parquet"), format="parquet").to_table(
            columns=["domain", "industry", "size_band", "title", "description", "text"]).to_pandas()
        rows = t.to_dict("records")
        out = []
        for i in range(0, len(rows), 100_000):
            part = rows[i:i + 100_000]
            proba = m["clf"].predict_proba(m["tfidf"].transform(VEC.transform([doc(r) for r in part])))
            top = np.argsort(-proba, 1)[:, :4]
            rows_i = np.arange(len(part))[:, None]
            out.append(pa.table({
                "domain": [r["domain"] for r in part],
                "archetype": m["clf"].classes_[top[:, 0]],
                "p": proba[rows_i[:, 0], top[:, 0]].astype(np.float32),
                "top4": pa.array([list(x) for x in m["clf"].classes_[top]], type=pa.list_(pa.string())),
                "top4_p": pa.array([list(x) for x in proba[rows_i, top].astype(np.float32)], type=pa.list_(pa.float32())),
            }))
        pq.write_table(pa.concat_tables(out), f"{OUT}/{name}.parquet", compression="zstd")
        print(f"{name}: {len(rows):,} companies in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "predict":
        predict(*(int(a) for a in sys.argv[2:4]))
    else:
        train()
