#!/usr/bin/env python3
"""W7 LLM authoring surface: gpt-5.6-luna authors each brief; a thin compiler owns representation.

The round-6 tool surface is NOT on disk (12 of its 16 ops reference undefined names; the runner
was notebook-only -- see M0.5/M6 in FINDINGS). Per the archived blocker's nextAction, this is a
REBUILT surface, and any number it produces is reported as NOT like-for-like comparable to the
published 0.466. What it preserves from round 6:

  * the authoring LLM is gpt-5.6-luna at reasoning effort medium, and nothing else (vlm.py);
  * the LLM makes the scenario-level decisions: mechanism family, actors, gap/timing windows,
    occluder, junction control, works geometry -- as one bounded JSON decision per round;
  * two solve rounds against real engine feedback (probe at draws=4), then one final measured
    batch at draws=10, exactly the round-6 rhythm (solve rounds=2 draws=4, simulate draws=10);
  * zero per-brief tuning by the operator: one prompt template, one decision schema, one compiler.

What the compiler owns (representation, not authoring): W1 warm-up compensation as a constant
(TG-A2), `actor.static` for stopped actors (TG-A1), `lateralM`/`lateralRef` for the verge (W2),
`closures` for work zones (W3), the safety governor kept ON with a late-reaction release (TG-P1),
and clamping every LLM number into pre-registered physical bounds.

The gate is the frozen physical gate v2, applied to the RAW trace by tg_gate, unchanged.

Usage:  author_llm.py --split DEV [--workers 6] [--out report.json]
"""
import argparse, concurrent.futures, json, os, re, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EC = os.path.join(ROOT, 'research', 'edge-case-corpus')
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(EC, 'tools', 'vista'))
import probe_lib as P                                                      # noqa: E402
import tg_gate as G                                                        # noqa: E402
import author_corpus as A                                                  # noqa: E402
import vlm                                                                 # noqa: E402

WARMUP = 2.0
CLIP = 18.0                                          # A._base's recorded clip length.
HESITATE_CLIP = 12.0                                 # see `_hesitating_crossing`.
RUN_TAG = 'w7'

FAMILIES = ('longitudinal_lead', 'crossing_vru', 'hesitating_vru', 'occluded_vru',
            'junction_conflict', 'lateral_incursion', 'oncoming', 'parking_pullout', 'workzone')
VEHICLES = {'vehicle.sedan': 'car', 'vehicle.suv': 'car', 'vehicle.box_truck': 'truck',
            'vehicle.van': 'van', 'vehicle.bus': 'bus', 'vehicle.motorcycle': 'motorcycle',
            'vehicle.bicycle': 'bicycle'}
VRUS = {'pedestrian.adult_walking': 'pedestrian', 'pedestrian.child_walking': 'pedestrian',
        'vehicle.bicycle': 'bicycle'}
OCCLUDERS = ('occluder.hedge_run', 'occluder.covered_car', 'occluder.dumpster',
             'street.bus_shelter')

# Pre-registered physical bounds. The compiler CLAMPS the LLM's numbers into these; it never
# invents numbers of its own when the LLM supplied one.
BOUNDS = {
  'egoSpeedKph':      (30.0, 70.0),
  'challengerSpeedKph': (0.0, 60.0),
  'gapM':             (8.0, 130.0),
  'reactAtTtcS':      (0.8, 3.5),
  'eventLeadS':       (0.5, 4.0),
  'brakeAtS':         (2.6, 6.0),
  'conflictS':        (30.0, 120.0),
  'vruSpeedKph':      (3.0, 20.0),
  'arrivalTtcS':      (0.3, 3.0),
  'oncomingStartM':   (40.0, 160.0),
  'worksStartM':      (50.0, 110.0),
  'worksLengthM':     (20.0, 60.0),
  'closedWidthM':     (1.0, 2.2),
  'workerSpeedKph':   (3.0, 8.0),
  'corridorSpeedKph': (25.0, 90.0),
  # Hesitating crossing. Every one of these is the EGO'S REMAINING DISTANCE to the
  # pedestrian at the moment the phase begins, not a clip time: the phases are
  # anchored to the ego's observed approach, so the hold costs the conflict nothing.
  'hesitateAtM':      (24.0, 90.0),
  'walkOutM':         (8.0, 40.0),
  'approachM':        (8.0, 40.0),
  'holdS':            (0.6, 3.0),
}


def _clamp(v, key):
    lo, hi = BOUNDS[key]
    return max(lo, min(hi, float(v)))


def _window(d, key, default):
    """A [lo, hi] window from the decision, clamped into bounds, or the family default."""
    v = d.get(key)
    if not (isinstance(v, (list, tuple)) and len(v) == 2):
        return default
    lo, hi = _clamp(v[0], key), _clamp(v[1], key)
    if hi <= lo:
        hi = min(BOUNDS[key][1], lo + max(0.2, 0.05 * lo))
    return (round(lo, 2), round(hi, 2))


def _scalar(d, key, default):
    v = d.get(key)
    if v is None or isinstance(v, (list, tuple, dict, str)):
        return default
    return _clamp(v, key)


def _react_interactions(react_expr):
    return [
      {'id': 'ego-inattentive', 'actor': 'ego', 'verb': 'set',
       'trigger': {'kind': 'at', 't': 0},
       'target': {'key': 'rules.collisionAvoidance', 'value': False}},
      {'id': 'ego-reacts', 'actor': 'ego', 'verb': 'set',
       'trigger': {'kind': 'at', 't': react_expr},
       'target': {'key': 'rules.collisionAvoidance', 'value': True}},
    ]


