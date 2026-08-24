# DEFECT: a constant negative `pose.s` on a role makes every site infeasible, with no clause named

**Package:** `packages/compiler` / `packages/compiler` (NOT owned by caps-reverse)
**Severity:** silent — `template validate` reports `ok`, `sites match` reports `totalSites: 0`, and no
clause is attributed
**Status:** open. Found while building the caps-reverse end-to-end proof; worked around, not fixed.

## Repro

Take `research/edge-case-corpus/tools/vista/newcaps/caps-reverse.template.json` — which matches 3
sites on every one of the 5 maps and produces 30 cells — and change ONLY the `on_reference` ego
role's `pose.s`:

| `roles[0].pose.s` | sites per map |
|---|---|
| `"-clamp(0.65 * lane.speedLimitKph, 18, 35) / 3.6 * 5"`  (evaluates to -25 .. -48.6) | **3, 3, 3, 3, 3** |
| `"-lane.speedLimitKph"`  (evaluates to -25 .. -40) | **3, 3, 3, 3, 3** |
| `"-param.egoApproachKph / 3.6 * 4.5"`  (evaluates to -25 .. -42.5) | 0, 0, 0, 0, 0 |
| `"-param.reverseSpeedKph * 5"` | 0, 0, 0, 0, 0 |
| `"-50"` / `"-40"` / `"-35"` / `"-30"` / `"-25"` / `"-20"` / `"-5"` / `"-1"` | 0, 0, 0, 0, 0 |
| `-35` (JSON number) | 0, 0, 0, 0, 0 |
| `"0"` | **3, 3, 3, 3, 3** |
| `"5"` | **3, 3, 3, 3, 3** |

## What this says

1. **The rejection is not about the value.** `-lane.speedLimitKph` matches every site while the
   literal `-40` it evaluates to on the same map matches none.
2. **It is about whether the expression is constant-foldable.** Anything that folds to a negative
   number at match time kills the site; anything that cannot be folded until a site is chosen sails
   through. So the check is applied inconsistently, and the *safer-looking* authoring (a plain number)
   is the one that fails.
3. **It is undiagnosable.** `template validate` returns `ok: true`, zero issues. `sites match`
   returns `totalSites: 0` with `sitesInfeasible: 127` and *no clause attributed*; with the whole
   anchor emptied (`corridor {}`, `features []`) it still returns 0 sites and an empty
   `selectivityOrder`. Nothing anywhere names the role, the field, or the reason.

Presumably an upstream-runway feasibility check on the resolved role station, silently skipped when
the station is not yet resolvable. Whatever the mechanism, the author-visible behaviour is: "put your
approaching vehicle 35 m upstream and the scenario becomes unbuildable on every map, and nothing will
tell you why".

## Workaround used

Express the upstream offset through a `lane.*` expression rather than a param or a constant. This is
a workaround, not a fix — it works by dodging the check, which is itself evidence the check is wrong.
