#!/usr/bin/env python3
"""Phase 3 — first mid-level PPO policy over the UniScenarios reactive env.

CleanRL-style single-file PPO (continuous actions) over a batched unix-socket
environment served by `reactive-env-server.mjs`:

- observation : state vector (10) ⊕ ego-centric BEV raster (80×40×3)
- action      : setpoints [targetSpeedMps ∈ 0..14, targetAccelMps2 ∈ -3.5..2]
                (motionDirection stays authored/forward; lateral guidance is
                the engine's authored route follower — a speed-regulation
                mid-level policy)
- decisionHz  : 5 (engine 50 Hz → 10 ticks per decision)
- curriculum  : banded by catalog criticality (bands.json): trivially-safe →
                moderate → critical, scheduled by update fraction
- metrics     : metrics.csv + episodes.csv under runs/<name>/

Determinism: training is stochastic by design; held-out evaluation
(`evaluate_policy.py`) records the action channel and byte-replays it.
"""
from __future__ import annotations


import argparse
import csv
import json
import pathlib
import random
import subprocess
import time
from collections import deque
import numpy as np
import torch
import torch.nn as nn
HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]

from env_client import EnvClient

# ---------------------------------------------------------------- observation
SV_SIZE = 10
# state-vector layout: x, y, cos h, sin h, speed, accel, lat off, lat rate, s, nearest range
SV_SCALE = np.array([100.0, 100.0, 1.0, 1.0, 15.0, 4.0, 3.0, 2.0, 100.0, 60.0], dtype=np.float32)

# ------------------------------------------------------------------ action box
SPEED_MAX_MPS = 14.0
ACCEL_MIN_MPS2, ACCEL_MAX_MPS2 = -3.5, 2.0
ACT_MID = np.array([SPEED_MAX_MPS / 2, (ACCEL_MAX_MPS2 + ACCEL_MIN_MPS2) / 2], dtype=np.float32)
ACT_HALF = np.array([SPEED_MAX_MPS / 2, (ACCEL_MAX_MPS2 - ACCEL_MIN_MPS2) / 2], dtype=np.float32)
ACT_MID_T = torch.tensor(ACT_MID, device="cuda" if torch.cuda.is_available() else "cpu")
ACT_HALF_T = torch.tensor(ACT_HALF, device="cuda" if torch.cuda.is_available() else "cpu")


def decode_action(a: np.ndarray) -> dict[str, float]:
    return {"target_speed_mps": float(a[0]), "target_acceleration_mps2": float(a[1])}


# -------------------------------------------------------------------- network
BEV_H, BEV_W = 80, 40


