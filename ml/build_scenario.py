# 실제 Tanager 관측 이력 6개를 가상 사이트에 입혀 데모 시나리오(관측·보고·모델 추정·화물)를 날짜순 사건 목록으로 만든다
"""Build the demo scenario the web app and the replay test run on the contract.

What is real and what is not
  real      : every overpass time, detection, emission rate and uncertainty (Carbon Mapper Tanager, Permian Basin),
              the 30-day publication delay, the persistence model and its coefficients
  fictional : operators, site names, map positions, monthly gas volumes and methane reports, the LNG plant,
              the cargo and the importer

Monthly satellite estimate (the model oracle, posted on chain)
  For a site-month with at least one valid overpass (a month whose overpasses are all clear gets estimate 0):
    p0   = model probability that the source is emitting at an overpass, from its history before the month
    p    ~ Beta(K*p0 + d, K*(1-p0) + n - d)   d detections in n overpasses this month, K prior overpasses
    r    = mean quantified rate of this month's detections, else the last quantified rate within 180 days
    estimate = r * E[p] * hours ;  low = max(r - 1.645 sigma, 0) * Beta_5% * hours
  The estimate only sees emitters above the satellite's detection limit, so it is a floor for the site, not a total.

Output: data/scenario.json
"""
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scipy.stats import beta

ROOT = Path(__file__).resolve().parent.parent
K = 4.0  # prior weight, in overpasses
PERIODS = [202606, 202607, 202608]
START = "2026-06-01T00:00:00Z"
END = "2026-10-08T23:59:59Z"
PUBLISH_DELAY_DAYS = 30

# fictional sites, each wearing one real source history
SITES = [
    {"key": "A1", "source": "126", "name": "Alder Gas Plant", "operator": "Alder Energy", "kind": "gas processing plant",
     "xy": [0.22, 0.30], "gas_t": {202606: 148000, 202607: 151000, 202608: 150000}, "reported_kg": {202606: 44000, 202607: 45500, 202608: 45000}},
    {"key": "A2", "source": "181", "name": "Alder Compressor 7", "operator": "Alder Energy", "kind": "compressor station",
     "xy": [0.50, 0.15], "gas_t": {202606: 61000, 202607: 60500, 202608: 62000}, "reported_kg": {202606: 30500, 202607: 21000, 202608: 18600}},
    {"key": "B1", "source": "145", "name": "Birch Wellpad Hub", "operator": "Birch Petroleum", "kind": "well pad hub",
     "xy": [0.73, 0.34], "gas_t": {202606: 23000, 202607: 22800, 202608: 22500}, "reported_kg": {202606: 9200, 202607: 9600, 202608: 9000}},
    {"key": "B2", "source": "764", "name": "Birch Station 12", "operator": "Birch Petroleum", "kind": "compressor station",
     "xy": [0.60, 0.60], "gas_t": {202606: 54000, 202607: 55000, 202608: 54500}, "reported_kg": {202606: 13500, 202607: 13800, 202608: 13600}},
    {"key": "C1", "source": "758", "name": "Cedar Treating Plant", "operator": "Cedar Midstream", "kind": "gas treating plant",
     "xy": [0.33, 0.72], "gas_t": {202606: 96000, 202607: 97000, 202608: 95500}, "reported_kg": {202606: 19200, 202607: 19400, 202608: 19100}},
    {"key": "C2", "source": "662", "name": "Cedar Wellpad Cluster", "operator": "Cedar Midstream", "kind": "well pad cluster",
     "xy": [0.10, 0.55], "gas_t": {202606: 31000, 202607: 30500, 202608: 31200}, "reported_kg": {202606: 7800, 202607: 7600, 202608: 7800}},
]
REMEDIATION = {  # operator repair claims (fictional dates, after the detections they answer)
    "A2": {"posted": "2026-07-02T10:00:00Z", "repaired": "2026-07-01T16:00:00Z", "note": "Replaced failed compressor rod packing on unit 3"},
    "B1": {"posted": "2026-08-01T09:00:00Z", "repaired": "2026-07-31T15:00:00Z", "note": "Closed stuck-open tank thief hatch, fitted new seal"},
}
CARGO = {"ref": "CL-2026-0912", "plant": "Coastline LNG", "minted": "2026-09-12T08:00:00Z",
         "allocations": [("A1", 202608, 40000), ("B2", 202608, 20000), ("C1", 202608, 12000)]}
