# 위성 관측 이력으로 「다음 관측에도 메탄이 검출될 확률」 모델을 학습·시간분할 평가하고 모델 카드를 쓴다
"""Persistence model: after a source has been flagged once, will the satellite see it emitting at the next overpass?

Each example is one Tanager overpass of a source that already had at least one detection. Features use only
what was known before that overpass. Train on overpasses before SPLIT, test on overpasses from SPLIT onward.

Outputs
  data/model/persistence_logit.json     logistic model as plain numbers (its sha256 is registered on chain)
  data/model/metrics.json               test metrics, baselines, calibration, triage curve
  docs/MODEL_CARD.md                     human-readable model card
"""
import hashlib
import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
SPLIT = "2026-03-01"
SEED = 7
FEATURES = [
    "n_obs", "n_det", "frac_smoothed", "last_detected", "streak", "days_since_obs", "days_since_det",
    "log_last_rate", "log_max_rate", "n_det_180d", "n_obs_180d", "doy_sin", "doy_cos",
]


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def features(history, t):
    """Features for an overpass at time t, from the observations strictly before t."""
    n_obs = len(history)
    dets = [o for o in history if o["detected"]]
    n_det = len(dets)
    last = history[-1]
    streak = 0
    for o in reversed(history):
        if not o["detected"]:
            break
        streak += 1
    rates = [o["rate"] for o in dets if o["rate"] > 0]
    last_rate = next((o["rate"] for o in reversed(dets) if o["rate"] > 0), 0.0)
    recent = [o for o in history if (t - o["_t"]).days <= 180]
    doy = t.timetuple().tm_yday
    return {
        "n_obs": n_obs,
        "n_det": n_det,
        "frac_smoothed": (n_det + 1) / (n_obs + 2),
        "last_detected": float(last["detected"]),
        "streak": streak,
        "days_since_obs": (t - last["_t"]).total_seconds() / 86400,
        "days_since_det": min((t - dets[-1]["_t"]).total_seconds() / 86400, 730),
        "log_last_rate": math.log1p(last_rate),
        "log_max_rate": math.log1p(max(rates) if rates else 0.0),
        "n_det_180d": sum(o["detected"] for o in recent),
        "n_obs_180d": len(recent),
        "doy_sin": math.sin(2 * math.pi * doy / 365.25),
        "doy_cos": math.cos(2 * math.pi * doy / 365.25),
    }


def examples(seqs):
    rows = []
    for sid, s in seqs.items():
        obs = s["obs"]
        for o in obs:
            o["_t"] = ts(o["t"])
        first = next((i for i, o in enumerate(obs) if o["detected"]), None)
        if first is None:
            continue
        for j in range(first + 1, len(obs)):
            f = features(obs[:j], obs[j]["_t"])
            rows.append({"source": sid, "t": obs[j]["t"], "y": int(obs[j]["detected"]), "rate": obs[j]["rate"], **f})
    return rows


def matrix(rows):
    return np.array([[r[k] for k in FEATURES] for r in rows], dtype=float), np.array([r["y"] for r in rows])


def calibration(y, p, bins=5):
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    out = []
    for i in range(bins):
        m = (p >= edges[i]) & (p <= edges[i + 1]) if i == bins - 1 else (p >= edges[i]) & (p < edges[i + 1])
        if m.sum():
            out.append({"p_mean": round(float(p[m].mean()), 3), "observed": round(float(y[m].mean()), 3), "n": int(m.sum())})
    return out


def triage(y, p, top=(0.1, 0.2, 0.3)):
    order = np.argsort(-p)
    total = y.sum()
    return {f"top_{int(k * 100)}pct_captures": round(float(y[order[: max(1, int(round(k * len(y))))]].sum() / total), 3) for k in top}


