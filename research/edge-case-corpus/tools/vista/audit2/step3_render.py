"""Step 3: render every pair under each rendering condition.

  base   -- exactly what the critic sees today (scene.render_rollout, 6 panels, 64 m across)
  enh    -- 9 panels, per-frame zoom, 2.5 s motion trails, per-actor speed labels, actor legend
  world  -- as enh but every panel pinned to one world view
"""
import json, os, sys
from concurrent.futures import ProcessPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
DEV = '/Users/michaelvu-simforge/Documents/Programming/SimForge-vista/dev-assets'
RD = os.path.join(HERE, 'renders')


def one(job):
    import scene, render2, render_trails
    pid, trace, ct, mode = job
    out = os.path.join(RD, f'{pid}.{mode}.png')
    if os.path.exists(out) and os.path.getsize(out) > 5000:
        return out
    try:
        if mode == 'base':
            scene.render_rollout(DEV, trace, out, closest_t=ct)
        elif mode == 'enh':
            render2.render_rollout2(DEV, trace, out, closest_t=ct)
        elif mode == 'world':
            render2.render_rollout2(DEV, trace, out, closest_t=ct, world_fixed=True)
        elif mode == 'trails':
            render_trails.render_trails(DEV, trace, out, closest_t=ct)
    except Exception as e:                                        # noqa: BLE001
        return f'ERROR {pid} {mode}: {e}'
    return out


if __name__ == '__main__':
    os.makedirs(RD, exist_ok=True)
    pairs = json.load(open(os.path.join(HERE, 'pairs.json')))['pairs']
    modes = sys.argv[1:] or ['base', 'enh', 'world']
    jobs = [(p['id'].replace('/', '_').replace(':', '__').replace('~', '--'),
             p['trace'], p.get('closestT'), m) for p in pairs for m in modes]
    print('render jobs:', len(jobs), flush=True)
    with ProcessPoolExecutor(max_workers=2) as ex:
        for r in ex.map(one, jobs, chunksize=2):
            if str(r).startswith('ERROR'):
                print(r, flush=True)
    print('done')
