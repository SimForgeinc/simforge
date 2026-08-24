# DEFECT: signal authority is wrong for both signal *failure* states

Found by `caps-surface` while adding authorable signal failure modes. Reported here as an engine
defect in its own right: both bugs are in shipped behaviour, both affect every scenario ever run
through the engine that carried the relevant phase, and they are wrong in **opposite directions**,
so neither is a conservative approximation of the other.

Source: `packages/engine/src/sim/signals.ts`

```ts
export function phaseForbidsEntry(phase: SignalPhase): boolean {
  // A dark/failed normal signal is uncontrolled. Flashing yellow is caution,
  // while flashing red retains stop semantics. ...
  return !['green', 'green_arrow', 'proceed', 'flashing_yellow', 'off'].includes(phase);
}
```

The comment states the intent, and the intent is itself the bug for `off`.

---

## Defect 1 — a blacked-out signal is treated as *no control at all*

`'off'` is in the permissive list. An actor approaching a dark head therefore does not slow at all.

**The law it should implement.** A signal displaying no indication is not an uncontrolled junction.
In every jurisdiction this repo's maps come from, a dark or failed signal reverts the intersection to
an **all-way stop**: every approach stops, then proceeds in arrival order. (US MUTCD 4D.34 / UVC
11-205; UK Highway Code r.176; equivalent rules elsewhere.) It is one of the most common real-world
degraded-infrastructure scenarios there is — a power cut at a junction — and it is the *opposite* of
what the engine does.

**Measured, before the fix.** Ego at 12 m/s on a straight lane, one signal program whose only phase
is `off`, stop line at s = 180 m, 25 s clip:

```
FAIL  signal blackout > treats a dark head as an all-way stop rather than as no control at all
AssertionError: expected null not to be null
  at expect(dark.stoppedAtS).not.toBeNull();
```

`stoppedAtS` is `null` because the ego's speed never drops below 0.05 m/s: it crosses the stop line
at full cruise. Compare the same run with `phase: 'green'` — the two traces are identical.

**Why it matters for data.** Any clip generated with a dark signal is labelled as a
degraded-infrastructure scenario and contains an ego that behaves as though the junction were a
priority road. That is confidently mislabelled training data: the ego does the single most dangerous
available thing, and nothing in the pipeline objects.

---

## Defect 2 — a flashing red is treated as a *solid* red

`'flashing_red'` is (correctly) absent from the permissive list, but the stop-line logic has only two
authorities: `kind: 'signal'` (obey the phase; a forbidding phase means *wait indefinitely*) and
`kind: 'stop'` (stop, dwell, be released). A flashing red is the second of those, and it is wired to
the first.

**The law it should implement.** Flashing red = stop sign: come to a complete stop, then proceed when
the way is clear. Not "wait until the indication changes".

**Measured, before the fix.** Same fixture, phase `flashing_red`, 25 s clip:

```
FAIL  signal blackout > gives flashing red stop-and-proceed semantics
AssertionError: expected 178.67281265035388 to be greater than 200
  at expect(flashing.finalS).toBeGreaterThan(STOP_LINE_S + 20);
```

