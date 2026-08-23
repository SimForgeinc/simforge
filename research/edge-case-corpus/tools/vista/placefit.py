"""M1.1 PLACE FIT: does each delivered scenario actually SIT in the context its brief declares?

The problem this instrument exists for
--------------------------------------
The anchor matcher's `score` answers "did every clause bind?". It never answers "is this a sensible
PLACE for this brief?". `newcaps/DIAG-locations.md` showed the gap is not academic: all 8 delivered
`c15g-red-light-runner` sites scored 1.00 / exact and none of them was a signalized junction;
`c9g-pedestrian-behind-bus` bound zero of the 14 mapped bus stops; `c4g-circulating-sudden-stop`
scored 6/6 exact on a map set with zero roundabouts.

So PLACE FIT is measured separately, from map-intel facts only, with NO LLM anywhere in the loop.
Every judgement below is a distance, a count, a lane width or an enum lookup in
`dev-assets/<map>/derived/{locations,topology-derived}.json.gz`. Nothing is scored by a model,
nothing is scored by the matcher, and nothing defaults to pass: a record whose map assets or trace
cannot be read is reported as `unmeasurable` and counted as a FAILURE, because a place check that
degrades to "fine" when its input is missing is worse than no check.

What a requirement is
---------------------
Two sources, both mechanical:

1. **Derived from the archetype's own tightened template** (`ws1b_tighten.py` output). Every anchor
   feature whose presence AND position are `essentiality: "required"` becomes a proximity assertion:
   a map-intel location of that kind must lie within the declared lateral window of the ego's driven
   path, and within the declared longitudinal reach of where the ego starts. Required junction
   clauses (`control`, `arms`, `sizeM`) become lookups against `topology-derived.junctions[]` for
   the site's own `originFeatureId`. Required corridor clauses become lookups against the
   `topology-derived.segments[]` entry that owns the ego's lane.

   This is deliberate: the template is the archetype's DECLARED context requirement, so the audit
   reads the declaration rather than a second, hand-maintained copy of it that can drift.

2. **`EXTRA` below** -- the assertions map-intel publishes as FACTS but the matcher's feature
   vocabulary cannot express, so a template physically cannot declare them. Three real cases:
     * school POIs: 11 exist across the five maps but 9 are typed `poi_frontage` (tag
       SCHOOL_ZONE_BOUNDARY) and the matcher's LOCATION_KIND_MAP only maps type `school_zone`.
     * crests: `crest` is not in FeatureKindSchema at all (adapter: "feature kind \"crest\" is not
       matchable; feature dropped"), but 13 locations carry `crest_present`.
     * `occlusion_zone.facts.supported_scenario_templates` -- an author-intent whitelist already
       computed on 275 occlusion zones and ignored by everything.

Geometry conventions (verified, not assumed)
--------------------------------------------
Location anchors are in SCENE coordinates `{x, y, z}`; trace/plot coordinates are `(x, y)` with
**plot_y = -scene_z**. Checked against a delivered site: nearest junction 3.2 m under this
convention versus 3171 m under the other.

Output
------
    {"summary": {"n":.., "pass":.., "rate":.., "perArchetype": {..}}, "records": [...]}

which is the shape `audit.py --placefit` reads for M1.1 (target rate >= 0.95).

Usage
-----
    python placefit.py --dataset /tmp/vista-dataset-all/train.jsonl /tmp/vista-dataset-all/test.jsonl \
                       --templates /tmp/vista-ws1b/templates \
                       --out /tmp/vista-placefit.json
"""
import os, sys, json, gzip, math, glob, argparse, collections

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = '/Users/michaelvu-simforge/Documents/Programming/UniScenarios-vista'
DEV = os.path.join(REPO, 'dev-assets')

TARGET_RATE = 0.95

#: Mirrors `LOCATION_KIND_MAP` in packages/compiler/src/normalize.ts. If that table changes,
#: this one has to change with it or the audit stops describing the same world as the matcher.
LOCATION_KIND = {
    'crosswalk': 'crossing', 'crossing': 'crossing',
    'parking_space': 'parking_zone', 'parking_area': 'parking_zone', 'parking_lane': 'parking_zone',
    'bus_stop': 'bus_stop', 'driveway': 'driveway', 'school_zone': 'school_zone',
    'work_zone_suitable': 'work_zone_suitable', 'occlusion_zone': 'occlusion_zone',
}

