# bridge-fidelity — WS1 RealityAnchor scorecard

Detector-based paired metrics between translated engine frames (H3/W0) and a
frozen real-world eval corpus. Implements plan WS1 (`docs/rl-platform-hardening-plan.md`):
the student-vs-teacher gate proves student ≈ teacher; this package measures
**teacher/bridge ≈ reality**.

## Components

| piece | path | committed |
|---|---|---|
| corpus manifest (1760 items, per-item sha256) | `corpus-manifest.v1.json` | yes |
| scorecard for the W0/H3 POV set | `bridge-fidelity-scorecard.w0-h3-pov.v1.json` | yes |
| tooling | `src/bridge_fidelity/` | yes |
| raw images + detection caches | `.corpus/` | **no** (gitignored) |

Raw data location: `research/bridge-fidelity/.corpus/images/{bdd,nuscenes}/`
(~1.4 GB). Everything is re-derivable: `corpus-manifest.v1.json` carries a
sha256 per image and `corpusHash = sha256(sorted("id:sha256" lines))`
(`3e67a6b5cef8a4f4944439799fee2b619ca9653c89b96f0c82774ef59af7fc6f`).

## Frozen instrument

- **yolo11s**, COCO-pretrained, ultralytics 8.4.126 / torch 2.13.0+cpu-index,
  device pinned to CPU so the metric instrument is host-independent.
- weights sha256 `85a76fe86dd8afe384648546b56a7a78580c7cb7b404fc595f97969322d502d5`
  (github.com/ultralytics/assets v8.3.0 release), cached at
  `.corpus/weights/yolo11s.pt`. Never retrained; conf floor 0.25, match IoU 0.5 —
  both pinned (changing them re-baselines the whole corpus).
- Classes collapsed to `vehicle / pedestrian / bicycle / motorcycle`.

## Real eval corpus

1760 frames, stratified to the W0 scenario classes:

| stratum | BDD10k | nuScenes CAM_FRONT | covers |
|---|---|---|---|
| night | 150 | – | night-proxy |
| weather (rain/fog/snow) | 150 | – | weather-proxy |
| dart-out (near pedestrians) | 260 | 250 | dart-out/pedestrian |
| cut-in (adjacent-lane close vehicles) | 250 | 250 | cut-in / merge |
| intersection (traffic-light scenes) | 250 | – | signalized intersections |
| baseline (clear day) | 200 | – | control |

Provenance:
- **BDD100K det-10k**: labels + boxes from the FiftyOne export inherited in
  `/home/path/w0-data/real-corpus/bdd-meta/samples.json`; weather /
  scene / timeofday attributes joined by filename from the official 100k label
  release (public archive.org mirror — the 10k split ships no attribute table).
  Images fetched per-file from a public mirror whose filenames are identical to
  the official release. License: BDD100K (non-commercial research/eval use).
- **nuScenes v1.0-trainval CAM_FRONT keyframes**: metadata + samples rsynced
  from simforge1's ungated copy (`~/real-corpus/nuscenes`, 34k keyframes).
  Selection is geometric: annotations transformed into the ego frame via the
  official calibration chain (global→ego quaternion inverse); dart-out = ped
  within 25 m ahead, |lat| < 8 m; cut-in = vehicle within 20 m ahead in the
  adjacent lane band (1.8–6.5 m lateral). GT pixel boxes are projected through
  ego→camera + intrinsics at build time. License: CC BY-NC-SA 4.0 (eval use).

The 10k split carries no weather attributes of its own and no dynamic scene
labels, so single-frame proxies are documented above rather than invented
attributes; strata are therefore "documented proxies", not ground-truth event
labels.

## Reproduce

```sh
cd research/bridge-fidelity
uv sync
bf-build-corpus \
  --bdd-samples /home/path/w0-data/real-corpus/bdd-meta/samples.json \
  --bdd-labels-dir .corpus/bdd-labels \
  --nuscenes-meta .corpus/nuscenes/v1.0-trainval \
  --images-root .corpus/images --out corpus-manifest.v1.json
bf-fetch-images --manifest corpus-manifest.v1.json --images-root .corpus/images
bf-scorecard \
  --corpus-manifest corpus-manifest.v1.json --corpus-images .corpus/images \
  --engine-clips /home/path/w0-data/clips-pov \
  --translated-dir /home/path/w0-data/real-corpus/w0-translated \
  --work .corpus/work --out bridge-fidelity-scorecard.w0-h3-pov.v1.json
```

