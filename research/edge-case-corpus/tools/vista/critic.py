"""The VISTA critic: a second agent that WATCHES the rendered rollout and verifies the
intended event actually occurred.

This is the sharpest use of sight in the whole harness. The authoring loop's repair step asks a
numeric question ("is the clearance small enough?"), which the trace already answers exactly and for
which an image is the wrong instrument. The critic asks a SEMANTIC question -- "did the cut-in
actually cut in? did the jaywalker cross the ego's path? is the occluder occluding?" -- which no
number in the trace answers, and which the independent evaluation lane measured as the single biggest
quality defect in the corpus (~24% of admitted scenarios do not contain the mechanism their brief names).

The critic never sees the template, the gate result, or the author's reasoning: only the brief and the
pictures. That keeps its verdict independent of the thing it is checking.
"""
import os, sys, json

import scene, vlm

# The independent render audit scored four renderings on the same 80 clips with this exact prompt.
# The enhanced one (9 panels, auto-zoom, 2.5 s motion trails, per-actor SPEED LABELS, legend) nearly
# doubled verdict recall (0.333 -> 0.611) and raised precision (0.545 -> 0.647). The single largest
# component was the speed label: hard-deceleration recall went 0.073 -> 0.440, because "did the lead
# brake?" is answered by a number printed on the panel, not by a picture of a car.
try:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'audit2'))
    from audit2.render2 import render_rollout2 as _render_enh
except Exception:                                                 # noqa: BLE001
    try:
        from render2 import render_rollout2 as _render_enh
    except Exception:                                             # noqa: BLE001
        _render_enh = None

REPO = '/Users/michaelvu-simforge/Documents/Programming/SimForge-vista'
DEV_ASSETS = REPO + '/dev-assets'


PROMPT = """You are reviewing a simulated driving-scenario clip to decide ONE thing: does it actually
contain the event it was supposed to contain?

The clip was authored from this one-sentence brief:

    "{brief}"

The attached image is the simulated rollout: six frames in time order, each 64 m across with a 10 m
grid. The EGO (the vehicle under test) is BLUE. Other actors are RED; small ones such as pedestrians
and cyclists are ringed so you can find them. Props (parked or stationary scenery) are YELLOW.
Grey is drivable surface, brown is junction surface, green is sidewalk, purple is parking.
White arrows show which way each thing is facing. One panel is marked CLOSEST APPROACH.

Read the frames in order and work out what physically happens. Then judge ONLY this:

**Does the specific mechanism named in the brief actually occur in these frames?**

Be strict and literal about the mechanism, not about the words:
- "a vehicle cuts in" requires a vehicle to actually move ACROSS into the ego's lane ahead of it.
  A car that is simply already in the lane, or that stays in its own lane, is NOT a cut-in.
- "a pedestrian steps out from behind X" requires a pedestrian that is behind X and then enters the
  road. A pedestrian standing at the roadside the whole time is NOT a dart-out.
- "the lead brakes hard" requires a lead vehicle that is moving and then slows sharply.
- "hidden / occluded" requires something to actually be BETWEEN the ego and the hazard.
- If the brief names an actor that is not present at all in any frame, the mechanism did not occur.

It is entirely possible for a clip to contain a real, dangerous, well-formed conflict that is
NEVERTHELESS NOT the event the brief describes. That is the case you are here to catch. Do not give
credit for "something exciting happened".

Reply with ONLY this JSON object and nothing else:
{{
  "whatISee": "<2-3 sentences describing what physically happens across the frames, in order>",
  "mechanismInBrief": "<the specific physical event the brief requires, in your own words>",
  "intentRealised": true | false,
  "whyNot": "<if false, what is missing or wrong; if true, empty string>",
  "confidence": <0.0-1.0>,
  "isGenuineConflict": true | false,
  "conflictNote": "<is there a real, non-trivial hazard to the ego here at all, regardless of whether it matches the brief?>"
}}"""