# ------------------------------------------------------------------ compilers
def c_longitudinal_lead(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 55.0)
    v_ego = v_ego_kph / 3.6
    cat = d.get('challengerCatalog') if d.get('challengerCatalog') in VEHICLES else 'vehicle.sedan'
    static = bool(d.get('challengerStatic', False))
    kph = 0.0 if static else _scalar(d, 'challengerSpeedKph', 45.0)
    mps = kph / 3.6
    lead_brakes = bool(d.get('leadBrakes', not static)) and not static
    closing = max(v_ego - mps, 0.5)
    if static:
        g_dflt = (round(3.2 * closing, 1), round(closing * closing / 4.0, 1))
    else:
        lead_stop_m = (mps * mps) / (2 * 6.0)
        hi = max(12.0, v_ego * v_ego / 3.6 - lead_stop_m)
        g_dflt = (round(max(10.0, 0.35 * hi), 1), round(hi, 1))
    gap = _window(d, 'gapM', g_dflt)
    react_w = _window(d, 'reactAtTtcS', (1.4, 2.9))
    actor = {'class': VEHICLES[cat], 'catalogId': cat}
    if static:
        actor['static'] = True
    dsM = 'param.initialGapM + %.4f' % (WARMUP * closing)
    react = 'clamp(param.initialGapM / %.4f - param.reactAtTtcS, 0.2, 12)' % v_ego
    inter = _react_interactions(react)
    params = [A._p('initialGapM', gap[0], gap[1], 'm'),
              A._p('reactAtTtcS', react_w[0], react_w[1], 's')]
    if lead_brakes:
        b = _window(d, 'brakeAtS', (2.6, 4.4))
        params.append(A._p('brakeAtS', b[0], b[1], 's'))
        inter.append({'id': 'lead-brakes', 'actor': 'chal', 'verb': 'speed',
                      'trigger': {'kind': 'at', 't': 'param.brakeAtS'},
                      'target': {'mode': 'stop'},
                      'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 6.0}})
    cs = _window(d, 'corridorSpeedKph', (50, 90))
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.longitudinal.%s' % brief['id'],
      A._corridor(speed=cs, runway=340), params,
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'relative_to', 'label': 'lead', 'actor': actor,
        'requiredSameSegmentAs': 'ego',
        'requiredHeadingRelation': {'role': 'ego', 'relation': 'parallel', 'maxErrorDeg': 10},
        'ref': 'ego', 'dLane': 0, 'dsM': dsM, 'tFrac': 0, 'headingOffsetRad': 0,
        'initialSpeedKph': kph}],
      [], inter)


def c_crossing_vru(brief, d, occluder=None, hesitate=False):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    cat = d.get('challengerCatalog') if d.get('challengerCatalog') in VRUS else None
    if cat is None:
        cat, cls, top = A._vru_catalog(brief['brief'])
    else:
        cls, top = VRUS[cat], (14.0 if cat == 'vehicle.bicycle' else 7.0)
    vspeed = _window(d, 'vruSpeedKph', (4.0, top))

    if hesitate:
        at, clip, params, inter = _hesitating_crossing(d, v_ego)
        archetype = 'w7.hesitating.%s' % brief['id']
    else:
        at, clip, params, inter = _continuous_crossing(d, v_ego)
        archetype = 'w7.crossing.%s' % brief['id']
    params.append(A._p('vruSpeedKph', vspeed[0], vspeed[1], 'kph'))

    props = []
    if occluder:
        props.append({'id': 'occ', 'catalogId': occluder, 'label': 'roadside occluder',
                      'essentiality': 'required',
                      'pose': {'laneOffset': 0, 's': at,
                               'lateralM': -2.2, 'lateralRef': 'verge', 'headingOffsetRad': 0},
                      'headingOffsetRad': 0, 'scale': 1,
                      'occludes': {'observer': 'ego', 'target': 'vru'}})
    start_lat = ({'lateralM': -3.4, 'lateralRef': 'verge'} if occluder
                 else {'lateralM': -1.0, 'lateralRef': 'verge'})
    return A._base(
      brief['id'], brief['brief'][:120], archetype,
      A._corridor(lanes=(1, 2), runway=220), params,
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'vru', 'kind': 'on_reference', 'label': 'crossing road user',
        'actor': {'class': cls, 'catalogId': cat},
        'pose': {'laneOffset': 0, 's': at, **start_lat, 'headingOffsetRad': 0},
        'initialSpeedKph': 0}],
      props, inter(start_lat), clip=clip)


def _crossing_polyline(at, start_lat):
    return [{'laneOffset': 0, 's': at, **start_lat, 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': '%s + 1.2' % at, 'lateralM': -0.2,
             'lateralRef': 'verge', 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': '%s + 2.6' % at, 'tFrac': 0, 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': '%s + 4.0' % at, 'tFrac': 1, 'headingOffsetRad': 0}]


