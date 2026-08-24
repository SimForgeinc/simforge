#!/usr/bin/env python3
"""Build the self-contained RL progress dashboard (viz/out/dashboard.html).

No CDN deps: all charts are hand-rolled inline SVG; styles inline; videos
referenced by relative path. Sections:
  1. Training reward curve (r1 + r2 concatenated, stage boundary, rolling mean)
  2. Curriculum mix over updates + KL / entropy subplots
  3. Held-out eval bars: baseline vs mid(r1) vs end(r2) per scenario class
  4. BEV animations grouped start/middle/end per episode (<video> tags)
  5. W0 bridge fidelity summary (v2 dashcam-POV table, from simforge1 report)
  6. Milestone timeline
"""
from __future__ import annotations

import csv
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
RL_DIR = HERE.parent
OUT_DIR = HERE / "out"
RUNS = RL_DIR / "runs"

STAGE_NAMES = {0: "trivially-safe", 1: "moderate", 2: "critical"}
CLASS_LABELS = [
    ("all", "all"),
    ("dartout", "dart-out"),
    ("merge", "merge"),
    ("critical", "critical band"),
    ("trivially_safe", "trivially safe"),
    ("unavoidable", "unavoidable"),
]

C_BASE = "#9aa0a6"
C_MID = "#4a7fd4"
C_END = "#1e7d43"
C_R1 = "#4a7fd4"
C_R2 = "#c07f1e"
INK = "#33322e"


def read_metrics(run: str) -> list[dict]:
    with open(RUNS / run / "metrics.csv") as fh:
        return list(csv.DictReader(fh))


def rolling(xs: list[float], w: int = 12) -> list[float]:
    out = []
    for i in range(len(xs)):
        lo = max(0, i - w + 1)
        window = xs[lo : i + 1]
        out.append(sum(window) / len(window))
    return out



def svg_line_chart(
    series: list[tuple[str, list[float], str, list[float]]],
    width: int,
    height: int,
    title: str,
    ylabel: str,
    boundary_x: int | None = None,
) -> str:
    """series: (label, values, color, rolling), laid out left-to-right on one
    concatenated x-axis (r1 then r2). boundary_x = global index of the split."""
    m_l, m_r, m_t, m_b = 58, 14, 34, 40
    x0, x1 = m_l, width - m_r
    y0, y1 = height - m_b, m_t
    all_vals = [v for _l, vs, _c, _r in series for v in vs]
    vmin, vmax = min(all_vals), max(all_vals)
    span = vmax - vmin or 1.0
    vmin -= 0.06 * span
    vmax += 0.06 * span
    total = sum(len(vs) for _l, vs, _c, _r in series)

    def px(gi: float) -> float:
        return x0 + (x1 - x0) * gi / (total - 1)

    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart">']
    for gv in range(5):
        gy = y1 + (y0 - y1) * gv / 4
        val = vmax - (vmax - vmin) * gv / 4
        parts.append(f'<line x1="{x0}" y1="{gy:.1f}" x2="{x1}" y2="{gy:.1f}" stroke="#e3e1da"/>')
        parts.append(f'<text x="{x0 - 6}" y="{gy + 3:.1f}" text-anchor="end" font-size="10" fill="#888">{val:.2f}</text>')
    if boundary_x is not None:
        bx = px(boundary_x)
        parts.append(f'<line x1="{bx:.1f}" y1="{y1}" x2="{bx:.1f}" y2="{y0}" stroke="#b3261e" stroke-dasharray="4 3"/>')
        parts.append(
            f'<text x="{bx + 5:.1f}" y="{y1 + 12}" font-size="10" fill="#b3261e">warm start → r2</text>'
        )
    gi = 0.0
    for label, vs, color, roll in series:
        pts_raw = []
        pts_roll = []
        for i, v in enumerate(vs):
            p = px(gi + i)
            q = y1 - (y1 - y0) * (v - vmin) / (vmax - vmin)
            qr = y1 - (y1 - y0) * (roll[i] - vmin) / (vmax - vmin)
            pts_raw.append(f"{p:.1f},{q:.1f}")
            pts_roll.append(f"{p:.1f},{qr:.1f}")
        parts.append(f'<polyline points="{" ".join(pts_raw)}" fill="none" stroke="{color}" stroke-width="1" opacity="0.28"/>')
        parts.append(f'<polyline points="{" ".join(pts_roll)}" fill="none" stroke="{color}" stroke-width="2.2"/>')
        gi += len(vs)
    lx = x0
    for label, _vs, color, _r in series:
        parts.append(f'<rect x="{lx}" y="{y1 - 18}" width="16" height="4" fill="{color}"/>')
        est = 7 * len(label)
        parts.append(f'<text x="{lx + 21}" y="{y1 - 13}" font-size="10.5" fill="{INK}">{label}</text>')
        lx += 34 + est
    parts.append(f'<text x="{width / 2}" y="{height - 8}" text-anchor="middle" font-size="11" fill="#777">PPO iteration</text>')
    parts.append(f'<text x="14" y="{(y0 + y1) / 2}" font-size="11" fill="#777" transform="rotate(-90 14 {(y0 + y1) / 2})" text-anchor="middle">{ylabel}</text>')
    parts.append("</svg>")
    return "".join(parts)


