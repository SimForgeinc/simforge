"""Run the authoring loop over a set of briefs, in parallel, and collect the results."""
import os, sys, json, time, argparse, traceback, signal
from concurrent.futures import ProcessPoolExecutor, as_completed

import author, gate

CORPUS = ('/Users/michaelvu-simforge/Documents/Programming/SimForge-vista/'
          'research/edge-case-corpus/agent-authoring/brief-corpus.json')


def load_briefs(split=None, corpus=CORPUS):
    d = json.load(open(corpus))
    by_id = {b['id']: b for b in d['briefs']}
    if split is None:
        return d['briefs']
    ids = d['split'][split]
    return [by_id[i] for i in ids if i in by_id]


def _one(args):
    b, mode, root, max_iters, use_critic = args
    outdir = f"{root}/{b['id']}-{mode}"
    os.makedirs(outdir, exist_ok=True)
    try:
        r = author.author(b['id'], b['brief'], b['category'], outdir, mode=mode,
                          max_iters=max_iters, log=lambda *_: None, use_critic=use_critic)
    except Exception as e:                                        # noqa: BLE001
        r = {'briefId': b['id'], 'mode': mode, 'category': b['category'], 'admitted': False,
             'error': f'{type(e).__name__}: {e}', 'tb': traceback.format_exc()[-2500:],
             'outdir': outdir}
        try:
            os.makedirs(outdir, exist_ok=True)
            with open(outdir + '/CRASH.txt', 'w') as fh:
                fh.write(traceback.format_exc())
        except Exception:                                         # noqa: BLE001
            pass
    r['outdir'] = outdir
    lg = r.get('lastGate') or {}
    print(f"[{mode}] {b['id']:26} admitted={str(r.get('admitted')):5} "
          f"HQ={str(lg.get('admittedHQ')):5} cells={lg.get('passingCells')}/{lg.get('totalCells')} "
          f"iters={len(r.get('iterations', []))} {r.get('wallClockS', 0)}s"
          + (f"  ERROR {r.get('error')}" if r.get('error') else ''), flush=True)
    return r


def run(briefs, mode, root, workers=3, max_iters=4, use_critic=False):
    os.makedirs(root, exist_ok=True)
    jobs = [(b, mode, root, max_iters, use_critic) for b in briefs]
    out = []
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        _install_pool_guard(ex)
        futs = {ex.submit(_one, j): j for j in jobs}
        for f in as_completed(futs):
            out.append(f.result())
    summary = {
        'mode': mode, 'root': root, 'n': len(out),
        'admitted': sum(1 for r in out if r.get('admitted')),
        'admittedHQ': sum(1 for r in out if (r.get('lastGate') or {}).get('admittedHQ')),
        'rate': round(sum(1 for r in out if r.get('admitted')) / max(1, len(out)), 4),
        'rateHQ': round(sum(1 for r in out if (r.get('lastGate') or {}).get('admittedHQ')) / max(1, len(out)), 4),
        'wallClockS': round(time.time() - t0, 1),
        'meanWallPerBriefS': round(sum(r.get('wallClockS', 0) for r in out) / max(1, len(out)), 1),
        'meanIters': round(sum(len(r.get('iterations', [])) for r in out) / max(1, len(out)), 2),
        'surfaceSha': author.SURFACE_SHA,
        'useCritic': use_critic,
        'gateAdmitted': sum(1 for r in out if r.get('gateAdmitted')),
        'criticAgreed': sum(1 for r in out if r.get('criticAgreed') is True),
        'criticRejectedGatePass': sum(1 for r in out if r.get('criticAgreed') is False),
        'results': [{k: v for k, v in r.items() if k not in ('iterations', 'template', 'lastCells')}
                    for r in out],
    }
    json.dump(summary, open(f'{root}/SUMMARY.json', 'w'), indent=1, default=str)
    print(f"\n== {mode}: admitted {summary['admitted']}/{summary['n']} = {summary['rate']}"
          f" | HQ {summary['admittedHQ']}/{summary['n']} = {summary['rateHQ']}"
          f" | {summary['wallClockS']}s wall, {summary['meanWallPerBriefS']}s/brief mean,"
          f" {summary['meanIters']} iters ==")
    return summary


def _own_process_group():
    """Become a process-group leader so the whole worker pool can be killed as one unit.

    `pkill -f run_lane.py` kills only the parent; ProcessPoolExecutor children are reparented to init
    and keep running. Measured: 31 orphans accumulated across restarts, the oldest 19h15m old, still
    holding CPU AND still writing into output directories that had since been deleted and recreated --
    which is what produced the FileNotFoundError on freshly written trace files.
    Kill a whole run with:  kill -TERM -<pid-of-run_lane>
    """
    try:
        os.setpgrp()
    except Exception:                                             # noqa: BLE001
        pass


def _install_pool_guard(ex):
    """Make SIGTERM/SIGINT tear the pool down instead of orphaning it."""
    def _bye(signum, _frame):
        try:
            ex.shutdown(wait=False, cancel_futures=True)
        finally:
            os.killpg(os.getpgrp(), signal.SIGKILL)
    for s in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(s, _bye)
        except Exception:                                         # noqa: BLE001
            pass


if __name__ == '__main__':
    _own_process_group()
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', default='DEV')
    ap.add_argument('--mode', default='sight')
    ap.add_argument('--root', required=True)
    ap.add_argument('--workers', type=int, default=3)
    ap.add_argument('--max-iters', type=int, default=4)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--corpus', default=CORPUS)
    ap.add_argument('--critic', action='store_true')
    a = ap.parse_args()
    bs = load_briefs(None if a.split == 'ALL' else a.split, a.corpus)
    if a.limit:
        bs = bs[:a.limit]
    run(bs, a.mode, a.root, a.workers, a.max_iters, a.critic)
