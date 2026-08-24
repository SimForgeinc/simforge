"""Export an ego-centric MP4 per scenario.

The repo's own scripts/render-trace.mjs is hash-verified and deterministic, but it draws actors on a
bare grid with no road network, which is not enough to judge a driving scenario. This reuses the
vista renderer (drivable surface, junction surface, sidewalks, parking, real lane widths) and adds
motion trails and per-actor speed labels, then encodes with ffmpeg.
"""
import os, sys, json, math, gzip, shutil, argparse, subprocess, tempfile
os.environ.pop('MPLBACKEND', None)
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gate, scene

DEV = '/Users/michaelvu-simforge/Documents/Programming/SimForge-vista/dev-assets'
TRAIL_S = 2.0


def _trail(ax, tr, aid, i, dt, color):
    a = tr['ticks']['actors'][aid]
    n = max(1, int(TRAIL_S / max(dt, 1e-6)))
    lo = max(0, i - n)
    xs = [a['x'][k] for k in range(lo, i + 1) if a['present'][k]]
    ys = [a['y'][k] for k in range(lo, i + 1) if a['present'][k]]
    if len(xs) > 1:
        ax.plot(xs, ys, color=color, lw=1.6, alpha=0.55, zorder=4, solid_capstyle='round')


# square figure: _panel forces an equal aspect with symmetric limits, so a 16:9 canvas just pads
def export(trace_path, out_mp4, brief='', fps=15, span_m=34, closest_t=None, dpi=110, size=(8.0, 8.0)):
    with gzip.open(trace_path) as f:
        tr = json.loads(f.read())
    ts = tr['ticks']['t']
    dt = tr['header'].get('dt', 0.02)
    mapid = tr['header']['mapId']
    facts = gate.trace_facts(tr)
    ct = closest_t if closest_t is not None else facts.get('closestT')
    step = max(1, int(round((1.0 / fps) / dt)))
    idx = list(range(0, len(ts), step))
    if idx and idx[-1] != len(ts) - 1:
        idx.append(len(ts) - 1)

    tmp = tempfile.mkdtemp(prefix='vidframes-')
    try:
        for n, i in enumerate(idx):
            b = scene.boxes_from_trace(tr, i)
            ego = next((q for q in b if q['id'] == 'ego'), None)
            cx, cy = (ego['x'], ego['y']) if ego else (b[0]['x'], b[0]['y'])
            fig, ax = plt.subplots(figsize=size, dpi=dpi)
            near = ct is not None and abs(ts[i] - ct) < 0.25
            title = (f"t = {ts[i]:5.2f} s    ego {ego['speed']*3.6:4.0f} kph"
                     + ("      *** CLOSEST APPROACH ***" if near else ''))
            scene._panel(ax, DEV, mapid, b, cx, cy, span_m, title)
            for q in b:
                if q['id'] in tr['ticks']['actors']:
                    _trail(ax, tr, q['id'], i, dt, q['color'])
            if brief:
                fig.suptitle(brief[:118], color='white', fontsize=10, y=0.985)
            fig.patch.set_facecolor('#171717')
            fig.tight_layout(rect=[0, 0, 1, 0.94])
            fig.savefig(f'{tmp}/f{n:05d}.png', facecolor='#171717')
            plt.close(fig)
        os.makedirs(os.path.dirname(out_mp4), exist_ok=True)
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps),
               '-i', f'{tmp}/f%05d.png', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
               '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', out_mp4]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr[-400:])
        return {'mp4': out_mp4, 'frames': len(idx), 'seconds': round(len(idx) / fps, 2)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _one(job):
    rec, outdir, fps = job
    name = f"{rec['archetypeId']}--{rec['scenarioId'][:8]}.mp4"
    try:
        r = export(rec['trace'], os.path.join(outdir, name), brief=rec.get('brief', ''),
                   fps=fps, closest_t=(rec.get('metrics') or {}).get('closestT'))
        print(f"  {name}  {r['frames']} frames / {r['seconds']}s", flush=True)
        return {**{k: rec[k] for k in ('scenarioId', 'archetypeId', 'category', 'mapId', 'siteId')},
                'brief': rec.get('brief'), 'metrics': rec.get('metrics'), **r}
    except Exception as e:                                        # noqa: BLE001
        print(f"  FAILED {name}: {e}", flush=True)
        return None


if __name__ == '__main__':
    from concurrent.futures import ProcessPoolExecutor
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', nargs='+', required=True, help='train.jsonl / test.jsonl')
    ap.add_argument('--out', required=True)
    ap.add_argument('--fps', type=int, default=15)
    ap.add_argument('--per-archetype', type=int, default=0, help='0 = all')
    ap.add_argument('--workers', type=int, default=4)
    a = ap.parse_args()
    recs = []
    for f in a.dataset:
        recs += [json.loads(l) for l in open(f)]
    if a.per_archetype:
        by = {}
        keep = []
        for r in recs:
            k = r['archetypeId']
            by[k] = by.get(k, 0)
            if by[k] < a.per_archetype:
                keep.append(r)
                by[k] += 1
        recs = keep
    os.makedirs(a.out, exist_ok=True)
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        out = [x for x in ex.map(_one, [(r, a.out, a.fps) for r in recs]) if x]
    json.dump(out, open(os.path.join(a.out, 'INDEX.json'), 'w'), indent=1)
    print(f"\n{len(out)} videos -> {a.out}")