def svg_stage_chart(r1: list[dict], r2: list[dict], width: int, height: int) -> str:
    stages = [int(r["stage"]) for r in r1] + [int(r["stage"]) for r in r2]
    m_l, m_r, m_t, m_b = 58, 14, 20, 30
    x0, x1 = m_l, width - m_r
    y0, y1 = height - m_b, m_t
    colors = ["#9fc79f", "#e6d491", "#dfa8a0"]
    names = [STAGE_NAMES[i] for i in range(3)]
    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart">']
    # runs of equal stage
    runs: list[tuple[int, int, int]] = []
    s0 = 0
    for i in range(1, len(stages) + 1):
        if i == len(stages) or stages[i] != stages[s0]:
            runs.append((s0, i, stages[s0]))
            s0 = i
    for lo, hi, st in runs:
        bx0 = x0 + (x1 - x0) * lo / len(stages)
        bx1 = x0 + (x1 - x0) * hi / len(stages)
        parts.append(
            f'<rect x="{bx0:.1f}" y="{y1}" width="{max(bx1 - bx0, 0.8):.2f}" height="{y0 - y1}" fill="{colors[st]}"/>'
        )
    # label every run wide enough to hold its name
    for lo, hi, st in runs:
        bx0 = x0 + (x1 - x0) * lo / len(stages)
        bx1 = x0 + (x1 - x0) * hi / len(stages)
        if bx1 - bx0 < 60:
            continue
        parts.append(
            f'<text x="{(bx0 + bx1) / 2:.1f}" y="{y1 + 13}" text-anchor="middle" font-size="10" fill="{INK}">{names[st]}</text>'
        )
    for gv in range(3):
        gx = x0 + (x1 - x0) * gv / 2
        parts.append(f'<line x1="{gx:.1f}" y1="{y1}" x2="{gx:.1f}" y2="{y0}" stroke="#d5d2ca"/>')
        lbl = "r1 start" if gv == 0 else ("warm start" if gv == 1 else "r2 end")
        parts.append(f'<text x="{gx:.1f}" y="{y0 + 13}" text-anchor="middle" font-size="10" fill="#888">{lbl}</text>')
    bx = x0 + (x1 - x0) * len(r1) / len(stages)
    parts.append(f'<line x1="{bx:.1f}" y1="{y1}" x2="{bx:.1f}" y2="{y0}" stroke="#b3261e" stroke-dasharray="4 3"/>')
    parts.append(f'<text x="14" y="{(y0 + y1) / 2}" font-size="11" fill="#777" transform="rotate(-90 14 {(y0 + y1) / 2})" text-anchor="middle">curriculum band</text>')
    parts.append("</svg>")
    return "".join(parts)


