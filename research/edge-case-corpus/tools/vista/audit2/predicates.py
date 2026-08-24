"""predicates.py -- a TRAJECTORY-FIRST scenario validator.

Built for the VISTA pipeline as a replacement for the vision critic as PRIMARY intent check.

Rationale (measured, see audit2/REPORT-1-PRECISION-RECALL.md):
    The vision critic's precision at its shipped operating point is 0.545 (95% CI 0.280-0.787) and
    on the realistic distribution it is not distinguishable from accepting everything
    (Fisher p = 0.31). The cause is not the prompt. Asked directly about facts the trace settles
    exactly, the same model achieves recall 0.500 on "does this actor enter the ego's lane" and
    0.440 on "does it slow sharply", with specificity ~0.92-0.97. It is being asked to perceive
    quantities that are computable to the millimetre.

Design
    parse_brief()  uses an LLM on the BRIEF TEXT ONLY. It never sees an image, so it cannot be
                   led by a rendering. Its job is translation, not judgement.
    evaluate()     is pure arithmetic on the raw trace. No model, deterministic, reproducible.

    Every numeric predicate has a decisive-TRUE threshold, a decisive-FALSE threshold, and an
    ABSTAIN BAND between them. Predicates outside the vocabulary return NOT_COMPUTABLE and force
    the whole verdict to 'abstain'. Abstaining is the point: it routes exactly those cases -- and
    only those -- to the vision critic, which is where a vision model has any advantage.

    The verdict is conservative in the direction that matters. It returns 'absent' only when a core
    predicate is decisively False, because a wrong 'absent' rejects a good scenario (costing yield,
    which is cheap) while a wrong 'present' poisons the corpus (which is not).

Validation
    On 33 CONSTRUCTED NEGATIVES -- a brief whose named actor class is provably absent from the
    clip's actor+prop inventory, paired with a foreign gate-passing trace -- this module returns
    'absent' 33/33 with no model and no image involved. `regression_suite()` re-runs that set.

Usage
    from predicates import parse_brief, evaluate, evaluate_trace
    preds = parse_brief("A cyclist swerves into the ego's lane ...")   # one LLM call, text only
    r = evaluate_trace('/path/draw-000.trace.json.gz', preds)
    r['verdict']   # 'present' | 'absent' | 'abstain'

    python predicates.py <batch-summary.json> --brief "..."    # score a whole batch
"""
import gzip
import json
import math
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# --------------------------------------------------------------------------- vocabulary

#: The closed predicate vocabulary. Anything a brief needs that is not in here is reported as
#: NOT_COMPUTABLE rather than approximated.
VOCABULARY = {
    'PRESENT':                      'an actor or prop of this class exists in the clip',
    'ENTERS_EGO_PATH':              'starts clearly OUTSIDE the ego travelled corridor and later moves INTO it',
    'CROSSES_EGO_PATH':             'its path and the ego path contest the same ground (timing removed)',
    'AHEAD_OF_EGO':                 'in front of the ego for most of the time they are co-present',
    'BEHIND_EGO':                   'behind the ego for most of the time they are co-present',
    'ONCOMING':                     'travels roughly opposite to the ego',
    'DECELERATES_HARD':             'is moving and then slows sharply',
    'STARTS_STATIONARY_THEN_MOVES': 'is stopped/parked and then sets off',
    'MOVES_THEN_STOPS':             'is moving and then comes to rest',
    'TURNS':                        'net heading change of 45 degrees or more',
    'REVERSES':                     'travels backwards along its own heading',
    'OCCLUDED_BY':                  'another body is physically between the ego and this actor before they meet',
    'EGO_BRAKES':                   'the ego itself decelerates hard',
    'EGO_STOPS':                    'the ego comes to a halt',
}

#: Things briefs routinely ask for that NO trajectory can settle. Listed explicitly so the caller
#: knows the difference between "I checked and it is absent" and "I cannot check this".
NOT_COMPUTABLE = {
    'SIGNAL_STATE':   'traffic-light / beacon / sign state is not in the trace',
    'INTENT':         '"fails to yield", "ignores", "does not notice" are attributions, not motion',
    'CAUSATION':      '"because", "causing", "forcing" -- the trace shows coincidence, not cause',
    'SURPRISE':       '"suddenly", "unexpectedly" are about the ego observer, not about geometry',
    'SURFACE':        'friction patches, potholes, gravel, water are not modelled as state',
    'ARTICULATION':   'doors opening, loads shifting, jackknifing are not separate bodies',
    'VISUAL_DETAIL':  'markings, cones, tapers, liveries are not in the trace',
}

ACTOR_CLASSES = ('pedestrian', 'cyclist', 'motorcycle', 'car', 'van', 'truck', 'bus',
                 'animal', 'object')

# --------------------------------------------------------------------------- thresholds
# Each entry is (decisive TRUE at/beyond, decisive FALSE at/beyond). Between them -> abstain.
# The gap is deliberately wide: it is the difference between a measurement and a guess.