def scores(y, p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return {"auc": round(float(roc_auc_score(y, p)), 3), "brier": round(float(brier_score_loss(y, p)), 4), "log_loss": round(float(log_loss(y, p)), 4)}


def main():
    seqs = json.loads((ROOT / "data" / "sequences.json").read_text(encoding="utf-8"))
    rows = examples(seqs)
    train = [r for r in rows if r["t"] < SPLIT]
    test = [r for r in rows if r["t"] >= SPLIT]
    Xtr, ytr = matrix(train)
    Xte, yte = matrix(test)
    assert len(train) > 500 and len(test) > 200, (len(train), len(test))

    gbm = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=250, l2_regularization=1.0, min_samples_leaf=40, random_state=SEED)
    gbm.fit(Xtr, ytr)
    logit = make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=2000))
    logit.fit(Xtr, ytr)

    base_rate = float(ytr.mean())
    preds = {
        "gradient_boosting": gbm.predict_proba(Xte)[:, 1],
        "logistic_regression": logit.predict_proba(Xte)[:, 1],
        "baseline_smoothed_fraction": Xte[:, FEATURES.index("frac_smoothed")],
        "baseline_last_result": np.where(Xte[:, FEATURES.index("last_detected")] > 0, 0.9, 0.1),
        "baseline_train_rate": np.full(len(yte), base_rate),
    }
    results = {k: scores(yte, v) for k, v in preds.items()}
    best = "gradient_boosting" if results["gradient_boosting"]["log_loss"] <= results["logistic_regression"]["log_loss"] else "logistic_regression"
    p = preds["logistic_regression"]

    # Mass at risk: rank cases by p * last rate; what share of next-overpass methane (kg/h) sits in the top of the queue
    rate_next = np.array([max(r["rate"], 0) for r in test])
    last_rate = np.expm1(Xte[:, FEATURES.index("log_last_rate")])
    order = np.argsort(-(p * last_rate))
    mass = rate_next * yte
    mass_top20 = float(mass[order[: int(round(0.2 * len(yte)))]].sum() / mass.sum())
    order_naive = np.argsort(-last_rate)
    mass_top20_naive = float(mass[order_naive[: int(round(0.2 * len(yte)))]].sum() / mass.sum())

    out_dir = ROOT / "data" / "model"
    out_dir.mkdir(parents=True, exist_ok=True)
    # The exported model is the logistic regression: a handful of numbers anyone can re-run by hand or in the browser.
    scaler, lr = logit.named_steps["standardscaler"], logit.named_steps["logisticregression"]
    export = {
        "name": "plumeline-persistence-logit",
        "version": 1,
        "features": FEATURES,
        "mean": [round(float(x), 8) for x in scaler.mean_],
        "scale": [round(float(x), 8) for x in scaler.scale_],
        "coef": [round(float(x), 8) for x in lr.coef_[0]],
        "intercept": round(float(lr.intercept_[0]), 8),
        "train_split": f"overpasses before {SPLIT}",
    }
    blob = json.dumps(export, separators=(",", ":"), sort_keys=True).encode("utf-8")
    (out_dir / "persistence_logit.json").write_bytes(blob)
    sha = hashlib.sha256(blob).hexdigest()
    # check the exported numbers reproduce sklearn exactly
    z = ((Xte - np.array(export["mean"])) / np.array(export["scale"])) @ np.array(export["coef"]) + export["intercept"]
    assert np.allclose(1 / (1 + np.exp(-z)), preds["logistic_regression"], atol=1e-6)
    # bootstrap over sources: confidence intervals for the model vs the smoothed-fraction baseline
    rng = np.random.default_rng(SEED)
    src = np.array([r["source"] for r in test])
    uniq = np.unique(src)
    idx_by = {u: np.flatnonzero(src == u) for u in uniq}
    d_auc, d_ll, aucs = [], [], []
    pl, pb = np.clip(preds["logistic_regression"], 1e-4, 1 - 1e-4), np.clip(preds["baseline_smoothed_fraction"], 1e-4, 1 - 1e-4)
    for _ in range(1000):
        ii = np.concatenate([idx_by[u] for u in rng.choice(uniq, len(uniq))])
        if yte[ii].min() == yte[ii].max():
            continue
        a, b = roc_auc_score(yte[ii], pl[ii]), roc_auc_score(yte[ii], pb[ii])
        aucs.append(a)
        d_auc.append(a - b)
        d_ll.append(log_loss(yte[ii], pb[ii]) - log_loss(yte[ii], pl[ii]))
    ci = lambda v: [round(float(np.percentile(v, 2.5)), 3), round(float(np.percentile(v, 97.5)), 3)]
    bootstrap = {"resamples": len(aucs), "logit_auc_95ci": ci(aucs), "auc_gain_vs_smoothed_fraction_95ci": ci(d_auc),
                 "log_loss_gain_vs_smoothed_fraction_95ci": ci(d_ll)}

    metrics = {
        "data": "Carbon Mapper Tanager CH4 plumes and scenes, oil & gas sector, Permian Basin bbox (-104.8, 30.8, -101.0, 33.6)",
        "examples": {"train": len(train), "test": len(test), "train_positive_rate": round(base_rate, 3), "test_positive_rate": round(float(yte.mean()), 3)},
        "sources_in_test": len({r["source"] for r in test}),
        "split": f"train: overpasses before {SPLIT}; test: overpasses from {SPLIT}",
        "best_by_log_loss": best,
        "exported_model": "logistic_regression",
        "bootstrap_by_source": bootstrap,
        "sha256": sha,
        "test_scores": results,
        "calibration_test": calibration(yte, p),
        "triage_test": triage(yte, p),
        "triage_test_baseline_smoothed_fraction": triage(yte, preds["baseline_smoothed_fraction"]),
        "mass_weighted_top20pct": {"model_p_times_last_rate": round(mass_top20, 3), "last_rate_only": round(mass_top20_naive, 3)},
        "features": FEATURES,
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=1), encoding="utf-8")
    print(json.dumps(metrics, indent=1))


if __name__ == "__main__":
    main()