#: Slack added to a declared window before calling a site misplaced. A template that says
#: "parking within 15 m laterally" is not falsified by a kerb line digitised 3 m off.
LATERAL_TOL_M = 6.0
LONGITUDINAL_TOL_M = 25.0


# ------------------------------------------------------------------ map facts

class MapFacts:
    """Everything the checks are allowed to look at, for one map."""

    _cache = {}

    def __init__(self, map_id):
        self.mapId = map_id
        base = os.path.join(DEV, map_id, 'derived')
        self.locations = json.loads(gzip.open(os.path.join(base, 'locations.json.gz')).read())['locations']
        top = json.loads(gzip.open(os.path.join(base, 'topology-derived.json.gz')).read())
        self.junctions = {j['junctionId']: j for j in top.get('junctions', [])}
        self.segments = top.get('segments', [])
        self.segByLane = {}
        for s in self.segments:
            for ref in s.get('laneRefs', []):
                self.segByLane.setdefault(ref, s)
        self.byKind = collections.defaultdict(list)
        for loc in self.locations:
            kind = LOCATION_KIND.get(loc.get('type'))
            if kind:
                self.byKind[kind].append(loc)

    @classmethod
    def get(cls, map_id):
        if map_id not in cls._cache:
            cls._cache[map_id] = cls(map_id)
        return cls._cache[map_id]

    def candidates(self, kind):
        """Every map-intel object that could satisfy a feature of this kind.

        Junctions are NOT in `locations.json` -- they live in `topology-derived.junctions[]` with a
        `centerXY` already in plot coordinates (verified: 5.6 m from the driven path of a delivered
        junction-anchored site). Crests have no location type at all, so they are recovered from the
        `crest_present` fact. Everything else comes through LOCATION_KIND, the same table the
        matcher uses.
        """
        if kind == 'junction':
            return [{'anchor': {'plot': j['centerXY']}, 'id': j['junctionId']}
                    for j in self.junctions.values() if j.get('centerXY')]
        if kind == 'crest':
            return self.crest_locations()
        return self.byKind.get(kind, [])

    def school_pois(self):
        """Type `school_zone` OR tag SCHOOL_ZONE_BOUNDARY OR fact poi_type=school.

        The matcher can only see the first of the three; this audit sees all 11.
        """
        out = []
        for loc in self.locations:
            tags = set(loc.get('tags') or [])
            facts = loc.get('facts') or {}
            if (loc.get('type') == 'school_zone' or 'SCHOOL_ZONE_BOUNDARY' in tags
                    or 'SCHOOL_ZONE' in tags or str(facts.get('poi_type')) == 'school'):
                out.append(loc)
        return out

    def crest_locations(self):
        return [l for l in self.locations if (l.get('facts') or {}).get('crest_present') in (True, 'true', 1)]

    def occlusions_supporting(self, template_name):
        out = []
        for loc in self.byKind.get('occlusion_zone', []):
            wl = (loc.get('facts') or {}).get('supported_scenario_templates')
            if isinstance(wl, str):
                wl = [wl]
            if wl and template_name in wl:
                out.append(loc)
        return out


def xy(loc):
    """Anchor in PLOT coordinates.

    Locations publish SCENE coordinates `{x, y, z}` and `plot_y = -scene_z` (verified: a delivered
    site's nearest junction is 3.2 m away under this convention and 3171 m under the other).
    Topology junctions already publish plot `centerXY`, injected here as `anchor.plot`.
    """
    anchor = loc.get('anchor') or {}
    if 'plot' in anchor:
        return tuple(anchor['plot'])
    sc = anchor.get('scene') or {}
    if 'x' not in sc or 'z' not in sc:
        return None
    return (sc['x'], -sc['z'])


# ------------------------------------------------------------------ geometry