def svg_eval_bars(eval_data: dict, width: int, height: int) -> str:
    m_l, m_r, m_t, m_b = 58, 10, 30, 52
    x0, x1 = m_l, width - m_r
    y0, y1 = height - m_b, m_t
    groups = CLASS_LABELS
    vals = []
    for key, _lbl in groups:
        for arm in ("baseline", "mid", "end"):
            vals.append(eval_data[key][arm])
    vmax = max(vals) * 1.15
    gw = (x1 - x0) / len(groups)
    bw = gw / 4.2
    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart">']
    for gv in range(5):
        gy = y1 + (y0 - y1) * gv / 4
        val = vmax * (1 - gv / 4)
        parts.append(f'<line x1="{x0}" y1="{gy:.1f}" x2="{x1}" y2="{gy:.1f}" stroke="#e3e1da"/>')
        parts.append(f'<text x="{x0 - 6}" y="{gy + 3:.1f}" text-anchor="end" font-size="10" fill="#888">{val:.0f}</text>')
    arms = [("baseline", C_BASE, "baseline (authored)"), ("mid", C_MID, "mid · r1"), ("end", C_END, "end · r2")]
    for gi, (key, label) in enumerate(groups):
        gx = x0 + gi * gw
        for ai, (arm, color, _albl) in enumerate(arms):
            v = eval_data[key][arm]
            bh = (y0 - y1) * v / vmax
            bx = gx + gw / 2 - 1.5 * bw + ai * bw
            parts.append(f'<rect x="{bx + 1.5:.1f}" y="{y0 - bh:.1f}" width="{bw - 3:.1f}" height="{bh:.1f}" fill="{color}"/>')
            parts.append(
                f'<text x="{bx + bw / 2:.1f}" y="{y0 - bh - 4:.1f}" text-anchor="middle" font-size="8.6" fill="{INK}">{v:.1f}</text>'
            )
        parts.append(
            f'<text x="{gx + gw / 2:.1f}" y="{y0 + 14}" text-anchor="middle" font-size="10.5" fill="{INK}">{label}</text>'
        )
        d = eval_data[key]["end"] - eval_data[key]["baseline"]
        dc = C_END if d >= 0 else "#b3261e"
        parts.append(f'<text x="{gx + gw / 2:.1f}" y="{y0 + 28}" text-anchor="middle" font-size="9.5" fill="{dc}">Δ {d:+.2f}</text>')
    lx = x0
    for arm, color, albl in arms:
        parts.append(f'<rect x="{lx}" y="6" width="16" height="4" fill="{color}"/>')
        parts.append(f'<text x="{lx + 21}" y="11" font-size="10.5" fill="{INK}">{albl}</text>')
        lx += 34 + 7 * len(albl)
    parts.append(f'<text x="14" y="{(y0 + y1) / 2}" font-size="11" fill="#777" transform="rotate(-90 14 {(y0 + y1) / 2})" text-anchor="middle">mean episode return</text>')
    parts.append("</svg>")
    return "".join(parts)


def build_eval_data() -> dict:
    r2_report = json.loads((RUNS / "ppo-phase3-r2/eval_report.json").read_text())
    r1_policy = json.loads((RUNS / "ppo-phase3-r1/eval_report.json").read_text())["arms"]["policy"]
    base = r2_report["arms"]["baseline"]
    out = {}
    for key, _lbl in CLASS_LABELS:
        out[key] = {
            "baseline": base[key]["mean_return"],
            "mid": r1_policy[key]["mean_return"],
            "end": r2_report["arms"]["policy"][key]["mean_return"],
        }
    return out