DOUBLE_SELL = {"at": "2026-09-14T08:00:00Z", "ref": "CL-2026-0914", "allocations": [("A1", 202608, 111000)]}
MAX_INTENSITY_PPM = 2000  # 0.20 %, illustrative (OGCI 2025 industry target); EU maximum values are not set yet


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def iso(d):
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def month_of(d):
    return d.year * 100 + d.month


def month_hours(period):
    y, m = divmod(period, 100)
    a = datetime(y, m, 1, tzinfo=timezone.utc)
    b = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=timezone.utc)
    return (b - a).total_seconds() / 3600


def load_model():
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from train_persistence import features  # same feature code the model was trained with

    m = json.loads((ROOT / "data" / "model" / "persistence_logit.json").read_text(encoding="utf-8"))

    def prob(history, t):
        f = features(history, t)
        z = m["intercept"] + sum(c * (f[k] - mu) / sd for k, c, mu, sd in zip(m["features"], m["coef"], m["mean"], m["scale"]))
        return 1 / (1 + math.exp(-z))

    return prob


def estimate(prob, obs, period):
    in_month = [o for o in obs if month_of(o["_t"]) == period]
    if not in_month:
        return None
    y, mth = divmod(period, 100)
    start = datetime(y, mth, 1, tzinfo=timezone.utc)
    before = [o for o in obs if o["_t"] < start]
    p0 = prob(before, start) if any(o["detected"] for o in before) else 0.05
    n, d = len(in_month), sum(o["detected"] for o in in_month)
    if d == 0:  # nothing above the detection limit this month: the satellite adds no evidence against the report
        return {"period": period, "estimateKg": 0, "lowKg": 0, "p0": None, "pMean": 0, "pLow": 0, "rateKgH": 0, "sigmaKgH": 0, "n": n, "d": 0}
    a, b = K * p0 + d, K * (1 - p0) + n - d
    p_mean, p_low = a / (a + b), float(beta.ppf(0.05, a, b))
    q = [o for o in in_month if o["detected"] and o["rate"] > 0]
    if not q:
        q = [o for o in before if o["detected"] and o["rate"] > 0 and (start - o["_t"]).days <= 180][-1:]
    if not q:
        return {"period": period, "estimateKg": 0, "lowKg": 0, "p0": round(p0, 4), "pMean": round(p_mean, 4), "pLow": round(p_low, 4),
                "rateKgH": 0, "sigmaKgH": 0, "n": n, "d": d}
    r = sum(o["rate"] for o in q) / len(q)
    sig = math.sqrt(sum(o["sigma"] ** 2 for o in q)) / len(q)
    h = month_hours(period)
    return {"period": period, "estimateKg": int(r * p_mean * h), "lowKg": int(max(r - 1.645 * sig, 0) * p_low * h),
            "p0": round(p0, 4), "pMean": round(p_mean, 4), "pLow": round(p_low, 4), "rateKgH": round(r, 1), "sigmaKgH": round(sig, 1), "n": n, "d": d}


