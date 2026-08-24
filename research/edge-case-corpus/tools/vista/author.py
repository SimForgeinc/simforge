"""The VISTA authoring loop.

  propose -> validate -> batch -> gate -> (SEE the rollout) -> repair -> ...

`mode="sight"` gives the repair step a rendered contact sheet of what actually happened.
`mode="blind"` gives it the identical numbers and no image. Everything else is held constant,
so the difference between the two is the experiment.
"""
import os, json, subprocess, time, hashlib

import critic, gate, scene, vlm

REPO = '/Users/michaelvu-simforge/Documents/Programming/SimForge-vista'
DEV_ASSETS = REPO + '/dev-assets'
CLI = ['node', REPO + '/packages/cli/bin/simforge.js']
HERE = os.path.dirname(os.path.abspath(__file__))
SURFACE = open(HERE + '/surface.md').read()
GOLD = open(REPO + '/research/edge-case-corpus/templates/'
            'expA-child-dartout-two-cars.template.json').read()
SURFACE_SHA = hashlib.sha256(SURFACE.encode()).hexdigest()


def _dump(obj, path):
    """Write JSON, creating the directory if it is missing.

    A brief was lost to `FileNotFoundError: .../template.json` with zero iterations recorded, even
    though `author()` calls `os.makedirs(outdir)` as its first statement. Rather than guess at the
    race, every write now guarantees its own directory: a lost brief is silent data loss and costs a
    whole authoring slot.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(obj, f, indent=1, default=str)


def run_cli(args, timeout=1200):
    env = dict(os.environ, FORCE_COLOR='0', NO_COLOR='1')
    p = subprocess.run(CLI + args, capture_output=True, text=True, timeout=timeout, cwd=REPO, env=env)
    out = p.stdout.strip()
    try:
        data = json.loads(out) if out else {}
    except json.JSONDecodeError:
        data = {'raw': out[-2000:]}
    return p.returncode, data, p.stderr[-1500:]


# ---------------------------------------------------------------- prompts

def propose_prompt(brief, category):
    return f"""{SURFACE}

---
# YOUR TASK
Author ONE scenario template for this brief.

  category: {category}
  brief:    "{brief}"

This is an EDGE CASE corpus for testing an autonomous vehicle. A scenario is only worth admitting if it
puts the ego in genuine, non-trivial jeopardy that a competent driver could still survive:
  - some actor must behave badly, unexpectedly, or be hidden until late
  - the ego must actually have to DO something: brake hard, or pass within a few metres
  - the conflict must develop DURING the clip, not exist at the first frame

Be inventive within the brief. Do NOT reproduce the example below; it is there to show you the SHAPE of a
valid document and nothing else. Choose your own cast, your own mechanism, your own geometry. Two authors
given the same brief should produce visibly different scenarios.

<example_showing_document_shape_only>
{GOLD}
</example_showing_document_shape_only>

Think first about: where the danger comes from, what makes it late or hidden or unexpected, and what
forces the ego to react. Then emit ONLY the template JSON object.

Include in `meta` an extra field `"expectation"`: one or two sentences stating, in plain language, what you
expect to SEE in the simulated clip: where each actor starts relative to the ego, what it does, and roughly
when and how close the conflict gets. You will later be shown what actually happened and asked to account
for any difference."""


def repair_prompt(brief, category, template, diagnosis, seeing):
    eye = ("The attached image is a contact sheet of the SIMULATED ROLLOUT of your template at one site:\n"
           "six frames in time order, each 64 m across with a 10 m grid. The EGO is BLUE. Other actors are\n"
           "RED (small ones such as pedestrians are ringed so you can find them). Props are YELLOW.\n"
           "Grey is drivable surface, brown is junction surface, green is sidewalk, purple is parking.\n"
           "White arrows are headings. The panel marked CLOSEST APPROACH is the instant the gate measured.\n\n"
           "LOOK AT IT before you answer. Compare it against your stated expectation:\n"
           "  - where do the actors ACTUALLY start relative to each other?\n"
           "  - do they ever converge, or are they closest at the start and then separating?\n"
           "  - is the challenger even in the ego's path, or on the wrong side / a different road?\n"
           "  - is anything off the drivable surface, facing the wrong way, or absent entirely?\n\n"
           if seeing else
           "You cannot see the rollout. Reason from the numbers alone.\n\n")
    return f"""{SURFACE}

