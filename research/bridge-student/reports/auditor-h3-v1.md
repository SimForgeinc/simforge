# Bridge auditor — auto-reject report

- Detector: `None` (frozen, conf≥None)
- Clips audited: **10**, rejected: **10** (rejection rate **1.0**)
- Gate (<20% rejection): **FAIL**

| clip | verdict | near-del | del | halluc-frame-frac | supported-det |
|---|---|---|---|---|---|
| baseline-midblock | REJECT | 1.0 | 1.0 | 0.5333 | 0.0 |
| bus-stop-emergence | REJECT | 0.9043 | 0.9412 | 0.5 | 0.3962 |
| cutout-reveals-stopped | REJECT | 1.0 | 1.0 | 0.1167 | 0.0 |
| fog-midblock | REJECT | 1.0 | 1.0 | 0.5333 | 0.0 |
| lane-drop-merge | REJECT | 1.0 | 1.0 | 0.8333 | 0.0215 |
| night-rain-merge | REJECT | 1.0 | 1.0 | 1.0 | 0.0 |
| parked-row-dartout | REJECT | 1.0 | 1.0 | 0.6333 | 0.0 |
| school-parked-row-dartout | REJECT | 1.0 | 1.0 | 0.6333 | 0.0 |
| signal-red-light | REJECT | 0.0 | 1.0 | 0.6333 | 0.0 |
| workzone-lane-shift | REJECT | 0.0 | 1.0 | 0.0167 | 0.0 |