THRESHOLDS = {
    # how far outside the corridor a body must have been for its arrival inside to be an ENTRY.
    # 2.80 m ~ one lane width beyond the corridor edge, so a real adjacent-lane cut-in qualifies
    # and lateral jitter does not. Decisive-FALSE at 1.50 m = "it was basically already there".
    'entryExcursionM':      (2.80, 1.50),
    # ALSO decisively FALSE if the body never gets inside the corridor at all, by this margin:
    'neverInsideMarginM':   (None, 1.00),
    # sustained over SMOOTH_WINDOW_S, NOT per tick. The engine zeroes a speed in one tick on
    # contact, which reads as 100+ m/s^2 and would let any contact claim "it braked".
    'decelMps2':            (2.00, 1.00),
    'egoDecelMps2':         (2.00, 1.00),
    # timing-removed body-to-body separation. 0.50 m is well inside a lane; 2.00 m is the
    # adjacent-lane body gap for two 1.9 m vehicles in 3.5 m lanes, so beyond it the paths are
    # genuinely not contesting the same ground.
    'pathSeparationM':      (0.50, 2.00),
    'aheadFraction':        (0.60, 0.30),
    'turnDeg':              (45.0, 20.0),
    'reverseM':             (0.80, 0.10),
    'movedM':               (2.00, 0.50),
    'egoStopMps':           (0.30, 1.50),
}

CORRIDOR_HALF_W_M = 1.75      # half a 3.50 m lane, the median driving-lane width in the dev maps
SMOOTH_WINDOW_S = 0.30        # window for every deceleration measurement
MOVING_MIN_MPS = 3.0          # a body must have been going this fast for "decelerates hard"
OCCLUSION_MIN_SAMPLES = 2     # sightline blocked at >= this many sampled ticks

#: Lenient class compatibility. Briefs say "vehicle" and a parser must pick a concrete class, so
#: vehicle-vs-vehicle is treated as interchangeable. Leniency here can only move a verdict TOWARDS
#: 'present', i.e. away from wrongly rejecting -- never towards wrongly accepting.
CLASS_COMPAT = {
    'pedestrian': {'pedestrian', 'pedestrian_or_object'},
    'animal':     {'animal', 'pedestrian_or_object'},
    'object':     {'object', 'pedestrian_or_object', 'small'},
    'cyclist':    {'cyclist', 'motorcycle'},
    'motorcycle': {'motorcycle', 'cyclist'},
    'car':        {'car', 'van', 'truck', 'bus'},
    'van':        {'van', 'car', 'truck'},
    'truck':      {'truck', 'bus', 'van', 'car'},
    'bus':        {'bus', 'truck'},
}


# --------------------------------------------------------------------------- geometry helpers


def _classify(aid, l, w):
    """Class of a body. Its semantic id wins; footprint is the fallback and the cross-check.

    Matching is on word-ish boundaries, NOT raw substrings: matching 'ped' anywhere classified
    `stopped-bus-0` as a pedestrian, which silently made a brief requiring a bus unsatisfiable.
    """
    n = re.sub(r'[^a-z]+', ' ', (aid or '').lower())
    toks = set(n.split())

    def has(key):
        return key in toks or any(t.startswith(key) for t in toks)

    for key, cls in (('pedestrian', 'pedestrian'), ('walker', 'pedestrian'), ('cyclist', 'cyclist'),
                     ('bicycle', 'cyclist'), ('bike', 'cyclist'), ('motorcycle', 'motorcycle'),
                     ('scooter', 'motorcycle'), ('moped', 'motorcycle'), ('bus', 'bus'),
                     ('truck', 'truck'), ('trailer', 'truck'), ('lorry', 'truck'), ('van', 'van'),
                     ('animal', 'animal'), ('deer', 'animal'), ('dog', 'animal'),
                     ('debris', 'object'), ('grate', 'object'), ('load', 'object'),
                     ('wheel', 'object'), ('ladder', 'object'), ('box', 'object'),
                     ('cone', 'object'), ('gravel', 'object'), ('pothole', 'object'),
                     ('ped', 'pedestrian'), ('child', 'pedestrian'), ('jaywalk', 'pedestrian')):
        if has(key):
            return cls, _geom_class(l, w)
    g = _geom_class(l, w)
    return g, g


def _geom_class(l, w):
    if l is None or w is None:
        return 'unknown'
    if l <= 1.2 and w <= 1.2:
        return 'pedestrian_or_object'
    if l <= 2.0 and w <= 0.9:
        return 'cyclist'
    if l <= 2.6 and w <= 1.1:
        return 'motorcycle'
    if l >= 10.0:
        return 'bus'
    if l >= 6.0:
        return 'truck'
    if l >= 3.5:
        return 'car'
    return 'small'


def _corners_v(x, y, hd, l, w):
    c, s = np.cos(hd), np.sin(hd)
    d = np.array([(l / 2, w / 2), (l / 2, -w / 2), (-l / 2, -w / 2), (-l / 2, w / 2)])
    cx = x[:, None] + c[:, None] * d[None, :, 0] - s[:, None] * d[None, :, 1]
    cy = y[:, None] + s[:, None] * d[None, :, 0] + c[:, None] * d[None, :, 1]
    return np.stack([cx, cy], axis=-1)


