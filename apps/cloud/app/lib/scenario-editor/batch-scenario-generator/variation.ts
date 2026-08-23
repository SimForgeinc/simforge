import type {
  BatchScenarioStrategy,
  ScenarioVariation,
  StopVariant,
} from "./types";
import { isHighwayStrategy, isLaneKeepStrategy } from "./types";
import {
  HIGHWAY_CRUISE_KPH_MAX,
  HIGHWAY_CRUISE_KPH_MIN,
  MAP_URBAN_CRUISE_KPH,
  STOP_CRUISE_SPEED_KPH_MAX,
  STOP_CRUISE_SPEED_KPH_MIN,
  STOP_HOLD_FRACTION,
  STOP_SIGN_FRACTION,
  STOP_VRU_FRACTION,
} from "./constants";
import { hashSeed, randomInRange, roundTo, seededRandom } from "./routing";

export function variationForScenario(
  strategy: BatchScenarioStrategy,
  seed: number,
  mapName: string,
  datasetId: string,
): ScenarioVariation {
  const random = seededRandom(hashSeed([datasetId, strategy, seed, mapName]));
  const spawnRange: readonly [number, number] =
    strategy === "turn_left" || strategy === "turn_right"
      ? [0.08, 0.28]
      : isLaneKeepStrategy(strategy)
        ? [0.08, 0.85]
        : strategy === "stop"
          ? [0.15, 0.6]
          : [0.15, 0.65];

  const isTurn = strategy === "turn_left" || strategy === "turn_right";
  return {
    spawnFraction: roundTo(randomInRange(random, spawnRange[0], spawnRange[1]), 3),
    // One shared draw for every strategy (stream-position discipline); stop
    // REMAPS the drawn value into its slower cruise band and the highway
    // families REMAP it into the highway cruise band — see
    // STOP_CRUISE_SPEED_KPH_MIN / HIGHWAY_CRUISE_KPH_MIN — without consuming
    // an extra draw.
    speedKph: (() => {
      const drawnSpeed = randomInRange(random, 28, 45);
      if (strategy === "stop") {
        return Math.round(
          STOP_CRUISE_SPEED_KPH_MIN +
            ((drawnSpeed - 28) / (45 - 28)) *
              (STOP_CRUISE_SPEED_KPH_MAX - STOP_CRUISE_SPEED_KPH_MIN),
        );
      }
      if (isHighwayStrategy(strategy)) {
        return Math.round(
          HIGHWAY_CRUISE_KPH_MIN +
            ((drawnSpeed - 28) / (45 - 28)) *
              (HIGHWAY_CRUISE_KPH_MAX - HIGHWAY_CRUISE_KPH_MIN),
        );
      }
      // Crowded urban maps (e.g. Munich) remap the shared 28-45 draw into a realistic
      // lower street-speed band so the subject cruises at ~30 km/h AND the runway gate isn't
      // over-demanded on short junction-dense blocks. Highway strategies (above) and
      // stop (above) keep their own bands; unlisted maps keep the default draw.
      const urbanBand = MAP_URBAN_CRUISE_KPH[mapName];
      if (urbanBand) {
        return Math.round(
          urbanBand.min +
            ((drawnSpeed - 28) / (45 - 28)) * (urbanBand.max - urbanBand.min),
        );
      }
      return Math.round(drawnSpeed);
    })(),
    // Every labeled maneuver must LAND inside the Alpamayo PAI future label
    // window (5.1s keyframe + 6.4s horizon): stop brakes at 4.5-7.5s, lane
    // changes start at 5.3-7.5s (the ~25m transition then completes inside
    // the window). Turns arm early ("at next intersection") — their timing
    // is controlled by approachTimeSeconds via the spawn fraction instead.
    // highway_exit / highway_entry consume the default 5.3-7.5 draw as their
    // gore-arrival / merge-arrival target time (inside the label window).
    instructionDelaySeconds:
      isLaneKeepStrategy(strategy)
        ? 0
        : strategy === "stop"
          ? roundTo(randomInRange(random, 4.5, 7.5), 1)
          : isTurn
            ? roundTo(randomInRange(random, 1.2, 3.2), 1)
            : roundTo(randomInRange(random, 5.3, 7.5), 1),
    approachTimeSeconds: isTurn ? roundTo(randomInRange(random, 5.6, 8.0), 1) : null,
    // Stop-only causal-variant draws. ALL of them are drawn unconditionally
    // (for the stop strategy) and AFTER the fields above, in this fixed
    // order, so (a) non-stop strategies consume zero extra draws and their
    // variation values stay byte-identical, and (b) variant fallback
    // (junction_proceed -> queue_at_junction -> lead_brake) reuses values
    // already drawn instead of shifting the stream.
    // Stop-and-HOLD v1 (dib 2026-06-23): anchor on `lead_brake` — the only variant
    // whose cause PERSISTS so the subject HOLDS to clip end (junction_proceed /
    // queue_at_junction stop-then-RESUME, and junction_proceed has no rendered
    // cause → the "stops for no reason" clips the stop_outcome audit caught: 16/20
    // uncaused, 15/20 resume). A stopped lead in the subject lane is a visible, rendered
    // cause that the metric verifies. The `random()` draw is still consumed so
    // non-stop strategies keep byte-identical variation streams. Phase 2 brings back
    // `signal_stop` (hold via a persistent red light — needs the worker to keep the
    // controlling light red) + the resume variants for the stop-and-resume metric.
    stopVariant:
      strategy === "stop"
        ? (() => {
            // Cause mix: most stops are a braking lead; a minority are a pedestrian
            // crossing (vru_yield). Both are cause-first (the subject's obstacle-stop does
            // the stopping). The single draw keeps the variation stream stable.
            const r = random();
            return (
              r < STOP_SIGN_FRACTION
                ? "stop_sign"
                : r < STOP_SIGN_FRACTION + STOP_VRU_FRACTION
                  ? "vru_yield"
                  : "lead_brake"
            ) as StopVariant;
          })()
        : undefined,
    stopMarginMeters: strategy === "stop" ? roundTo(randomInRange(random, 2, 6), 1) : null,
    stopQueueGapMeters: strategy === "stop" ? roundTo(randomInRange(random, 2, 5), 1) : null,
    stopLeadDeltaSeconds:
      strategy === "stop" ? roundTo(randomInRange(random, 1.2, 1.8), 1) : null,
    stopResumeAtSeconds:
      strategy === "stop" ? roundTo(randomInRange(random, 12.0, 13.5), 1) : null,
    stopLeadResumeAtSeconds:
      strategy === "stop" ? roundTo(randomInRange(random, 12.0, 12.5), 1) : null,
    stopRestGapMeters: strategy === "stop" ? roundTo(randomInRange(random, 3, 6), 1) : null,
    // Hold/resume mix: most caused stops RESUME (lead pulls away → subject follows — the
    // review default for "subject stops but never resumes"), but a deliberate minority
    // HOLD (lead stays stopped → subject holds → valid_stop) so the dataset carries both
    // verdicts. Drawn LAST in the stop block so earlier stop draws + every non-stop
    // strategy keep byte-identical variation streams.
    stopLeadHolds: strategy === "stop" ? random() < STOP_HOLD_FRACTION : false,
  };
}