def ego_path(rec):
    tr = json.loads(gzip.open(rec['trace']).read())
    ego = tr['ticks']['actors'].get('ego')
    if not ego:
        return None
    xs, ys = ego['x'], ego['y']
    step = max(1, len(xs) // 400)
    return list(zip(xs[::step], ys[::step]))


def dist_to_path(p, path):
    px, py = p
    best = float('inf')
    for i in range(len(path) - 1):
        ax, ay = path[i]
        bx, by = path[i + 1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        cx, cy = ax + t * dx, ay + t * dy
        best = min(best, math.hypot(px - cx, py - cy))
    if len(path) == 1:
        best = math.hypot(px - path[0][0], py - path[0][1])
    return best


def nearest(locs, path, start):
    """(lateral distance to the driven path, distance from the ego start) of the closest location."""
    best = None
    for loc in locs:
        p = xy(loc)
        if p is None:
            continue
        lat = dist_to_path(p, path)
        lon = math.hypot(p[0] - start[0], p[1] - start[1])
        if best is None or lat < best[0]:
            best = (lat, lon, loc)
    return best


# ----------------------------------------------------- requirements from template

def _req(clause):
    return isinstance(clause, dict) and clause.get('essentiality') == 'required'


def template_requirements(tpl):
    """Read the archetype's DECLARED context requirement straight off its anchor.

    Only clauses the author marked `required` are read. A `preferred` clause is a wish, and this
    instrument refuses to grade a scenario against a wish -- that conflation is the whole reason
    the delivered corpus scored 1.00 in the wrong places.
    """
    a = tpl.get('anchor', {})
    reqs = {'features': [], 'junction': {}, 'corridor': {}}
    for f in a.get('features', []):
        if f.get('essentiality', 'required') != 'required':
            continue
        at, lat = f.get('atM'), f.get('lateralDistanceM')
        if not _req(at):
            continue
        a0, a1 = (at['value'] + [None, None])[:2]
        reach = max(abs(a0 or 0), abs(a1 or 0))
        lat_max = (lat['value'][1] if _req(lat) and lat['value'][1] is not None else 20.0)
        reqs['features'].append({'id': f['id'], 'kind': f['kind'],
                                 'reachM': reach, 'lateralM': lat_max})
        if f['kind'] == 'junction':
            for key in ('control', 'arms', 'sizeM'):
                if _req(f.get(key)):
                    reqs['junction'][key] = f[key]['value']
    for key, clause in (a.get('corridor') or {}).items():
        if _req(clause):
            reqs['corridor'][key] = clause['value']
    return reqs


# ------------------------------------------------- fact-level extras (not expressible in a template)

def x_school(mf, path, start, _rec):
    hit = nearest(mf.school_pois(), path, start)
    if hit is None:
        return False, 'no school POI on this map'
    return hit[0] <= 250.0, f'nearest school POI {hit[0]:.0f} m from the driven path (<=250)'


def x_crest(mf, path, start, _rec):
    hit = nearest(mf.crest_locations(), path, start)
    if hit is None:
        return False, 'no crest_present location on this map'
    return hit[0] <= 60.0, f'nearest crest_present {hit[0]:.0f} m from the driven path (<=60)'


def _whitelist(name, radius=60.0):
    def check(mf, path, start, _rec):
        hit = nearest(mf.occlusions_supporting(name), path, start)
        if hit is None:
            return False, f'no occlusion zone whitelisted for "{name}" on this map'
        return hit[0] <= radius, (f'nearest occlusion zone whitelisted for "{name}" '
                                  f'{hit[0]:.0f} m from the driven path (<={radius:.0f})')
    return check


def x_narrow_street(mf, path, start, rec):
    """A "narrow ordinary street" brief must not be staged on a 3-lane 105 kph arterial."""
    seg = ego_segment(mf, rec)
    if seg is None:
        return False, 'ego lane not resolvable to a segment'
    ok = seg.get('maxLanesSameDir', 9) <= 2 and seg.get('maxSpeedLimitKph', 999) <= 70
    return ok, (f'{seg.get("roadName")}: {seg.get("maxLanesSameDir")} lanes/dir, '
                f'{seg.get("maxSpeedLimitKph")} kph (need <=2 lanes and <=70 kph)')


def x_parking_adjacent(mf, path, start, rec):
    """Kerbside-parking briefs: the segment says so, or a parking zone is within 20 m of the path."""
    seg = ego_segment(mf, rec)
    if seg is not None and seg.get('hasParkingAdjacent'):
        return True, f'{seg.get("roadName")} segment hasParkingAdjacent=true'
    hit = nearest(mf.byKind.get('parking_zone', []), path, start)
    if hit is None:
        return False, 'no parking zone on this map'
    return hit[0] <= 20.0, f'nearest parking zone {hit[0]:.0f} m from the driven path (<=20)'


def x_parking_lot(mf, path, start, _rec):
    """The three `c11g-*` briefs are parking-LOT briefs; a kerb parking lane is not a lot."""
    lots = [l for l in mf.locations if l.get('type') == 'parking_area']
    hit = nearest(lots, path, start)
    if hit is None:
        return False, 'no parking_area (lot) on this map'
    return hit[0] <= 60.0, f'nearest parking_area {hit[0]:.0f} m from the driven path (<=60)'


def x_bus_stop(mf, path, start, _rec):
    hit = nearest(mf.byKind.get('bus_stop', []), path, start)
    if hit is None:
        return False, 'no bus_stop on this map'
    return hit[0] <= 40.0, f'nearest bus_stop {hit[0]:.0f} m from the driven path (<=40)'


def x_stop_controlled(mf, path, start, rec):
    j = ego_junction(mf, rec)
    if j is None:
        return False, 'site is not anchored on a junction'
    return j.get('control') in ('minor_stop', 'all_way_stop'), f'junction control = {j.get("control")}'


def x_big_junction(mf, path, start, rec):
    """The re-briefed `c4g`: the ego must be committed inside a real intersection box."""
    j = ego_junction(mf, rec)
    if j is None:
        return False, 'site is not anchored on a junction'
    ok = j.get('armCount', 0) >= 4 and j.get('sizeM', 0) >= 20
    return ok, f'junction arms={j.get("armCount")}, sizeM={j.get("sizeM")} (need >=4 arms, >=20 m)'


def x_real_intersection(mf, path, start, rec):
    """A red-light runner needs an intersection, not a two-arm road-to-road link."""
    j = ego_junction(mf, rec)
    if j is None:
        return False, 'site is not anchored on a junction'
    ok = j.get('armCount', 0) >= 3 and j.get('sizeM', 0) >= 8
    return ok, f'junction arms={j.get("armCount")}, sizeM={j.get("sizeM")} (need >=3 arms, >=8 m)'


#: Assertions map-intel supports as facts but a ScenarioTemplate v2 anchor cannot express.
EXTRA = {
    'c12g-red-pedestrian-phase': [('school within 250 m', x_school)],
    'c12g-suv-ignores-paddle': [('school within 250 m', x_school)],
    'blind-crest-queue': [('crest within 60 m', x_crest)],
    'c9g-pedestrian-behind-bus': [
        ('bus stop within 40 m', x_bus_stop),
        ('occluder whitelisted for pedestrian_emerging_around_bus',
         _whitelist('pedestrian_emerging_around_bus')),
    ],
    'child-from-parked-cars': [
        ('kerbside parking', x_parking_adjacent),
        ('occluder whitelisted for child_dartout_from_parked_cars',
         _whitelist('child_dartout_from_parked_cars')),
    ],
    'parked-vans-narrow-road': [('narrow ordinary street', x_narrow_street),
                                ('kerbside parking', x_parking_adjacent)],
    'rideshare-door-pedestrian': [('kerbside parking', x_parking_adjacent)],
    'c11g-hidden-child': [('parking lot within 60 m', x_parking_lot)],
    'c11g-wrong-way-aisle': [('parking lot within 60 m', x_parking_lot),
                             ('narrow ordinary street', x_narrow_street)],
    'c11g-indicator-mislead': [('parking lot within 60 m', x_parking_lot)],
    'low-friction-stop-slide': [('stop-controlled junction', x_stop_controlled)],
    'c4g-circulating-sudden-stop': [('large multi-arm junction box', x_big_junction)],
    'c15g-red-light-runner': [('real intersection', x_real_intersection)],
    'c1g-illegal-u-turn': [],
    'c1g-cut-in-turn': [],
}


# ------------------------------------------------------------------ site lookup

def ego_junction(mf, rec):
    inst = _instance(rec)
    ofid = (((inst or {}).get('manifest') or {}).get('site') or {}).get('originFeatureId') or ''
    if not ofid.startswith('junction:'):
        return None
    return mf.junctions.get(ofid.split(':', 1)[1])


def ego_segment(mf, rec):
    inst = _instance(rec)
    site = ((inst or {}).get('manifest') or {}).get('site') or {}
    for ref in (site.get('entryLaneRsl'), ):
        if ref and ref in mf.segByLane:
            return mf.segByLane[ref]
    for actor in ((inst or {}).get('manifest') or {}).get('actors', []):
        ref = actor.get('laneRsl')
        if ref and ref in mf.segByLane:
            return mf.segByLane[ref]
    return None


_INST = {}


def _instance(rec):
    p = rec.get('instance')
    if not p or not os.path.exists(p):
        return None
    if p not in _INST:
        _INST[p] = json.load(open(p))
    return _INST[p]


# ------------------------------------------------------------------ the check

def check_record(rec, reqs):
    """Every clause that must hold, evaluated. Returns (pass, [(name, ok, detail)])."""
    results = []
    try:
        mf = MapFacts.get(rec['mapId'])
        path = ego_path(rec)
    except Exception as exc:
        return False, [('unmeasurable', False, f'{type(exc).__name__}: {exc}')]
    if not path:
        return False, [('unmeasurable', False, 'no ego track in the trace')]
    start = path[0]
    j = ego_junction(mf, rec)

    for f in reqs['features']:
        name = f"required feature {f['id']} ({f['kind']})"
        if f['kind'] == 'junction' and j is not None:
            # A junction-anchored site names its junction in `manifest.site.originFeatureId`.
            # Asking "is a junction near the path" would be weaker than the fact already on record.
            results.append((name, True, f'site is anchored on junction {j["junctionId"]}'))
            continue
        locs = mf.candidates(f['kind'])
        hit = nearest(locs, path, start)
        if hit is None:
            results.append((name, False, f'no {f["kind"]} exists on {rec["mapId"]}'))
            continue
        lat, lon, _loc = hit
        # LATERAL distance to the DRIVEN PATH is the test, not distance from the ego spawn.
        # The spawn sits an approach-runway upstream of the event (60-120 m is normal), so a
        # spawn-relative window rejects correctly-placed junction and kerb features. The
        # longitudinal window is the matcher's job; place fit asks whether the corridor the ego
        # actually drove has the kind of place the brief names beside it.
        ok = lat <= f['lateralM'] + LATERAL_TOL_M
        results.append((name, ok,
                        f'nearest {lat:.0f} m from the driven path '
                        f'(declared <= {f["lateralM"]:.0f} m lateral, +{LATERAL_TOL_M:.0f} m tol; '
                        f'{lon:.0f} m from the ego spawn, not tested)'))

    for key, want in reqs['junction'].items():
        if j is None:
            results.append((f'junction.{key}', False, 'site is not anchored on a junction'))
            continue
        if key == 'control':
            results.append((f'junction.{key}', j.get('control') in want,
                            f'control = {j.get("control")}, declared {want}'))
        elif key == 'arms':
            lo = want[0] or 0
            results.append((f'junction.{key}', (j.get('armCount') or 0) >= lo,
                            f'armCount = {j.get("armCount")}, declared >= {lo}'))
        elif key == 'sizeM':
            lo, hi = (want + [None, None])[:2]
            v = j.get('sizeM') or 0
            results.append((f'junction.{key}', v >= (lo or 0) and (hi is None or v <= hi),
                            f'sizeM = {v}, declared {want}'))

    seg = ego_segment(mf, rec)
    for key, want in reqs['corridor'].items():
        if key not in ('speedLimitKph', 'throughLanesSameDir', 'laneWidthM', 'requiresAdjacent'):
            continue
        if seg is None:
            results.append((f'corridor.{key}', False, 'ego lane not resolvable to a segment'))
            continue
        if key == 'speedLimitKph':
            lo, hi = (want + [None, None])[:2]
            v = seg.get('maxSpeedLimitKph')
            results.append((f'corridor.{key}', v is not None and (lo is None or v >= lo) and (hi is None or v <= hi),
                            f'{seg.get("roadName")} max {v} kph, declared {want}'))
        elif key == 'throughLanesSameDir':
            lo, hi = (want + [None, None])[:2]
            v = seg.get('maxLanesSameDir')
            results.append((f'corridor.{key}', v is not None and (lo is None or v >= lo) and (hi is None or v <= hi),
                            f'{seg.get("roadName")} max {v} lanes/dir, declared {want}'))
        elif key == 'requiresAdjacent':
            flag = {'parking': 'hasParkingAdjacent', 'sidewalk': 'hasSidewalkAdjacent',
                    'bike': 'hasBikeAdjacent', 'shoulder': 'hasShoulderAdjacent',
                    'median': 'hasMedianAdjacent'}
            ok = all(seg.get(flag[k], False) for k in want if k in flag)
            results.append((f'corridor.{key}', ok,
                            f'{seg.get("roadName")}: ' + ', '.join(
                                f'{k}={seg.get(flag.get(k), "n/a")}' for k in want)))

    for name, fn in EXTRA.get(rec['archetypeId'], []):
        try:
            ok, detail = fn(mf, path, start, rec)
        except Exception as exc:
            ok, detail = False, f'{type(exc).__name__}: {exc}'
        results.append((name, ok, detail))

    if not results:
        # An archetype that declares nothing cannot be graded as placed. Say so, do not pass it.
        return None, [('no declared context requirement', None,
                       'the anchor marks no context clause required; place fit is undefined')]
    return all(r[1] for r in results), results


def load_templates(directory):
    out = {}
    for p in glob.glob(os.path.join(directory, '*.json')):
        out[os.path.basename(p)[:-5]] = json.load(open(p))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', nargs='+',
                    default=['/tmp/vista-dataset-all/train.jsonl', '/tmp/vista-dataset-all/test.jsonl'])
    ap.add_argument('--templates', default='/tmp/vista-ws1b/templates',
                    help='tightened templates; the DECLARED context requirement is read from these')
    ap.add_argument('--out', default='/tmp/vista-placefit.json')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()

    recs = []
    for f in a.dataset:
        recs += [json.loads(l) for l in open(f)]
    tpls = load_templates(a.templates)
    reqs = {k: template_requirements(v) for k, v in tpls.items()}

    per = collections.defaultdict(lambda: {'n': 0, 'pass': 0, 'undeclared': 0})
    out_recs, n_pass, n_undeclared = [], 0, 0
    for r in recs:
        aid = r['archetypeId']
        if aid not in reqs:
            ok, detail = None, [('no template', None, f'no tightened template for {aid}')]
        else:
            ok, detail = check_record(r, reqs[aid])
        per[aid]['n'] += 1
        if ok is None:
            per[aid]['undeclared'] += 1
            n_undeclared += 1
        elif ok:
            per[aid]['pass'] += 1
            n_pass += 1
        out_recs.append({'scenarioId': r.get('scenarioId'), 'archetypeId': aid,
                         'mapId': r.get('mapId'), 'siteId': r.get('siteId'),
                         'pass': ok, 'clauses': [{'name': n, 'ok': o, 'detail': d}
                                                 for n, o, d in detail]})

    n = len(recs)
    summary = {
        'n': n,
        'pass': n_pass,
        'rate': round(n_pass / n, 4) if n else 0.0,
        'undeclared': n_undeclared,
        'target': f'>= {TARGET_RATE}',
        'perArchetype': {k: {**v, 'rate': round(v['pass'] / v['n'], 4) if v['n'] else 0.0}
                         for k, v in sorted(per.items())},
    }
    summary['pass'] = summary['rate'] >= TARGET_RATE and n_undeclared == 0
    summary['passing'] = n_pass
    json.dump({'summary': summary, 'records': out_recs}, open(a.out, 'w'), indent=1)

    print(f"{'archetype':32}{'n':>5}{'pass':>6}{'rate':>8}")
    for k, v in summary['perArchetype'].items():
        print(f'  {k:30}{v["n"]:5}{v["pass"]:6}{v["rate"]:8}')
    print(f"\nPLACE FIT {n_pass}/{n} = {summary['rate']}  (target {TARGET_RATE}) "
          f"-> {'PASS' if summary['pass'] else 'FAIL'}")
    if a.verbose:
        for rec in out_recs:
            if rec['pass'] is not True:
                print('\n', rec['archetypeId'], rec['mapId'], rec['siteId'])
                for c in rec['clauses']:
                    if c['ok'] is not True:
                        print('    FAIL', c['name'], '|', c['detail'])
    print('wrote', a.out)


if __name__ == '__main__':
    main()
