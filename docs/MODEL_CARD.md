<!-- Plumeline 지속성 모델의 데이터·평가·한계를 적은 모델 카드 -->
# Model card: persistence model

**Question it answers.** A satellite has already seen methane at a site at least once. Will it see the site emitting again at the next overpass?

**Why Plumeline needs it.** Tanager passes over a given Permian site every few weeks, so a month usually has one to three overpasses. A detection rate built from those passes can only be 0 %, 50 % or 100 %. The monthly estimate needs a probability that holds up better than that. The model provides that probability, drawing on the site's longer history.

**What it is not.** It does not open or close cases, and it does not decide compliance. Cases follow a fixed rule: any detection above 100 kg/h opens one, and only a later clear overpass closes it. The model ranks open cases and feeds the monthly estimate.

## Data

- **Source:** Carbon Mapper public catalog (Data by Carbon Mapper®), Tanager satellite, CH₄, oil & gas sector (IPCC 1B2), Permian Basin bounding box (-104.8, 30.8, -101.0, 33.6). Downloaded 17–18 October 2026 with `ml/fetch_carbonmapper.py`.
- **Sources:** plumes within 250 m are grouped with DBSCAN into 909 sources. A source's observations are the Tanager scenes whose footprint covers it, as returned by the catalog's `intersects` query. A scene counts as a detection when one of the source's plumes came from it.
- **Cleaning:** non-detections in scenes with more than 50 % cloud cover are dropped (1,109 of them), because a cloudy scene that shows nothing says little. Plumes without a quantified rate still count as detections.
- **Result:** 7,116 observations, 1,344 detections, September 2024 – September 2026 (`data/sequences.json`).
- **Examples:** every overpass that comes after a source's first detection. That gives 3,692 examples (positive rate 14.0 % in the training set and 9.2 % in the test set).

## Features (known before the overpass)

Number of previous overpasses and detections, Laplace-smoothed detection fraction, whether the previous overpass detected, current detection streak, days since the previous overpass, days since the last detection, log of the last and of the largest quantified rate, overpasses and detections in the previous 180 days, day of year (sine, cosine).

## Model

Logistic regression on standardized features (scikit-learn, C = 0.5). The exported file `data/model/persistence_logit.json` holds the means, scales, coefficients and intercept as plain numbers. The training script checks that these numbers reproduce scikit-learn's probabilities to within 1e-6. The SHA-256 of that file is registered in the contract (`registerModel`), and the demo page re-hashes it in the browser. A gradient-boosted tree model was also trained. It did worse on the test set, so it was not used.

## Evaluation: time split

The model trains on overpasses before 1 March 2026 (2,000 examples) and is tested on overpasses from 1 March 2026 onward (1,692 examples, 708 sources).

| Model | AUC | Brier | Log loss |
|---|---|---|---|
| **Logistic regression (exported)** | **0.755** | **0.0695** | **0.259** |
| Gradient boosting | 0.728 | 0.0719 | 0.268 |
| Baseline: smoothed detection fraction | 0.742 | 0.1234 | 0.415 |
| Baseline: repeat the last result | 0.640 | 0.1982 | 0.622 |
| Baseline: training base rate | 0.500 | 0.0859 | 0.318 |

Bootstrap over sources (1,000 resamples):

- AUC 95 % interval: 0.697 – 0.808.
- AUC gain over the smoothed fraction: −0.023 to +0.051. **The model does not rank sources clearly better than counting past detections.**
- Log-loss gain over the smoothed fraction: 0.134 to 0.179. **The model's probabilities are clearly better calibrated, and calibration is what the monthly estimate needs.**

Calibration on the test set, in quintiles of predicted probability:

| Mean predicted | Observed | n |
|---|---|---|
| 0.021 | 0.041 | 339 |
| 0.039 | 0.027 | 338 |
| 0.065 | 0.041 | 338 |
| 0.105 | 0.104 | 338 |
| 0.279 | 0.248 | 339 |

Triage, test set:

- **Re-detections captured.** The top 10 % of overpasses ranked by the model contain 41.7 % of all re-detections, against 34.6 % for the smoothed fraction.
- **Methane captured.** Ranking by model probability × last rate puts 57.6 % of the next-overpass methane (kg/h) in the top 20 % of the queue, against 46.2 % when ranking by last rate alone.

## How the monthly estimate uses it

For a site-month with at least one detection:

- p₀ is the model probability from the history before the month.
- The month's detection probability follows Beta(4·p₀ + d, 4·(1 − p₀) + n − d), where d is detections in n overpasses.
- The rate r is the mean quantified rate of the month's detections, with uncertainty σ.
- **estimate** = r · E[p] · hours in the month.
- **floor** = max(r − 1.645 σ, 0) · 5th percentile of p · hours in the month.

A month whose overpasses are all clear gets estimate 0. The satellite only sees emitters above its detection limit, so the estimate is a floor for the site, not its total. The contract flags a month only when the floor alone is above the operator's report.

## Limits

- One basin and one instrument. The model was not tested on other basins or on other satellites (EMIT, GHGSat, MethaneSAT), which have different detection limits.
- **Selection bias.** Sources exist in the data only because they were detected at least once. The model is meant for exactly that situation, a site that has already been flagged. It says nothing about sites that were never detected.
- **Cloud.** Scene-level cloud cover is a coarse filter. A partly cloudy scene can hide a plume at one site and not at another.
- **Prior weight.** The prior weight of 4 overpasses was set by judgment and was not fitted.
- **Rate uncertainty.** The floor uses Carbon Mapper's reported rate uncertainty and treats it as Gaussian.
