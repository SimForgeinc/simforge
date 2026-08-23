# Bridge auditor — auto-reject report

- Detector: `None` (frozen, conf≥None)
- Clips audited: **10**, rejected: **10** (rejection rate **1.0**)
- Gate (<20% rejection): **FAIL**

| clip | verdict | near-del | del | halluc-frame-frac | supported-det |
|---|---|---|---|---|---|
| baseline-midblock | REJECT | 1.0 | 1.0 | 0.0333 | 0.0 |
| bus-stop-emergence | REJECT | 1.0 | 1.0 | 0.3 | 0.0 |
| cutout-reveals-stopped | REJECT | 1.0 | 1.0 | 0.4333 | 0.4932 |
| fog-midblock | REJECT | 1.0 | 1.0 | 0.1167 | 0.0 |
| lane-drop-merge | REJECT | 0.0 | 0.0 | 0.4833 | 0.0 |
| night-rain-merge | REJECT | 0.0 | 0.0 | 0.9 | 0.0 |
| parked-row-dartout | REJECT | 1.0 | 1.0 | 0.8 | 0.0641 |
| school-parked-row-dartout | REJECT | 1.0 | 1.0 | 0.55 | 0.3425 |
| signal-red-light | REJECT | 0.0 | 0.0 | 0.5167 | 0.0 |
| workzone-lane-shift | REJECT | 1.0 | 1.0 | 0.65 | 0.0 |