W0_POV_ROWS = [
    # clip, class, floor present (orig), trans IoU>=0.5, trans IoU>=0.25, trans present, med disp px
    ("baseline-midblock", "person", "0.183", "0.000", "0.033", "0.250", "5.7"),
    ("bus-stop-emergence", "person", "0.310", "0.000", "0.024", "0.333", "24.7"),
    ("cutout-reveals-stopped", "car", "0.033", "0.000", "0.000", "0.350", "15.6"),
    ("fog-midblock (fog)", "person", "0.000", "0.000", "0.050", "0.067", "8.5"),
    ("lane-drop-merge", "–", "no in-frame GT", "–", "–", "–", "–"),
    ("night-rain-merge (night-rain)", "–", "no in-frame GT", "–", "–", "–", "–"),
    ("parked-row-dartout", "car", "0.033", "0.000", "0.067", "0.567", "26.5"),
    ("parked-row-dartout", "person", "0.017", "0.000", "0.000", "0.233", "26.7"),
    ("school-parked-row-dartout", "car", "0.100", "0.000", "0.000", "0.200", "56.3"),
    ("school-parked-row-dartout", "person", "0.033", "0.000", "0.000", "0.100", "27.1"),
    ("signal-red-light", "–", "no in-frame GT", "–", "–", "–", "–"),
    ("workzone-lane-shift (construction)", "car", "0.000", "0.000", "0.000", "0.353 (disp 82 px)", "82.1"),
]

