"""WS-1b probe: how many sites does a minimal anchor with ONE required feature kind find?

Answers the only question that matters before tightening: is the semantic class the brief names
actually reachable by the matcher on these maps, and at what yield. Writes JSON so the answer
survives the agent.
"""
import os, sys, json, copy, argparse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import author

TPL = {
 "scenarioVersion": 2,
 "meta": {"name": "probe", "description": "probe", "createdAt": "2026-08-01T00:00:00.000Z",
          "modifiedAt": "2026-08-01T00:00:00.000Z", "appVersion": "simforge/0.0.1",
          "archetype": "C1.car-following", "tags": ["probe"], "author": "agent/ws1b",
          "negativeControl": False},
 "params": {"declarations": [], "constraints": []},
 "environment": {"weather": "clear", "timeOfDay": "noon"},
 "anchor": {"id": "probe", "corridor": {}, "features": [],
            "policy": {"allowMirror": True, "maxSitesPerMap": 400, "diversity": "off",
                       "minScore": 0.0}},
 "roles": [{"id": "ego", "kind": "on_reference", "label": "ego", "essentiality": "required",
            "actor": {"class": "car", "catalogId": "vehicle.sedan"},
            "pose": {"laneOffset": 0, "s": 0, "tFrac": 0, "headingOffsetRad": 0},
            "initialSpeedKph": 40}],
 "props": [], "choreography": {"clipSeconds": 8, "warmupSeconds": 0.5, "interactions": []},
 "invariants": [], "variants": [], "metricSubject": "ego",
}


def probe(feature, corridor=None, path='/tmp/vista-ws1b/probe.json', maxsites=400):
    t = copy.deepcopy(TPL)
    if corridor:
        t['anchor']['corridor'] = corridor
    t['anchor']['features'] = [feature] if isinstance(feature, dict) else list(feature)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(t, open(path, 'w'), indent=1)
    rc, v, _ = author.run_cli(['template', 'validate', path])
    drops = [n.get('reason') for n in (v.get('adapterNotes') or v.get('notes') or [])] if isinstance(v, dict) else []
    rc2, d, err = author.run_cli(['sites', 'match', path, '--all-maps', '--max-sites', str(maxsites)])
    if rc2 != 0:
        return {'error': (d or {}).get('code') or err[-300:], 'sites': 0, 'drops': drops}
    per = {}
    ex = de = 0
    for m in d.get('maps', []):
        vd = m.get('verdicts') or {}
        per[m.get('mapId')] = m.get('siteCount', len(m.get('sites', [])))
        ex += int(vd.get('exact', 0)); de += int(vd.get('degraded', 0))
    return {'sites': d.get('totalSites', 0), 'exact': ex, 'degraded': de,
            'perMap': per, 'drops': drops}


def simple(kind, at=(10, 60), lat=(0, 15), same=True):
    f = {'id': f'probe-{kind}', 'kind': kind, 'essentiality': 'required',
         'atM': {'value': list(at), 'essentiality': 'required'},
         'lateralDistanceM': {'value': list(lat), 'essentiality': 'required'}}
    if same:
        f['sameRoad'] = {'value': True, 'essentiality': 'required'}
    return f


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/tmp/vista-ws1b/probe-kinds.json')
    a = ap.parse_args()
    res = {}
    for kind in ['parking_zone', 'bus_stop', 'school_zone', 'occlusion_zone', 'driveway',
                 'crossing', 'work_zone_suitable', 'crest', 'junction']:
        for same in (True, False):
            key = f'{kind}{"" if same else " (any road)"}'
            res[key] = probe(simple(kind, same=same))
            print(key, json.dumps(res[key]))
    json.dump(res, open(a.out, 'w'), indent=1)
    print('wrote', a.out)