---
# REPAIR TASK
Your template did not pass the admission gate. Fix it.

  category: {category}
  brief:    "{brief}"

## What you authored
```json
{json.dumps(template)}
```

## What actually happened
{eye}```
{diagnosis}
```

## Reminder of what actually decides this
Any single finding rejects a cell. `required` invariants that miss are rejections; `preferred` ones are
free. minTTC must land at or below 3.0 s, so aim for 1.2-2.5 s. A declared `occludes` that the engine
cannot prove is a rejection on its own.

## The gate you must satisfy (it is never relaxed)
  C1 the ego really drives:      max speed >= 2.0 m/s AND distance travelled >= 10 m
  C2 not a spawn artifact:       the closest approach happens at t > warmupSeconds + 0.5 s
  C3 genuine proximity:          true bounding-box clearance <= 5.0 m at that instant
  C4 genuine demand:             ego required decel >= 1.5 m/s^2 OR minTTC <= 3.0 s
  C5 the evaluator accepts it:   verdict=accept, band=critical, no collision, no trigger that never fired
  and it must do all of that at >= 3 distinct sites across >= 2 different maps.

## Do not buy a pass by making the scenario boring
The gate only measures physics. It cannot tell an edge case from a dull encounter, but a separate quality
judge can, and it will reject what you produce if you strip the interest out of it.
Deleting the occlusion, the bad actor, the surprise or the awkward geometry in order to satisfy the
numbers is a FAILURE, not a fix. If your first draft was "a child darts out from behind a parked van" and
your repair is "a car is stopped in the lane", you have thrown the scenario away.
**Keep the mechanism that makes this an edge case, and fix the geometry and timing around it.**

Diagnose the ROOT CAUSE first, then emit a corrected template. If the mechanism is what is wrong, change
the mechanism rather than nudging a number. Keep it portable: no coordinates, no road ids, no map names.
Re-state `meta.expectation` for the corrected version.

Emit ONLY the template JSON object."""


def validate_repair_prompt(template, findings):
    return f"""{SURFACE}

---
The template you emitted is INVALID against the schema.

```json
{json.dumps(template)}
```

Validator findings:
```
{json.dumps(findings, indent=1)[:4000]}
```