class Policy(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.bev_cnn = nn.Sequential(
            nn.Conv2d(3, 16, 3, stride=2, padding=1), nn.ReLU(),
            nn.Conv2d(16, 32, 3, stride=2, padding=1), nn.ReLU(),
            nn.Conv2d(32, 32, 3, stride=2, padding=1), nn.ReLU(),
            nn.Flatten(),
        )
        with torch.no_grad():
            cnn_out = self.bev_cnn(torch.zeros(1, 3, BEV_H, BEV_W)).shape[1]
        self.bev_proj = nn.Sequential(nn.Linear(cnn_out, 256), nn.ReLU())
        self.sv_mlp = nn.Sequential(nn.Linear(SV_SIZE, 64), nn.ReLU(), nn.Linear(64, 64), nn.ReLU())
        self.actor = nn.Sequential(nn.Linear(256 + 64, 256), nn.ReLU(), nn.Linear(256, 2))
        self.critic = nn.Sequential(nn.Linear(256 + 64, 256), nn.ReLU(), nn.Linear(256, 1))
        self.log_std = nn.Parameter(torch.full((2,), -0.5))

    def features(self, sv: torch.Tensor, bev: torch.Tensor) -> torch.Tensor:
        return torch.cat([self.bev_proj(self.bev_cnn(bev)), self.sv_mlp(sv)], dim=1)

    def value(self, sv: torch.Tensor, bev: torch.Tensor) -> torch.Tensor:
        return self.critic(self.features(sv, bev)).squeeze(-1)

    def raw_dist(self, sv: torch.Tensor, bev: torch.Tensor):
        mean = self.actor(self.features(sv, bev))
        std = self.log_std.exp().expand_as(mean)
        return torch.distributions.Normal(mean, std)


def to_setpoints(raw: np.ndarray) -> np.ndarray:
    """Raw normal samples → squashed setpoints inside the action box."""
    return ACT_MID + ACT_HALF * np.tanh(raw)


def raw_from_setpoints(act: np.ndarray) -> np.ndarray:
    z = np.clip((act - ACT_MID) / ACT_HALF, -0.9995, 0.9995)
    return np.arctanh(z)


# --------------------------------------------------------------------- vec env
class SocketVecEnv:
    """N concurrent server sessions with per-session canonical seeds."""

    def __init__(self, socket_path: str, members: list[tuple[int, str]]) -> None:
        self.client = EnvClient(socket_path)
        self.client.hello()
        self.members = members          # [(server session id, canonical seed)]
        self.num_envs = len(members)
        self.session_ids = [s for s, _ in members]
        self.seeds_by_session = {i: seed for i, (_s, seed) in enumerate(members)}
        assert self.client.bev_shape == (BEV_H, BEV_W, 3), f"unexpected BEV shape {self.client.bev_shape}"
        self.ep_log: list[dict] = []
        self._rr = 0
        self._live: set[int] = set(range(self.num_envs))
        self.reset()

    def reset(self) -> None:
        frames = self.client.reset_all([self.seeds_by_session[i] for i in range(self.num_envs)])
        self._obs: dict[int, tuple[np.ndarray, np.ndarray]] = {
            i: self._pack(f) for i, f in enumerate(frames)
        }
        self._live = set(range(self.num_envs))
        self._ep_ret = [0.0] * self.num_envs
        self._ep_len = [0] * self.num_envs

    @staticmethod
    def _pack(f: dict) -> tuple[np.ndarray, np.ndarray]:
        return f["sv"] / SV_SCALE, f["bev"].transpose(2, 0, 1)  # → [c,h,w]

    def step(self, actions_by_env: dict[int, np.ndarray]):
        pairs = []
        for i, sid in enumerate(self.session_ids):
            a = actions_by_env.get(i)
            pairs.append((sid, decode_action(a) if a is not None else None))
        frames = self.client.batch_step(pairs)
        obs, rews, dones = [], [], []
        for i, f in enumerate(frames):
            if i not in self._live:
                continue
            self._ep_ret[i] += f["reward"]
            self._ep_len[i] += 1
            done = f["terminated"] or f["truncated"]
            if done:
                self.ep_log.append({
                    "session_idx": i,
                    "session": self.session_ids[i],
                    "seed": self.seeds_by_session[i],
                    "return": self._ep_ret[i],
                    "length": self._ep_len[i],
                    "collision": f["collision"],
                    "goal": f["goal"],
                    "terminated": f["terminated"],
                })
                # auto-reset into the next episode from the same band pool
                sid, seed = self.members[self._rr % len(self.members)]
                self._rr += 1
                fresh = self.client.reset(sid, seed)
                self.session_ids[i] = sid
                self.seeds_by_session[i] = seed
                obs.append((i, self._pack(fresh)))
                self._ep_ret[i] = 0.0
                self._ep_len[i] = 0
                continue
            obs.append((i, self._pack(f)))
            rews.append((i, f["reward"]))
            dones.append((i, done))
        return obs, rews, dones


# --------------------------------------------------------------------- rollout
@torch.no_grad()
def rollout(env: SocketVecEnv, policy: Policy, device: str, steps_per_env: int):
    T = steps_per_env
    N = env.num_envs
    sv_buf = torch.zeros(T, N, SV_SIZE)
    bev_buf = torch.zeros(T, N, 3, BEV_H, BEV_W)
    act_buf = torch.zeros(T, N, 2)
    logp_buf = torch.zeros(T, N)
    rew_buf = torch.zeros(T, N)
    done_buf = torch.ones(T, N)  # rows for finished/absent envs are masked out later
    val_buf = torch.zeros(T, N)

    cur = env._obs
    for t in range(T):
        live = sorted(env._live)
        actions: dict[int, np.ndarray] = {}
        if live:
            sv = torch.tensor(np.stack([cur[i][0] for i in live]), dtype=torch.float32, device=device)
            bev_in = torch.tensor(np.stack([cur[i][1] for i in live]), dtype=torch.float32, device=device)
            dist = policy.raw_dist(sv, bev_in)
            v = policy.value(sv, bev_in)
            raw = dist.sample()
            act_sp = ACT_MID_T + ACT_HALF_T * torch.tanh(raw)
            logp = dist.log_prob(raw).sum(-1)
            for j, i in enumerate(live):
                actions[i] = act_sp[j].cpu().numpy()
        obs, rews, dones = env.step(actions)

        sv_t = torch.zeros(N, SV_SIZE)
        bev_t = torch.zeros(N, 3, BEV_H, BEV_W)
        rew_t = torch.zeros(N)
        done_t = torch.ones(N)  # rows not produced this step are masked out
        logp_t = torch.zeros(N)
        val_t = torch.zeros(N)
        act_t = torch.zeros(N, 2)
        for i, (s, b) in obs:
            sv_t[i] = torch.tensor(s)
            bev_t[i] = torch.tensor(b)
        for i, r in rews:
            rew_t[i] = r
        for i, d in dones:
            done_t[i] = 1.0 if d else 0.0
        for j, i in enumerate(live):
            act_t[i] = act_sp[j].cpu()
            logp_t[i] = logp[j]
            val_t[i] = v[j]
        cur.update({i: o for i, o in obs})
        sv_buf[t], bev_buf[t], act_buf[t] = sv_t, bev_t, act_t
        logp_buf[t], rew_buf[t], done_buf[t], val_buf[t] = logp_t, rew_t, done_t, val_t
    return {
        "sv": sv_buf, "bev": bev_buf, "act": act_buf, "logp": logp_buf,
        "rew": rew_buf, "done": done_buf, "val": val_buf,
    }


def rollout_masked(env: SocketVecEnv, policy: Policy, device: str, steps_per_env: int):
    """Rollout with the validity mask. Auto-reset keeps every slot live for
    the whole rollout, so the mask is all ones; kept as plumbing for GAE."""
    batch = rollout(env, policy, device, steps_per_env)
    batch["mask"] = torch.ones_like(batch["done"])
    return batch


def gae(rew, done, val, mask, last_val, gamma=0.99, lam=0.95):
    T, N = rew.shape
    adv = torch.zeros(T, N)
    lastgaelam = torch.zeros(N)
    for t in reversed(range(T)):
        nextv = last_val if t == T - 1 else val[t + 1]
        nonterm = (1.0 - done[t]) * mask[t]
        delta = rew[t] * mask[t] + gamma * nextv * nonterm - val[t] * mask[t]
        lastgaelam = delta + gamma * lam * nonterm * lastgaelam * mask[t]
        adv[t] = lastgaelam
    return adv, adv + val


# ------------------------------------------------------------------------ main
def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--socket", default="/tmp/rl-train.sock")
    p.add_argument("--name", default="ppo-phase3")
    p.add_argument("--total-decisions", type=int, default=262_144)
    p.add_argument("--num-envs", type=int, default=8)
    p.add_argument("--steps-per-env", type=int, default=128)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--minibatch", type=int, default=512)
    p.add_argument("--clip", type=float, default=0.2)
    p.add_argument("--ent-coef", type=float, default=0.005)
    p.add_argument("--gamma", type=float, default=0.99)
    p.add_argument("--lam", type=float, default=0.95)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--init-from", default=None, help="checkpoint to warm-start from")
    p.add_argument("--stage-mix", default="0.25,0.30,0.45",
                   help="comma fractions of iterations per curriculum stage")
    p.add_argument("--reward-json", default=None,
                   help="provisional RewardConfig overrides passed to the shim")
    args = p.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    random.seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    bands = json.loads((HERE / "bands.json").read_text())["rows"]
    spec_order = []  # (kind, map, site, seeds) in server session order
    train_specs = sorted((HERE / "episodes").glob("*-train.json"))
    for spec in train_specs:
        doc = json.loads(spec.read_text())
        kind = "dartout" if spec.name.startswith("dartout") else "merge"
        spec_order.append((kind, doc["map"], doc["site"], doc["seeds"]))
    band_lookup = {(r["kind"], r["map"], r["site"], str(r["seed"])): r for r in bands}

    stage_sessions: dict[int, list[tuple[int, str]]] = {0: [], 1: [], 2: []}
    for sid, (kind, map_, site, seeds) in enumerate(spec_order):
        for seed in seeds:
            r = band_lookup[(kind, map_, site, str(seed))]
            c = r["criticality"] if r["criticality"] is not None else 9.9
            if r["band"] in ("trivially-safe", "no-interaction"):
                stage = 0
            elif r["band"] == "unavoidable" or c < 0.7:
                stage = 2
            elif c < 1.5:
                stage = 1
            else:
                stage = 1
            stage_sessions[stage].append((sid, seed))
    for b in (0, 1, 2):
        print(f"stage {b}: {len(stage_sessions[b])} episodes")

    # ---- server lifecycle
    server = None
    def ensure_server() -> subprocess.Popen | None:
        """Spawn the shim unless a live server already answers on the socket."""
        import socket as pysocket

        def alive() -> bool:
            if not pathlib.Path(args.socket).exists():
                return False
            try:
                probe = pysocket.socket(pysocket.AF_UNIX, pysocket.SOCK_STREAM)
                probe.settimeout(2)
                probe.connect(str(args.socket))
                probe.close()
                return True
            except OSError:
                pathlib.Path(args.socket).unlink(missing_ok=True)
                return False

        if alive():
            return None
        cmd = [
            "node", str(HERE / "reactive-env-server.mjs"),
            "--episodes", ",".join(str(s) for s in train_specs),
            "--socket", args.socket, "--decision-hz", "5",
        ]
        if args.reward_json:
            cmd += ["--reward", args.reward_json]
        proc = subprocess.Popen(cmd, cwd=str(REPO_ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 120
        while time.time() < deadline and not pathlib.Path(args.socket).exists():
            time.sleep(0.5)
        if not pathlib.Path(args.socket).exists():
            proc.terminate()
            raise RuntimeError("env server did not become ready")
        return proc

    run_dir = HERE / "runs" / args.name
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.json").write_text(json.dumps({**vars(args), "device": device}, indent=1))
    mf = (run_dir / "metrics.csv").open("w", newline="")
    mwriter = csv.DictWriter(mf, [
        "iter", "stage", "decisions", "mean_reward", "episodes_done", "collision_rate",
        "goal_rate", "mean_ep_len", "pi_loss", "v_loss", "kl", "entropy", "dec_per_s", "elapsed_s"])
    mwriter.writeheader()
    ef = (run_dir / "episodes.csv").open("w", newline="")
    ewriter = csv.DictWriter(ef, [
        "iter", "stage", "kind", "map", "site", "seed", "return", "length",
        "collision", "goal", "terminated"])
    ewriter.writeheader()

    iterations = max(1, args.total_decisions // (args.num_envs * args.steps_per_env))
    mix = [float(x) for x in args.stage_mix.split(",")]
    assert len(mix) == 3 and abs(sum(mix) - 1.0) < 1e-6
    cuts = [mix[0], mix[0] + mix[1]]
    stage_plan = [0 if it / iterations < cuts[0] else (1 if it / iterations < cuts[1] else 2) for it in range(iterations)]
    kind_of_sid = {sid: k for sid, (k, _m, _s, _seeds) in enumerate(spec_order)}
    map_of_sid = {sid: m for sid, (_k, m, _s, _seeds) in enumerate(spec_order)}
    site_of_sid = {sid: s for sid, (_k, _m, s, _seeds) in enumerate(spec_order)}

    # curriculum schedule by update fraction (args.stage_mix)

    def make_env(stage: int) -> SocketVecEnv:
        members = stage_sessions[stage]
        picked = [members[(i * 7 + stage * 3) % len(members)] for i in range(args.num_envs)]
        return SocketVecEnv(args.socket, picked)

    server = ensure_server()
    policy = Policy().to(device)
    if args.init_from:
        policy.load_state_dict(torch.load(args.init_from, map_location=device, weights_only=True))
        print(f"warm-started from {args.init_from}")

    opt = torch.optim.Adam(policy.parameters(), lr=args.lr, eps=1e-5)

    recent_returns: deque = deque(maxlen=200)
    recent_coll: deque = deque(maxlen=200)
    t_start = time.time()
    global_step = 0
    cur_stage = stage_plan[0]
    env = make_env(cur_stage)

    try:
        for it in range(iterations):
            stage = stage_plan[it]
            if stage != cur_stage:
                env.client.close()
                env = make_env(stage)
                cur_stage = stage
            t0 = time.time()
            batch = rollout_masked(env, policy, device, args.steps_per_env)
            T, N = batch["rew"].shape
            global_step += int(batch["mask"].sum())

            with torch.no_grad():
                last_val = torch.zeros(N)
                live_now = sorted(env._live)
                if live_now:
                    sv = torch.tensor(np.stack([env._obs[i][0] for i in live_now]), dtype=torch.float32, device=device)
                    bev = torch.tensor(np.stack([env._obs[i][1] for i in live_now]), dtype=torch.float32, device=device)
                    vals = policy.value(sv, bev).cpu()
                    for j, i in enumerate(live_now):
                        last_val[i] = vals[j]
            adv, ret = gae(batch["rew"], batch["done"], batch["val"], batch["mask"], last_val, args.gamma, args.lam)

            mask = batch["mask"].reshape(-1).bool()
            b_sv = batch["sv"].reshape(T * N, SV_SIZE)[mask]
            b_bev = batch["bev"].reshape(T * N, 3, BEV_H, BEV_W)[mask]
            b_act = batch["act"].reshape(T * N, 2)[mask]
            b_logp = batch["logp"].reshape(T * N)[mask]
            b_adv = adv.reshape(T * N)[mask]
            b_ret = ret.reshape(T * N)[mask]
            n_samples = b_sv.shape[0]
            b_adv = (b_adv - b_adv.mean()) / (b_adv.std() + 1e-8)

            idx = np.arange(n_samples)
            sums = {"pi": 0.0, "v": 0.0, "kl": 0.0, "ent": 0.0}
            n_updates = 0
            act_mid = torch.tensor(ACT_MID, dtype=torch.float32, device=device)
            act_half = torch.tensor(ACT_HALF, dtype=torch.float32, device=device)
            for _ in range(args.epochs):
                np.random.shuffle(idx)
                for start in range(0, n_samples, args.minibatch):
                    mb = torch.tensor(idx[start:start + args.minibatch])
                    sv = b_sv[mb].to(device)
                    bev = b_bev[mb].to(device)
                    act = b_act[mb].to(device)
                    adv_mb = b_adv[mb].to(device)
                    ret_mb = b_ret[mb].to(device)
                    logp_old = b_logp[mb].to(device)

                    inv = torch.atanh(torch.clamp((act - act_mid) / act_half, -0.999, 0.999))
                    dist = policy.raw_dist(sv, bev)
                    logp = dist.log_prob(inv).sum(-1)
                    ratio = (logp - logp_old).exp()
                    pg1 = -adv_mb * ratio
                    pg2 = -adv_mb * torch.clamp(ratio, 1 - args.clip, 1 + args.clip)
                    pi_loss = torch.max(pg1, pg2).mean()
                    v_loss = ((policy.value(sv, bev) - ret_mb) ** 2).mean()
                    ent = dist.entropy().sum(-1).mean()
                    loss = pi_loss + 0.5 * v_loss - args.ent_coef * ent
                    opt.zero_grad()
                    loss.backward()
                    nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
                    opt.step()
                    with torch.no_grad():
                        kl = (dist.log_prob(inv).sum(-1) - logp_old).mean().abs()
                    sums["pi"] += pi_loss.item()
                    sums["v"] += v_loss.item()
                    sums["kl"] += kl.item()
                    sums["ent"] += ent.item()
                    n_updates += 1

            eps = list(env.ep_log)
            env.ep_log.clear()
            for e in eps:
                ewriter.writerow({
                    "iter": it, "stage": stage,
                    "kind": kind_of_sid[e["session"]], "map": map_of_sid[e["session"]],
                    "site": site_of_sid[e["session"]], "seed": e["seed"],
                    "return": round(e["return"], 3), "length": e["length"],
                    "collision": int(e["collision"]), "goal": int(e["goal"]),
                    "terminated": int(e["terminated"]),
                })
                recent_returns.append(e["return"])
                recent_coll.append(1.0 if e["collision"] else 0.0)
            dt = time.time() - t0
            row = {
                "iter": it, "stage": stage, "decisions": global_step,
                "mean_reward": round(float(np.mean([e["return"] for e in eps])), 3) if eps else "",
                "episodes_done": len(eps),
                "collision_rate": round(float(np.mean(recent_coll)), 3) if recent_coll else "",
                "goal_rate": round(sum(e["goal"] for e in eps) / len(eps), 3) if eps else "",
                "mean_ep_len": round(float(np.mean([e["length"] for e in eps])), 1) if eps else "",
                "pi_loss": round(sums["pi"] / max(1, n_updates), 5),
                "v_loss": round(sums["v"] / max(1, n_updates), 5),
                "kl": round(sums["kl"] / max(1, n_updates), 5),
                "entropy": round(sums["ent"] / max(1, n_updates), 4),
                "dec_per_s": round(int(batch["mask"].sum()) / dt, 1),
                "elapsed_s": round(time.time() - t_start, 1),
            }
            mwriter.writerow(row)
            mf.flush()
            ef.flush()
            if it % 10 == 0 or it == iterations - 1:
                print(
                    f"it {it:4d} st{stage} dec {global_step:7d} "
                    f"R {float(np.mean(recent_returns)) if recent_returns else float('nan'):7.2f} "
                    f"coll {float(np.mean(recent_coll)) if recent_coll else 0:.2f} "
                    f"pi {row['pi_loss']:+.4f} v {row['v_loss']:.3f} kl {row['kl']:.4f} "
                    f"{row['dec_per_s']:.0f} dec/s", flush=True)
            if it in (iterations // 3, 2 * iterations // 3) or it == iterations - 1:
                torch.save(policy.state_dict(), run_dir / "policy.pt")
    finally:
        torch.save(policy.state_dict(), run_dir / "policy.pt")
        mf.close()
        ef.close()
        try:
            env.client.close()
        except Exception:
            pass
        if server is not None:
            server.terminate()
    print(f"done → {run_dir}")


if __name__ == "__main__":
    main()
