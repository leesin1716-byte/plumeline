# 받은 Carbon Mapper 원자료를 source 별 위성 관측 이력(검출·비검출)으로 바꿔 data/sequences.json 에 저장한다
"""Turn raw Carbon Mapper downloads into per-source observation histories.

An observation is a Tanager scene whose footprint covers the source. It is a detection when one of the
source's plumes came from that scene. Scenes with more than MAX_CLOUD_PCT cloud cover are dropped,
because a cloudy non-detection says little.

Input:  data/raw/*.json|csv (ml/fetch_carbonmapper.py)
Output: data/sequences.json  {source_id: {lat, lon, obs: [{t, scene, detected, rate, sigma, cloud}]}}
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
MAX_CLOUD_PCT = 50


def main():
    scenes = {s["name"]: s for s in json.loads((RAW / "scenes_tanager_permian.json").read_text(encoding="utf-8"))}
    plumes = pd.read_csv(RAW / "plumes_tanager_permian_og.csv")
    plumes["scene"] = plumes.plume_id.str.rsplit("-", n=1).str[0]
    by_id = plumes.set_index("plume_id")
    sources = json.loads((RAW / "source_scenes.json").read_text(encoding="utf-8"))

    out, dropped = {}, 0
    for key, s in sources.items():
        mine = by_id.loc[s["plume_ids"]]
        # several plumes of one source in one scene: keep the sum (they are separate vents of the same site)
        det = mine.groupby("scene").agg(rate=("emission_auto", lambda x: x.sum(min_count=1)), sigma=("emission_uncertainty_auto", lambda x: float((x ** 2).sum() ** 0.5)))
        obs = []
        for name in s["scenes"]:
            sc = scenes[name]
            cloud = sc.get("cloud_cover_pct")
            hit = name in det.index
            if not hit and cloud is not None and cloud > MAX_CLOUD_PCT:
                dropped += 1
                continue
            rate = float(det.loc[name, "rate"]) if hit else 0.0
            sigma = float(det.loc[name, "sigma"]) if hit else 0.0
            if hit and not rate == rate:  # plume without a quantified rate: keep as detection, rate unknown
                rate, sigma = -1.0, 0.0
            obs.append({"t": sc["timestamp"], "scene": name, "detected": hit, "rate": round(rate, 1), "sigma": round(sigma, 1),
                        "cloud": cloud})
        obs.sort(key=lambda o: o["t"])
        out[key] = {"lat": round(s["lat"], 5), "lon": round(s["lon"], 5), "obs": obs}

    n_obs = sum(len(v["obs"]) for v in out.values())
    n_det = sum(o["detected"] for v in out.values() for o in v["obs"])
    assert n_det == len(set(zip(plumes.scene, plumes.plume_id.map(lambda p: next(k for k, v in sources.items() if p in v["plume_ids"]))))), "detection count mismatch"
    (ROOT / "data" / "sequences.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"sources {len(out)}  observations {n_obs}  detections {n_det}  cloudy non-detections dropped {dropped}")


if __name__ == "__main__":
    main()
