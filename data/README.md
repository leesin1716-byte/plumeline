# Data

| File | What | Source and terms |
|---|---|---|
| `sequences.json` | Per-source Tanager observation histories (detection or clear) for 909 oil & gas methane sources in the Permian Basin, Sep 2024 – Sep 2026 | Derived from Carbon Mapper public data (plumes, scenes). **Data by Carbon Mapper®.** Redistributed for non-commercial use under the [Carbon Mapper Terms of Use](https://carbonmapper.org/terms), section 3 (attribution; redistribution on the same terms). |
| `model/persistence_logit.json` | The persistence model (logistic regression) as plain numbers. Its SHA-256 is registered in the contract. | Trained by `ml/train_persistence.py` on `sequences.json`. |
| `model/metrics.json` | Held-out test metrics, baselines, bootstrap intervals, calibration | `ml/train_persistence.py` |
| `scenario.json` | The demo: six fictional sites replaying six real source histories, plus fictional reports, a cargo and an importer | `ml/build_scenario.py` |
| `replay_summary.json` | Result of replaying the scenario through the contract | `scripts/replay-node.mjs` |
| `../web/public/plumes/*.png` | Methane plume images for the demo detections | Carbon Mapper plume overlays. **Data by Carbon Mapper®**, same terms as above. |

`raw/` (not committed) holds the downloads from `ml/fetch_carbonmapper.py`. Re-create everything with:

```
python ml/fetch_carbonmapper.py
python ml/build_sequences.py
python ml/train_persistence.py
python ml/build_scenario.py
```

Live satellite data changes as Carbon Mapper publishes new scenes, so a fresh download can give slightly different counts than the committed files (downloaded 17–18 October 2026).

Operators, site names, map positions, monthly gas volumes and methane reports, the LNG plant, the cargo and the importer are fictional. The sources behind the six demo sites are identified only by internal cluster numbers.
