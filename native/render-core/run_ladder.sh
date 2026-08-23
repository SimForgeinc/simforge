#!/usr/bin/env bash
# WSB4 lighting-ladder + weather-ladder capture script (deterministic inputs).
set -e
BIN="/home/path/UniScenarios-ws/wsb4-realism-stack/native/target/debug/native-render"
CORPUS=/home/path/UniScenarios/scripts/renderer-spike/corpus
GLBS="$CORPUS/road.glb,$CORPUS/tile_2_4.glb,$CORPUS/tile_2_5.glb,$CORPUS/tile_2_6.glb,$CORPUS/tile_3_5.glb"
EYE="580.45 14.44 -1655.66"; TGT="590.40 14.35 -1648.96"
OUT="$(dirname "$0")/out"; mkdir -p "$OUT"
run() { # rung profile weather out extra...
  local r=$1 p=$2 w=$3 o=$4; shift 4
  echo "== rung=$r profile=$p weather=$w -> $o"
  "$BIN" --glbs "$GLBS" --eye $EYE --target $TGT \
    --width 736 --height 416 --cameras 1 --warmup 24 --frames 3 \
    --rung "$r" --profile "$p" --weather "$w" --out "$OUT/$o" "$@" | tail -2
}
# Lighting ladder (sensor profile, fixed EV — hash-stable)
run 0 sensor clear ladder-r0-sensor --lux 12000 --ambient 1.2
run 1 sensor clear ladder-r1-sensor
run 2 sensor clear ladder-r2-sensor
run 3 sensor clear ladder-r3-sensor
run 4 sensor clear ladder-r4-sensor
# Profiles from one scene state
run 2 cinematic clear profile-cinematic-clear --taa
run 2 sensor clear profile-sensor-clear
# Weather ladder (cinematic)
run 2 cinematic fog weather-fog-cinematic
run 2 cinematic rain weather-rain-cinematic --ssr
run 2 cinematic night weather-night-cinematic
# Weather ladder (sensor, for measurement)
run 2 sensor fog weather-fog-sensor
run 2 sensor rain weather-rain-sensor
run 2 sensor night weather-night-sensor