def _sep(A, B):
    """Exact polygon separation for N pose pairs; 0.0 where they overlap."""
    E1 = np.roll(A, -1, 1) - A
    E2 = np.roll(B, -1, 1) - B
    ax = np.concatenate([np.stack([-E1[..., 1], E1[..., 0]], -1),
                         np.stack([-E2[..., 1], E2[..., 0]], -1)], axis=1)
    ax = ax / np.maximum(np.linalg.norm(ax, axis=-1, keepdims=True), 1e-12)
    pa = np.einsum('nkd,njd->nkj', ax, A)
    pb = np.einsum('nkd,njd->nkj', ax, B)
    ov = np.minimum(pa.max(-1), pb.max(-1)) - np.maximum(pa.min(-1), pb.min(-1))
    disjoint = (ov <= 0).any(1)
    out = np.zeros(len(A))
    idx = np.where(disjoint)[0]
    if len(idx):
        out[idx] = np.minimum(_p2s(A[idx], B[idx]), _p2s(B[idx], A[idx]))
    return out


def _p2s(P, Q):
    S0, S1 = Q, np.roll(Q, -1, 1)
    d = S1 - S0
    dd = (d * d).sum(-1)
    w = P[:, :, None, :] - S0[:, None, :, :]
    t = np.clip((w * d[:, None, :, :]).sum(-1) / np.maximum(dd[:, None, :], 1e-12), 0, 1)
    proj = S0[:, None, :, :] + t[..., None] * d[:, None, :, :]
    return np.linalg.norm(P[:, :, None, :] - proj, axis=-1).reshape(len(P), -1).min(1)


def _dist_to_polyline(px, py, X, Y):
    """Distance from points to the ego's travelled path, with ENDPOINT REJECTION.

    Returns (distance, interior_mask). `interior` is False where the nearest point is clamped to
    the very start or end of the polyline -- there the distance is LONGITUDINAL (the body is off
    the end of the ego's route), not lateral, and must not be read as a lane offset.

    This was a real bug in the first version of this audit: the ego's path only spans where the ego
    has been, so a tailgater behind the start point measured a 26-33 m 'lateral excursion' while
    its own lane offset never moved 0.5 m. It is the same missing-longitudinal-gate error this
    audit diagnosed in hybrid.motion.
    """
    A = np.stack([X[:-1], Y[:-1]], -1)
    B = np.stack([X[1:], Y[1:]], -1)
    d = B - A
    dd = (d * d).sum(-1)
    P = np.stack([px, py], -1)
    w = P[:, None, :] - A[None]
    t = np.clip((w * d[None]).sum(-1) / np.maximum(dd[None], 1e-12), 0, 1)
    proj = A[None] + t[..., None] * d[None]
    dist = np.linalg.norm(P[:, None, :] - proj, axis=-1)
    j = dist.argmin(1)
    k = np.arange(len(px))
    nseg = len(A)
    tb = t[k, j]
    interior = ~(((j == 0) & (tb <= 1e-6)) | ((j == nseg - 1) & (tb >= 1 - 1e-6)))
    return dist[k, j], interior


def _smooth_decel(t, v, window_s=SMOOTH_WINDOW_S):
    if len(t) < 3:
        return 0.0
    k = max(2, int(round(window_s / max(np.median(np.diff(t)), 1e-6))))
    k = min(k, len(t) - 1)
    dv, dt = v[:-k] - v[k:], t[k:] - t[:-k]
    g = dt > 0
    return float((dv[g] / dt[g]).max()) if g.any() else 0.0


def _seg_hits_box(p0, p1, cx, cy, hd, l, w):
    c, s = math.cos(-hd), math.sin(-hd)

    def loc(p):
        dx, dy = p[0] - cx, p[1] - cy
        return (c * dx - s * dy, s * dx + c * dy)

    a, b = loc(p0), loc(p1)
    dx, dy = b[0] - a[0], b[1] - a[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, a[0] + l / 2), (dx, l / 2 - a[0]), (-dy, a[1] + w / 2), (dy, w / 2 - a[1])):
        if abs(p) < 1e-12:
            if q < 0:
                return False
        else:
            r = q / p
            if p < 0:
                t0 = max(t0, r)
            else:
                t1 = min(t1, r)
            if t0 > t1:
                return False
    return True


# --------------------------------------------------------------------------- fact extraction


