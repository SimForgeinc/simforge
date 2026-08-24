"""M1.4 instrument: does this scenario happen in a PLAUSIBLE PLACE?

Deliberately separate from critic.py, which asks whether the named MECHANISM is present. This asks
only about the setting. It renders a WIDE-AREA context view (the neighbourhood, not the ego's
bumper), because plausibility of a location is a question about surroundings.

Blind by construction: the judge is shown the picture and the brief, never the archetype id, the site
score, the match verdict, or which corpus a scenario came from.
"""
import os, sys, json, gzip, argparse, random
os.environ.pop('MPLBACKEND', None)   # the caller's inline backend must not leak into this process
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scene, vlm, gate

DEV = '/Users/michaelvu-simforge/Documents/Programming/SimForge-vista/dev-assets'

PROMPT = """You are auditing a driving-scenario dataset for SETTING PLAUSIBILITY only.

The brief describes something that is supposed to happen. The image is a top-down view of the PLACE it
was staged, drawn from the actual road network. Blue ringed = ego. Red = other road users.
Grey = drivable road, brown = junction, green = sidewalk, purple = parking.
White X = marked crosswalk. Yellow square = bus stop. Small blue dots = building entrances, which
indicate where buildings and therefore pedestrians actually are. Absence of blue dots means an area
with no buildings fronting the road.

BRIEF: "{brief}"

Ignore whether the manoeuvre itself is well executed, whether anyone brakes, and whether it looks
dangerous. Judge ONLY this: is this a sensible, realistic PLACE for the situation in the brief?

Ask yourself what the brief REQUIRES of a location. Examples of the reasoning wanted:
 - a school-bus or schoolchild brief needs a school zone or a plausible residential street, not an
   isolated industrial slip road
 - a parking brief needs an actual parking aisle or lot, not a through road
 - a roundabout brief needs a roundabout
 - a signalised-junction brief needs a real junction of the right shape
 - a "car door opens into traffic" brief needs kerbside parking next to a live lane
 - a pedestrian brief needs somewhere a pedestrian would credibly be: a crossing, a sidewalk, a shop
   frontage. Not the middle of a motorway slip road.

Answer STRICT JSON, one object, no prose outside it:
{{"plausible": true|false,
  "requiredContext": "<what the brief needs of a place, one short phrase>",
  "observed": "<what the image actually shows, one short phrase>",
  "reason": "<=25 words"}}"""


LOC_CACHE = '/tmp/vista-locations-cache.json'
# map-intel sceneAnchor is (x, y, z) with scene z = -plot_y. Verified against a known ego position:
# nearest junction 3.2 m under this convention vs 3171 m under the other.
_LOC = None
_MARK = {'crosswalk': ('#f2f2f2', 'X', 'crosswalk'), 'bus_stop': ('#ffd24a', 's', 'bus stop'),
         'building_entrance': ('#9fd4ff', '.', 'building entrance')}


def _landmarks(mapid, cx, cy, span):
    global _LOC
    if _LOC is None:
        _LOC = json.load(open(LOC_CACHE)) if os.path.exists(LOC_CACHE) else {}
    out = []
    for x in _LOC.get(mapid, []):
        px, py = x['x'], -x['z']
        if abs(px - cx) <= span and abs(py - cy) <= span:
            out.append((px, py, x))
    return out


def _draw_landmarks(ax, mapid, cx, cy, span):
    seen = set()
    for px, py, x in _landmarks(mapid, cx, cy, span):
        st = _MARK.get(x['type'])
        if not st:
            continue
        col, mk, lab = st
        ax.scatter([px], [py], c=col, marker=mk, s=44 if mk != '.' else 12,
                   zorder=7, edgecolors='black', linewidths=0.4)
        if x['type'] in ('crosswalk', 'bus_stop') and x['type'] not in seen:
            ax.annotate(lab, (px, py), color=col, fontsize=7, zorder=8,
                        xytext=(4, 4), textcoords='offset points')
            seen.add(x['type'])


