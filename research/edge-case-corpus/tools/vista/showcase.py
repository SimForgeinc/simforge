"""Ego-centric showcase renders: one PNG per scenario, built for a human to evaluate.

Differs from the critic renders: this is for a person, not a model. Bigger panels, the ego always
centred and prominently marked, a title carrying the brief text, and a caption with the measured
physics (clearance, minTTC, what the ego actually did) so the picture can be checked against numbers.
"""
import os, sys, json, math, argparse, gzip
os.environ.pop('MPLBACKEND', None)
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MPoly

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gate, motion, scene

DEV = '/Users/michaelvu-simforge/Documents/Programming/SimForge-vista/dev-assets'


def _wrap(s, n=104):
    out, line = [], ''
    for w in str(s).split():
        if len(line) + len(w) + 1 > n:
            out.append(line); line = w
        else:
            line = (line + ' ' + w).strip()
    if line:
        out.append(line)
    return '\n'.join(out)


def showcase(trace_path, brief, out, title=None, n=8, closest_t=None):
    with gzip.open(trace_path) as f:
        tr = json.loads(f.read())
    ts = tr['ticks']['t']
    mapid = tr['header']['mapId']
    facts = gate.trace_facts(tr)
    ego_f = motion.ego_facts(tr)
    ct = closest_t if closest_t is not None else facts.get('closestT')

    picks = sorted(set([0.0] + [ts[-1] * k / (n - 2) for k in range(1, n - 1)]
                       + ([ct] if ct is not None else []) + [ts[-1]]))[:n]
    idx = [min(range(len(ts)), key=lambda j: abs(ts[j] - p)) for p in picks]

    cols = 4
    rows = (len(idx) + cols - 1) // cols
    fig, axs = plt.subplots(rows, cols, figsize=(5.6 * cols, 5.6 * rows), dpi=100)
    axs = axs.ravel() if hasattr(axs, 'ravel') else [axs]
    for k, i in enumerate(idx):
        b = scene.boxes_from_trace(tr, i)
        ego = next((q for q in b if q['id'] == 'ego'), None)
        cx, cy = (ego['x'], ego['y']) if ego else (b[0]['x'], b[0]['y'])
        # zoom to fit the ego and its nearest challenger, floored so a pedestrian is visible
        d = [math.hypot(q['x'] - cx, q['y'] - cy) for q in b if q['id'] != 'ego']
        span = max(18.0, min(55.0, (min(d) if d else 25.0) * 1.9))
        tag = '   <<< CLOSEST APPROACH' if ct is not None and abs(ts[i] - ct) < 1e-6 else ''
        scene._panel(axs[k], DEV, mapid, b, cx, cy, span,
                     f"t = {ts[i]:5.2f} s   ego {ego['speed']*3.6:4.0f} kph{tag}")
        if ego:   # ring the ego so a human can find it instantly
            axs[k].scatter([ego['x']], [ego['y']], s=1500, facecolors='none',
                           edgecolors='#3aa0ff', linewidths=2.2, zorder=9, clip_on=True)
    for k in range(len(idx), len(axs)):
        axs[k].axis('off')

    cap = (f"map {mapid}   |   closest approach {facts['clearanceM']} m to '{facts['closestWith']}' "
           f"at t={facts['closestT']} s   |   minTTC {facts['minTTC']} s   |   "
           f"ego braked {ego_f['peakDecelMps2']} m/s^2, speed {ego_f['minSpeedMps']*3.6:.0f}"
           f"-{ego_f['maxSpeedMps']*3.6:.0f} kph\n"
           f"EGO = blue, ringed.  challengers = red.  props = yellow.  "
           f"grey = drivable, brown = junction, green = sidewalk, purple = parking.")
    fig.suptitle(_wrap(title or brief) + '\n\n' + cap, color='white', fontsize=13, y=0.995)
    fig.patch.set_facecolor('#171717')
    fig.tight_layout(rect=[0, 0, 1, 0.93])
    fig.savefig(out, facecolor='#171717')
    plt.close(fig)
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--harvest', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--per-template', type=int, default=2)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    H = json.load(open(a.harvest))
    made = []
    for r in H['rows']:
        sc = (r.get('scenarios') or [])[:a.per_template]
        for j, c in enumerate(sc):
            png = f"{a.out}/{r['briefId']}--{j}.png"
            try:
                showcase(c['traceFile'], r['brief'], png,
                         title=f"[{r.get('category','')}] {r['brief']}", closest_t=c.get('closestT'))
                made.append({'briefId': r['briefId'], 'brief': r['brief'],
                             'category': r.get('category'), 'png': png,
                             'mapId': c['mapId'], 'siteId': c['siteId'],
                             'clearanceM': c['clearanceM'], 'minTTC': c['minTTC']})
                print('  rendered', os.path.basename(png), flush=True)
            except Exception as e:                                # noqa: BLE001
                print('  FAILED', r['briefId'], e, flush=True)
    json.dump(made, open(a.out + '/INDEX.json', 'w'), indent=1)
    print(f'\n{len(made)} showcase renders -> {a.out}')
