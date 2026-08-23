import { describe, expect, it } from "vitest";
import { parseXoscToActors, XoscImportError } from "../xosc/importer";
import { xoscToJobSpec } from "../xosc/job-spec";

/**
 * These exercise the importer against hand-written OpenSCENARIO 1.0 fragments —
 * independent of the in-house writer — so parse behavior and placement-mode
 * inference are locked on their own. The writer<->parser round trip is proven
 * separately in apps/web/test/unit/scenario-editor/xosc-roundtrip.test.ts.
 */

function doc(entities: string, storyboard: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="0" date="2026-07-23T00:00:00Z" description="unit" author="test"/>
  <RoadNetwork><LogicFile filepath="Town03.xodr"/></RoadNetwork>
  <Entities>${entities}</Entities>
  <Storyboard>${storyboard}</Storyboard>
</OpenSCENARIO>`;
}

const VEHICLE_ENTITY = `<ScenarioObject name="veh"><Vehicle name="vehicle.tesla.model3" vehicleCategory="car"/></ScenarioObject>`;
const WALKER_ENTITY = `<ScenarioObject name="ped"><Pedestrian name="walker.pedestrian.0001" pedestrianCategory="pedestrian" model="walker.pedestrian.0001"/></ScenarioObject>`;

function initBlock(entityRef: string, x: number, y: number, hRad: number, speedMps: number): string {
  return `<Private entityRef="${entityRef}">
    <PrivateAction><TeleportAction><Position><WorldPosition x="${x}" y="${y}" z="0" h="${hRad}" p="0" r="0"/></Position></TeleportAction></PrivateAction>
    <PrivateAction><LongitudinalAction><SpeedAction>
      <SpeedActionDynamics dynamicsShape="step" value="0" dynamicsDimension="time"/>
      <SpeedActionTarget><AbsoluteTargetSpeed value="${speedMps}"/></SpeedActionTarget>
    </SpeedAction></LongitudinalAction></PrivateAction>
  </Private>`;
}

function followTrajectory(
  entityRef: string,
  vertices: Array<{ x: number; y: number; time?: number }>,
  timed: boolean,
): string {
  const verts = vertices
    .map(
      (v) =>
        `<Vertex time="${v.time ?? 0}"><Position><WorldPosition x="${v.x}" y="${v.y}" z="0" h="0" p="0" r="0"/></Position></Vertex>`,
    )
    .join("");
  const timeRef = timed
    ? `<TimeReference><Timing domainAbsoluteRelative="absolute" scale="1" offset="0"/></TimeReference>`
    : `<TimeReference><None/></TimeReference>`;
  return `<ManeuverGroup name="${entityRef}_group" maximumExecutionCount="1">
    <Actors selectTriggeringEntities="false"><EntityRef entityRef="${entityRef}"/></Actors>
    <Maneuver name="${entityRef}_maneuver"><Event name="${entityRef}_e" priority="overwrite">
      <Action name="${entityRef}_a"><PrivateAction><RoutingAction><FollowTrajectoryAction>
        <Trajectory name="${entityRef}_traj" closed="false"><ParameterDeclarations/><Shape><Polyline>${verts}</Polyline></Shape></Trajectory>
        ${timeRef}
        <TrajectoryFollowingMode followingMode="position"/>
      </FollowTrajectoryAction></RoutingAction></PrivateAction></Action>
    </Event></Maneuver>
  </ManeuverGroup>`;
}

function story(groups: string): string {
  return `<Init><Actions>__INIT__</Actions></Init><Story name="MainStory"><Act name="MainAct">${groups}</Act></Story>`;
}

describe("parseXoscToActors", () => {
  it("imports a path-mode vehicle: spawn from Teleport, mode from TimeReference/None", () => {
    const xml = doc(
      VEHICLE_ENTITY,
      story(followTrajectory("veh", [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 25, y: 5 },
      ], false)).replace(
        "__INIT__",
        initBlock("veh", 0, 0, 0, 30 / 3.6),
      ),
    );
    const result = parseXoscToActors(xml);
    expect(result.logicFile).toBe("Town03.xodr");
    expect(result.actors).toHaveLength(1);
    const a = result.actors[0]!;
    expect(a.id).toBe("veh");
    expect(a.kind).toBe("vehicle");
    expect(a.blueprint).toBe("vehicle.tesla.model3");
    expect(a.placement_mode).toBe("path");
    expect(a.spawn_point).toEqual({ x: 0, y: 0 });
    expect(a.speed_kph).toBeCloseTo(30, 4);
    // spawn(0,0) is vertex 0; destination is the last vertex; middle is path_placement.
    expect(a.destination_point).toEqual({ x: 25, y: 5 });
    expect(a.path_placement).toEqual([{ x: 10, y: 0 }]);
  });

  it("imports a timed_path walker: TimeReference/Timing -> timed_waypoints (x/y/time)", () => {
    const xml = doc(
      WALKER_ENTITY,
      story(followTrajectory("ped", [
        { x: 15, y: -3, time: 0 },
        { x: 15, y: 3, time: 4 },
      ], true)).replace("__INIT__", initBlock("ped", 15, -3, 1.5708, 5 / 3.6)),
    );
    const result = parseXoscToActors(xml);
    const a = result.actors[0]!;
    expect(a.kind).toBe("walker");
    expect(a.blueprint).toBe("walker.pedestrian.0001");
    expect(a.placement_mode).toBe("timed_path");
    expect(a.timed_waypoints).toEqual([
      { x: 15, y: -3, time: 0 },
      // speed_kph reconstructed from the timing: 6 m / 4 s = 1.5 m/s = 5.4 kph.
      { x: 15, y: 3, time: 4, speed_kph: 5.4 },
    ]);
    expect(a.spawn_yaw).toBeCloseTo(90, 3);
  });

  it("recovers actor role from <Property name=\"role\">", () => {
    const egoEntity = `<ScenarioObject name="veh"><Vehicle name="vehicle.tesla.model3" vehicleCategory="car"><Properties><Property name="role" value="ego"/></Properties></Vehicle></ScenarioObject>`;
    const xml = doc(egoEntity, story("").replace("__INIT__", initBlock("veh", 0, 0, 0, 0)));
    expect(parseXoscToActors(xml).actors[0]!.role).toBe("ego");
  });

  it("role is null when no role Property is present (legacy .xosc)", () => {
    const xml = doc(VEHICLE_ENTITY, story("").replace("__INIT__", initBlock("veh", 0, 0, 0, 0)));
    expect(parseXoscToActors(xml).actors[0]!.role).toBeNull();
  });

  it("recovers stop_at_stop_line from its Property and carries it into the job_spec", () => {
    // The parking-runway compliance flag (PR-538): the managed OpenSCENARIO
    // contract carries it as an entity Property, the same transport as role.
    const compliant = `<ScenarioObject name="veh"><Vehicle name="vehicle.tesla.model3" vehicleCategory="car"><Properties><Property name="role" value="ego"/><Property name="stop_at_stop_line" value="true"/></Properties></Vehicle></ScenarioObject>`;
    const xml = doc(compliant, story("").replace("__INIT__", initBlock("veh", 0, 0, 0, 5)));
    expect(parseXoscToActors(xml).actors[0]!.stop_at_stop_line).toBe(true);
    expect(xoscToJobSpec(xml, { mapName: "Town03" }).actors[0]!.stop_at_stop_line).toBe(true);

    const explicit = xml.replace('value="true"', 'value="false"');
    expect(parseXoscToActors(explicit).actors[0]!.stop_at_stop_line).toBe(false);
    expect(xoscToJobSpec(explicit, { mapName: "Town03" }).actors[0]!.stop_at_stop_line).toBe(false);
  });

  it("stop_at_stop_line is null/omitted when the .xosc has no such Property (legacy)", () => {
    const xml = doc(VEHICLE_ENTITY, story("").replace("__INIT__", initBlock("veh", 0, 0, 0, 5)));
    expect(parseXoscToActors(xml).actors[0]!.stop_at_stop_line).toBeNull();
    // Byte-parity: the key must be ABSENT from the job_spec actor, not false.
    expect("stop_at_stop_line" in xoscToJobSpec(xml, { mapName: "Town03" }).actors[0]!).toBe(false);
  });

  it("job_spec keeps the recovered ego role (falls back to kind default when absent)", () => {
    const egoEntity = `<ScenarioObject name="veh"><Vehicle name="vehicle.tesla.model3" vehicleCategory="car"><Properties><Property name="role" value="ego"/></Properties></Vehicle></ScenarioObject>`;
    const egoXml = doc(egoEntity, story("").replace("__INIT__", initBlock("veh", 0, 0, 0, 0)));
    expect(xoscToJobSpec(egoXml, { mapName: "Town03" }).actors[0]!.role).toBe("ego");
    // role-less vehicle -> kind default "traffic"
    const plainXml = doc(VEHICLE_ENTITY, story("").replace("__INIT__", initBlock("veh", 0, 0, 0, 0)));
    expect(xoscToJobSpec(plainXml, { mapName: "Town03" }).actors[0]!.role).toBe("traffic");
  });

  it("reconstructs per-waypoint speed_kph from a Timing trajectory's position/time", () => {
    // 10 m in 1 s = 36 kph; then 20 m in 1 s = 72 kph.
    const xml = doc(
      WALKER_ENTITY,
      story(followTrajectory("ped", [
        { x: 0, y: 0, time: 0 },
        { x: 10, y: 0, time: 1 },
        { x: 30, y: 0, time: 2 },
      ], true)).replace("__INIT__", initBlock("ped", 0, 0, 0, 0)),
    );
    const wps = parseXoscToActors(xml).actors[0]!.timed_waypoints;
    expect(wps[0]!.speed_kph).toBeUndefined(); // first waypoint has no segment
    expect(wps[1]!.speed_kph).toBeCloseTo(36, 4);
    expect(wps[2]!.speed_kph).toBeCloseTo(72, 4);
  });

  it("imports a spawn-only entity (no maneuver) as point mode", () => {
    const xml = doc(
      VEHICLE_ENTITY,
      story("").replace("__INIT__", initBlock("veh", 3, 4, 0, 0)),
    );
    const a = parseXoscToActors(xml).actors[0]!;
    expect(a.placement_mode).toBe("point");
    expect(a.spawn_point).toEqual({ x: 3, y: 4 });
    expect(a.path_placement).toEqual([]);
    expect(a.timed_waypoints).toEqual([]);
  });

  it("throws when an entity has no Init spawn", () => {
    const xml = doc(
      VEHICLE_ENTITY,
      story("").replace("__INIT__", ""),
    );
    expect(() => parseXoscToActors(xml)).toThrow(XoscImportError);
  });

  it("throws on a document with no OpenSCENARIO root", () => {
    expect(() => parseXoscToActors("<Nope/>")).toThrow(XoscImportError);
  });

  it("compiles a parsed .xosc into a submittable simulate job_spec", () => {
    const xml = doc(
      VEHICLE_ENTITY,
      story(followTrajectory("veh", [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
      ], false)).replace("__INIT__", initBlock("veh", 0, 0, 0, 30 / 3.6)),
    );
    const spec = xoscToJobSpec(xml, { mapName: "Town03", scenarioId: "scn_1" });
    expect(spec.type).toBe("simulate");
    expect(spec.no_rendering_mode).toBe(true);
    expect(spec.render_enabled).toBe(false);
    expect(spec.fixed_delta_seconds).toBe(0.05);
    expect(spec.map_name).toBe("Town03");
    expect(spec.scenario_id).toBe("scn_1");
    expect(spec.source_format).toBe("openscenario-1.0");
    expect(spec.actors).toHaveLength(1);
    const actor = spec.actors[0]!;
    expect(actor.placement_mode).toBe("path");
    expect(actor.autopilot).toBe(false);
    expect(actor.role).toBe("traffic");
    expect(actor.destination_point).toEqual({ x: 30, y: 0 });
  });

  it("render mode flips the rendering flags", () => {
    const xml = doc(
      VEHICLE_ENTITY,
      story("").replace("__INIT__", initBlock("veh", 1, 2, 0, 0)),
    );
    const spec = xoscToJobSpec(xml, { mapName: "Town03", type: "render" });
    expect(spec.type).toBe("render");
    expect(spec.no_rendering_mode).toBe(false);
    expect(spec.render_enabled).toBe(true);
  });

  it("throws without a map name", () => {
    const xml = doc(VEHICLE_ENTITY, story("").replace("__INIT__", initBlock("veh", 0, 0, 0, 0)));
    expect(() => xoscToJobSpec(xml, { mapName: "" })).toThrow();
  });

  it("recovers duration from the Storyboard StopTrigger", () => {
    const sb = `<Init><Actions>${initBlock("veh", 0, 0, 0, 0)}</Actions></Init>
      <Story name="S"><Act name="A">${followTrajectory("veh", [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
      ], false)}</Act></Story>
      <StopTrigger><ConditionGroup><Condition name="stop" delay="0" conditionEdge="rising">
        <ByValueCondition><SimulationTimeCondition value="19" rule="greaterOrEqual"/></ByValueCondition>
      </Condition></ConditionGroup></StopTrigger>`;
    const xml = doc(VEHICLE_ENTITY, sb);
    expect(parseXoscToActors(xml).durationSeconds).toBe(19);
  });
});
