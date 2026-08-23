import { describe, expect, it } from "vitest";
import {
  buildPostSimChecklist,
  compareRuns,
  parityToChecks,
  runKinematicChecks,
  runOscRoundTripChecks,
  summarizeChecks,
  tracksFromEsminiTrajectories,
  tracksFromCarlaTimeline,
  type CheckActorTrack,
} from "../scenario-checks/index";

/** A straight, constant-speed vehicle at 10 m/s, sampled at 20 Hz for 2 s. */
function constantSpeedVehicle(actorId = "veh"): CheckActorTrack {
  const samples = [];
  for (let i = 0; i <= 40; i++) {
    const t = i * 0.05;
    samples.push({ t, x: 10 * t, y: 0, yaw: 0, speed: 10 });
  }
  return { actorId, kind: "vehicle", samples };
}

describe("runKinematicChecks", () => {
  it("passes a smooth constant-speed vehicle", () => {
    const checks = runKinematicChecks([constantSpeedVehicle()]);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
    // Emits the vehicle metric set + integrity checks.
    expect(checks.map((c) => c.id)).toContain("kinematic.longitudinal_deceleration");
    expect(checks.map((c) => c.id)).toContain("integrity.position_discontinuity");
  });

  it("fails hard braking beyond the deceleration limit", () => {
    // 10 m/s -> 0 over 0.1 s = 100 m/s^2, far past the 9 m/s^2 limit.
    const samples = [
      { t: 0.0, x: 0, y: 0, yaw: 0, speed: 10 },
      { t: 0.05, x: 0.5, y: 0, yaw: 0, speed: 10 },
      { t: 0.1, x: 1.0, y: 0, yaw: 0, speed: 5 },
      { t: 0.15, x: 1.1, y: 0, yaw: 0, speed: 0 },
      { t: 0.2, x: 1.1, y: 0, yaw: 0, speed: 0 },
    ];
    const checks = runKinematicChecks([{ actorId: "veh", kind: "vehicle", samples }]);
    const decel = checks.find((c) => c.id === "kinematic.longitudinal_deceleration");
    expect(decel?.status).toBe("fail");
    expect((decel?.measuredValue ?? 0)).toBeGreaterThan(9);
  });

  it("flags a teleport as a position/speed discontinuity", () => {
    const samples = [
      { t: 0.0, x: 0, y: 0, yaw: 0, speed: 10 },
      { t: 0.05, x: 0.5, y: 0, yaw: 0, speed: 10 },
      { t: 0.1, x: 500, y: 0, yaw: 0, speed: 10 }, // jumped 500 m in one step
      { t: 0.15, x: 500.5, y: 0, yaw: 0, speed: 10 },
    ];
    const checks = runKinematicChecks([{ actorId: "veh", kind: "vehicle", samples }]);
    const pos = checks.find((c) => c.id === "integrity.position_discontinuity");
    expect(pos?.status).toBe("fail");
  });

  it("uses walker thresholds for walkers", () => {
    // 9 m/s walker — past the 7 m/s walker limit.
    const samples = Array.from({ length: 5 }, (_, i) => ({
      t: i * 0.05,
      x: 9 * i * 0.05,
      y: 0,
      yaw: 0,
      speed: 9,
    }));
    const checks = runKinematicChecks([{ actorId: "ped", kind: "walker", samples }]);
    const speed = checks.find((c) => c.id === "kinematic.walker_speed");
    expect(speed?.status).toBe("fail");
  });
});

