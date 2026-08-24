# SimForge verified edge-case corpus

**20 gold instances · 2 archetypes · all five maps · 16 distinct sites**

Every instance in `gold/` clears all six hard requirements, each proven by real command output:

1. authored as a portable ScenarioTemplate v2 (logical anchor; no coordinates, no road IDs)
2. transfers across maps via `sites match --all-maps` with the criticality signature preserved
3. `evaluate` returns ACCEPT band `critical`; zero collisions read from the trace; no never-fired triggers
4. occluders proven causal (`revealed_before_conflict`, reveal-to-conflict inside 0.4-1.5 s)
5. passes an intent rubric written and sha256-registered **before** the scenario was tuned
6. reviewed by a blind LLM judge over the **symbolic trace**, with measured agreement

**All 20 re-simulate from disk with identical `inputHash` and `minTTC`.**

| Archetype | Instances | Maps | Judge agreement | Judge on gold |
|---|---:|---:|---:|---|
| C5 occluded child dart-out | 9 | 4 | 0.767 / k 0.521 | 9/9 mechanism, 8/9 accept |
| C1 lead hard brake | 11 | 3 | 0.788 / k 0.533 | 10/11 mechanism, 8/11 accept |

## Layout
- `gold/` — one directory per instance: trace, instance, result, `evidence.json`; `MANIFEST.json` indexes all
- `rubrics/` — pre-registered rubrics + sha256 registration records
- `templates/` — portable templates, including rejected candidates
- `reports/` — yield progression, judge calibration, archetype admissions
- `catalog-drift/` — the `catalog verify` diagnosis and the superseded catalog
- `PROGRESS.md` — the full session-by-session record, including defects found and mistakes made
- `JUDGE-FINDINGS.md` — how to use an LLM judge, with evidence

## Honest limits
- **Two archetypes, 20 instances.** This is a proof-carrying seed corpus, not a training-scale dataset.
- LTAP/OD and cut-in-brake were attempted and **rejected** by their own pre-registered rubrics; see
  `reports/archetype-admissions.json`. Nothing was admitted by relaxing a rubric.
- Occlusion is 2-D: `heightM` is carried and never read, and the child is instantiated at 1.75 m.
- The ego controller brakes with omniscient perception, decoupled from the occlusion metric.
- The arrival solver cannot solve a stationary actor (`arrival_unconverged`), which blocks the
  cleanest occlusion construction.
- `intent-rubric.ts` cannot verify `at t=0` interactions: they are folded into initial state and
  never emit `trigger_fired`.
