# Drive

A real in-memory scenario editor whose compiled 20-second scenario can be driven
interactively. Drive reuses the scenario editor's document, controller, actor
library, inspector, header, and timeline rather than maintaining parallel UI.

## Shape

```
page.tsx ─ requireAppContext, then DriveClient
DriveClient.tsx ─ composes the real editor regions:
   EditorHeader          shared authoring header and viewport settings
   ActorLibraryRail      controller-backed actor and environment placement
   EditorOverlayHost     selected-actor details
   ScenarioTimelineDock  authored actor lanes and world transport
   CityView              map and authored/live actor rendering
cameras/PoleCameraGrid.tsx ─ real feed beside a twin render, per pole camera
pole-cameras.ts ─ resolves rigs + map signal features
```

`useEditorRuntime` opens a genuine blank `EditorDocument` in memory and binds an
`EditorController` to the viewer, lane index, and indexed ground sampler. The
local `AuthoredWorldSource` compiles that document through the normal playback
compiler and starts its `WorldSession` input in the live-world worker. Truth
frames drive the viewer imperatively; React does not re-render per simulation
tick.
## Running it

A live world needs a browser manifest and a lane topology. Both can be supplied
directly, so an un-ingested bundle is drivable without the authoring
publication pipeline:

```
/dashboard/drive
  ?manifest=/map-bundles/<name>/3d/manifest.json
  &lanes=/map-bundles/<name>/topology-index.json.gz
  &rigs=/drive-rigs/<name>.json     # optional pole cameras
  &twin=1                           # optional: attach to a twin on this host
```

With no `manifest`, Drive uses the first published map (preferring Richmond).
Env equivalents: `NEXT_PUBLIC_DRIVE_MAP_MANIFEST_URL`,
`NEXT_PUBLIC_DRIVE_MAP_LANES_URL`, `NEXT_PUBLIC_DRIVE_CAMERA_RIGS_URL`,
`NEXT_PUBLIC_DRIVE_TWIN_URL`. Camera feeds are proxied same-origin through
`SIMFORGE_TWIN_HTTP_ORIGIN`.

Set `NEXT_PUBLIC_DRIVE_STANDALONE` to a non-empty value to remove the Studio
app switcher and route `/` directly to Drive. In standalone mode,
`NEXT_PUBLIC_DRIVE_HOME_URL` optionally adds a single plain `Home` link to the
Drive header. Both `NEXT_PUBLIC_*` values are compiled into the client bundle,
so set them before building Studio.

Direct bundles must have the same complete sidecar closure as published maps.
The `manifest` must end in `/3d/manifest.json`; `lanes` overrides the topology
used by the live world. Missing compiler sidecars or invalid digests are surfaced
as world-start errors rather than silently falling back to an ad-hoc simulation.

## Attaching to a live twin

With `?twin=`, two further surfaces are driven by the twin rather than invented
locally:

- **Site lighting** (`environment/`) — solar elevation and azimuth computed from
  the map's own geography (`CoordinateFrame` → WGS84, no configured coordinates)
  and the authoritative clock, applied through the shipped
  `applyEditorSceneEnvironment`.
- **Camera feeds** (`@/app/lib/live-world/camera-feeds`) — one WebSocket carries
  every channel, tagged per channel with its honest feed state. Construct it in
  an effect with cleanup because the class connects in its constructor.

## Aiming a pole camera

A rig's numbers rarely match a real installation on the first try, so the
Cameras view can aim each channel by hand: compass heading, mount pitch, mount
height and the four extrinsic corrections, each editable as an exact number
because the target is a physical camera. The resolved scene yaw, vertical FOV
and final position are shown alongside, since the point is to debug an aim
rather than nudge a slider. A REAL-over-TWIN opacity overlay is the sharpest
tool here — coincident road edges and poles expose angular error that two
separate panes hide.

Adjustments live in `localStorage` per (pole, camera) and never mutate the
loaded rig. **Copy rig JSON** emits the complete payload to paste into product
configuration, which is the only durable home for calibration.

## Drive is camera and input ownership

Selecting **Enter drive** designates the selected authored vehicle (or the first
authored vehicle) as ego, starts the document's compiled transport, attaches the
camera through `followCameraPose`, and routes keys to `control` at 20 Hz. Exiting
releases the camera, clears ego ownership, and stops transmitting controls while
the authored scenario keeps playing. Authoring chrome is hidden and the timeline
is read-only only while that ownership is active.

The keyboard effect depends only on stable identities (`source`, `actorId`).
Depending on an object rebuilt per frame can tear down the listener between
keydown and keyup and leave the zero-order-held throttle active.

## Cameras on poles

A rig binds camera channels to a `SignalFeature` id — a traffic-light pole in
the map — and each channel carries its own compass bearing, pitch, mount height
and intrinsics. Pose comes from surveyed map geometry via `resolveCameraPose`
(`@simforge/maps/camera-rig`), not per-site constants. Vertical FOV is derived
from `fy` and image height.

`headingDeg` is a **compass** bearing; `resolveCameraPose` applies the −90 that
converts it to scene yaw, which is why it uses `(cos yaw, sin yaw)` and does not
repeat the local→scene `-sin` from `renderer-contract.ts`.

A pole's `zOffset` is its signal head, **not** the camera height: at Richmond the
head sits at 4.48 m while the rig is at 7 m on the same mast.

Rigs are supplied at runtime and carry the stream URLs. Map bundles are
content-addressed and must never contain endpoints or credentials.

Only the focused channel streams. Long-lived `multipart/x-mixed-replace`
responses each consume one of the browser's six connections per host, and four
of them starve map-tile streaming. Non-focused channels show an explicit paused
state — never a stale frame presented as current.
