#!/usr/bin/env python3
"""BEV top-down animations of captured rollouts (baseline / mid / end).

Per stage×episode JSONL in viz/data/, renders a matplotlib animation:
  - honest road sketch: driving-lane polylines dumped by capture-server
    (straight from the map graph — no invented corridors)
  - actors as labeled oriented rectangles (ego accent yellow #e8e044,
    other vehicles gray, pedestrians red)
  - ego trajectory trail
  - overlay panel: speed m/s, cumulative reward, decision count,
    min TTC/PET, TERMINAL banner on collision/goal

Playback: 10 fps over decision frames (decisionHz 5 → 2× speed), poses
linearly interpolated between decisions. Axis limits are shared across all
three stages of an episode so differences are directly comparable.
Output: viz/out/<label>__<stage>.mp4
"""
from __future__ import annotations

import json
import math
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.transforms  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib import animation, patches  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
OUT_DIR = HERE / "out"

EGO_COLOR = "#e8e044"
VEH_COLOR = "#9aa0a6"
PED_COLOR = "#c0392b"
ROAD_COLOR = "#d8d5cc"
ROAD_EDGE = "#b8b4a9"
BG_COLOR = "#f4f2ec"
ACCENT_DARK = "#33322e"

PLAYBACK_FPS = 10
SUBFRAMES = 2  # interpolation frames per decision


def load_rollout(path: pathlib.Path) -> tuple[dict, list[dict]]:
    lines = path.read_text().splitlines()
    meta = json.loads(lines[0])
    records = [json.loads(ln) for ln in lines[1:] if ln.strip()]
    return meta, records


def draw_road(ax, lanes: list[dict]) -> None:
    # two passes so neighbouring lanes' outlines never cut through fills
    for ln in lanes:
        pts = np.asarray(ln["polyline"])
        w = max(ln.get("widthM") or 3.0, 0.15)
        ax.plot(pts[:, 0], pts[:, 1], color=ROAD_EDGE, lw=w * 1.6, solid_capstyle="round", zorder=1)
    for ln in lanes:
        pts = np.asarray(ln["polyline"])
        w = max(ln.get("widthM") or 3.0, 0.15)
        ax.plot(pts[:, 0], pts[:, 1], color=ROAD_COLOR, lw=w * 1.45, solid_capstyle="round", zorder=1.1)

VIEW_HALF_X = 40.0  # follow-cam window half-extents (m)
VIEW_HALF_Y = 36.0


def actor_dims(rec_actor: dict) -> tuple[float, float]:
    dims = rec_actor.get("dims") or {"l": 4.5, "w": 1.9}
    return float(dims["l"]), float(dims["w"])


def place(ax, patch, x: float, y: float, heading: float) -> None:
    t = matplotlib.transforms.Affine2D().rotate(heading).translate(x, y)
    patch.set_transform(t + ax.transData)