The ego stops at s = 178.7 m and is **still there 25 s later**. `finalS === stoppedAtS`. A program
that never leaves `flashing_red` (which is what an author writes to mean "this junction is on
flashing red") deadlocks the actor for the whole clip. Any scenario built on it produces a clip whose
event never happens, and which is then rejected downstream for a reason that has nothing to do with
what the author wrote.

---

## Defect 3 (lesser) — flashing *arrow* indications do not exist

`CONTROL_INDICATIONS` carries `green_arrow`, `yellow_arrow`, `red_x` but neither
`flashing_yellow_arrow` nor `flashing_red_arrow`. The flashing yellow arrow is the indication that
changes protected-left logic to permissive-left — the entire point of the FYA in the field — and it
is not expressible, so a permissive-left conflict has to be faked with a plain `flashing_yellow` on a
head that is supposed to be an arrow. Reversible-lane control has the same hole.

```
FAIL  turn-arrow indications > accepts flashing arrows and gives them the documented right of way
AssertionError: expected true to be false
  at expect(phaseForbidsEntry('flashing_yellow_arrow')).toBe(false);
```

---

## Scope of the blast radius

`phaseForbidsEntry` is the single executable right-of-way boundary for signals: it is consulted from
`distanceToStopLine` in `packages/engine/src/sim/controllers.ts` and nowhere else. So the two
behaviours above are the *only* behaviours the engine has ever had for these phases. Nothing
downstream can compensate: the trace records what the ego did, and what the ego did was wrong.

## Fix

Implemented alongside the surface-patch work:

- Stop-line authority becomes a function of time, not a constant established at `SignalBook`
  construction. `SignalBook.authorityAt(binding, t)` returns `{kind: 'signal' | 'stop', dwellS}`, so a
  program that is dark *right now* presents a stop-control authority *right now* and the existing,
  already-correct all-way-stop arbitration in `Engine.canReleaseStop` takes over unchanged.
- `off` therefore resolves to `stop` by default, with a per-program, author-visible
  `darkFallback: 'all_way_stop' | 'uncontrolled' | 'yield'` for the (real, rarer) cases where a dark
  head genuinely is uncontrolled — a decommissioned head, or a jurisdiction that signs it that way.
  The default is the law; the exception must be written down.
- `flashing_red` resolves to `stop` unconditionally, which is what it means.
- `flashing_yellow_arrow` and `flashing_red_arrow` are added to the indication vocabulary at both the
  authoring and engine layers, permissive and forbidding respectively.

Regression tests: `packages/engine/src/__tests__/environment-signal-failure.test.ts`.


---

## Defect 4 (found while proving Defect 1 end to end) — a matched site's controls are usually not on the ego's route

This is not part of the signal-authority fix and I do not own the code, but it is what stopped the
end-to-end proof of Defect 1, and it is measurable.

Template `caps-surface-blackout.template.json` anchors a junction with `control: ["signalized"]`
required, puts the ego straight through it, and fails the head with
`set(signal:feature:dark-junction:ego.phase, "off")`.

The override fires and is recorded: the trace's signal channel for `signal:2232` goes
`["green", "off"]`. `SignalBook.authorityAt` correctly returns `stop`. And nothing happens, because:

```
cells with a signal stop line on the ego's driven route: 0/16
```

across el-camino-road, richmond-field-station and yale-street. Concretely, on
`el-camino-road/24990c5c98b2746a`, the ego drives `612:0:-1, 0:0:-3, 775:0:-3, 1:0:-3`, while the four
bound signal programs put their stop lines on `26:*`, `72:*`, `128:*` and `74:*`. The feature matched,
the head resolved, the phase was forced — and the executable right-of-way boundary was on other lanes.
`distanceToStopLine` looks up stop lines by the lanes in the actor's route, so it finds none and the
ego's `obeySignals` is inert no matter what the phase is.

The authored-control path has the same shape of problem from a different direction:
`buildTrafficControls` binds every stop line to `this.site.frame.lateralLanes[k]` — the lane at the
**frame origin** — and then projects the junction-feature point onto it. When the junction is 50–110 m
downstream, that projection clamps to the end of a lane the ego may not even drive, so a portable
`trafficControls` entry attached to a junction feature lands in the wrong place.

Spot check of what is already committed, for calibration: of the 18 `catalog/evidence/*/instance.json`
files, only 3 carry any control at all, and 2 of those 3 do have controls on the metric subject's route
(`yale-street-001-left-turn-across-opposing-through`, static stop controls). So it is not universal —
but for a *signalized* junction reached through the anchor/feature path it was 0 for 16.

Consequence: a signal-phase scenario can be authored, materialized, simulated and accepted while the
signal never governs anybody. The phase appears in the trace, so it looks like it worked.

Not fixed here. Owner: whoever owns `buildTrafficControls` / `resolveSiteSignalProgram` in
`packages/compiler/src/materialize.ts` and the site-frame lane binding.
Reproducer: `research/edge-case-corpus/tools/vista/newcaps/check-stopline-binding.ts` (per-instance)
and `check-stopline-binding-corpus.ts` (over committed evidence).