/** Lighting presets whose derived sun altitude falls in the tasteful 25-65°
 * daylight band (weather.timeToSunAngles: MID_MORNING -> 45°, AFTERNOON ->
 * 60°). The render path only accepts presets, not raw angles. */
const BATCH_WEATHER_LIGHTING = ["MID_MORNING", "AFTERNOON"] as const;

export type BatchEnvironmentPreset = {
  lighting: string;
  weather: string;
  roadSurface: string;
};

/** Seeded per-scenario environment preset for the render path (applied by the
 * worker's apply_environment_preset from job_spec.environment_preset; the
 * submit-batch route forwards it from the draft's renderConfig). Tasteful
 * daylight only: clear or overcast skies, mid-morning/afternoon sun, mostly
 * dry roads with occasional light wetness — nothing extreme. DEDICATED rng
 * stream (the "weather" hash suffix): existing draw streams stay
 * byte-identical. Ported verbatim from the monolith batch-scenario-generator
 * (drawBatchEnvironmentPreset) during the wave-2a engine consolidation. */
export function drawBatchEnvironmentPreset(
  strategy: BatchScenarioStrategy,
  seed: number,
  mapName: string,
  datasetId: string,
): BatchEnvironmentPreset {
  const random = seededRandom(hashSeed([datasetId, strategy, seed, mapName, "weather"]));
  const lighting =
    BATCH_WEATHER_LIGHTING[Math.floor(random() * BATCH_WEATHER_LIGHTING.length)] ??
    "MID_MORNING";
  const weather = random() < 0.65 ? "CLEAR_SKY" : "OVERCAST";
  const roadSurface = random() < 0.85 ? "DRY_ROAD" : "PUDDLES";
  return { lighting, weather, roadSurface };
}