def render(meta: dict, records: list[dict], lanes: list[dict], bounds: tuple, out_path: pathlib.Path) -> None:
    ego_id = "ego"
    xmin, xmax, ymin, ymax = bounds
    pad = 12.0
    fig = plt.figure(figsize=(11.0, 7.2), dpi=110)
    ax_bev = fig.add_axes([0.03, 0.05, 0.62, 0.88])
    ax_panel = fig.add_axes([0.68, 0.05, 0.30, 0.88])
    ax_bev.set_facecolor(BG_COLOR)
    ax_bev.set_aspect("equal")
    ax_bev.set_xlim(xmin - pad, xmax + pad)
    ax_bev.set_ylim(ymin - pad, ymax + pad)
    ax_bev.set_xticks([])
    ax_bev.set_yticks([])
    for spine in ax_bev.spines.values():
        spine.set_color(ROAD_EDGE)
    draw_road(ax_bev, lanes)

    title = f"{meta['label']}  ·  stage: {meta['stage'].upper()}"
    fig.text(0.5, 0.955, title, ha="center", va="top", fontsize=13, fontweight="bold", color=ACCENT_DARK)
    fig.text(
        0.5, 0.925,
        f"seed {meta['seed']} · {meta['bank']} · reactive ambient · decisionHz {meta['decisionHz']} · {meta.get('note', '')}",
        ha="center", va="top", fontsize=8.5, color="#666",
    )

    (trail_line,) = ax_bev.plot([], [], color=EGO_COLOR, lw=2.2, alpha=0.85, zorder=4)

    patches_by_id: dict[str, patches.FancyBboxPatch] = {}
    labels_by_id: dict[str, plt.Text] = {}
    ids = sorted(records[0]["actors"].keys())
    for aid in ids:
        rec_actor = records[0]["actors"][aid]
        l, w = actor_dims(rec_actor)
        kind = rec_actor["kind"]
        color = EGO_COLOR if aid == ego_id else (PED_COLOR if kind == "pedestrian" else VEH_COLOR)
        rect = patches.FancyBboxPatch(
            (-l / 2, -w / 2), l, w,
            boxstyle="round,pad=0,rounding_size=0.18",
            facecolor=color, edgecolor=ACCENT_DARK, linewidth=0.7, zorder=5,
        )
        ax_bev.add_patch(rect)
        patches_by_id[aid] = rect
        labels_by_id[aid] = ax_bev.text(0, 0, aid, fontsize=7.5, ha="center", va="center",
                                        color=ACCENT_DARK,
                                        fontweight="bold" if aid == ego_id else "normal", zorder=6)

    banner = ax_bev.text(0.5, 0.94, "", transform=ax_bev.transAxes, ha="center", va="center",
                         fontsize=17, fontweight="bold", color="white", visible=False,
                         bbox={"boxstyle": "round,pad=0.35", "fc": "#b3261e", "ec": "none"}, zorder=10)
    banner_goal_bbox = {"boxstyle": "round,pad=0.35", "fc": "#1e7d43", "ec": "none"}
    banner_col_bbox = {"boxstyle": "round,pad=0.35", "fc": "#b3261e", "ec": "none"}

    def interp(a: float, b: float, f: float) -> float:
        return a + (b - a) * f

    def angle_interp(a: float, b: float, f: float) -> float:
        d = (b - a + math.pi) % (2 * math.pi) - math.pi
        return a + d * f

    def move_camera(a_cur: dict, a_nxt: dict, f: float) -> None:
        cx = interp(a_cur["x"], a_nxt["x"], f)
        cy = interp(a_cur["y"], a_nxt["y"], f)
        ax_bev.set_xlim(cx - VIEW_HALF_X, cx + VIEW_HALF_X)
        ax_bev.set_ylim(cy - VIEW_HALF_Y, cy + VIEW_HALF_Y)

    def fmt(v, unit) -> str:
        return "—" if v is None else f"{v:.2f}{unit}"

    def action_str(action: dict | None) -> str:
        if action is None:
            return "authored (no hook)"
        return f"v={action['targetSpeedMps']:.1f} m/s a={action['targetAccelerationMps2']:+.1f}"

    trail_pts: list[tuple[float, float]] = []

    def update(frame_idx: int):
        di, sub = divmod(frame_idx, SUBFRAMES)
        di = min(di, len(records) - 1)
        rec = records[di]
        nxt = records[min(di + 1, len(records) - 1)]
        f = sub / SUBFRAMES
        for aid in ids:
            a_cur, a_nxt = rec["actors"][aid], nxt["actors"][aid]
            x = interp(a_cur["x"], a_nxt["x"], f)
            y = interp(a_cur["y"], a_nxt["y"], f)
            h = angle_interp(a_cur["headingRad"], a_nxt["headingRad"], f)
            place(ax_bev, patches_by_id[aid], x, y, h)
            labels_by_id[aid].set_position((x, y))
            alpha = 1.0 if a_cur["present"] else 0.25
            patches_by_id[aid].set_alpha(alpha)
            labels_by_id[aid].set_alpha(alpha)
        move_camera(rec["actors"][ego_id], nxt["actors"][ego_id], f)
        if sub == 0 and not trail_pts:
            trail_pts.append((rec["actors"][ego_id]["x"], rec["actors"][ego_id]["y"]))
        elif sub == 0 and trail_pts[-1] != (rec["actors"][ego_id]["x"], rec["actors"][ego_id]["y"]):
            trail_pts.append((rec["actors"][ego_id]["x"], rec["actors"][ego_id]["y"]))
        tx, ty = zip(*trail_pts) if trail_pts else ([], [])
        trail_line.set_data(tx, ty)

        # overlay panel (redrawn each frame — cheap and avoids stale-text bugs)
        ax_panel.clear()
        ax_panel.set_facecolor("#fbfaf7")
        ax_panel.set_xticks([])
        ax_panel.set_yticks([])
        for spine in ax_panel.spines.values():
            spine.set_color(ROAD_EDGE)
        ego = rec["actors"][ego_id]
        rows = [
            ("stage", meta["stage"].upper()),
            ("decision", f"{rec['decisions']}  ({rec['t']:.1f} s)"),
            ("speed", f"{abs(ego['speedMps']):.2f} m/s"),
            ("cum reward", f"{rec['cumReward']:.2f}"),
            ("step reward", f"{rec['reward']:+.3f}"),
            ("min distance", fmt(rec.get("nearestDistanceM"), " m")),
            ("min TTC", fmt(rec.get("minTtcS"), " s")),
            ("min PET", fmt(rec.get("minPetS"), " s")),
            ("action", action_str(rec.get("action"))),
        ]
        ax_panel.text(0.06, 0.96, "ROLLOUT METRICS", fontsize=10.5, fontweight="bold",
                      color=ACCENT_DARK, va="top")
        for i, (k, v) in enumerate(rows):
            yy = 0.84 - i * 0.085
            ax_panel.text(0.08, yy, k, fontsize=9, color="#777", va="top")
            ax_panel.text(0.48, yy, v, fontsize=9.5, color=ACCENT_DARK, va="top", family="monospace")

        if rec["collision"]:
            banner.set_text("TERMINAL — COLLISION")
            banner.set_bbox(banner_col_bbox)
            banner.set_visible(True)
        elif rec["goal"]:
            banner.set_text("TERMINAL — GOAL REACHED")
            banner.set_bbox(banner_goal_bbox)
            banner.set_visible(True)
        else:
            banner.set_visible(False)
        return []

    n_frames = len(records) * SUBFRAMES
    anim = animation.FuncAnimation(fig, update, frames=n_frames, blit=False)
    writer = animation.FFMpegWriter(fps=PLAYBACK_FPS, bitrate=-1, metadata={"title": out_path.stem})
    anim.save(str(out_path), writer=writer)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    groups: dict[str, list[pathlib.Path]] = {}
    for p in sorted(DATA_DIR.glob("*.jsonl")):
        label = p.name.split("__")[0]
        groups.setdefault(label, []).append(p)

    for label, paths in sorted(groups.items()):
        geo_path = DATA_DIR / f"{label}__geometry.json"
        lanes = json.loads(geo_path.read_text())["lanes"] if geo_path.exists() else []
        loaded = [(p, *load_rollout(p)) for p in paths]
        xs, ys = [], []
        for ln in lanes:
            for x, y in ln["polyline"]:
                xs.append(x)
                ys.append(y)
        for _p, _m, records in loaded:
            for rec in records:
                for a in rec["actors"].values():
                    xs.append(a["x"])
                    ys.append(a["y"])
        bounds = (min(xs), max(xs), min(ys), max(ys))
        for p, meta, records in loaded:
            out = OUT_DIR / f"{p.stem}.mp4"
            print(f"rendering {out.name} ({len(records)} decisions)…")
            render(meta, records, lanes, bounds, out)
    print("render complete →", OUT_DIR)


if __name__ == "__main__":
    main()