def review_trace(trace_path, brief, out_png=None, closest_t=None):
    """Render the rollout and ask the critic whether the brief's mechanism actually happened."""
    png = out_png or (os.path.splitext(trace_path)[0] + '.critic.png')
    if _render_enh is not None:
        _render_enh(DEV_ASSETS, trace_path, png, closest_t=closest_t)
    else:
        scene.render_rollout(DEV_ASSETS, trace_path, png, closest_t=closest_t)
    try:
        d, raw = vlm.ask_json(PROMPT.format(brief=brief), images=[png], max_tokens=3000)
    except Exception as e:                                        # noqa: BLE001
        return {'error': str(e), 'image': png}
    d['image'] = png
    d['trace'] = trace_path
    return d


# Unanimity was the right threshold for the critic used ALONE, where it was the only defence.
# INSIDE the conjunction with a mechanical validator it is paying for unanimity twice: the
# mechanical layer has already removed everything it can see, so a strict critic threshold only
# discards good scenarios. Measured with `predicates = present` required, on all three tiers:
#     critic unanimous 6/6  precision 1.000 (0.61,1.00)  recall 0.333  FP 0
#     critic >= 0.70        precision 1.000 (0.68,1.00)  recall 0.444  FP 0
#     critic >= 0.34        precision 1.000 (0.72,1.00)  recall 0.556  FP 0
# Zero false positives at every threshold, and the precision CI TIGHTENS as it loosens.
ACCEPT_AT = 0.34          # >= this fraction of YES votes -> intent verified (inside a conjunction)
REJECT_AT = 0.30          # <= this fraction -> intent rejected; in between -> UNCERTAIN


def review_cells(cells, brief, limit=2, reps=3, log=None, workers=6):
    """Review `limit` distinct sites, `reps` times each, and pool the votes.

    A SINGLE critic call is not a reliable instrument: measured test-retest stability on identical
    images is 11/14 = 0.786, and with one call per site 36.7% of judgements came out 1-1 ties that
    were then silently resolved as "reject". Self-consistency voting over reps x sites removes most of
    that, and anything still near the fence is reported as UNCERTAIN rather than forced to a verdict.
    Uncertain scenarios are cheap to discard when the goal is volume, and dangerous to keep when the
    goal is training data.
    """
    from concurrent.futures import ThreadPoolExecutor

    seen, picks = set(), []
    for c in cells:
        if not c.get('traceFile'):
            continue
        key = (c.get('mapId'), c.get('siteId'))
        if key in seen:
            continue
        seen.add(key)
        picks.append(c)
        if len(picks) >= limit:
            break

    jobs = [(c, k) for c in picks for k in range(reps)]

    def _one(j):
        c, k = j
        png = os.path.splitext(c['traceFile'])[0] + f'.critic{k}.png'
        r = review_trace(c['traceFile'], brief, out_png=png, closest_t=c.get('closestT'))
        r['mapId'], r['siteId'], r['rep'] = c.get('mapId'), c.get('siteId'), k
        return r

    with ThreadPoolExecutor(max_workers=workers) as ex:
        reviews = list(ex.map(_one, jobs))

    votes = [r.get('intentRealised') for r in reviews if r.get('intentRealised') is not None]
    yes = sum(1 for v in votes if v is True)
    frac = yes / len(votes) if votes else 0.0
    verdict = 'verified' if frac >= ACCEPT_AT else ('rejected' if frac <= REJECT_AT else 'uncertain')
    bad = [r for r in reviews if r.get('intentRealised') is False]
    good = [r for r in reviews if r.get('intentRealised') is True]
    conflict_votes = [r.get('isGenuineConflict') for r in reviews if r.get('isGenuineConflict') is not None]

    if log:
        log(f"      critic: {yes}/{len(votes)} yes over {len(picks)} sites x {reps} reps "
            f"-> {verdict.upper()}")
    return {
        'n': len(votes), 'nSites': len(picks), 'reps': reps,
        'nIntentRealised': yes, 'nIntentMissing': len(votes) - yes,
        'yesFraction': round(frac, 3), 'verdict': verdict,
        'intentRealised': verdict == 'verified',
        'uncertain': verdict == 'uncertain',
        'unanimous': len(set(votes)) == 1 if votes else False,
        'genuineConflict': (sum(1 for v in conflict_votes if v) / len(conflict_votes) >= 0.5
                            if conflict_votes else False),
        'whyNot': (bad[0].get('whyNot') if bad else ''),
        'whatISee': (bad[0].get('whatISee') if bad else (good[0].get('whatISee') if good else '')),
        'reviews': reviews,
    }