def render_context(trace_path, out_png, span_m=95, t_frac=0.5):
    with gzip.open(trace_path) as f:
        tr = json.loads(f.read())
    ts = tr['ticks']['t']
    facts = gate.trace_facts(tr)
    ct = facts.get('closestT')
    i = min(range(len(ts)), key=lambda k: abs(ts[k] - ct)) if ct is not None else int(len(ts) * t_frac)
    b = scene.boxes_from_trace(tr, i)
    ego = next((q for q in b if q['id'] == 'ego'), b[0])
    fig, ax = plt.subplots(figsize=(7.6, 7.6), dpi=115)
    scene._panel(ax, DEV, tr['header']['mapId'], b, ego['x'], ego['y'], span_m,
                 'context view', grid_m=20)
    _draw_landmarks(ax, tr['header']['mapId'], ego['x'], ego['y'], span_m)
    fig.patch.set_facecolor('#171717')
    fig.tight_layout()
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    fig.savefig(out_png, facecolor='#171717')
    plt.close(fig)
    return out_png


def judge(trace_path, brief, workdir, tag):
    png = render_context(trace_path, os.path.join(workdir, f'{tag}.png'))
    raw = vlm.ask(PROMPT.format(brief=brief), images=[png])
    d = vlm.parse_json(raw)
    if isinstance(d, list):
        d = d[0] if d else {}
    return {'plausible': bool(d.get('plausible')), 'requiredContext': d.get('requiredContext'),
            'observed': d.get('observed'), 'reason': d.get('reason'), 'png': png}


def _one(job):
    rec, workdir = job
    tag = f"{rec['scenarioId']}"
    try:
        r = judge(rec['trace'], rec['brief'], workdir, tag)
        print(f"  {'OK  ' if r['plausible'] else 'BAD '} {rec['archetypeId'][:28]:28} {r['reason']}", flush=True)
        return {**{k: rec[k] for k in ('scenarioId', 'archetypeId', 'mapId', 'siteId')}, **r}
    except Exception as e:                                              # noqa: BLE001
        print(f"  ERR  {rec['archetypeId']}: {e}", flush=True)
        return None


if __name__ == '__main__':
    from concurrent.futures import ThreadPoolExecutor
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', nargs='+', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--per-archetype', type=int, default=4)
    ap.add_argument('--workers', type=int, default=5)
    ap.add_argument('--seed', type=int, default=17)
    ap.add_argument('--shuffle-briefs', action='store_true',
                    help='NEGATIVE CONTROL: judge each scene against a brief from a DIFFERENT '
                         'archetype. A useful instrument must say "implausible" far more often here '
                         'than on real pairs; if it does not, it is not discriminating and its '
                         'positive rate means nothing.')
    a = ap.parse_args()
    recs = []
    for f in a.dataset:
        recs += [json.loads(l) for l in open(f)]
    by = {}
    for r in recs:
        by.setdefault(r['archetypeId'], []).append(r)
    rng = random.Random(a.seed)
    sample = []
    for k in sorted(by):
        rs = by[k][:]
        rng.shuffle(rs)
        sample += rs[:a.per_archetype]
    if a.shuffle_briefs:
        pool = sorted({(r['archetypeId'], r['brief']) for r in recs})
        shuffled = []
        for r in sample:
            alt = [b for k, b in pool if k != r['archetypeId']]
            r = dict(r, brief=rng.choice(alt), _trueArchetype=r['archetypeId'])
            shuffled.append(r)
        sample = shuffled
    os.makedirs(a.out, exist_ok=True)
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        out = [x for x in ex.map(_one, [(r, a.out) for r in sample]) if x]
    n = len(out)
    ok = sum(1 for x in out if x['plausible'])
    per = {}
    for x in out:
        per.setdefault(x['archetypeId'], []).append(x['plausible'])
    summary = {'n': n, 'plausible': ok, 'rate': round(ok / max(n, 1), 4),
               'perArchetype': {k: f'{sum(v)}/{len(v)}' for k, v in sorted(per.items())}}
    json.dump({'summary': summary, 'judgements': out}, open(os.path.join(a.out, 'PLAUSIBILITY.json'), 'w'), indent=1)
    print('\n' + json.dumps(summary, indent=1))
