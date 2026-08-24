# SimForge Context

This folder is the canonical repository context source for what SimForge is,
why it exists, how it relates to SimForge Cloud, and how the current repository
was produced.

| Document | Purpose |
|---|---|
| [project-overview.md](project-overview.md) | Current product, architecture, repository layout, and verification culture |
| [program-history-2026-08.md](program-history-2026-08.md) | Historical record of the August 2026 worktree programs; pre-rebrand names are retained |
| [../engineering/simcloud-convergence.md](../engineering/simcloud-convergence.md) | SimForge ↔ SimForge Cloud ownership and release contract |
| [../engineering/simcloud-local-port-plan.md](../engineering/simcloud-local-port-plan.md) | Historical plan that created the local product now at `studio/` |
| [../research/rl-platform-hardening-plan.md](../research/rl-platform-hardening-plan.md) | RL and sim-to-real hardening program |
| [../engineering/native-renderer-production-plan.md](../engineering/native-renderer-production-plan.md) | Historical Bevy renderer production plan |
| [../engineering/v2x-port-plan.md](../engineering/v2x-port-plan.md) | Historical V2X digital-twin port plan |

## One-paragraph summary

SimForge is an open-source, deterministic ML training environment and CARLA
competitor. A portable scenario document and fixed-step TypeScript engine drive
Studio authoring, headless simulation, replay, native and web rendering, and
training environments without separate behavioral implementations. SimForge
Studio runs locally from `studio/` on port 5199; SimForge Cloud consumes the same
immutable 13-package stack. The Rust SimForge Renderer lives in `renderer/`,
and distinct CARLA API and CARLA execution adapters support replacement and
reference-runtime workflows in opposite directions.