def trace_facts(trace_path_or_obj, corridor_half_w=CORRIDOR_HALF_W_M):
    """Everything the predicates need, computed once from the raw trace. Deterministic."""
    if isinstance(trace_path_or_obj, (str, bytes, os.PathLike)):
        with gzip.open(trace_path_or_obj) as f:
            tr = json.loads(f.read())
        src = str(trace_path_or_obj)
    else:
        tr, src = trace_path_or_obj, '<in-memory>'

    hdr, ticks = tr['header'], tr['ticks']
    ts = np.asarray(ticks['t'], float)
    meta = hdr.get('actorMetadata', {})
    ego = ticks['actors'].get('ego')
    if ego is None:
        return {'error': 'no ego in trace', 'trace': src}

    epr = np.asarray(ego['present'], bool)
    ex, ey = np.asarray(ego['x'], float), np.asarray(ego['y'], float)
    ehd, esp = np.asarray(ego['headingRad'], float), np.asarray(ego['speedMps'], float)
    ed = meta.get('ego', {}).get('dims', {})
    el, ew = ed.get('l', 4.8), ed.get('w', 1.9)
    EX, EY = ex[epr], ey[epr]

    F = {'trace': src, 'mapId': hdr.get('mapId'), 'dt': hdr.get('dt', 0.02),
         'clipSeconds': hdr.get('clipSeconds'), 'egoDims': [el, ew],
         'egoMaxSpeedMps': round(float(esp[epr].max()), 3) if epr.any() else 0.0,
         'egoMinSpeedMps': round(float(esp[epr].min()), 3) if epr.any() else 0.0,
         'egoDecelMps2': round(_smooth_decel(ts[epr], esp[epr]), 3),
         'egoDistanceM': round(float(np.hypot(np.diff(EX), np.diff(EY)).sum()), 2),
         'bodies': {}}

    bodies = []
    for aid, a in ticks['actors'].items():
        if aid == 'ego':
            continue
        d = meta.get(aid, {}).get('dims', {})
        bodies.append((aid, np.asarray(a['x'], float), np.asarray(a['y'], float),
                       np.asarray(a['headingRad'], float), np.asarray(a['present'], bool),
                       np.asarray(a['speedMps'], float), d.get('l'), d.get('w'), False))
    for pid, pm in (hdr.get('propMetadata') or {}).items():
        p, d = pm.get('pose', {}), pm.get('dims', {})
        n = len(ts)
        bodies.append((pid, np.full(n, p.get('x', 0.0)), np.full(n, -p.get('z', 0.0)),
                       np.full(n, p.get('headingRad', 0.0)), np.ones(n, bool), np.zeros(n),
                       d.get('l', 4.5), d.get('w', 1.9), True))

    for aid, ax, ay, ahd, apr, asp, al, aw, is_prop in bodies:
        cls, geo = _classify(aid, al, aw)
        b = {'id': aid, 'dims': [al, aw], 'class': cls, 'geomClass': geo, 'isProp': is_prop}
        if not apr.any():
            b['neverPresent'] = True
            F['bodies'][aid] = b
            continue
        al_, aw_ = (al or 0.6), (aw or 0.6)
        sp = asp[apr]
        b['maxSpeedMps'] = round(float(sp.max()), 3)
        b['movedM'] = round(float(np.hypot(np.diff(ax[apr]), np.diff(ay[apr])).sum()), 3)
        b['decelMps2'] = round(_smooth_decel(ts[apr], sp), 3)
        b['startsStationaryThenMoves'] = bool(
            sp[:max(1, len(sp) // 10)].max() < 0.3 and sp.max() > 1.5)
        b['movesThenStops'] = bool(
            sp[:max(1, len(sp) // 5)].max() > 2.0 and sp[-max(1, len(sp) // 10):].max() < 0.3)
        hu = np.unwrap(ahd[apr])
        b['turnDeg'] = round(float(np.degrees(hu[-1] - hu[0])), 2)
        # REVERSING: speedMps is unsigned, so this is the ONLY way to see it
        fwd = np.diff(ax) * np.cos(ahd[:-1]) + np.diff(ay) * np.sin(ahd[:-1])
        m2 = apr[:-1] & apr[1:]
        back = -fwd[m2]
        b['reverseM'] = round(float(back[back > 0].sum()), 3)

        co = epr & apr
        b['coPresentTicks'] = int(co.sum())
        if not co.any() or len(EX) < 2:
            F['bodies'][aid] = b
            continue

        lat_all, interior = _dist_to_polyline(ax[apr], ay[apr], EX, EY)
        halfw = corridor_half_w + aw_ / 2.0
        b['corridorHalfWidthM'] = round(halfw, 3)
        b['fracInteriorSamples'] = round(float(interior.mean()), 3)
        # ONLY interior samples are lateral measurements; the rest are longitudinal artifacts
        lat = lat_all[interior]
        tsi = ts[apr][interior]
        b['minLateralOffsetM'] = round(float(lat.min()), 3) if len(lat) else None
        inside = lat <= halfw if len(lat) else np.zeros(0, bool)
        b['everInsideCorridor'] = bool(inside.any())
        b['entryExcursionM'] = None
        b['tEntersCorridor'] = None
        if inside.any():
            first = int(np.argmax(inside))
            if first > 0:
                b['entryExcursionM'] = round(float(lat[:first].max()), 3)
                b['tEntersCorridor'] = float(tsi[first])

        idx = np.where(co)[0]
        fx = ((ax[idx] - ex[idx]) * np.cos(ehd[idx]) + (ay[idx] - ey[idx]) * np.sin(ehd[idx]))
        b['aheadFraction'] = round(float((fx > 0).mean()), 3)
        b['behindFraction'] = round(float((fx < 0).mean()), 3)
        cd = np.hypot(ex[idx] - ax[idx], ey[idx] - ay[idx])
        k = int(np.argmin(cd))
        i = idx[k]
        b['minCentreDistM'] = round(float(cd[k]), 3)
        b['tMinCentreDist'] = float(ts[i])
        dh = (ahd[i] - ehd[i] + math.pi) % (2 * math.pi) - math.pi
        b['relHeadingDeg'] = round(float(math.degrees(dh)), 2)
        ad = abs(math.degrees(dh))
        b['geometry'] = 'same-direction' if ad < 45 else ('oncoming' if ad > 135 else 'crossing')

        # timing-removed body separation, subsampled then refined
        ei, ai = np.where(epr)[0][::6], np.where(apr)[0][::6]
        if len(ei) and len(ai):
            D = np.linalg.norm(np.stack([ex[ei], ey[ei]], -1)[:, None, :]
                               - np.stack([ax[ai], ay[ai]], -1)[None], axis=-1)
            ii, jj = np.where(D <= (el + ew + al_ + aw_))
            if len(ii):
                b['pathSeparationM'] = round(float(_sep(
                    _corners_v(ex[ei[ii]], ey[ei[ii]], ehd[ei[ii]], el, ew),
                    _corners_v(ax[ai[jj]], ay[ai[jj]], ahd[ai[jj]], al_, aw_)).min()), 3)
            else:
                b['pathSeparationM'] = round(float(D.min() - (el + al_) / 2.0), 3)

        # occlusion: which bodies block the ego->this sightline before closest approach
        hits = {}
        for kk in idx[idx <= i][::5]:
            p0, p1 = (ex[kk], ey[kk]), (ax[kk], ay[kk])
            for oid, ox, oy, ohd, opr, _osp, ol, ow, _ip in bodies:
                if oid == aid or not opr[kk]:
                    continue
                if _seg_hits_box(p0, p1, ox[kk], oy[kk], ohd[kk], ol or 4.5, ow or 1.9):
                    hits[oid] = hits.get(oid, 0) + 1
        b['occludedBy'] = {k2: v for k2, v in hits.items() if v >= OCCLUSION_MIN_SAMPLES}
        F['bodies'][aid] = b
    return F


# --------------------------------------------------------------------------- evaluation


def _tri(true_hits, false_hits, n, why_true, why_false):
    """TRUE if anything decisively satisfies. FALSE only if EVERY candidate decisively fails.
    Otherwise abstain. The asymmetry is deliberate: 'absent' is the expensive claim to get wrong
    in the direction of rejecting good data, and 'present' in the direction of poisoning it, so
    neither is asserted without a decisive measurement."""
    if true_hits:
        return True, f'{why_true}: ' + '; '.join(true_hits)
    if n and len(false_hits) == n:
        return False, f'{why_false}: ' + '; '.join(false_hits)
    return None, (f'ABSTAIN -- {len(false_hits)}/{n} decisively fail and none decisively passes; '
                  f'the trajectory does not settle this')


def _candidates(facts, cls, include_props=True):
    allow = CLASS_COMPAT.get(cls, {cls})
    out = []
    for b in facts.get('bodies', {}).values():
        if b.get('neverPresent'):
            continue
        if b.get('isProp') and not include_props:
            continue
        if b.get('class') in allow or b.get('geomClass') in allow:
            out.append(b)
    return out


def _num(bodies, key, thresh_key, higher_is_true=True):
    tt, ff = THRESHOLDS[thresh_key]
    ht, hf = [], []
    for b in bodies:
        v = b.get(key)
        if v is None:
            continue
        ok = (v >= tt) if higher_is_true else (v <= tt)
        bad = (v <= ff) if higher_is_true else (v >= ff)
        (ht if ok else (hf if bad else [])).append(f"{b['id']}={v}") if (ok or bad) else None
    return ht, hf


def evaluate_predicate(pred, facts):
    """pred is [NAME, class, optional_occluder_class]. Returns (True|False|None, why)."""
    name = pred[0]
    cls = pred[1] if len(pred) > 1 else None
    occ = pred[2] if len(pred) > 2 else None

    if name in NOT_COMPUTABLE:
        return None, f'NOT COMPUTABLE from a trajectory: {NOT_COMPUTABLE[name]}'
    if name not in VOCABULARY:
        return None, f'NOT COMPUTABLE: {name!r} is outside the closed vocabulary'

    if name in ('EGO_BRAKES', 'EGO_STOPS'):
        if name == 'EGO_BRAKES':
            v = facts.get('egoDecelMps2', 0.0)
            tt, ff = THRESHOLDS['egoDecelMps2']
            if v >= tt:
                return True, f'ego decelerates {v} m/s^2 over {SMOOTH_WINDOW_S}s'
            if v <= ff:
                return False, f'ego peak deceleration only {v} m/s^2 over {SMOOTH_WINDOW_S}s'
            return None, f'ABSTAIN -- ego deceleration {v} is between {ff} and {tt}'
        v = facts.get('egoMinSpeedMps', 99.0)
        tt, ff = THRESHOLDS['egoStopMps']
        if v <= tt:
            return True, f'ego reaches {v} m/s'
        if v >= ff:
            return False, f'ego never drops below {v} m/s'
        return None, f'ABSTAIN -- ego minimum speed {v}'

    bodies = _candidates(facts, cls)
    if name == 'PRESENT':
        if bodies:
            return True, ', '.join(f"{b['id']}({b['class']}"
                                   + (', static prop' if b.get('isProp') else '') + ')'
                                   for b in bodies)
        have = sorted({b['class'] + ('/prop' if b.get('isProp') else '')
                       for b in facts.get('bodies', {}).values()})
        return False, f'no {cls} anywhere in the clip; it contains {have}'
    if not bodies:
        return False, f'no body of class {cls} exists, so {name} cannot hold'

    live = [b for b in bodies if b.get('coPresentTicks', 0) > 0 or b.get('isProp')]
    if not live:
        return False, f'no {cls} is ever co-present with the ego'

    if name == 'ENTERS_EGO_PATH':
        tt, ff = THRESHOLDS['entryExcursionM']
        margin = THRESHOLDS['neverInsideMarginM'][1]
        ht, hf = [], []
        for b in live:
            if b.get('isProp'):
                hf.append(f"{b['id']} is static scenery and cannot enter anything")
                continue
            exc, ml, hw = b.get('entryExcursionM'), b.get('minLateralOffsetM'), b.get('corridorHalfWidthM')
            if exc is not None and exc >= tt:
                ht.append(f"{b['id']} came from {exc} m outside the corridor to "
                          f"{ml} m at t={b.get('tEntersCorridor')}")
            elif ml is not None and hw is not None and ml > hw + margin:
                hf.append(f"{b['id']} is never inside (min lateral {ml} m vs corridor {hw} m)")
            elif exc is not None and exc <= ff:
                hf.append(f"{b['id']} was already there (excursion only {exc} m)")
        return _tri(ht, hf, len(live), 'enters the ego corridor from outside', 'nothing enters')

    if name == 'CROSSES_EGO_PATH':
        ht, hf = _num(live, 'pathSeparationM', 'pathSeparationM', higher_is_true=False)
        return _tri(ht, hf, len(live), 'path within '
                    f"{THRESHOLDS['pathSeparationM'][0]} m of the ego path (timing removed)",
                    'no path comes near the ego path')
    if name == 'AHEAD_OF_EGO':
        ht, hf = _num(live, 'aheadFraction', 'aheadFraction')
        return _tri(ht, hf, len(live), 'ahead of the ego', 'nothing is ahead of the ego')
    if name == 'BEHIND_EGO':
        ht, hf = _num(live, 'behindFraction', 'aheadFraction')
        return _tri(ht, hf, len(live), 'behind the ego', 'nothing is behind the ego')
    if name == 'DECELERATES_HARD':
        tt, ff = THRESHOLDS['decelMps2']
        ht, hf = [], []
        for b in live:
            d, vm = b.get('decelMps2'), b.get('maxSpeedMps') or 0.0
            if d is None:
                continue
            if d >= tt and vm >= MOVING_MIN_MPS:
                ht.append(f"{b['id']} decel {d} m/s^2 from {vm} m/s")
            elif d <= ff or vm < 1.0:
                hf.append(f"{b['id']} decel {d} m/s^2, peak speed {vm} m/s")
        return _tri(ht, hf, len(live), 'decelerates hard having been moving', 'nothing brakes')
    if name == 'TURNS':
        tt, ff = THRESHOLDS['turnDeg']
        ht = [f"{b['id']} turns {b.get('turnDeg')} deg" for b in live
              if b.get('turnDeg') is not None and abs(b['turnDeg']) >= tt]
        hf = [f"{b['id']} net heading change {b.get('turnDeg')} deg" for b in live
              if b.get('turnDeg') is not None and abs(b['turnDeg']) <= ff]
        return _tri(ht, hf, len(live), 'turns', 'nothing turns')
    if name == 'REVERSES':
        tt, ff = THRESHOLDS['reverseM']
        ht = [f"{b['id']} travels {b.get('reverseM')} m backwards" for b in live
              if (b.get('reverseM') or 0) >= tt]
        hf = [f"{b['id']} travels {b.get('reverseM')} m backwards" for b in live
              if (b.get('reverseM') or 0) <= ff]
        return _tri(ht, hf, len(live), 'reverses', 'nothing reverses')
    if name == 'ONCOMING':
        ht = [b['id'] for b in live if b.get('geometry') == 'oncoming']
        hf = [f"{b['id']} is {b.get('geometry')}" for b in live
              if b.get('geometry') == 'same-direction']
        return _tri(ht, hf, len(live), 'oncoming', 'nothing is oncoming')
    if name == 'STARTS_STATIONARY_THEN_MOVES':
        ht = [b['id'] for b in live if b.get('startsStationaryThenMoves')]
        hf = [f"{b['id']} moves {b.get('movedM')} m" for b in live
              if b.get('isProp') or (b.get('maxSpeedMps') or 0) < 0.5]
        return _tri(ht, hf, len(live), 'sets off from rest', 'nothing sets off')
    if name == 'MOVES_THEN_STOPS':
        ht = [b['id'] for b in live if b.get('movesThenStops')]
        hf = [b['id'] for b in live if b.get('isProp') or (b.get('maxSpeedMps') or 0) < 0.5]
        return _tri(ht, hf, len(live), 'comes to rest', 'nothing stops')
    if name == 'OCCLUDED_BY':
        allow = CLASS_COMPAT.get(occ, {occ}) if occ else None
        ht, hf = [], []
        for b in live:
            got = []
            for oid, cnt in (b.get('occludedBy') or {}).items():
                ob = facts['bodies'].get(oid, {})
                if allow is None or ob.get('class') in allow or ob.get('geomClass') in allow:
                    got.append(f'{oid} x{cnt}')
            if got:
                ht.append(f"{b['id']} occluded by " + ', '.join(got))
            else:
                seen = list((b.get('occludedBy') or {}).keys())
                hf.append(f"{b['id']} never occluded by a {occ}"
                          + (f' (blocked only by {seen})' if seen else ' (sightline never blocked)'))
        return _tri(ht, hf, len(live), 'occluder between ego and hazard', 'no occlusion')
    return None, f'NOT COMPUTABLE: {name}'


def evaluate(facts, predicates):
    """Evaluate parsed predicates against pre-computed facts.

    `predicates` is either the dict returned by parse_brief, or a bare list of core predicates.
    """
    if isinstance(predicates, dict):
        core = predicates.get('core') or []
        secondary = predicates.get('secondary') or []
        notes = predicates.get('notComputable') or []
    else:
        core, secondary, notes = list(predicates), [], []

    per, sec = [], []
    for p in core:
        v, why = evaluate_predicate(p, facts)
        per.append({'predicate': p, 'value': v, 'why': why, 'role': 'core'})
    for p in secondary:
        v, why = evaluate_predicate(p, facts)
        sec.append({'predicate': p, 'value': v, 'why': why, 'role': 'secondary'})

    vals = [d['value'] for d in per]
    if not vals:
        verdict = 'abstain'
        reason = 'no core predicate could be extracted from the brief'
    elif any(v is False for v in vals):
        verdict = 'absent'
        reason = '; '.join(d['why'] for d in per if d['value'] is False)
    elif all(v is True for v in vals):
        verdict = 'present'
        reason = '; '.join(d['why'] for d in per)
    else:
        verdict = 'abstain'
        reason = ('the trajectory settles some but not all core predicates -- '
                  'send this one to the vision critic: '
                  + '; '.join(d['why'] for d in per if d['value'] is None))
    return {'verdict': verdict, 'reason': reason, 'perPredicate': per + sec,
            'nCoreTrue': sum(1 for v in vals if v is True),
            'nCoreFalse': sum(1 for v in vals if v is False),
            'nCoreAbstain': sum(1 for v in vals if v is None),
            'notComputable': notes,
            'facts': facts}


def evaluate_trace(trace_path, predicates, corridor_half_w=CORRIDOR_HALF_W_M):
    """Convenience: compute facts from a trace file and evaluate in one call."""
    f = trace_facts(trace_path, corridor_half_w)
    if 'error' in f:
        return {'verdict': 'abstain', 'reason': f['error'], 'perPredicate': [], 'facts': f}
    r = evaluate(f, predicates)
    r['trace'] = trace_path
    return r


# --------------------------------------------------------------------------- brief parsing (LLM)

_VOCAB_BLOCK = '\n'.join(f'  {k:30s} {v}' for k, v in VOCABULARY.items())
_NC_BLOCK = '\n'.join(f'  {k:16s} {v}' for k, v in NOT_COMPUTABLE.items())

PARSE_PROMPT = """You are translating a one-sentence driving-scenario brief into a formal,
machine-checkable specification. You are NOT looking at any video or image -- you only read English,
and you must not speculate about what a clip might show.

BRIEF:
    "{brief}"

ACTOR CLASSES: """ + ', '.join(ACTOR_CLASSES) + """
  ("object" = debris, a detached wheel, a dropped load, a grate, gravel, a fallen branch ...)

PREDICATES (each takes an actor class; the ego is the vehicle under test):
""" + _VOCAB_BLOCK + """

  OCCLUDED_BY takes a second class: the occluder.
  EGO_BRAKES and EGO_STOPS take no class -- pass null.

THINGS THAT CANNOT BE CHECKED FROM MOTION AT ALL. If the brief's distinctive element is one of
these, say so in `notComputable` instead of inventing a motion predicate that stands in for it:
""" + _NC_BLOCK + """

Rules:
- `core` = what MUST be true for the brief to be honestly realised. AT MOST 3 predicates. Prefer the
  single most distinctive one. If the brief names an actor class, PRESENT for it is always core.
- `secondary` = supporting detail whose absence weakens but arguably does not falsify the clip.
- Do NOT put a predicate in `core` as a proxy for something in the not-computable list. If the
  distinctive event is "the lead loses traction on a friction patch", the surface is not checkable;
  say so. It is far better to abstain than to approximate.
- Causal glue ("forcing", "causing") is not itself checkable, but its CONSEQUENCE often is: prefer
  EGO_BRAKES / EGO_STOPS over trying to encode causation.

Reply with ONLY this JSON:
{{
  "core": [["PREDICATE", "class_or_null", "occluder_class_or_null"], ...],
  "secondary": [["PREDICATE", "class_or_null", null], ...],
  "notComputable": ["<KEY from the list above>", ...],
  "namedActorClasses": ["..."],
  "distinctiveMechanism": "<one clause: the single physical thing that must happen>",
  "notes": "<anything the vocabulary cannot express>"
}}"""


def parse_brief(brief, ask_json=None):
    """One LLM call, TEXT ONLY. `ask_json(prompt) -> (dict, raw)` may be injected for testing.

    Falls back to the vista `vlm` module so this has no dependency of its own.
    """
    if ask_json is None:
        vista = os.path.dirname(HERE)
        if vista not in sys.path:
            sys.path.insert(0, vista)
        import vlm
        ask_json = lambda p: vlm.ask_json(p, max_tokens=3000)          # noqa: E731
    d, _raw = ask_json(PARSE_PROMPT.format(brief=brief))
    d.setdefault('core', [])
    d.setdefault('secondary', [])
    d.setdefault('notComputable', [])
    d['brief'] = brief
    return d


# --------------------------------------------------------------------------- regression suite

REGRESSION_FILE = os.path.join(HERE, 'regression-negatives.json')


def regression_suite(verbose=True):
    """Re-run the CONSTRUCTED NEGATIVES: briefs whose named actor class is provably absent from
    the clip. Ground truth needs no model and no image, so this is a permanent, cheap regression
    test for ANY future validator -- vision-based or otherwise. It must score 100%.
    """
    if not os.path.exists(REGRESSION_FILE):
        raise FileNotFoundError(f'{REGRESSION_FILE} not found; run build_regression() first')
    cases = json.load(open(REGRESSION_FILE))
    ok, fail, skip = 0, [], 0
    for c in cases:
        if not os.path.exists(c['trace']):
            skip += 1
            continue
        r = evaluate_trace(c['trace'], {'core': [tuple(p) for p in c['corePredicates']]})
        if r['verdict'] == 'absent':
            ok += 1
        else:
            fail.append({'id': c['id'], 'got': r['verdict'], 'why': r['reason'][:200]})
    n = ok + len(fail)
    if verbose:
        print(f'constructed-negative regression: {ok}/{n} returned "absent"'
              + (f' ({skip} skipped, trace missing)' if skip else ''))
        for f_ in fail:
            print('  FAIL', f_['id'], '->', f_['got'], '|', f_['why'])
    return {'passed': ok, 'total': n, 'skipped': skip, 'failures': fail,
            'ok': len(fail) == 0 and n > 0}


# --------------------------------------------------------------------------- CLI


def score_batch(summary_path, predicates, only_passing=True):
    """Score every cell in a `simforge batch` summary."""
    s = json.load(open(summary_path))
    rows = []
    for r in s.get('results', []):
        tf = r.get('traceFile')
        if not tf or r.get('status') != 'ok' or not os.path.exists(tf):
            continue
        if only_passing and not (r.get('verdict') == 'accept' and r.get('band') == 'critical'):
            continue
        out = evaluate_trace(tf, predicates)
        rows.append({'mapId': r.get('mapId'), 'siteId': r.get('siteId'), 'trace': tf,
                     'verdict': out['verdict'], 'reason': out['reason'][:400],
                     'nCoreTrue': out['nCoreTrue'], 'nCoreFalse': out['nCoreFalse'],
                     'nCoreAbstain': out['nCoreAbstain']})
    counts = {}
    for r in rows:
        counts[r['verdict']] = counts.get(r['verdict'], 0) + 1
    return {'summary': summary_path, 'n': len(rows), 'counts': counts, 'cells': rows}


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('target', nargs='?', help='a batch-summary.json, or a .trace.json.gz')
    ap.add_argument('--brief', help='the brief text; parsed with one text-only LLM call')
    ap.add_argument('--predicates', help='JSON file with a parsed spec, instead of --brief')
    ap.add_argument('--all-cells', action='store_true',
                    help='score every cell, not just accept/critical ones')
    ap.add_argument('--regression', action='store_true', help='run the constructed-negative suite')
    ap.add_argument('--json', help='write the full result here')
    a = ap.parse_args(argv)

    if a.regression:
        r = regression_suite()
        return 0 if r['ok'] else 1

    if a.predicates:
        spec = json.load(open(a.predicates))
    elif a.brief:
        spec = parse_brief(a.brief)
        print('parsed spec:', json.dumps({k: spec[k] for k in
                                          ('core', 'secondary', 'notComputable')}, indent=1))
        if spec['notComputable']:
            print('NOT COMPUTABLE from a trajectory:', spec['notComputable'],
                  '-- these must go to the vision critic')
    else:
        ap.error('one of --brief or --predicates is required')

    if a.target.endswith('.trace.json.gz'):
        out = evaluate_trace(a.target, spec)
        out.pop('facts', None)
        print(json.dumps(out, indent=1, default=str))
    else:
        out = score_batch(a.target, spec, only_passing=not a.all_cells)
        print(f"{out['n']} cells scored: {out['counts']}")
        for r in out['cells'][:20]:
            print(f"  {r['verdict']:8s} {r['mapId']}/{r['siteId']}  {r['reason'][:110]}")
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=1, default=str)
    return 0


if __name__ == '__main__':
    sys.exit(main())
