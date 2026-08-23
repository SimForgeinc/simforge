# UniScenarios Context

This folder is the canonical context source for the project: what UniScenarios
is, why it exists, how it relates to SimCloud, and the program history that
shaped the current tree. Start here; follow links for depth.

| Document | Contents |
| --- | --- |
| [project-overview.md](./project-overview.md) | What UniScenarios is, the product goal, architecture, and how to run it |
| [program-history-2026-08.md](./program-history-2026-08.md) | The August 2026 hardening/port programs: RL pipeline, native renderer, V2X port, H3 investigation, SimCloud local port |
| [../simcloud-convergence.md](../simcloud-convergence.md) | The UniScenarios ↔ SimCloud ownership and release contract (see 2026-08 addendum) |
| [../simcloud-local-port-plan.md](../simcloud-local-port-plan.md) | Plan for the local SimCloud product shell (`apps/cloud`) |
| [../rl-platform-hardening-plan.md](../rl-platform-hardening-plan.md) | RL/sim-to-real pipeline hardening plan (WS1–WS7) |
| [../native-renderer-production-plan.md](../native-renderer-production-plan.md) | Bevy native renderer production plan (WSB1–WSB7) |
| [../v2x-port-plan.md](../v2x-port-plan.md) | V2XCarla digital-twin port plan (V1–V7) |
| [../teacher-license-decision.md](../teacher-license-decision.md) | Video-teacher decision: H3-only for research by user directive (2026-08-23); prior license analysis retained as history |

## One-paragraph summary

UniScenarios is a deterministic, local-first autonomous-vehicle scenario
platform: a TypeScript scenario model + simulation engine + editor runtime that
authors, simulates, replays, and exports (OpenSCENARIO 1.4/OpenDRIVE) driving
scenarios on real map assets, with a browser three.js renderer and a Bevy
(Rust) native renderer for sensor-grade and cinematic output, plus adapters for
RL training (gym), CARLA compatibility, SUMO ambient traffic, and V2X digital
twins. The commercial product surface is SimForge/SimCloud, whose entire
dashboard + scenario editor now also runs fully locally from this repo
(`apps/cloud`) against an embedded Postgres, a filesystem object store, and an
optional local render/compile worker — the cloud and the laptop run the same
product code over the same vendored engine.