describe("runOscRoundTripChecks", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="0" date="2026-07-23T00:00:00Z" description="t" author="test"/>
  <RoadNetwork><LogicFile filepath="Town03.xodr"/></RoadNetwork>
  <Entities><ScenarioObject name="veh"><Vehicle name="vehicle.tesla.model3" vehicleCategory="car"/></ScenarioObject></Entities>
  <Storyboard>
    <Init><Actions><Private entityRef="veh">
      <PrivateAction><TeleportAction><Position><WorldPosition x="0" y="0" z="0" h="0" p="0" r="0"/></Position></TeleportAction></PrivateAction>
      <PrivateAction><LongitudinalAction><SpeedAction>
        <SpeedActionDynamics dynamicsShape="step" value="0" dynamicsDimension="time"/>
        <SpeedActionTarget><AbsoluteTargetSpeed value="8.333333"/></SpeedActionTarget>
      </SpeedAction></LongitudinalAction></PrivateAction>
    </Private></Actions></Init>
    <Story name="S"><Act name="A">
      <ManeuverGroup name="veh_group" maximumExecutionCount="1">
        <Actors selectTriggeringEntities="false"><EntityRef entityRef="veh"/></Actors>
        <Maneuver name="m"><Event name="e" priority="overwrite"><Action name="a"><PrivateAction><RoutingAction><FollowTrajectoryAction>
          <Trajectory name="t" closed="false"><ParameterDeclarations/><Shape><Polyline>
            <Vertex time="0"><Position><WorldPosition x="0" y="0" z="0" h="0"/></Position></Vertex>
            <Vertex time="0"><Position><WorldPosition x="30" y="0" z="0" h="0"/></Position></Vertex>
          </Polyline></Shape></Trajectory>
          <TimeReference><None/></TimeReference>
          <TrajectoryFollowingMode followingMode="position"/>
        </FollowTrajectoryAction></RoutingAction></PrivateAction></Action></Event></Maneuver>
      </ManeuverGroup>
    </Act></Story>
  </Storyboard>
</OpenSCENARIO>`;

  it("passes a faithful round-trip", () => {
    const checks = runOscRoundTripChecks(
      [
        {
          id: "veh",
          placement_mode: "path",
          spawn_point: { x: 0, y: 0 },
          spawn_yaw: 0,
          speed_kph: 30,
          path_placement: [],
          destination_point: { x: 30, y: 0 },
        },
      ],
      xml,
    );
    expect(checks.find((c) => c.id === "osc.placement_supported")?.status).toBe("pass");
    expect(checks.find((c) => c.id === "osc.round_trip")?.status).toBe("pass");
  });

  it("fails an unsupported placement mode without a round-trip", () => {
    const checks = runOscRoundTripChecks(
      [{ id: "veh", placement_mode: "road", spawn_point: { x: 0, y: 0 } }],
      xml,
    );
    expect(checks.find((c) => c.id === "osc.placement_supported")?.status).toBe("fail");
    // No round_trip check emitted for an unsupported actor.
    expect(checks.some((c) => c.id === "osc.round_trip")).toBe(false);
  });
});

describe("compareRuns (trace parity)", () => {
  it("identical traces are within tolerance with zero error", () => {
    const track = constantSpeedVehicle();
    const result = compareRuns([track], [structuredClone(track)]);
    expect(result.withinTolerance).toBe(true);
    expect(result.maxPositionErrorM).toBe(0);
    expect(result.unmatched).toEqual([]);
  });

  it("matches across different sample grids via interpolation", () => {
    // Reference at 20 Hz, candidate at 10 Hz — same underlying motion.
    const ref = constantSpeedVehicle();
    const candSamples = ref.samples.filter((_, i) => i % 2 === 0);
    const result = compareRuns([ref], [{ actorId: "veh", kind: "vehicle", samples: candSamples }]);
    expect(result.withinTolerance).toBe(true);
    expect(result.maxPositionErrorM).toBeLessThan(1e-6);
  });

  it("flags a diverging trajectory (constant 2 m offset)", () => {
    const ref = constantSpeedVehicle();
    const cand: CheckActorTrack = {
      actorId: "veh",
      kind: "vehicle",
      samples: ref.samples.map((s) => ({ ...s, y: s.y + 2 })),
    };
    const result = compareRuns([ref], [cand], { positionM: 0.5 });
    expect(result.withinTolerance).toBe(false);
    expect(result.maxPositionErrorM).toBeCloseTo(2, 3);
    const checks = parityToChecks(result, "esmini-vs-carla");
    expect(checks.find((c) => c.id === "parity.actor_trajectory")?.status).toBe("fail");
  });

  it("reports actors present in only one run as unmatched", () => {
    const a = constantSpeedVehicle("veh");
    const b = constantSpeedVehicle("other");
    const result = compareRuns([a], [b]);
    expect(result.unmatched.sort()).toEqual(["other", "veh"]);
    expect(result.withinTolerance).toBe(false);
  });
});

describe("summarizeChecks / buildPostSimChecklist", () => {
  it("verdict is fail if any check fails, warn if any warns, else pass", () => {
    expect(summarizeChecks([{ id: "a", category: "osc", status: "pass", label: "", detail: "" }]).verdict).toBe("pass");
    expect(
      summarizeChecks([
        { id: "a", category: "osc", status: "pass", label: "", detail: "" },
        { id: "b", category: "kinematic", status: "warn", label: "", detail: "" },
      ]).verdict,
    ).toBe("warn");
    expect(
      summarizeChecks([
        { id: "a", category: "osc", status: "warn", label: "", detail: "" },
        { id: "b", category: "kinematic", status: "fail", label: "", detail: "" },
      ]).verdict,
    ).toBe("fail");
  });

  it("builds tracks from a CARLA timeline (grouping samples by actor across frames)", () => {
    const frames = constantSpeedVehicle().samples.map((s) => ({
      timestamp: s.t,
      actors: [
        { authored_actor_id: "veh", kind: "vehicle", x: s.x, y: s.y, speed_mps: s.speed! },
        { authored_actor_id: "ped", kind: "walker", x: 0, y: s.x * 0.1, speed_mps: 1 },
      ],
    }));
    const tracks = tracksFromCarlaTimeline(frames);
    expect(tracks).toHaveLength(2);
    const veh = tracks.find((t) => t.actorId === "veh");
    expect(veh?.kind).toBe("vehicle");
    expect(veh?.samples).toHaveLength(41);
    expect(tracks.find((t) => t.actorId === "ped")?.kind).toBe("walker");
    const report = buildPostSimChecklist({ tracks });
    expect(report.verdict).not.toBe("fail");
  });

  it("builds a report from an esmini/2D-sim trace", () => {
    const trajectories = [
      {
        actor_id: "veh",
        points: constantSpeedVehicle().samples.map((s) => ({ t: s.t, x: s.x, y: s.y, yaw: s.yaw!, speed: s.speed! })),
      },
    ];
    const tracks = tracksFromEsminiTrajectories(trajectories, { veh: "vehicle" });
    const report = buildPostSimChecklist({ tracks, generatedAt: "2026-07-23T00:00:00Z" });
    expect(report.verdict).toBe("pass");
    expect(report.failed).toBe(0);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.generatedAt).toBe("2026-07-23T00:00:00Z");
  });
});
