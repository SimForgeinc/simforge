#!/usr/bin/env tsx
/**
 * osc-carla-parity — score the OSC/CARLA/esmini traces of one scenario.
 *
 * The GPU box produces the trace files (this tool does NOT run CARLA/esmini):
 *   - CARLA-native 2D simulate of the draft   -> timeline.json
 *   - CARLA-OSC 2D simulate of xoscToJobSpec() -> timeline.json
 *   - esmini headless of the same .xosc        -> state.csv
 * See docs/plans/2026-07-23-openscenario-carla-e2e-plan.md for the emit steps.
 *
 * It then answers, deterministically:
 *   - Is the OSC run identical to the native run in CARLA?
 *     (native-CARLA vs OSC-CARLA parity — the live confirmation of the static
 *      round-trip proof.)
 *   - Is esmini identical to CARLA? (CARLA vs esmini parity — decides whether
 *     esmini can stay a cheap validator, or only for nominal cases.)
 *   - Is the motion kinematically plausible? (lint checklist on the CARLA run.)
 *
 * Usage:
 *   tsx osc-carla-parity.ts \
 *     --carla-native native/timeline.json \
 *     --carla-osc    osc/timeline.json \
 *     --esmini-csv   esmini/state.csv \
 *     [--kinds kinds.json] [--position-m 0.5] [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";

import { parseEsminiCsv } from "../esmini-state-log";
import { CarlaTimelineFrameSchema } from "../carla-live-e2e";
import {
  buildPostSimChecklist,
  compareRuns,
  parityToChecks,
  summarizeChecks,
  tracksFromCarlaTimeline,
  tracksFromEsminiTrajectories,
  type CheckActorTrack,
  type ScenarioCheck,
} from "../scenario-checks/index";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadTimeline(path: string): CheckActorTrack[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  // timeline.json is either an array of frames or { frames: [...] }.
  const frames = Array.isArray(raw) ? raw : (raw.frames ?? raw.actor_frame_samples ?? []);
  const parsed = frames.map((f: unknown) => CarlaTimelineFrameSchema.parse(f));
  return tracksFromCarlaTimeline(parsed);
}

function loadEsmini(path: string, kinds: Record<string, CheckActorTrack["kind"]>): CheckActorTrack[] {
  const csv = readFileSync(path, "utf8");
  const parsed = parseEsminiCsv(csv);
  return tracksFromEsminiTrajectories(parsed.trajectories, kinds);
}

function main(): void {
  const nativePath = arg("carla-native");
  const oscPath = arg("carla-osc");
  const esminiPath = arg("esmini-csv");
  const kindsPath = arg("kinds");
  const positionM = arg("position-m") ? Number(arg("position-m")) : undefined;
  const jsonOut = arg("json");

  const kinds: Record<string, CheckActorTrack["kind"]> = kindsPath
    ? JSON.parse(readFileSync(kindsPath, "utf8"))
    : {};

  const native = nativePath ? loadTimeline(nativePath) : null;
  const osc = oscPath ? loadTimeline(oscPath) : null;
  const esmini = esminiPath ? loadEsmini(esminiPath, kinds) : null;

  const checks: ScenarioCheck[] = [];
  const tol = { positionM };

  if (native && osc) {
    const r = compareRuns(native, osc, tol);
    checks.push(...parityToChecks(r, "native-CARLA vs OSC-CARLA"));
    console.log(
      `\nOSC == native (CARLA): ${r.withinTolerance ? "PASS" : "FAIL"}  max pos err ${r.maxPositionErrorM} m`,
    );
    for (const a of r.perActor) {
      console.log(`  ${a.actorId}: max ${a.maxPositionErrorM} m, mean ${a.meanPositionErrorM} m over ${a.samplesCompared} samples`);
    }
  }

  const carlaRef = native ?? osc;
  if (carlaRef && esmini) {
    const r = compareRuns(carlaRef, esmini, tol);
    checks.push(...parityToChecks(r, "CARLA vs esmini"));
    console.log(
      `\nesmini == CARLA: ${r.withinTolerance ? "PASS" : "FAIL"}  max pos err ${r.maxPositionErrorM} m`,
    );
    for (const a of r.perActor) {
      console.log(`  ${a.actorId}: max ${a.maxPositionErrorM} m, mean ${a.meanPositionErrorM} m over ${a.samplesCompared} samples`);
    }
    if (r.unmatched.length) console.log(`  unmatched actors: ${r.unmatched.join(", ")}`);
  }

  // Lint the CARLA run (native preferred).
  if (carlaRef) {
    const report = buildPostSimChecklist({ tracks: carlaRef });
    checks.push(...report.checks.filter((c) => c.category !== "osc"));
    const bad = report.checks.filter((c) => c.status !== "pass");
    console.log(`\nKinematic lint: ${report.verdict.toUpperCase()}  (${report.passed} pass, ${report.warned} warn, ${report.failed} fail)`);
    for (const c of bad) console.log(`  [${c.status}] ${c.actorId ?? "-"} ${c.id}: ${c.detail}`);
  }

  const summary = summarizeChecks(checks);
  console.log(`\nOVERALL: ${summary.verdict.toUpperCase()}  (${summary.passed} pass, ${summary.warned} warn, ${summary.failed} fail)`);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }

  process.exit(summary.verdict === "fail" ? 1 : 0);
}

main();