MILESTONES = [
    ("2026-07-31", "Foundation scaffold", "P0 monorepo: studio app, city-renderer, xodr-tools, Yale St fixtures."),
    ("2026-08-08", "Execution baseline audit", "Repository state audited and recorded (docs/simforge-execution-baseline.md)."),
    ("2026-08-21", "Foundation complete — rc.45", "Authoring CLI commands, shared editor components language, render runtime integration; release 0.1.0-rc.45."),
    ("2026-08-22 am", "Episode banks + criticality banding", "65 train + 39 held-out eval episodes; authored-choreography traces banded via simforge evaluate (bands.json)."),
    ("2026-08-22 10:43", "First policy trained (r1)", "320k decisions from scratch, curriculum mix 25/30/45, lr 3e-4."),
    ("2026-08-22 11:21", "Warm-start policy (r2)", "+240k decisions, mix 10/30/60, reward retune; held-out eval beats baseline on critical band."),
    ("2026-08-22 pm", "Progress visualizations", "This dashboard: deterministic BEV rollouts of baseline/mid/end on identical held-out episodes."),
]


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    r1, r2 = read_metrics("ppo-phase3-r1"), read_metrics("ppo-phase3-r2")
    rewards = [float(r["mean_reward"]) for r in r1] + [float(r["mean_reward"]) for r in r2]
    kls = [float(r["kl"]) for r in r1] + [float(r["kl"]) for r in r2]
    ents = [float(r["entropy"]) for r in r1] + [float(r["entropy"]) for r in r2]
    boundary = len(r1)

    reward_svg = svg_line_chart(
        [("r1 (from scratch)", rewards[:boundary], C_R1, rolling(rewards[:boundary])),
         ("r2 (warm start)", rewards[boundary:], C_R2, rolling(rewards[boundary:]))],
        720, 300, "Training reward", "mean ep reward", boundary_x=boundary,
    )
    kl_svg = svg_line_chart(
        [("KL(policy‖old)", kls, "#8a63b8", rolling(kls))], 720, 190, "KL", "KL",
    )
    ent_svg = svg_line_chart(
        [("policy entropy", ents, "#2a8fbd", rolling(ents))], 720, 190, "Entropy", "entropy",
    )
    stage_svg = svg_stage_chart(r1, r2, 720, 120)
    eval_data = build_eval_data()
    eval_svg = svg_eval_bars(eval_data, 720, 330)

    total_decisions = 320_000 + 240_000
    summary = json.loads((HERE / "data/critical-dartout__end.jsonl").read_text().splitlines()[0])

    video_groups = ""
    episodes = {}
    for mp4 in sorted(OUT_DIR.glob("*__*.mp4")):
        label, stage = mp4.stem.split("__")
        episodes.setdefault(label, {})[stage] = mp4.name
    stage_titles = {"baseline": "START — baseline (authored choreography)",
                    "mid": "MIDDLE — after r1 (+320k decisions)",
                    "end": "END — after r2 warm start (+240k)"}
    meta_by_label = {}
    for p in sorted((HERE / "data").glob("*__*.jsonl")):
        label = p.name.split("__")[0]
        if label not in meta_by_label:
            meta_by_label[label] = json.loads(p.read_text().splitlines()[0])

    for label in sorted(episodes):
        meta = meta_by_label[label]
        cards = ""
        for stage in ("baseline", "mid", "end"):
            f = episodes[label].get(stage)
            if not f:
                continue
            cards += f"""
      <figure class="vidcard">
        <video controls preload="metadata" src="{f}"></video>
        <figcaption>{stage_titles[stage]}</figcaption>
      </figure>"""
        video_groups += f"""
    <section class="epgroup">
      <h3>{esc(label)} <span class="sub">— {esc(meta.get('note', ''))} · seed {meta['seed']} · returns: base {meta['return']}</span></h3>
      <div class="vidrow">{cards}</div>
    </section>"""

    w0_rows = "".join(
        "<tr>" + "".join(f"<td>{esc(c)}</td>" for c in row) + "</tr>" for row in W0_POV_ROWS
    )
    timeline = "".join(
        f'<li><span class="tl-date">{esc(d)}</span><span class="tl-body"><strong>{esc(t)}</strong> — {esc(b)}</span></li>'
        for d, t, b in MILESTONES
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SimForge RL Progress — Phase 3 mid-level PPO</title>
<style>
  :root {{ --ink:{INK}; --paper:#fbfaf7; --line:#e3e1da; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:32px 40px 64px; background:var(--paper); color:var(--ink);
         font:15px/1.55 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }}
  h1 {{ font-size:25px; margin:0 0 4px; }}
  h2 {{ font-size:18px; margin:44px 0 10px; border-bottom:2px solid var(--ink); padding-bottom:5px; }}
  h3 {{ font-size:15px; margin:22px 0 8px; }}
  .sub {{ font-weight:normal; color:#777; font-size:12.5px; }}
  .lede {{ color:#666; margin:0 0 8px; font-size:13.5px; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:26px; }}
  @media (max-width:1100px) {{ .grid {{ grid-template-columns:1fr; }} }}
  .panel {{ background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px 16px 10px; }}
  .chart {{ width:100%; height:auto; display:block; }}
  .statrow {{ display:flex; gap:14px; flex-wrap:wrap; margin:14px 0 0; }}
  .stat {{ background:#fff; border:1px solid var(--line); border-radius:8px; padding:10px 16px; min-width:150px; }}
  .stat b {{ display:block; font-size:21px; }}
  .stat span {{ color:#777; font-size:11.5px; }}
  table {{ border-collapse:collapse; width:100%; background:#fff; font-size:12.5px; }}
  th, td {{ border:1px solid var(--line); padding:5px 9px; text-align:left; }}
  th {{ background:#f1efe9; }}
  td:nth-child(n+3) {{ font-family:ui-monospace,Menlo,monospace; }}
  .vidrow {{ display:flex; gap:14px; flex-wrap:wrap; }}
  .vidcard {{ margin:0; flex:1 1 260px; max-width:420px; }}
  .vidcard video {{ width:100%; aspect-ratio:1210/792; background:#eee; border:1px solid var(--line); border-radius:6px; }}
  .vidcard figcaption {{ font-size:12px; color:#666; padding-top:4px; }}
  .epgroup {{ break-inside:avoid; }}
  ol.timeline {{ list-style:none; padding:0; margin:10px 0; }}
  ol.timeline li {{ display:flex; gap:14px; padding:7px 0; border-bottom:1px dashed var(--line); }}
  .tl-date {{ flex:0 0 130px; font-family:ui-monospace,Menlo,monospace; font-size:12.5px; color:#777; padding-top:1px; }}
  .tl-body {{ flex:1; font-size:13.5px; }}
  .verdict {{ display:inline-block; background:#b3261e; color:#fff; border-radius:4px;
              padding:2px 10px; font-size:12px; font-weight:700; letter-spacing:.04em; }}
</style>
</head>
<body>
<h1>SimForge — RL training progress</h1>
<p class="lede">Phase 3 mid-level PPO (setpoints: target speed / target accel) · reactive ambient traffic · decisionHz 5 ·
{total_decisions:,} decisions total ({320000:,} r1 from scratch + {240000:,} r2 warm start) ·
held-out eval on 39 disjoint-seed episodes.</p>

<div class="statrow">
  <div class="stat"><b>+2.07</b><span>held-out Δ return vs baseline (all)</span></div>
  <div class="stat"><b>+3.51</b><span>Δ return, merge class</span></div>
  <div class="stat"><b>+22.72</b><span>Δ return, unavoidable band</span></div>
  <div class="stat"><b>0.000 → 0.000</b><span>collision rate base → policy (no regression)</span></div>
  <div class="stat"><b>{summary['steps']}</b><span>decisions per captured rollout</span></div>
</div>

<h2>1 · Training reward</h2>
<div class="panel">{reward_svg}</div>

<div class="grid">
  <div>
    <h2 style="margin-top:26px">2 · Curriculum mix</h2>
    <div class="panel">{stage_svg}</div>
  </div>
  <div>
    <h2 style="margin-top:26px">Health: KL &amp; entropy</h2>
    <div class="panel">{kl_svg}</div>
    <div class="panel" style="margin-top:12px">{ent_svg}</div>
  </div>
</div>

<h2>3 · Held-out evaluation — baseline vs mid vs end</h2>
<p class="lede">39 held-out episodes (disjoint seeds), identical reward config for every arm.
Baseline arm from the r2 report; policy arms are each run's final checkpoint.</p>
<div class="panel">{eval_svg}</div>

<h2>4 · Driving evolution — same episodes, three training stages</h2>
<p class="lede">Deterministic captures: identical seeds ⇒ identical ambient traffic at every stage
(asserted by re-running each rollout twice and comparing byte-for-byte). BEV top-down,
follow-cam, 10 fps playback of 5 Hz decisions. Ego is yellow; the trail shows its path.</p>
{video_groups}

<h2>5 · W0 generative-bridge fidelity <span class="verdict">KILLED</span></h2>
<p class="lede">Why the roadmap stays mid-level-only: zero-shot H3 Ref2VA failed the kill criterion
(reward-relevant recall &lt;90% on novel classes). v2 dashcam-POV retry improved aesthetics, not
semantic fidelity — strict IoU≥0.5 recall is 0.000 everywhere below. Source:
<code>~/w0-data/W0_REPORT.md</code> on simforge1 (2026-08-22).</p>
<table>
  <thead><tr><th>clip (v2 dashcam-POV)</th><th>class</th><th>floor present (orig)</th><th>trans IoU≥0.5</th><th>trans IoU≥0.25</th><th>trans present</th><th>med disp px</th></tr></thead>
  <tbody>{w0_rows}</tbody>
</table>

<h2>6 · Milestone timeline</h2>
<ol class="timeline">{timeline}</ol>

<p class="lede" style="margin-top:36px">Generated by scripts/rl/viz/make_dashboard.py · data under scripts/rl/viz/data/ · animations alongside this file.</p>
</body>
</html>
"""
    out = OUT_DIR / "dashboard.html"
    out.write_text(html)
    print(f"wrote {out} ({len(html):,} bytes)")


if __name__ == "__main__":
    main()