def _continuous_crossing(d, v_ego):
    """One monotone walk, started on a clip clock back-solved from the ego's nominal speed."""
    conflict = _window(d, 'conflictS', (45, 85))
    lead = _window(d, 'eventLeadS', (1.4, 3.2))
    step = 'clamp(param.conflictS / %.4f - param.crossLeadS, 0.2, 12)' % v_ego
    at = 'param.conflictS'
    params = [A._p('conflictS', conflict[0], conflict[1], 'm'),
              A._p('crossLeadS', lead[0], lead[1], 's')]

    def inter(start_lat):
        return [
          {'id': 'vru-crosses', 'actor': 'vru', 'verb': 'route',
           'trigger': {'kind': 'at', 't': step},
           'target': {'mode': 'polyline', 'points': _crossing_polyline(at, start_lat)}},
          {'id': 'vru-walks', 'actor': 'vru', 'verb': 'speed',
           'trigger': {'kind': 'at', 't': step},
           'target': {'mode': 'absolute', 'valueKph': 'param.vruSpeedKph'},
           'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.0}}]
    return at, CLIP, params, inter


def _hesitating_crossing(d, v_ego):
    """Will-they-won't-they: step out, freeze in the road, then commit.

    Every phase is triggered by the EGO'S REMAINING DISTANCE to the pedestrian rather
    than by a clip time. That is what makes the pause authorable: a clip clock has to
    be back-solved from an assumed ego speed and an assumed zero warm-up, and any hold
    inserted afterwards shifts the pedestrian's arrival at the conflict by the hold plus
    the walking ramps -- measured on this engine, a hand-timed 1 s pause took a crossing
    from 4/16 admitted cells to 0/16. Anchored to the approach, the hold is free: the
    pedestrian is in the road, stationary, exactly when the ego is `hesitateAtM` away,
    and commits `holdS` later whatever the site's speed limit did to the ego.
    A 12 s clip, not the family default 18 s. The mechanism runs from the step-out at
    about 1.5 s to the far kerb at about 10 s, and the review surface spends a FIXED
    budget of eight evenly spaced frames on whatever length the clip declares. At 18 s
    those frames are 2.6 s apart, so a 2 s standstill lands in at most one of them and
    is literally unobservable: measured here, the 2D oracle read frames-only evidence of
    an 18 s clip as "crosses continuously without a visible hesitation". At 12 s they are
    1.7 s apart and the hold spans two, which is what makes a standstill visible at all.
    """
    hes = _window(d, 'hesitateAtM', (44, 60))
    walk = _window(d, 'walkOutM', (16, 26))
    appr = _window(d, 'approachM', (14, 26))
    hold = _window(d, 'holdS', (2.0, 2.8))
    step_out = 'param.hesitateAtM + param.walkOutM'
    # The ego has already driven WARMUP * v_ego metres when the clip starts, so the
    # crossing sits that much further downstream for `stepOutM` to be an event at all.
    at = '%s + param.approachM + %.2f' % (step_out, WARMUP * v_ego)
    params = [A._p('hesitateAtM', hes[0], hes[1], 'm'),
              A._p('walkOutM', walk[0], walk[1], 'm'),
              A._p('approachM', appr[0], appr[1], 'm'),
              A._p('holdS', hold[0], hold[1], 's')]

    def near(m):
        return {'kind': 'distance', 'from': 'ego', 'to': {'role': 'vru'},
                'measure': 'euclidean', 'op': '<=', 'valueM': m}

    def inter(start_lat):
        return [
          {'id': 'vru-a-steps-out', 'actor': 'vru', 'verb': 'route',
           'trigger': {'kind': 'when', 'condition': near(step_out),
                       'byLatest': HESITATE_CLIP - 4.0, 'ifNever': 'fire'},
           'target': {'mode': 'polyline', 'points': _crossing_polyline(at, start_lat)}},
          {'id': 'vru-b-walks', 'actor': 'vru', 'verb': 'speed',
           'trigger': {'kind': 'after', 'of': 'vru-a-steps-out', 'event': 'start', 'delayS': 0},
           'target': {'mode': 'absolute', 'valueKph': 'param.vruSpeedKph'},
           'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.0}},
          {'id': 'vru-c-hesitates', 'actor': 'vru', 'verb': 'speed',
           'trigger': {'kind': 'when', 'condition': near('param.hesitateAtM'),
                       'byLatest': HESITATE_CLIP - 2.0, 'ifNever': 'fire'},
           'target': {'mode': 'stop'},
           'dynamics': {'shape': 'step', 'constraint': 'time', 'value': 0.1}},
          {'id': 'vru-d-commits', 'actor': 'vru', 'verb': 'speed',
           'trigger': {'kind': 'after', 'of': 'vru-c-hesitates', 'event': 'start',
                       'delayS': 'param.holdS'},
           'target': {'mode': 'absolute', 'valueKph': 'param.vruSpeedKph'},
           'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.0}}]
    return at, HESITATE_CLIP, params, inter


def c_hesitating_vru(brief, d):
    return c_crossing_vru(brief, d, hesitate=True)


def c_occluded_vru(brief, d):
    occ = d.get('occluder') if d.get('occluder') in OCCLUDERS else 'occluder.hedge_run'
    t = c_crossing_vru(brief, d, occluder=occ)
    t['meta']['archetype'] = 'w7.occluded.%s' % brief['id']
    return t


def c_junction_conflict(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    ctl = d.get('junctionControl')
    control = (['signalized'] if ctl == 'signalized'
               else ['all_way_stop', 'minor_stop'] if ctl == 'stop' else None)
    jx = {'id': 'jx', 'kind': 'junction', 'essentiality': 'required',
          'atM': {'value': [0, 0], 'essentiality': 'required'}}
    if control:
        jx['control'] = {'value': control, 'essentiality': 'required'}
    cat = d.get('challengerCatalog')
    if cat in VRUS:
        chal = {'class': VRUS[cat], 'catalogId': cat}
    elif cat in VEHICLES:
        chal = {'class': VEHICLES[cat], 'catalogId': cat}
    else:
        conflicting = re.search(r'\bpedestrian|\bcyclist|\bchild', brief['brief'], re.I)
        if conflicting:
            c2, cls2, _ = A._vru_catalog(brief['brief'])
            chal = {'class': cls2, 'catalogId': c2}
        else:
            chal = {'class': 'car', 'catalogId': 'vehicle.sedan'}
    arrival = _window(d, 'arrivalTtcS', (0.5, 2.2))
    react_w = _window(d, 'reactAtTtcS', (1.2, 2.6))
    chal_kph = _scalar(d, 'challengerSpeedKph', 30.0)
    approach_m = 70.0
    react = 'clamp(%.4f / %.4f - param.reactAtTtcS, 0.2, 12)' % (approach_m, v_ego)
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.junction.%s' % brief['id'],
      {**A._corridor(lanes=(1, 8), runway=200),
       'runwayUpstreamM': {'value': [110, None], 'essentiality': 'required'}},
      [A._p('arrivalTtc', arrival[0], arrival[1], 's'),
       A._p('reactAtTtcS', react_w[0], react_w[1], 's')],
      [{**A._ego(s=-approach_m), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'conflicting_gate', 'label': 'conflicting movement',
        'actor': chal, 'essentiality': 'required',
        'feature': 'jx', 'from': 'from_left', 'turn': 'straight',
        'arriveAtConflict': {'relativeTo': 'ego', 'deltaT': '-param.arrivalTtc'},
        'requiredUpstreamRunwayM': 60,
        'initialSpeedKph': chal_kph}],
      [],
      _react_interactions(react) + [
       {'id': 'chal-commits', 'actor': 'chal', 'verb': 'set',
        'trigger': {'kind': 'at', 't': 0},
        'target': {'key': 'rules.yieldToVehicles', 'value': False}}],
      features=[jx], max_sites=8)


def c_lateral_incursion(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    chal_kph = _scalar(d, 'challengerSpeedKph', 34.0)
    cat = d.get('challengerCatalog') if d.get('challengerCatalog') in VEHICLES else 'vehicle.sedan'
    closing = max(v_ego - chal_kph / 3.6, 1.0)
    gap = _window(d, 'gapM', (14, 34))
    cut_w = _window(d, 'eventLeadS', (0.8, 2.4))
    react_w = _window(d, 'reactAtTtcS', (1.0, 2.4))
    dsM = 'param.initialGapM + %.4f' % (WARMUP * closing)
    cut = 'clamp(param.initialGapM / %.4f - param.cutLeadS, 0.2, 12)' % closing
    react = 'clamp(param.initialGapM / %.4f - param.reactAtTtcS, 0.2, 12)' % closing
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.lateral.%s' % brief['id'],
      A._corridor(lanes=(2, 8), speed=_window(d, 'corridorSpeedKph', (40, 90)), runway=260),
      [A._p('initialGapM', gap[0], gap[1], 'm'), A._p('cutLeadS', cut_w[0], cut_w[1], 's'),
       A._p('reactAtTtcS', react_w[0], react_w[1], 's')],
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'relative_to', 'label': 'cutting-in vehicle',
        'actor': {'class': VEHICLES[cat], 'catalogId': cat},
        'requiredSameSegmentAs': 'ego',
        'ref': 'ego', 'dLane': 1, 'dsM': dsM, 'tFrac': 0, 'headingOffsetRad': 0,
        'initialSpeedKph': chal_kph}],
      [],
      _react_interactions(react) + [
       {'id': 'chal-cuts-in', 'actor': 'chal', 'verb': 'changeLane',
        'trigger': {'kind': 'at', 't': cut},
        'target': {'mode': 'toRole', 'role': 'ego'},
        'dynamics': {'shape': 'sinusoidal', 'constraint': 'rate', 'value': 1.6}}])


def c_oncoming(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    onc_kph = _scalar(d, 'challengerSpeedKph', 35.0)
    cat = d.get('challengerCatalog') if d.get('challengerCatalog') in VEHICLES else 'vehicle.sedan'
    close = v_ego + onc_kph / 3.6
    start = _window(d, 'oncomingStartM', (60, 130))
    drift_w = _window(d, 'eventLeadS', (1.4, 3.0))
    react_w = _window(d, 'reactAtTtcS', (1.0, 2.4))
    react = 'clamp(param.oncomingStartM / %.4f - param.reactAtTtcS, 0.2, 12)' % close
    drift = 'clamp(param.oncomingStartM / %.4f - param.driftLeadS, 0.2, 12)' % close
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.oncoming.%s' % brief['id'],
      A._corridor(lanes=(1, 1), speed=_window(d, 'corridorSpeedKph', (30, 70)), runway=260),
      [A._p('oncomingStartM', start[0], start[1], 'm'),
       A._p('driftLeadS', drift_w[0], drift_w[1], 's'),
       A._p('reactAtTtcS', react_w[0], react_w[1], 's')],
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'opposing', 'label': 'oncoming vehicle',
        'actor': {'class': VEHICLES[cat], 'catalogId': cat},
        'pose': {'laneOffset': 0, 's': 'param.oncomingStartM', 'tFrac': 0,
                 'headingOffsetRad': 0},
        'initialSpeedKph': onc_kph}],
      [],
      _react_interactions(react) + [
       {'id': 'chal-holds', 'actor': 'chal', 'verb': 'set',
        'trigger': {'kind': 'at', 't': drift},
        'target': {'key': 'rules.collisionAvoidance', 'value': False}}])


def c_parking_pullout(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 45.0)
    v_ego = v_ego_kph / 3.6
    gap = _window(d, 'gapM', (22, 48))
    pull_w = _window(d, 'eventLeadS', (1.0, 2.6))
    react_w = _window(d, 'reactAtTtcS', (1.0, 2.4))
    dsM = 'param.initialGapM + %.4f' % (WARMUP * v_ego)
    pull = 'clamp(param.initialGapM / %.4f - param.pullLeadS, 0.2, 12)' % v_ego
    react = 'clamp(param.initialGapM / %.4f - param.reactAtTtcS, 0.2, 12)' % v_ego
    comp = WARMUP * v_ego
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.parking.%s' % brief['id'],
      A._corridor(lanes=(1, 8), speed=(55, 90), runway=200),
      [A._p('initialGapM', gap[0], gap[1], 'm'), A._p('pullLeadS', pull_w[0], pull_w[1], 's'),
       A._p('reactAtTtcS', react_w[0], react_w[1], 's')],
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'chal', 'kind': 'relative_to', 'label': 'vehicle leaving a kerbside bay',
        'actor': {'class': 'car', 'catalogId': 'vehicle.sedan'},
        'requiredSameSegmentAs': 'ego',
        'ref': 'ego', 'dLane': 0, 'dsM': dsM,
        'lateralM': -1.1, 'lateralRef': 'lane_edge', 'headingOffsetRad': 0,
        'initialSpeedKph': 0}],
      [],
      _react_interactions(react) + [
       {'id': 'chal-pulls-out', 'actor': 'chal', 'verb': 'route',
        'trigger': {'kind': 'at', 't': pull},
        'target': {'mode': 'polyline', 'points': [
            {'laneOffset': 0, 's': 'param.initialGapM + %.4f' % comp,
             'lateralM': -1.1, 'lateralRef': 'lane_edge', 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': 'param.initialGapM + %.4f' % (comp + 6.0),
             'lateralM': -0.2, 'lateralRef': 'lane_edge', 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': 'param.initialGapM + %.4f' % (comp + 14.0),
             'tFrac': 0, 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': 'param.initialGapM + %.4f' % (comp + 30.0),
             'tFrac': 0, 'headingOffsetRad': 0}]}},
       {'id': 'chal-accelerates', 'actor': 'chal', 'verb': 'speed',
        'trigger': {'kind': 'at', 't': pull},
        'target': {'mode': 'absolute', 'valueKph': 24},
        'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.5}}])


def c_workzone(brief, d):
    v_ego_kph = _scalar(d, 'egoSpeedKph', 40.0)
    v_ego = v_ego_kph / 3.6
    ws = _window(d, 'worksStartM', (60, 95))
    wl = _window(d, 'worksLengthM', (25, 50))
    cw = _window(d, 'closedWidthM', (1.2, 1.8))
    cl = _window(d, 'eventLeadS', (1.6, 3.4))
    wk = _window(d, 'workerSpeedKph', (3.5, 7.0))
    step = ('clamp((param.worksStartM + 0.5 * param.worksLengthM) / %.4f - param.crossLeadS, 0.2, 12)'
            % v_ego)
    mid = 'param.worksStartM + 0.5 * param.worksLengthM'
    return A._base(
      brief['id'], brief['brief'][:120], 'w7.workzone.%s' % brief['id'],
      A._corridor(lanes=(1, 8), speed=(50, 90), runway=340),
      [A._p('worksStartM', ws[0], ws[1], 'm'), A._p('worksLengthM', wl[0], wl[1], 'm'),
       A._p('closedWidthM', cw[0], cw[1], 'm'), A._p('crossLeadS', cl[0], cl[1], 's'),
       A._p('workerSpeedKph', wk[0], wk[1], 'kph')],
      [{**A._ego(), 'initialSpeedKph': v_ego_kph},
       {'id': 'worker', 'kind': 'on_reference', 'label': 'road worker',
        'actor': {'class': 'pedestrian', 'catalogId': 'construction.flagger'},
        'pose': {'laneOffset': 0, 's': mid, 'lateralM': -0.9,
                 'lateralRef': 'lane_edge', 'headingOffsetRad': 0},
        'initialSpeedKph': 0}],
      [],
      [{'id': 'worker-steps-out', 'actor': 'worker', 'verb': 'route',
        'trigger': {'kind': 'at', 't': step},
        'target': {'mode': 'polyline', 'points': [
            {'laneOffset': 0, 's': mid, 'lateralM': -0.9, 'lateralRef': 'lane_edge',
             'headingOffsetRad': 0},
            {'laneOffset': 0, 's': mid + ' + 1.5', 'lateralM': -0.2, 'lateralRef': 'lane_edge',
             'headingOffsetRad': 0},
            {'laneOffset': 0, 's': mid + ' + 3.0', 'tFrac': 0, 'headingOffsetRad': 0},
            {'laneOffset': 0, 's': mid + ' + 4.5', 'tFrac': 0.9, 'headingOffsetRad': 0}]}},
       {'id': 'worker-walks', 'actor': 'worker', 'verb': 'speed',
        'trigger': {'kind': 'at', 't': step},
        'target': {'mode': 'absolute', 'valueKph': 'param.workerSpeedKph'},
        'dynamics': {'shape': 'linear', 'constraint': 'rate', 'value': 2.0}}],
      closures=[{'id': 'wz', 'label': 'lane closure', 'laneOffset': 0,
                 'fromS': 'param.worksStartM',
                 'toS': 'param.worksStartM + param.worksLengthM',
                 'closedWidthM': 'param.closedWidthM', 'side': 'right', 'device': 'cone',
                 'assumedSpeedKph': 40, 'shiftTraffic': True, 'essentiality': 'required'}])


COMPILERS = {
  'longitudinal_lead': c_longitudinal_lead,
  'crossing_vru':      c_crossing_vru,
  'hesitating_vru':    c_hesitating_vru,
  'occluded_vru':      c_occluded_vru,
  'junction_conflict': c_junction_conflict,
  'lateral_incursion': c_lateral_incursion,
  'oncoming':          c_oncoming,
  'parking_pullout':   c_parking_pullout,
  'workzone':          c_workzone,
}


# ------------------------------------------------------------------ prompts
TOOLDOC = """You are the scenario author for an autonomous-driving edge-case corpus. You receive
ONE one-sentence brief and must author it as a JSON authoring decision. A deterministic compiler
turns your decision into a portable scenario template (logical road anchors, no coordinates); the
real engine simulates it on five maps; a frozen physical gate admits or rejects it from the raw
trace. You cannot change the compiler, the engine, or the gate.

MECHANISM FAMILIES (pick exactly one as "family"):
- longitudinal_lead: ego closes on a slower/stopped/braking lead in its own lane (rear-end class).
- crossing_vru: a pedestrian/cyclist enters the ego lane from the roadside and keeps walking.
- hesitating_vru: will-they-won't-they. The pedestrian steps off the kerb, FREEZES in the road
  while the car bears down, then commits. Use it whenever the brief says hesitates, pauses,
  wavers, thinks better of it, steps back, or is undecided. Its phases are triggered by the
  ego's remaining distance, not by a clip clock, so the pause does not push the conflict away.
- occluded_vru: crossing_vru, but the VRU starts hidden behind a roadside occluder and is
  revealed before the conflict.
- junction_conflict: a conflicting movement (vehicle or VRU) arrives at a junction as ego crosses.
- lateral_incursion: a vehicle in the adjacent lane cuts into the ego lane.
- oncoming: an oncoming vehicle encroaches into the ego lane (closing speed is the SUM).
- parking_pullout: a parked vehicle pulls out of a kerbside bay into the ego path.
- workzone: a solved MUTCD lane closure shifts traffic; a road worker steps into the running lane.

DECISION FIELDS (all optional except "family"; ranges are [lo, hi] windows the engine samples
uniformly; every number is clamped into the physical bounds shown):
  family              one of the nine names above
  egoSpeedKph         30..70 (scalar)
  challengerCatalog   vehicles: vehicle.sedan | vehicle.suv | vehicle.box_truck | vehicle.van |
                      vehicle.bus | vehicle.motorcycle | vehicle.bicycle
                      VRUs: pedestrian.adult_walking | pedestrian.child_walking | vehicle.bicycle
  challengerSpeedKph  0..60 (scalar; lead/cut-in/oncoming/junction challenger speed)
  challengerStatic    true for a genuinely stopped lead (longitudinal only)
  leadBrakes          true = moving lead brakes hard, Euro NCAP CCRb (longitudinal only)
  gapM                [8..130] initial ego->challenger gap window (longitudinal/lateral/parking)
  reactAtTtcS         [0.8..3.5] ego reacts when TTC falls to this (late-reaction mechanism)
  eventLeadS          [0.5..4.0] event lead time before ego arrival (cross/cut/pull/drift)
  brakeAtS            [2.6..6.0] when the braking lead brakes (longitudinal, leadBrakes)
  conflictS           [30..120] conflict point distance ahead of ego spawn (crossing/occluded)
  vruSpeedKph         [3..20] VRU crossing speed window
  hesitateAtM         [24..90] hesitating_vru: ego's remaining distance when she FREEZES.
                      This single number sets the criticality; smaller = later = more critical.
  holdS               [0.6..3.0] hesitating_vru: how long she stands still in the road.
  walkOutM            [8..40] hesitating_vru: extra ego distance covered while she walks out,
                      i.e. how far into the road she gets before freezing.
  approachM           [8..40] hesitating_vru: extra ego distance before she steps off the kerb.
  occluder            occluder.hedge_run | occluder.covered_car | occluder.dumpster |
                      street.bus_shelter (occluded_vru only)
  junctionControl     signalized | stop | any (junction_conflict only)
  arrivalTtcS         [0.3..3.0] challenger arrives this long before ego at the conflict point
  oncomingStartM      [40..160] oncoming start distance window
  worksStartM/worksLengthM/closedWidthM/workerSpeedKph   workzone geometry windows
  corridorSpeedKph    [25..90] required posted-speed window for the corridor
  rationale           one sentence, for the record

PHYSICS FACTS you must design around (all measured on this engine):
- The trace starts AFTER a 2.0 s warm-up; the compiler already compensates authored gaps for it.
- The frozen admission gate (pre-registered, cannot change): C1 ego really drives
  (>=2 m/s, >=10 m); C2 closest approach happens after t = 2.5 s (not a spawn artifact);
  C3 true OBB clearance <= 5.0 m; C4 requiredDecel >= 1.5 m/s^2 OR minTTC <= 3.0 s;
  C5 verdict=accept AND band=critical AND zero collisions; C6 occlusion briefs must show
  genuine hide-then-reveal before the conflict; portability >= 2 maps AND >= 3 distinct sites.
- The evaluator bands a trace trivially-safe unless minTTC <= 3.0 s, so the scenario must reach
  that; a hazard in plain view that the ego's safety governor sees early never gets there. The
  compiler therefore releases the ego's avoidance late (reactAtTtcS) -- your reactAtTtcS window
  decides how late. Lower = more critical but risks collision (C5 rejects any contact).
- C2 and C4 nearly exclude each other at low ego speed: at 35 kph the admissible gap window for a
  stopped lead is EMPTY, at 40 kph it is ~1 m wide, at 55 kph ~19 m. Longitudinal briefs with a
  stopped lead need egoSpeedKph >= 50.
- The five maps publish NO corridor posted below ~60 kph; a corridorSpeedKph upper bound <= 60
  matches ZERO sites. There are no roundabouts, school zones, parking aisles, or rail crossings;
  those briefs must be authored as the nearest hostable mechanism on an ordinary corridor.
- Collisions REJECT (C5): windows that force contact (huge vruSpeed + tiny eventLead, or
  reactAtTtcS all the way down) lose cells to collisions.

OUTPUT: exactly one JSON object, no prose outside it."""

AUTHOR_PROMPT = """%s

BRIEF (category %s):
"%s"

Author this brief. Return one JSON decision object."""

REVISE_PROMPT = """%s

BRIEF (category %s):
"%s"

Your previous decision was:
%s

The engine ran it on all five maps. Result: NOT admitted.
%s

Gate criteria the failing cells failed FIRST (count): %s
Feasible cells: %d across %d maps / %d sites; passing cells: %d.

Revise your decision to fix the dominant failure. Return one JSON decision object."""


def feedback_lines(row):
    notes = []
    ff = row.get('firstFailure') or {}
    if row.get('error'):
        notes.append('Hard error: %s %s' % (row['error'], row.get('detail', '')))
    if ff.get('C2'):
        notes.append('C2 failures: the closest approach lands too early -- widen the gap or '
                     'lower closing speed so the conflict develops after 2.5 s.')
    if ff.get('C4'):
        notes.append('C4 failures: no braking demand -- tighten reactAtTtcS or the event lead '
                     'so the ego is genuinely surprised.')
    if ff.get('C3'):
        notes.append('C3 failures: clearance stays above 5 m -- the encounter never gets close.')
    if ff.get('C1'):
        notes.append('C1 failures: the ego never really drives.')
    if ff.get('C5'):
        notes.append('C5 failures: rejected by the evaluator (collision, trivially-safe band, '
                     'or never-fired trigger).')
    if ff.get('C6'):
        notes.append('C6 failures: occlusion not proven (hide-then-reveal missing).')
    rc = row.get('refusalCodes') or {}
    if rc:
        notes.append('Engine refusals (no trace produced): %s -- these cells never simulated; '
                     'change the decision so the solver can place the scene.' % json.dumps(rc))
    if row.get('maps', 0) < 2 or row.get('sites', 0) < 3:
        notes.append('Portability short: %d maps / %d sites (need >=2 maps and >=3 sites) -- '
                     'loosen corridor requirements if possible.' % (row.get('maps', 0),
                                                                    row.get('sites', 0)))
    return '\n'.join('- ' + n for n in notes) if notes else '- (no per-criterion detail)'


# ------------------------------------------------------------------ runner
_print_lock = threading.Lock()


def decide(prompt):
    """One luna call -> decision dict. Raises on unusable output."""
    d, raw = vlm.ask_json(prompt, max_tokens=12000)
    if not isinstance(d, dict) or d.get('family') not in FAMILIES:
        raise ValueError('decision missing a valid family: %r' % (d if isinstance(d, dict)
                                                                  else type(d).__name__))
    return d, raw


def compile_and_validate(brief, decision, tag):
    template = COMPILERS[decision['family']](brief, decision)
    path = '/tmp/tg-%s-%s-%s.template.json' % (RUN_TAG, tag,
                                               re.sub(r'[^A-Za-z0-9_-]', '-', brief['id']))
    json.dump(template, open(path, 'w'), indent=1)
    rc, out, so, se = P.cli('template', 'validate', path)
    issues = [str(i.get('message'))[:160] for i in ((out or {}).get('issues') or [])[:4]]
    return path, rc == 0, issues


def run_and_gate(brief, path, decision, draws, max_sites, concurrency):
    outdir = P.unique_outdir('%s-%s' % (RUN_TAG, re.sub(r'[^A-Za-z0-9_-]', '-', brief['id'])))
    try:
        summary = P.run_batch(path, outdir, maps=None, draws=draws,
                              max_sites=max_sites, concurrency=concurrency, timeout=1800)
    except Exception as e:                                                 # noqa: BLE001
        return {'id': brief['id'], 'category': brief['category'], 'family': decision['family'],
                'admitted': False, 'error': 'batch_failed', 'detail': str(e)[:200],
                'outdir': outdir}
    recs = P.gate_summary(summary, brief=brief['brief'], version=2)
    refusals = {}
    for r in summary.get('results', []):
        tf = r.get('traceFile')
        if not tf or not os.path.exists(tf):
            code = (r.get('error') or {}).get('code') or r.get('status') or 'unknown'
            refusals[code] = refusals.get(code, 0) + 1
    feasible = [r for r in recs if r.get('firstFailure') != 'NOTRACE']
    port = G.portability(feasible)
    census = P.loss_census(feasible) if feasible else {'counts': {}, 'passed': 0}
    admitted = bool(census['passed'] > 0 and port['ok'])
    return {'id': brief['id'], 'category': brief['category'], 'family': decision['family'],
            'cells': len(recs), 'feasibleCells': len(feasible),
            'passingCells': census['passed'], 'maps': port['nMaps'], 'sites': port['nSites'],
            'admitted': admitted, 'firstFailure': census['counts'],
            'refusalCodes': refusals, 'outdir': outdir,
            'template': path}


def author_brief(brief, probe_draws, final_draws, max_sites, concurrency, log_dir):
    """The frozen per-brief protocol: author -> (repair) -> probe -> (revise) -> final."""
    trail = {'id': brief['id'], 'category': brief['category'], 'rounds': []}

    # Round 1: author.
    try:
        d1, raw1 = decide(AUTHOR_PROMPT % (TOOLDOC, brief['category'], brief['brief']))
    except Exception as e:                                                 # noqa: BLE001
        return {**trail, 'admitted': False, 'error': 'author_call_failed',
                'detail': str(e)[:200], 'family': None}
    trail['rounds'].append({'kind': 'author', 'decision': d1})
    path, ok, issues = compile_and_validate(brief, d1, 'r1')

    # One repair round on validation failure.
    if not ok:
        try:
            d1, raw1 = decide(REVISE_PROMPT % (
                TOOLDOC, brief['category'], brief['brief'], json.dumps(d1, indent=1),
                'The compiled template FAILED validation:\n' +
                '\n'.join('- ' + i for i in issues), '{}', 0, 0, 0, 0))
            trail['rounds'].append({'kind': 'repair', 'decision': d1})
            path, ok, issues = compile_and_validate(brief, d1, 'r1b')
        except Exception as e:                                             # noqa: BLE001
            return {**trail, 'admitted': False, 'error': 'repair_call_failed',
                    'detail': str(e)[:200], 'family': d1.get('family')}
        if not ok:
            return {**trail, 'admitted': False, 'error': 'template_invalid',
                    'detail': issues, 'family': d1.get('family')}

    # Probe (solve round): cheap batch, real feedback.
    probe = run_and_gate(brief, path, d1, probe_draws, max_sites=6, concurrency=concurrency)
    trail['rounds'].append({'kind': 'probe', 'result':
                            {k: probe.get(k) for k in ('admitted', 'cells', 'feasibleCells',
                                                       'passingCells', 'maps', 'sites',
                                                       'firstFailure', 'refusalCodes', 'error')}})
    d_final = d1
    if not probe['admitted']:
        # Round 2: revise against the measured census.
        try:
            d2, raw2 = decide(REVISE_PROMPT % (
                TOOLDOC, brief['category'], brief['brief'], json.dumps(d1, indent=1),
                feedback_lines(probe), json.dumps(probe.get('firstFailure') or {}),
                probe.get('feasibleCells', 0), probe.get('maps', 0), probe.get('sites', 0),
                probe.get('passingCells', 0)))
            trail['rounds'].append({'kind': 'revise', 'decision': d2})
            p2, ok2, iss2 = compile_and_validate(brief, d2, 'r2')
            if ok2:
                d_final, path = d2, p2
        except Exception as e:                                             # noqa: BLE001
            trail['rounds'].append({'kind': 'revise_failed', 'detail': str(e)[:200]})

    # Final measured batch.
    final = run_and_gate(brief, path, d_final, final_draws, max_sites=max_sites,
                         concurrency=concurrency)
    row = {**trail, **final}
    if log_dir:
        json.dump(row, open(os.path.join(log_dir, '%s.json' % brief['id']), 'w'), indent=1)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', default='DEV', choices=('DEV', 'HELDOUT', 'ALL'))
    ap.add_argument('--probe-draws', type=int, default=4)
    ap.add_argument('--draws', type=int, default=10)
    ap.add_argument('--max-sites', type=int, default=10)
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--batch-concurrency', type=int, default=4)
    ap.add_argument('--limit', type=int)
    ap.add_argument('--only', help='comma-separated brief ids')
    ap.add_argument('--log-dir')
    ap.add_argument('--out')
    a = ap.parse_args()

    briefs, dev, held = A.load_splits()
    if a.split == 'DEV':
        sel = [b for b in briefs if b['id'] in dev]
    elif a.split == 'HELDOUT':
        sel = [b for b in briefs if b['id'] in held]
    else:
        sel = briefs
    if a.only:
        want = set(a.only.split(','))
        sel = [b for b in sel if b['id'] in want]
    if a.limit:
        sel = sel[:a.limit]
    if a.log_dir:
        os.makedirs(a.log_dir, exist_ok=True)
    print('W7 LLM authoring: %d briefs (%s), model %s effort %s, probe=%d final=%d maxSites=%d'
          % (len(sel), a.split, vlm.MODEL, vlm.EFFORT, a.probe_draws, a.draws, a.max_sites))

    def run(b):
        try:
            r = author_brief(b, a.probe_draws, a.draws, a.max_sites, a.batch_concurrency,
                             a.log_dir)
        except Exception as e:                                             # noqa: BLE001
            r = {'id': b['id'], 'category': b['category'], 'family': None,
                 'admitted': False, 'error': 'unhandled', 'detail': str(e)[:300], 'rounds': []}
        with _print_lock:
            print('  %-4s %-24s %-18s cells=%3d pass=%3d maps=%d sites=%d rounds=%d %s'
                  % ('ADM' if r.get('admitted') else '----', r['id'], str(r.get('family')),
                     r.get('feasibleCells', 0) or 0, r.get('passingCells', 0) or 0,
                     r.get('maps', 0) or 0, r.get('sites', 0) or 0,
                     len(r.get('rounds', [])), r.get('error', '')))
        return r

    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        rows = list(pool.map(run, sel))

    admitted = sum(1 for r in rows if r.get('admitted'))
    by_cat = {}
    for r in rows:
        c = by_cat.setdefault(r['category'], {'total': 0, 'admitted': 0})
        c['total'] += 1
        c['admitted'] += 1 if r.get('admitted') else 0
    fails = {}
    for r in rows:
        if not r.get('admitted'):
            for k, v in (r.get('firstFailure') or {}).items():
                fails[k] = fails.get(k, 0) + v
            if r.get('error'):
                fails[r['error']] = fails.get(r['error'], 0) + 1

    rep = {'gate': 'W7 LLM authoring (gpt-5.6-luna, effort medium)', 'split': a.split,
           'model': vlm.MODEL, 'effort': vlm.EFFORT,
           'endpoint': os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
           'briefs': len(rows), 'admitted': admitted,
           'admissionRate': round(admitted / len(rows), 4) if rows else 0.0,
           'probeDraws': a.probe_draws, 'draws': a.draws, 'maxSites': a.max_sites,
           'perCategory': dict(sorted(by_cat.items())),
           'categoriesCovered': sum(1 for c in by_cat.values() if c['admitted'] > 0),
           'firstFailureAcrossRejected': dict(sorted(fails.items(), key=lambda kv: -kv[1])),
           'rows': rows}
    print(json.dumps({k: v for k, v in rep.items() if k != 'rows'}, indent=1))
    if a.out:
        json.dump(rep, open(a.out, 'w'), indent=1)
        print('wrote %s' % a.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
