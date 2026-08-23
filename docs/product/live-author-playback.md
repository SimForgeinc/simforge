# Live author playback

Normal Studio **Play** runs the canonical deterministic engine live in one
persistent browser worker. The authoring world is materialized only through its
warmed `t=0` state. Pressing Play records a 250 ms lead, makes that state visible,
then streams bounded quarter-second fixed-step batches while wall-clock playback
advances. Pause/resume controls both presentation and the live producer; Escape cancels the producer,
discards derived playback state, and restores the unchanged authoring document.
The scrubber is clamped to the range already recorded. A completed trace is
cached with the persistent world and subsequent replay is immediate.

The engine session and offline `runSimulation` use the same tick loop, dynamic-v1
backend, signals, triggers, actor/static collisions, and trace builder. Validation,
robustness evaluation, and export continue to use headless full-trace execution.

## Latency contract

With the map, topology, and authoring world cached, Play should show its first
moving state within 250 ms of the input event. The worker does not simulate the
20-second clip before playback starts. A cold map is outside that 250 ms budget:
network/cache latency for topology and initial scenario materialization must
finish first, and Studio reports that loading state instead of dropping actors
or substituting a regenerated traffic population.

The worker yields after at most 250 ms of simulated time per batch and paces
those batches close to wall time. Rendering
may clamp briefly to the latest recorded tick under extreme CPU pressure, but
simulation ticks are never skipped and completed traces remain byte-identical to
offline output.
