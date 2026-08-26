# Drive

A continuously simulating world you can drop actors into and drive through,
presented in the same editor chrome as the rest of Studio.

Drive is a dashboard app (`DASHBOARD_APPS` in `app/lib/dashboard-nav.ts`), not a
mode of the scenario editor. That separation is deliberate and load-bearing —
see "Why not the editor" below.

## Shape

```
page.tsx ─ requireAppContext, then DriveClient
DriveClient.tsx ─ composes the real ScenarioEditorShell:
   header        mode toggle (World / Cameras), enter/exit drive, camera mode
   leftSidebar   actor palette, from @simforge/asset-catalog
   canvas        CityView from @simforge/viewer/react
   statusOverlay world status, honest connection state
   floatingOverlay telemetry
cameras/PoleCameraGrid.tsx ─ real feed beside a twin render, per pole camera
pole-cameras.ts ─ resolves rigs + map signal features
```

The world itself is not in this directory. It is a `WorldSource`
(`app/lib/live-world/`), with two implementations behind one interface:

- **local** — a real `WorldSession` from `@simforge/training-env` running in a
  Web Worker at 20 Hz (`worker/live-world-worker.ts`). No server required.
- **remote** — attaches to a live twin over WebSocket, decoding the frozen
  `u32 LE + msgpack(TruthFrame)` wire with `TruthStreamClient`.

Truth frames drive the viewer imperatively through
`ThreeRendererAdapter.applyActorFrame`; React never re-renders per tick.

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

Omitting `lanes` produces a world that runs but refuses every road actor. That
is reported once as a notice rather than left to look like a placement bug.

## Attaching to a live twin

With `?twin=`, three further surfaces come alive, all driven by the twin rather
than invented locally:

- **Replay** (`replay/ReplayDock.tsx`) — pick a start within the past 24 hours
  and a speed in the server's real 0.25×–8× range. The clock displayed is the
  server's (`twin_clock`), never a locally ticked estimate that would drift. The
  dock returns `null` for a world that cannot replay, so mounting it against a
  local world costs nothing. Server refusals are shown verbatim — replay is
  legitimately refused while a drive session is active, and that must never be
  presented as if it started.
- **Site lighting** (`environment/`) — solar elevation and azimuth computed from
  the map's own geography (`CoordinateFrame` → WGS84, no configured coordinates)
  and the authoritative clock, applied through the shipped
  `applyEditorSceneEnvironment`. Because it follows the twin's clock, a replayed
  night renders as night. The sun is continuous, not quantised to the
  `timeOfDay` presets; only the ambient appearance model remains preset-derived.
- **Camera feeds** (`@/app/lib/live-world/camera-feeds`) — one WebSocket carries
  every channel, tagged per channel with its honest feed state. This exists
  because a long-lived `multipart/x-mixed-replace` response per channel consumed
  one of the browser's six connections per host, and four of them starved
  map-tile streaming; only the focused channel could stream. Construct it in an
  effect with cleanup: the class connects in its constructor, so React
  StrictMode's double-invoke creates two instances and the cleanup must close the
  first.

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

## Why not the editor

The editor's authoring regions are bound to `EditorDocument`, a view over the
authored `ScenarioTemplateV2`, which has no tick, time, observation, velocity or
live-signal concept and carries undo/autosave. A truth stream is an observation,
not an edit. Mirroring frames into that document would file observations as
authoring changes and engage undo.

So Drive reuses the shell, the shared viewer, the tokens and the chrome, and
**must not** import `useEditorRuntime`, `EditorDocument`, `EditorController`,
`ActorLibraryRail`, the inspector or `ScenarioTimelineDock`.

## Drive is camera and input ownership

Entering drive does not change what the world is doing. It attaches the camera
to an ego via `followCameraPose` and routes keys to `control` at 20 Hz; exiting
releases the camera and stops transmitting. The world never stops, and actors
can still be placed while driving. This mirrors how playback's
`inspecting`/`presenting` states take actor and camera ownership from authoring.

Two invariants that have each caused a real bug:

- The keyboard effect depends only on stable identities (`source`, `actorId`).
  Depend on an object rebuilt per frame and the listener is torn down between
  keydown and keyup; the lost keyup leaves the zero-order-held throttle on.
- Convert speed to km/h exactly once. Truth-frame velocity is m/s; a twin's
  `telemetry.speed` is already km/h.

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
