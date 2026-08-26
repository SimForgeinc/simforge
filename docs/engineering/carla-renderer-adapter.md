# CARLA renderer adapter and conformance plan

Status: public concrete backend and deterministic worker runtime implemented,
with dependency-free fake-CARLA conformance coverage, verified 2026-08-08.
This document uses upstream project documentation and repositories as primary
sources. Fake-backend conformance is not presented as a real GPU/CARLA
qualification run; the latter remains an explicit acceptance gate.

## Verified compatibility facts

- ASAM lists OpenSCENARIO XML **1.4.0**, released **2026-05-19**, as the
  current XML standard. The official deliverable and schema are linked from
  [ASAM's standard page](https://www.asam.net/standards/detail/openscenario-xml/)
  and the [1.4.0 publication](https://publications.pages.asam.net/standards/ASAM_OpenSCENARIO/ASAM_OpenSCENARIO_XML/v1.4.0/index.html).
- CARLA **0.10.0** is the Unreal Engine **5.5** line according to the
  [official release announcement](https://carla.org/2024/12/19/release-0.10.0/).
  CARLA also published **0.9.16** for the UE4.26 line, and GitHub currently
  marks it latest in the [official release listing](https://github.com/carla-simulator/carla/releases).
- The current ScenarioRunner release is **0.9.16**, paired with CARLA 0.9.16
  in its [official repository compatibility table](https://github.com/carla-simulator/scenario_runner).
  Its documented XML implementation is OpenSCENARIO **1.0**, with only a
  subset of actions, conditions, stories, and Storyboard implemented; the
  project explicitly directs users to its parser for the exact subset in
  [OpenSCENARIO support](https://github.com/carla-simulator/scenario_runner/blob/master/Docs/openscenario_support.md).
- The upstream ScenarioRunner pull request list shows
  [PR 1163](https://github.com/carla-simulator/scenario_runner/pull/1163),
  opened 2026-05-28 for CARLA 0.10.0/UE5 compatibility. An open compatibility
  PR is evidence of active work, not released support.

Therefore stock ScenarioRunner must not receive native SimForge XML 1.4 or
be treated as the authoritative runtime. A CARLA/UE plugin is also not the
starting point. The public Python API is sufficient to test the thin bridge;
consider a plugin only if exact custom-map signal or required asset bindings
cannot be exposed through that API.

## Architecture

The authoritative pipeline, implemented in
`adapters/carla-exec/simforge_oss_carla_exec/runtime`, is:

1. Validate the authored scenario and exact OpenDRIVE/controller/head bindings.
2. Compile once with the SimForge evaluator into an immutable 50 Hz trace
   plus actor lifecycle, event, signal, weather, light/siren, collision
   expectation, and provenance streams.
3. Hash the trace, complete XODR, catalogs/assets, bridge protocol, CARLA build,
   sensor configuration, and comparison thresholds.
4. Give those immutable inputs to the optional local CARLA CLI, or to a cloud
   adapter that imports the exact same public wheel. The browser never imports
   or controls CARLA.
5. The service loads the identical OpenDRIVE/custom-map package, configures one
   synchronous tick owner and a fixed 0.02 s delta, freezes native traffic-light
   cycling, resolves every actor/head exactly, and applies one authoritative
   frame per CARLA tick.
6. CARLA records actor state, lane/road projection, collisions, signals, RGB and
   requested sensors. The existing trace comparator consumes that external
   result using the same stable actor identities.
7. Independently, a ScenarioRunner 1.0 down-converter may run only when its
   feature gate says every required semantic is exact. Approximate or unknown
   mappings block native execution. Its result is compared to the same
   authoritative trace and never replaces it.

[CARLA's foundations documentation](https://carla.readthedocs.io/en/latest/foundations/)
requires synchronous mode plus `fixed_delta_seconds`; it also warns that only
one client should tick the server and that Traffic Manager must be synchronous.
The bridge owns that responsibility.

## Capability matrix

`Exact` means exact at the control-stream boundary. It does not claim CARLA
physics produced the motion. `Approximate` is always visible in evidence and is
blocking for the native ScenarioRunner gate.

| SimForge semantic | ScenarioRunner 1.0 | Trace-authority bridge | Notes / gate |
| --- | --- | --- | --- |
| Initial/final actor lifecycle | Approximate | Exact | Spawn/destroy on frame edge; catalog/blueprint binding must be unique. |
| World trajectory and heading | Approximate | Exact | Pose/velocity applied every fixed step; compare before accepting. |
| Speed actions | Exact subset | Exact | Native only for parser-supported absolute-speed shape/dynamics. |
| Routes | Approximate | Exact result | Bridge replays compiled result; route identity remains provenance. |
| Lane changes / pull-over | Approximate | Exact result | Native dynamics cannot inherit trace-parity status. |
| Traffic head states | Unsupported for required fidelity | Exact | Freeze and address by OpenDRIVE ID; position is a cross-check, never ownership. |
| Controller programs / preemption | Unsupported | Exact result | SimForge evaluator owns stage/conflict semantics. |
| Flashing signal phases | Unsupported | Approximate | Schedule `Yellow/Red` and `Off` edges; CARLA has no flashing enum. |
| Vehicle indicators/headlights | Approximate | Exact where blueprint supports bits | Probe blueprint, record applied/read-back state. |
| Siren | Unsupported | Approximate | Require an allowlisted blueprint/component; never infer from emergency category. |
| Pedestrian trajectories | Approximate | Exact pose; approximate gait | Public walker control exists, but animation parity is not motion parity. |
| Static objects/custom props | Approximate | Exact only with catalog asset | Procedural/unbound props fail closed. |
| Weather | Approximate | Exact mapped fields | Reject unknown/unmapped weather fields. |
| Collision observation | Approximate | Exact observed edges | Collision sensors report frame/time/pair; unexpected/missing pairs fail comparison. |
| Stop-line behavior | Approximate | Exact result + observation | Authoritative trajectory and exact head state; verify lane/stop waypoint occupancy. |
| RGB/depth/segmentation/lidar/radar | Unsupported | Exact sensor invocation | Calibration and sensor tick are immutable inputs. |
| OpenDRIVE standalone geometry | Approximate | Exact XODR input | Runtime generation is possible; production visuals may require a packaged map. |
| Full custom visual map/assets | Unsupported | Exact if prepackaged | Package for the target CARLA build; XODR digest still must match. |
| Occlusion and rubric metrics | Unsupported | SimForge exact | CARLA sensors are supporting evidence, not a replacement evaluator. |

CARLA exposes manual signal state, global freezing, signal groups, stop/affected
lane waypoints, pole index, and `get_opendrive_id()` in its
[Python API](https://carla.readthedocs.io/en/latest/python_api/). These APIs make
exact-ID signal binding plausible, but every target CARLA/map build must pass a
binding inventory test before scenario execution. The exposed states are red,
yellow, green, off, and unknown; flashing is not native.

CARLA can generate a world from XODR through
[`generate_opendrive_world`](https://carla.readthedocs.io/en/latest/tuto_G_openstreetmap/).
That mode is useful for geometry conformance. A visually complete production
world needs the custom map's geometry/assets packaged for the selected engine;
the 0.9.15 custom-map documentation requires FBX plus XODR. UE5 ingestion must
be qualified on the actual 0.10 build rather than assumed from UE4 instructions.

CARLA documents RGB, depth, segmentation, lidar, radar and collision sensors in
its [sensor reference](https://carla.readthedocs.io/en/latest/ref_sensors/).
Collision events include frame, timestamp, actor, other actor, and impulse.
Vehicle/walker/light state and camera output can therefore be evidence outputs.

## Binding and control details

### Actors and assets

The manifest maps every canonical actor ID to exactly one allowlisted CARLA
blueprint plus dimensions and optional visual attributes. Before ticking, the
service verifies the blueprint exists and records its actual bounding box.
Dimension mismatch outside a declared tolerance blocks fidelity acceptance.
Pedestrians use stable IDs and record gait/animation as appearance metadata.
Props without a shipped asset binding fail before world mutation.

Vehicle light bits are applied and read back. A siren requires a specific,
tested asset contract because CARLA's generic vehicle light state is not a
portable emergency-audio interface. Unsupported sirens remain an explicit
rendering discrepancy even when the vehicle trajectory is exact.

### Signals and stop lines

Inventory all `TrafficLight` actors after map load. Bind `get_opendrive_id()` to
the exact authored physical-head ID and require one result. Group/pole index,
light boxes, positions, affected lanes, and stop waypoints are consistency
checks only. Duplicate, absent, stale-control-digest, or ambiguous bindings
reject the job. Freeze native cycling before applying the first frame. Record
requested and read-back state on every edge.

Flashing yellow/red is represented as scheduled state/off edges at a declared
frequency, marked approximate because CARLA has no flashing state and public
traffic behavior may interpret `Off` differently. Four-way-stop arbitration is
unsupported until explicitly implemented in SimForge; flashing red retains
the fail-safe label.

### Motion, collisions, and determinism

Trajectory replay applies pose plus linear/angular velocity in a synchronous
batch immediately before each tick. Physics/autopilot is disabled for replayed
actors so CARLA cannot silently rewrite semantics. Collision sensors still
record overlaps, but CARLA response does not alter the next authoritative pose.
This is a renderer parity mode, not a CARLA-physics validation mode.

For a later control-input mode, apply throttle/brake/steer or WalkerControl and
let CARLA physics own motion. That mode needs a different capability label and
looser comparator profile. Never show its result as trajectory replay.

Deterministic reruns require identical CARLA server/client builds, map/assets,
fixed delta, seeds, quality settings, sensor attributes, GPU/driver, and one tick
owner. Camera pixels may still vary across GPU/driver builds; numerical actor,
event and signal gates remain primary.

## ScenarioRunner compatibility exporter

The down-converter targets real OpenSCENARIO 1.0 and emits a per-feature report.
Before writing XML, derive required semantic identifiers and run the versioned
gate in `adapters/carla-exec/simforge_oss_carla_exec/capabilities.py`.
Unknown, unsupported, or approximate identifiers block execution. The initial
exact allowlist is intentionally tiny (for example, supported absolute speed).
Expand it only with an upstream parser mapping, an XSD-valid fixture, a real
ScenarioRunner execution, and comparator evidence.

No 1.4 document may be relabeled 1.0. No unsupported 1.4 construct may be
dropped. Trajectory baking is a different export profile with a different
verdict.

## Acceptance and evidence

For every required fixture, run at least three fresh reruns and retain immutable
receipts. The trajectory-replay gate is:

- initial pose equal at the first fixed frame;
- planar position error <= **0.25 m** at every required sample;
- heading error <= **2 degrees**;
- speed error <= **0.25 m/s**;
- event, lifecycle, collision, and signal edges within **one fixed step**;
- identical actor lifecycle and exact actor/signal identity closure;
- matching road/lane occupancy when both sides expose it;
- no unexpected off-road, collision, teleport, missing sensor frame, or signal
  read-back mismatch;
- byte-identical numerical report hashes across deterministic reruns (sensor
  media digests are separately scoped to a qualified hardware image).

Every result states CARLA/server/client versions, engine branch (UE4/UE5), map
and asset digests, GPU/driver, fixed step, seed, sensor configuration, bridge
revision, source trace digest, runtime duration, dropped sensor frames, and all
approximations. Missing output is failure, not zero error.

The ScenarioRunner 1.0 path additionally requires its feature gate to be all
exact and compares against the same thresholds. A green native run is
compatibility evidence only; SimForge remains the semantic authority.

## Deployment and hardware

Package the bridge as a separate Python service/container next to a pinned
CARLA server image. Mount immutable job inputs read-only; place outputs in a
bounded result volume. Do not accept browser-supplied paths, URLs, Python,
blueprint names outside the allowlist, or CARLA console commands. Enforce wall
time, output size, camera resolution/count, actor count, and sensor count.

The 0.10/UE5 path requires a modern supported OS and substantially more GPU
memory than headless numerical testing; exact hardware sizing depends on map,
resolution, Lumen/ray-tracing settings, sensor count, and target realtime
factor. Qualify representative workloads on the deployment hardware and report
median/p95 tick and sensor latency, GPU memory high-water mark, dropped frames,
and achieved simulation-to-wall-time ratio. Use CARLA no-rendering mode only for
control/conformance tests; camera acceptance necessarily enables rendering.

## Implementation and qualification status

Implemented in the public wheel:

1. The concrete CARLA Python backend and synchronous fixed-step executor.
2. Exact actor, blueprint, signal, OpenDRIVE, and asset-catalog binding gates.
3. OpenSCENARIO 1.4 compilation and official-schema validation.
4. Lifecycle, pose/control, collision, signal, stop-line, appearance, camera,
   sensor-manifest, ambient-traffic, cancellation, and parity evidence.
5. Bounded downloads/uploads, redirect and SSRF controls, deadlines, retries,
   cleanup, and output-volume limits.
6. A local CLI and a versioned wheel that SimCloud consumes unchanged.

Still hardware- and asset-specific acceptance work, not shared source work:

1. Qualify the pinned UE5 CARLA build on representative GPU hardware and
   retain three immutable rerun receipts per required fixture.
2. Certify each packaged custom map and asset catalog against exact actor and
   OpenDRIVE signal inventories.
3. Expand an optional ScenarioRunner 1.0 down-converter only when every mapping
   is exact and independently evidenced. It never replaces the 1.4 compiler.
4. Consider a CARLA/UE plugin only if public API inventory proves an exact
   required map, signal, or custom-asset binding impossible.