def main():
    prob = load_model()
    seqs = json.loads((ROOT / "data" / "sequences.json").read_text(encoding="utf-8"))
    model_card = json.loads((ROOT / "data" / "model" / "metrics.json").read_text(encoding="utf-8"))
    start, end = ts(START), ts(END)
    events = []
    sites_out = []
    for i, s in enumerate(SITES, start=1):
        obs = seqs[s["source"]]["obs"]
        for o in obs:
            o["_t"] = ts(o["t"])
        window = [o for o in obs if start - timedelta(days=PUBLISH_DELAY_DAYS) <= o["_t"] and o["_t"] + timedelta(days=PUBLISH_DELAY_DAYS) <= end]
        sites_out.append({"id": i, "key": s["key"], "name": s["name"], "operator": s["operator"], "kind": s["kind"], "xy": s["xy"],
                          "history": [{"t": o["t"], "detected": o["detected"], "rate": o["rate"]} for o in obs if o["_t"] < start - timedelta(days=PUBLISH_DELAY_DAYS)]})
        for o in window:
            pub = o["_t"] + timedelta(days=PUBLISH_DELAY_DAYS)
            ev = {"at": iso(pub), "type": "observation", "site": i, "scene": o["scene"], "t": o["t"], "detected": o["detected"],
                  "rateKgH": max(int(round(o["rate"])), 0), "sigmaKgH": int(round(o["sigma"])), "quantified": o["rate"] > 0 or not o["detected"]}
            history = [x for x in obs if x["_t"] <= o["_t"]]
            if o["detected"]:
                nxt = o["_t"] + timedelta(days=1)
                ev["riskNext"] = round(prob(history, nxt), 4)  # P(still emitting at the next overpass), scored on publication
            events.append(ev)
            # refresh the monthly estimate each time a scene of a reporting month is published
            per = month_of(o["_t"])
            if per in PERIODS:
                est = estimate(prob, [x for x in obs if x["_t"] <= o["_t"]], per)
                if est:
                    events.append({"at": iso(pub + timedelta(minutes=30)), "type": "estimate", "site": i, **est})
        for per in PERIODS:
            y, m = divmod(per, 100)
            nxt = datetime(y + (m == 12), m % 12 + 1, 5, 9, tzinfo=timezone.utc)
            events.append({"at": iso(nxt), "type": "report", "site": i, "period": per, "gasTonnes": s["gas_t"][per], "reportedKg": s["reported_kg"][per]})
            events.append({"at": iso(nxt + timedelta(days=5)), "type": "verify", "site": i, "period": per})
        if s["key"] in REMEDIATION:
            r = REMEDIATION[s["key"]]
            events.append({"at": r["posted"], "type": "remediation", "site": i, "repairedAt": r["repaired"], "note": r["note"]})
    key2id = {s["key"]: i for i, s in enumerate(SITES, start=1)}
    events.append({"at": CARGO["minted"], "type": "cargo", "ref": CARGO["ref"], "plant": CARGO["plant"],
                   "allocations": [{"site": key2id[k], "period": p, "tonnes": t} for k, p, t in CARGO["allocations"]]})
    events.append({"at": "2026-09-12T12:00:00Z", "type": "transfer", "ref": CARGO["ref"], "to": "importer"})
    events.append({"at": DOUBLE_SELL["at"], "type": "cargo", "ref": DOUBLE_SELL["ref"], "plant": CARGO["plant"], "expectRevert": "OverAllocated",
                   "allocations": [{"site": key2id[k], "period": p, "tonnes": t} for k, p, t in DOUBLE_SELL["allocations"]]})
    events.sort(key=lambda e: (e["at"], {"observation": 0, "estimate": 1}.get(e["type"], 2)))

    # sanity checks that pin the story the demo tells
    obs_ev = [e for e in events if e["type"] == "observation"]
    assert len(obs_ev) >= 15, len(obs_ev)
    cargo_t = ts(CARGO["minted"])
    a1_aug = [e for e in events if e["type"] == "estimate" and e["site"] == key2id["A1"] and e["period"] == 202608]
    assert a1_aug and ts(a1_aug[-1]["at"]) > cargo_t, "Alder Gas Plant's August evidence must arrive after the cargo is loaded"
    assert a1_aug[-1]["lowKg"] > SITES[0]["reported_kg"][202608], "August lower bound must exceed the report"
    for e in obs_ev:
        assert ts(e["t"]) <= ts(e["at"]), e

    out = {
        "generated": "ml/build_scenario.py",
        "attribution": "Satellite observations: Data by Carbon Mapper(R) (Tanager), Permian Basin oil & gas sources, anonymized. "
                       "Operators, sites, gas volumes, reports, plant, cargo and importer are fictional.",
        "kPrior": K,
        "maxIntensityPpm": MAX_INTENSITY_PPM,
        "responseWindowDays": 10,
        "superEmitterKgH": 100,
        "model": {"sha256": model_card["sha256"], "uri": "data/model/persistence_logit.json", "auc": model_card["test_scores"]["logistic_regression"]["auc"]},
        "start": START,
        "end": END,
        "periods": PERIODS,
        "sites": sites_out,
        "events": events,
    }
    (ROOT / "data" / "scenario.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    n_det = sum(e["detected"] for e in obs_ev)
    print(f"events {len(events)}  observations {len(obs_ev)}  detections {n_det}")
    for e in events:
        if e["type"] in ("estimate",):
            print(e["at"][:10], "site", e["site"], e["period"], "est", e["estimateKg"], "low", e["lowKg"], "n", e["n"], "d", e["d"], "p0", e["p0"])
        elif e["type"] == "observation" and e["detected"]:
            print(e["at"][:10], "site", e["site"], "DETECT", e["rateKgH"], "risk", e.get("riskNext"))


if __name__ == "__main__":
    main()
