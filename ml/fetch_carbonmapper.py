# Carbon Mapper 공개 API 에서 Permian 분지 Tanager 메탄 plume·장면·source 별 관측 장면을 받아 data/raw 에 저장한다
"""Download the public Carbon Mapper data this project is built on.

Data by Carbon Mapper(R). Used under the Carbon Mapper Terms of Use, section 3
(non-commercial use, attribution, redistribution under the same terms).

Outputs (data/raw/, not committed):
  plumes_tanager_permian_og.csv   every Tanager CH4 plume, oil & gas sector, Permian bbox
  scenes_tanager_permian.json     every Tanager scene that intersects the bbox
  source_scenes.json              for each plume source: ids of scenes whose footprint covers it

Run:  python ml/fetch_carbonmapper.py
"""
import csv
import io
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from sklearn.cluster import DBSCAN

API = "https://api.carbonmapper.org/api/v1/catalog"
BBOX = (-104.8, 30.8, -101.0, 33.6)  # lon_min, lat_min, lon_max, lat_max (Permian Basin, Texas / New Mexico)
EPS_M = 250  # same source radius Carbon Mapper uses for oil & gas sources
RAW = Path(__file__).resolve().parent.parent / "data" / "raw"


def get(path, params, tries=4):
    url = f"{API}/{path}?{urllib.parse.urlencode(params, doseq=True)}"
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "plumeline-research"}), timeout=120) as r:
                return r.read()
        except Exception as e:  # network hiccup or rate limit: back off and retry
            if i == tries - 1:
                raise
            print("retry", path, e)
            time.sleep(5 * (i + 1))


def bbox_params():
    return {"bbox": list(BBOX)}


def main():
    RAW.mkdir(parents=True, exist_ok=True)

    rows, offset = [], 0
    while True:
        text = get("plume-csv", {**bbox_params(), "plume_gas": "CH4", "instruments": "tan", "limit": 5000, "offset": offset,
                                 "exclude_columns": ["plume_tif", "con_tif", "rgb_tif"]}).decode("utf-8")
        batch = list(csv.DictReader(io.StringIO(text)))
        rows += batch
        if len(batch) < 5000:
            break
        offset += 5000
    og = [r for r in rows if "1B2" in (r.get("ipcc_sector") or "")]
    assert og, "no oil & gas plumes returned"
    with open(RAW / "plumes_tanager_permian_og.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(og[0].keys()))
        w.writeheader()
        w.writerows(og)
    print("plumes", len(rows), "oil & gas", len(og))

    scenes = json.loads(get("scenes/annotated", {**bbox_params(), "instruments": "tan", "limit": 1000}))["items"]
    (RAW / "scenes_tanager_permian.json").write_text(json.dumps(scenes, indent=1), encoding="utf-8")
    print("scenes", len(scenes))

    # Group plumes into sources (DBSCAN, 250 m) and ask the API which scene footprints cover each source.
    lat = np.array([float(r["plume_latitude"]) for r in og])
    lon = np.array([float(r["plume_longitude"]) for r in og])
    labels = DBSCAN(eps=EPS_M / 6_371_000, min_samples=1, metric="haversine").fit_predict(np.radians(np.c_[lat, lon]))
    out_path = RAW / "source_scenes.json"
    done = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    for k in sorted(set(labels)):
        key = str(k)
        if key in done:
            continue
        m = labels == k
        clat, clon = float(lat[m].mean()), float(lon[m].mean())
        point = json.dumps({"type": "Point", "coordinates": [clon, clat]})
        items = json.loads(get("scenes/annotated", {"intersects": point, "instruments": "tan", "limit": 1000}))["items"]
        done[key] = {"lat": clat, "lon": clon, "plume_ids": [og[i]["plume_id"] for i in np.flatnonzero(m)],
                     "scenes": [s["name"] for s in items]}
        if len(done) % 50 == 0:
            out_path.write_text(json.dumps(done), encoding="utf-8")
            print("sources", len(done))
        time.sleep(0.3)
    out_path.write_text(json.dumps(done), encoding="utf-8")
    print("sources", len(done))


if __name__ == "__main__":
    main()
