#!/usr/bin/env bash
# h3-reproduce payload matrix on simforge1 — three ref2va workers in parallel.
# All arms: short_edge 416, aspect 16:9, duration 8s, seed 44 pinned.
# Usage: run_matrix.sh <phase>   phase in {engine, real}
set -uo pipefail
RUN=~/h3-reproduce-run
OUT=$RUN/out
SMOKE_ASSETS=~/h3-teacher/smoke/assets
mkdir -p "$OUT"

USER_PROMPT='Can you turn this base video into a realistic driving video? transform the style of the scene into the real world and change the weather and lighting so that it is midnight. Do not change the movement of the cars. Only change the style of the video. This is for a realistic movie. ultra realism 4k tv. It should not look low poly. Hyper realism.'
W0_NOIMG_PROMPT='<Video 1> is a stylized 3D simulation render of a real-world driving scene. Produce a photorealistic live-camera version of the exact same scene: identical road layout, lane markings, vehicle types/colors/positions, pedestrian positions and clothing, traffic signal states, weather, and time of day, at every timestamp. Preserve all motion trajectories and event timing exactly. Change only materials, lighting realism, textures, and camera characteristics to match real-world dashcam footage style. Do not add, remove, or move any object.'
W0_PROMPT='<Video 1> is a stylized 3D simulation render of a real-world driving scene. Produce a photorealistic live-camera version of the exact same scene: identical road layout, lane markings, vehicle types/colors/positions, pedestrian positions and clothing, traffic signal states, weather, and time of day, at every timestamp. Preserve all motion trajectories and event timing exactly. Change only materials, lighting realism, textures, and camera characteristics to match <Picture 1-3> dashcam footage style. Do not add, remove, or move any object.'

export RUN OUT USER_PROMPT W0_PROMPT W0_NOIMG_PROMPT SMOKE_ASSETS

write_reqs() {
python3 - <<'EOF'
import json, os
RUN = os.environ["RUN"]; OUT = os.environ["OUT"]
U = os.environ["USER_PROMPT"]; W0 = os.environ["W0_PROMPT"]
W0N = os.environ["W0_NOIMG_PROMPT"]; SA = os.environ["SMOKE_ASSETS"]
base = dict(model="MiniMaxAI/MiniMax-H3", seconds=8,
            target={"short_edge": 416, "aspect_ratio": "16:9",
                    "duration_seconds": 8.0},
            num_outputs_per_prompt=1, flow_shift=12.0, audio_flow_shift=3.0,
            seed=44)
vr = f"file://{RUN}/richmond8s.mp4"
vn = f"file://{RUN}/nuplan8s.mp4"

def vid(uri, typ="video"): return {"type": typ, "uri": uri, "role": "reference"}

reqs = {}
# A1: omni/default — source video as SOLE condition, user's exact prompt,
#     server defaults everywhere else (steps omitted -> default 50)
reqs["A1_omni_userprompt_defaults"] = dict(base, prompt=U, task="ref2va",
    conditions=[vid(vr)])
# A2: same but pinned 20 steps (budget-matched ablation vs A3/A4)
reqs["A2_videoonly_userprompt_20st"] = dict(base, prompt=U, task="ref2va",
    conditions=[vid(vr)], num_inference_steps=20)
# A3: video-only + W0-style long prompt (image clause neutralized), 20 steps
reqs["A3_videoonly_w0_20st"] = dict(base, prompt=W0N, task="ref2va",
    conditions=[vid(vr)], num_inference_steps=20)
# A4: current harness control — video + 3 style images + full W0 prompt
reqs["A4_control_styleimgs_w0_20st"] = dict(base, prompt=W0, task="ref2va",
    conditions=[vid(vr),
                {"type": "image", "uri": f"file://{SA}/ref1_madison_sb_oakst.jpg", "role": "reference"},
                {"type": "image", "uri": f"file://{SA}/ref2_madison_sb_dampier.jpg", "role": "reference"},
                {"type": "image", "uri": f"file://{SA}/ref3_colin_kelley_marker.jpg", "role": "reference"}],
    num_inference_steps=20)
# A5: video_audio condition type — binds soundtrack too, user prompt, 20 steps
reqs["A5_videoaudio_userprompt_20st"] = dict(base, prompt=U, task="ref2va",
    conditions=[vid(vr, "video_audio")], num_inference_steps=20)
# D1: REAL footage control — nuPlan demo crop as sole condition, simple edit prompt
reqs["D1_nuplan_rain_videoonly_20st"] = dict(base, prompt=
    "Make it rainy in this video while keeping everything else identical.",
    task="ref2va", conditions=[vid(vn)], num_inference_steps=20)

for name, r in reqs.items():
    with open(f"{OUT}/req_{name}.json", "w") as f:
        json.dump(r, f, indent=2)
print("wrote", len(reqs), "requests")
EOF
}

submit_and_wait() { # <port> <json> <name>
  local port=$1 json=$2 name=$3 id status t0 t1
  t0=$(date +%s)
  id=$(curl -sS -X POST "http://127.0.0.1:${port}/v1/videos" \
    -H 'Content-Type: application/json' --data-binary @"$json" | jq -er '.id') \
    || { echo "[$name] SUBMIT FAILED"; return 1; }
  echo "[$name] submitted id=$id $(date +%H:%M:%S)"
  while true; do
    status=$(curl -sS "http://127.0.0.1:${port}/v1/videos/${id}" | jq -r '.status')
    case "$status" in
      completed) break;;
      failed)
        echo "[$name] FAILED"
        curl -sS "http://127.0.0.1:${port}/v1/videos/${id}" > "$OUT/${name}.error.json"
        return 1;;
    esac
    sleep 10
  done
  t1=$(date +%s)
  curl -sS -L "http://127.0.0.1:${port}/v1/videos/${id}/content" -o "$OUT/${name}.mp4"
  echo "[$name] DONE wall=$((t1-t0))s"
}

case "${1:-engine}" in
engine)
  write_reqs
  worker() { # port arm1 arm2
    submit_and_wait "$1" "$OUT/req_$2.json" "$2"
    submit_and_wait "$1" "$OUT/req_$3.json" "$3"
  }
  worker 30010 A1_omni_userprompt_defaults A4_control_styleimgs_w0_20st &
  worker 30020 A2_videoonly_userprompt_20st A5_videoaudio_userprompt_20st &
  worker 30030 A3_videoonly_w0_20st D1_nuplan_rain_videoonly_20st &
  wait
  ;;
real) echo "reserved";;
esac
echo "MATRIX PHASE $1 COMPLETE $(date +%H:%M:%S)"
