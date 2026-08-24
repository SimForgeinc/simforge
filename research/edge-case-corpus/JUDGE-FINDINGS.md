# Blind trace-judge calibration (gpt-5.6-luna, medium effort)

Judge sees ONLY a symbolic trace summary: actors, events, metrics, occlusion records.
No image, no author claim, no method label. n=60 balanced per round.

| Round | Ground truth | Agreement | Cohen's kappa |
|---|---|---:|---:|
| 1 | engine `evaluate` verdict, engine `minDistance` shown | 0.700 | 0.400 |
| 2 | independently re-verified, corrected clearance shown | 0.600 | 0.200 |
| **Mechanism sub-question** | engine occlusion-proven | **0.950** | — |

## Finding 1 — the judge found two real engine defects from the trace alone
Unprompted, in round 1, it repeatedly flagged *"the reported 0 m minimum distance is inconsistent
with zero collisions"*. It was right: `EpisodeMetrics.minDistance` reports the collision broad-phase
value `max(0, centreDistance - (r_a + r_b))` over **circumscribed circles**. Car r=2.58 m against
pedestrian r=0.42 m sum to 3.00 m, so every encounter closer than three metres reports exactly 0 m
clearance alongside zero collisions. True footprint clearance on that cell: **0.421 m**.
Fixed by `packages/engine/src/trace/min-clearance.ts`.

It also consistently rejected cells with minTTC 3.4-4.8 s as non-critical. Also right: those passed
only because the mechanism-aware criticality selector chose a different metric than the
`trivially_safe` filter's 3 s threshold.

## Finding 2 — the judge is excellent at MECHANISM, not at THRESHOLDS
On the objectively-checkable question "did the occlusion mechanism operate", agreement is **0.950**
with **zero false positives** (54 TP / 3 TN / 3 FN / 0 FP). It never claimed a mechanism operated
when it had not.

On "is this genuinely critical" it disagreed — but *consistently*, not noisily. On 30 independently
verified cells it returned `mechanism_operated=True` 29 times while returning
`genuinely_critical=False` 22 times, always citing the same quantities. Sweeping the criticality
definition against the **same** judgments moves agreement 0.600 -> **0.867** at
`clearance <= 0.6 m`. The disagreement was our threshold choice, not judge unreliability.

## Conclusion — how to use a judge
1. **Deterministic gates decide criticality.** Thresholds come from a published catalog
   (Westhofen et al.), never from a model's implicit standard.
2. **The LLM judge decides mechanism and coherence**, where it scores 0.95 with no false positives.
   That is exactly the question the old benchmark could not answer and the reason it failed.
3. **Never show a judge a metric you have not verified.** Round 1's agreement was partly manufactured
   by a misleading `minDistance` field.
4. Judge the **symbolic trace**, never a render — consistent with CODA-LM (text judges beat LVLM
   judges on driving scenes) and with this team's own result that the vision condition scored worse.