## Executed result (2026-08-22, H3 Ref2VA dashcam-POV set, 10 clips x 60 frames)

Instrument on real corpus (ceiling): vehicle AP 0.53 / recall 0.55,
pedestrian AP 0.37 / recall 0.41 (conf 0.25). On engine renders (floor):
vehicle AP 0.107, pedestrian AP 0.384.

| class | translated AP | Δ vs render floor | translated recall | hallucination | deletion |
|---|---|---|---|---|---|
| vehicle | 0.095 | −0.012 | 0.123 | 0.97 | 0.88 |
| pedestrian | 0.302 | −0.082 | 0.350 | 0.72 | 0.65 |

Overall hallucination **0.87**, overall deletion **0.76** →
**verdict FAIL** under `bridge-gate.v1`. Per clip: bus-stop-emergence collapses
(veh ΔAP −0.46); fog-midblock deletes every pedestrian (recall 0.00);
workzone-lane-shift and night-rain-merge keep almost no matched vehicles while
emitting unanchored detections (hallucination 1.0). parked-row-dartout is the
one clip where translation *raises* pedestrian recall (0.81 vs 0.40 floor).

This independently reproduces the W0 kill-test audit verdict
(`simforge1:~/w0-data/W0_REPORT.md`: zero-shot H3 Ref2VA fails as an observation
bridge) with a frozen, versioned instrument instead of ad-hoc probing.

### Findings

1. The dominant failure mode is **unanchored content**, not detector drift:
   translated clips contain many confident detections with no engine-GT
   counterpart (hallucination 0.72–1.0 per clip), consistent with H3's
   documented scene-rebind behavior.
2. Pedestrian preservation is the weakest link (deletion 0.65 overall;
   total deletion on fog-midblock) — exactly the class WS3's dense-conditioning
   work targets.
3. Where geometry survives (both dart-out school/parked-row clips), translated
   recall meets or exceeds the stylized-render floor — translation can help
   perception on in-distribution scenes; the failure is out-of-distribution
   content (fog, night, workzone).

### Caveats

- The W0 engine frames were rendered by headless Chrome; per the platform
  audit this lands on **SwiftShader software rasterization** (not the RTX GPU
  path), so both sides of the paired comparison share a software-raster
  provenance. Absolute floor numbers may shift with hardware rendering; the
  paired deltas are less sensitive but should be re-measured once the render
  provenance is pinned (WS4 determinism work).
- Bicycle/motorcycle rows are null: no GT instances of those classes appear in
  the 10 POV clips' frustum. They are measured on the real corpus only.
- FID is intentionally omitted (`fid?` stays unset): literature in the plan
  (arXiv 2602.18525, 2208.01022) shows global generative metrics do not predict
  downstream utility, and no Inception-FID reference weights are vendored
  offline. It remains a tie-breaker slot in the schema.

## Gate proposal (`bridge-gate.v1`)

Every student checkpoint gets a scorecard against this frozen corpus +
instrument. **PASS requires all of:**

1. per-class mean **AP delta ≥ −0.10 absolute** vs the engine-render floor
   (band ≈ 2σ of across-clip floor variance measured on the W0 set);
2. overall **hallucination rate ≤ 0.25** (detections with no IoU≥0.5 GT match);
3. **pedestrian deletion ≤ 0.35** (the safety-critical class gets a tighter
   band than the aggregate).

Rationale: the instrument itself only reaches ~0.5 recall on real footage and
far less on stylized renders, so absolute parity with reality is unattainable;
bands anchor to measured instrument noise (1) and relative content fidelity
(2–3). A relative-retention criterion (translated recall ≥ 70% of the matched
stratum's real recall) is reported in the scorecard (`perClass`,
`realReferenceByStratum`) and becomes enforceable once the clip set grows past
the current 10. Regression on any clause blocks promotion (WS3 student gate,
WS4 realism ablation consume this read-only).