Fix every finding. Emit ONLY the corrected template JSON object."""


# ---------------------------------------------------------------- diagnosis

def diagnose_text(g, batch, validate_findings=None):
    L = []
    if validate_findings:
        L.append('validator: ' + json.dumps(validate_findings)[:600])
    crit = (batch or {}).get('criticality') or {}
    if crit:
        L.append(f"evaluate: accepted={crit.get('accepted')} rejected={crit.get('rejected')} "
                 f"infeasible={crit.get('infeasible')} bands={crit.get('bands')}")
    nm = len({c.get('mapId') for c in g['cells']})
    ns = len({(c.get('mapId'), c.get('siteId')) for c in g['cells']})
    L.append(f"simulated: {g['totalCells']} cells over {nm} maps / {ns} distinct sites")
    L.append(f"cells passing the whole gate: {g['passingCells']} "
             f"(on {g['nMaps']} maps / {g['nSites']} sites)  ->  ADMITTED={g['admitted']}"
             f"   [need >= 3 sites across >= 2 maps]")
    L.append(f"failures by clause across cells: {g['lossCounts']}")
    if g.get('errorCounts'):
        L.append(f"cells that could not even be built/simulated: {g['errorCounts']}")
    L.append('')
    L.append('per cell:')
    for c in g['cells'][:8]:
        if c.get('error'):
            L.append(f"  {c.get('mapId')}/{str(c.get('siteId'))[:8]}  FAILED TO BUILD: {c['error']}"
                     + (f" at {c.get('errorPath')}" if c.get('errorPath') else ''))
            if c.get('errorReason'):
                L.append(f"      reason: {c['errorReason']}")
            if c.get('errorDetail'):
                L.append(f"      detail: {c['errorDetail']}")
            continue
        fails = [k for k in ('C1', 'C2', 'C3', 'C4', 'C5') if c.get(k) is False]
        L.append(
            f"  {c['mapId'][:22]:22} site {str(c['siteId'])[:8]}  "
            f"{'PASS' if c['pass'] else 'FAIL ' + ','.join(fails)}")
        L.append(f"      ego maxSpeed {c['maxSpeedMps']:.1f} m/s, travelled {c['distanceTravelledM']:.0f} m"
                 f"  (warmup {c['warmupSeconds']} s, clip {c['clipSeconds']} s)")
        L.append(f"      closest approach to '{c['closestWith']}': {c['clearanceM']} m at t={c['closestT']} s"
                 f"   [C2 needs t > {c['warmupSeconds'] + 0.5} s, C3 needs <= 5.0 m]")
        L.append(f"      minTTC {c['minTTC']}, ego requiredDecelMax {c['requiredDecelMaxEgo']} m/s^2, "
                 f"verdict={c['verdict']} band={c['band']}"
                 + (f", collisions={c['collisions']}" if c['collisions'] else '')
                 + (f", TRIGGER NEVER FIRED: {c['triggerNeverFired']}" if c['triggerNeverFired'] else ''))
        qs = [k for k in ('Q1_jointChallenger', 'Q2_egoReallyResponded', 'Q3_noPropOverlap',
                          'Q5_notClipped', 'Q6_ttcPairIsEgo') if c.get(k) is False]
        if qs:
            L.append(f"      QUALITY PROBLEMS: {', '.join(qs)}"
                     f"  (ego actually decelerated {c.get('egoPeakDecelMps2')} m/s^2 and gave up "
                     f"{c.get('egoSpeedDropMps')} m/s of speed"
                     + (f"; closest prop approach {c['propClearance']['minPropClearanceM']} m"
                        if c.get('propClearance') else '') + ')')
    # the evaluator's own reject codes are the most actionable feedback in the pipeline
    L.append('')
    L.append('why the evaluator rejected these cells:')
    seen = set()
    for r in (batch or {}).get('results', [])[:12]:
        if len(seen) > 11:
            break
        for f in (r.get('findings') or []):
            k = (f.get('code'), f.get('reason'))
            if k in seen:
                continue
            seen.add(k)
            L.append(f"  [{f.get('code')}] {f.get('reason')}")
        bad = [i for i in (r.get('invariants') or []) if i.get('status') not in ('held', None)]
        for i in bad[:3]:
            k = ('inv', i.get('id'), i.get('reason'))
            if k in seen:
                continue
            seen.add(k)
            L.append(f"  invariant '{i.get('id')}' ({i.get('kind')}, {i.get('essentiality')}) "
                     f"{i.get('status')}: {str(i.get('reason'))[:170]}")
    if len(seen) == 0:
        L.append('  (none reported)')
    L.append('')
    L.append("what the evaluator's bands mean:")
    L.append("  trivially-safe = the ego was never actually in danger (minTTC above the 3 s threshold, "
             "or it braked early and comfortably). Reveal the hazard LATER, or start the challenger's "
             "move closer, or raise the closing speed. Do NOT simply move the obstacle nearer at t=0 -- "
             "that breaks C2 instead.")
    L.append("  invariant     = a required invariant you declared did not hold. Either the scenario is "
             "not doing what you claimed, or your declared range was wrong. Fix whichever is true.")
    L.append("  infeasible    = a required invariant could never hold at that site, so the cell is lost "
             "entirely. Mark it `preferred` unless it IS the scenario.")
    L.append("  occlusion_unproven = you declared occludes{observer,target} but the target was never "
             "actually hidden and then revealed. The occluder is in the wrong place, too small, or the "
             "target was already visible. This kills the whole point of a hidden-hazard scenario.")
    return '\n'.join(L)


def best_cell(g):
    """The cell that came closest to passing: the most informative one to look at."""
    ok = [c for c in g['cells'] if not c.get('error')]
    if not ok:
        return None
    return max(ok, key=lambda c: (sum(bool(c.get(k)) for k in ('C1', 'C2', 'C3', 'C4', 'C5')),
                                  -(c.get('clearanceM') if c.get('clearanceM') is not None else 1e9)))


CELL_KEYS = ('mapId', 'siteId', 'pass', 'C1', 'C2', 'C3', 'C4', 'C5', 'clearanceM', 'closestT',
             'closestWith', 'minTTC', 'requiredDecelMaxEgo', 'maxSpeedMps', 'distanceTravelledM',
             'verdict', 'band', 'traceFile', 'instanceFile', 'warmupSeconds')


# ---------------------------------------------------------------- the loop

def author(brief_id, brief, category, outdir, mode='sight', max_iters=4,
           probe_sites=2, final_sites=4, log=print, use_critic=False):
    os.makedirs(outdir, exist_ok=True)
    t_start = time.time()
    rec = {'briefId': brief_id, 'brief': brief, 'category': category, 'mode': mode,
           'iterations': [], 'admitted': False, 'surfaceSha': SURFACE_SHA}
    tpl_path = outdir + '/template.json'
    prompt, images = propose_prompt(brief, category), None
    template = None
    # A repair can make things WORSE (measured: 1 passing cell -> 0 across one iteration).
    # Always carry the best template seen so far forward, and report the best, not the last.
    best = {'score': (-1, 0), 'template': None, 'gate': None, 'diag': None, 'cellsdir': None, 'iter': None}

    for it in range(max_iters):
        step = {'i': it, 'phase': 'propose' if it == 0 else 'repair', 'sawImage': bool(images)}
        try:
            template, _raw = vlm.ask_json(prompt, images=images)
        except Exception as e:                                    # noqa: BLE001
            step['error'] = 'model: ' + str(e)
            rec['iterations'].append(step)
            break
        if not isinstance(template, dict):
            step['error'] = 'model did not return a JSON object'
            rec['iterations'].append(step)
            break
        template.setdefault('meta', {}).setdefault('author', 'agent/vista-' + mode)
        step['expectation'] = template.get('meta', {}).get('expectation')
        _dump(template, tpl_path)
        _dump(template, outdir + f'/template.iter{it}.json')

        # --- schema validation, with cheap text-only repairs
        vfind = None
        for _ in range(3):
            rc, vd, _err = run_cli(['template', 'validate', tpl_path])
            # the validator reports under `issues`; `findings` does not exist and reading it
            # silently produced an EMPTY repair prompt, which could never converge
            vfind = vd.get('issues') or vd.get('findings') or []
            hard = [f for f in vfind if f.get('severity') in (None, 'error')]
            if rc == 0 and not hard:
                break
            step['validateRepairs'] = step.get('validateRepairs', 0) + 1
            try:
                template, _ = vlm.ask_json(validate_repair_prompt(template, vfind))
                _dump(template, tpl_path)
            except Exception as e:                                # noqa: BLE001
                step['error'] = 'validate-repair: ' + str(e)
                break
        step['validateFindings'] = (vfind or [])[:6]

        # --- cheap anchor pre-check: `sites match` is far cheaper than a batch, and an anchor that
        # matches nothing used to burn a whole authoring iteration on an empty result
        for _ in range(2):
            _rc, sm, _e = run_cli(['sites', 'match', tpl_path, '--all-maps'])
            # `sites match` reports per-map: {totalSites, maps:[{mapId, siteCount, stats, failureSummary}]}
            mp = sm.get('maps') or []
            n_sites = sm.get('totalSites') or 0
            nmaps = sum(1 for m in mp if (m.get('siteCount') or 0) > 0)
            step['preSites'] = n_sites
            step['preMaps'] = nmaps
            if n_sites >= 3 and nmaps >= 2:
                break
            fs = {'perMap': [{'mapId': m.get('mapId'), 'siteCount': m.get('siteCount'),
                              'infeasible': (m.get('stats') or {}).get('sitesInfeasible'),
                              'belowMinScore': (m.get('stats') or {}).get('sitesBelowMinScore'),
                              'whichClausesRejected': (m.get('stats') or {}).get('selectivityOrder'),
                              'failureSummary': m.get('failureSummary')} for m in mp]}
            step['anchorRepairs'] = step.get('anchorRepairs', 0) + 1
            fix = (SURFACE + '\n\n---\n'
                   'Your anchor matched ' + str(n_sites) + ' site(s) on ' + str(nmaps) + ' map(s). '
                   'It must match at least 3 sites across at least 2 maps or the scenario cannot be '
                   'admitted at all.\n\n```json\n' + json.dumps(template) + '\n```\n\n'
                   'Which clauses failed, and at how many sites:\n```\n'
                   + json.dumps(fs, indent=1)[:2500] + '\n```\n\n'
                   'Relax the anchor: widen ranges, drop `required` to `preferred`, or delete the '
                   'feature entirely. Keep the scenario itself intact -- only the site predicate is '
                   'wrong. Emit ONLY the corrected template JSON object.')
            try:
                template, _ = vlm.ask_json(fix)
                _dump(template, tpl_path)
            except Exception as e:                                # noqa: BLE001
                step['error'] = 'anchor-repair: ' + str(e)
                break

        # --- run it
        cellsdir = outdir + f'/batch-iter{it}'
        n_sites = probe_sites if it < max_iters - 1 else final_sites
        rc, bd, err = run_cli(['batch', tpl_path, '--all-maps', '--draws', '1',
                               '--max-sites', str(n_sites), '--out', cellsdir, '--concurrency', '2'])
        g = None
        if not bd.get('results'):
            # batch reports a hard failure as {code, reason, detail} on stdout, or dies on stderr
            step['batchError'] = (json.dumps(bd) if bd else '')[:900] or err[:900]
            _rcs, sd, serr = run_cli(['sites', 'match', tpl_path, '--all-maps'])
            step['failureSummary'] = json.dumps(
                [{'mapId': m.get('mapId'), 'siteCount': m.get('siteCount'),
                  'stats': m.get('stats'), 'failureSummary': m.get('failureSummary')}
                 for m in (sd.get('maps') or [])])[:1800] if sd else serr[:600]
            diag = ("NO SITES MATCHED, so nothing could be simulated.\n"
                    f"batch said: {step['batchError']}\n"
                    f"why the anchor matched nothing: {step['failureSummary']}\n\n"
                    "Loosen or drop the anchor clauses named above: make them `preferred`, widen the range, "
                    "or remove the feature entirely. Every clause you mark `required` has to exist at a real "
                    "place on these five maps, and most of them are ordinary suburban streets.")
        else:
            g = gate.gate_batch(cellsdir + '/batch-summary.json')
            step.update({'admitted': g['admitted'], 'passingCells': g['passingCells'],
                         'totalCells': g['totalCells'], 'nMaps': g['nMaps'], 'nSites': g['nSites'],
                         'lossCounts': g['lossCounts']})
            diag = diagnose_text(g, bd, step['validateFindings'])
            rec['lastGate'] = {k: v for k, v in g.items() if k != 'cells'}
            rec['lastCells'] = [{k: c.get(k) for k in CELL_KEYS} for c in g['cells']]
            rec['evidenceDir'] = cellsdir

        step['diagnosis'] = diag[:2500]
        if g is not None:
            score = (g['passingCells'], -sum(g['lossCounts'].values()))
            step['score'] = score
            if score > best['score']:
                best = {'score': score, 'template': json.loads(json.dumps(template)), 'gate': g,
                        'diag': diag, 'cellsdir': cellsdir, 'iter': it}
        rec['iterations'].append(step)
        log(f"  [{brief_id}/{mode}] iter{it}: "
            + (f"admitted={g['admitted']} pass={g['passingCells']}/{g['totalCells']} "
               f"maps={g['nMaps']} sites={g['nSites']} loss={g['lossCounts']}" if g else 'NO SITES'))

        if g and g['admitted']:
            # The gate only reads trajectories. It cannot tell whether the clip contains the MECHANISM
            # the brief names -- measured at ~24% of admitted scenarios. So a second agent watches the
            # rendered rollout and rules on intent, independently of the template and the gate.
            if not use_critic:
                rec['admitted'] = True
                break
            cr = critic.review_cells([c for c in g['cells'] if c.get('pass')], brief, limit=2, log=log)
            step['critic'] = {k: v for k, v in cr.items() if k != 'reviews'}
            rec.setdefault('criticVerdicts', []).append(
                {'iter': it, 'gateAdmitted': True, **{k: v for k, v in cr.items() if k != 'reviews'}})
            if cr.get('intentRealised'):
                rec['admitted'] = True
                rec['criticAgreed'] = True
                break
            # gate says yes, critic says the brief's mechanism is not in the clip -> keep working
            rec['criticAgreed'] = False
            log(f"  [{brief_id}/{mode}] iter{it}: GATE PASSED but CRITIC REJECTED intent -- "
                f"{str(cr.get('whyNot'))[:110]}")
            diag += ("\n\nAN INDEPENDENT REVIEWER WATCHED THE RENDERED ROLLOUT AND REJECTED IT.\n"
                     "It passes the physical gate, so the geometry and timing are fine. The problem is\n"
                     "that the clip does not contain the event the brief describes.\n"
                     f"  what the reviewer saw:  {cr.get('whatISee')}\n"
                     f"  what is missing:        {cr.get('whyNot')}\n"
                     "Keep the physics you have already got right. Change the scenario so the brief's\n"
                     "actual mechanism happens on screen.")

        # --- repair from the BEST attempt so far, not from the most recent one
        src_tpl, src_gate, src_diag = template, g, diag
        if best['template'] is not None and best['score'] > (g['passingCells'] if g else -1,
                                                             -sum(g['lossCounts'].values()) if g else 0):
            src_tpl, src_gate, src_diag = best['template'], best['gate'], best['diag']
            step['repairedFrom'] = 'best@iter%s' % best['iter']

        images = None
        if mode == 'sight' and src_gate:
            bc = best_cell(src_gate)
            if bc and bc.get('traceFile'):
                try:
                    png = outdir + f'/rollout-iter{it}.png'
                    scene.render_rollout(DEV_ASSETS, bc['traceFile'], png, closest_t=bc.get('closestT'))
                    images = [png]
                    step['image'] = png
                except Exception as e:                            # noqa: BLE001
                    step['renderError'] = type(e).__name__ + ': ' + str(e)
        template = src_tpl
        prompt = repair_prompt(brief, category, src_tpl, src_diag, seeing=bool(images))

    # --- final: give the best template its best shot across more sites
    if not rec['admitted'] and best['template'] is not None and best['score'][0] >= 1:  # noqa: PLR2004
        _dump(best['template'], tpl_path)
        fdir = outdir + '/batch-final'
        _rc, bd, _e = run_cli(['batch', tpl_path, '--all-maps', '--draws', '2', '--max-sites', '8',
                               '--out', fdir, '--concurrency', '2'])
        if bd.get('results'):
            gf = gate.gate_batch(fdir + '/batch-summary.json')
            rec['finalExpansion'] = {k: v for k, v in gf.items() if k != 'cells'}
            log(f"  [{brief_id}/{mode}] final: admitted={gf['admitted']} "
                f"pass={gf['passingCells']}/{gf['totalCells']} maps={gf['nMaps']} sites={gf['nSites']}")
            if gf['passingCells'] > best['gate']['passingCells']:
                best['gate'], best['cellsdir'] = gf, fdir
            if gf['admitted']:
                if use_critic:
                    cr = critic.review_cells([c for c in gf['cells'] if c.get('pass')], brief,
                                             limit=2, log=log)
                    rec.setdefault('criticVerdicts', []).append(
                        {'iter': 'final', 'gateAdmitted': True,
                         **{k: v for k, v in cr.items() if k != 'reviews'}})
                    rec['criticAgreed'] = bool(cr.get('intentRealised'))
                    rec['admitted'] = bool(cr.get('intentRealised'))
                    if not cr.get('intentRealised'):
                        log(f"  [{brief_id}/{mode}] final: GATE PASSED but CRITIC REJECTED intent")
                else:
                    rec['admitted'] = True
    if best['template'] is not None:
        template = best['template']
        rec['lastGate'] = {k: v for k, v in best['gate'].items() if k != 'cells'}
        rec['lastCells'] = [{k: c.get(k) for k in CELL_KEYS} for c in best['gate']['cells']]
        rec['evidenceDir'] = best['cellsdir']
        rec['bestIter'] = best['iter']
        if not use_critic:
            rec['admitted'] = rec['admitted'] or best['gate']['admitted']
        rec['gateAdmitted'] = bool(best['gate']['admitted']) or bool(rec.get('finalExpansion', {})
                                                                    .get('admitted'))
        _dump(template, tpl_path)

    rec['wallClockS'] = round(time.time() - t_start, 1)
    rec['template'] = template
    _dump(rec, outdir + '/record.json')
    return rec
