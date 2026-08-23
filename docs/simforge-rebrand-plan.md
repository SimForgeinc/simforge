# SimForge Rebrand & Repository Reorganization Plan

Decision basis (Michael, 2026-08-23, recorded in the context MCP as
`simforge-professional-naming`): the platform brands as **SimForge** with
plain descriptive component names — SimForge Engine, SimForge Renderer,
SimForge Studio, SimForge Cloud. No creative sub-names. Positioning:
open-source ML training environment and CARLA competitor; fast; professional.

## 1. Brand architecture

| Public name | What it is | Where it lives |
|---|---|---|
| **SimForge** | The company AND the open-source platform (repo, GitHub org, docs site) | repo root → renamed `simforge` |
| **SimForge Engine** | Deterministic fixed-step simulation core | `packages/engine` |
| **SimForge Renderer** | Native sensor-grade renderer (Rust/Bevy) | `renderer/` (was `native/`) |
| **SimForge Studio** | The product app — editor, datasets, maps, assets, renders — running locally | `studio/` (was `apps/cloud`) |
| **SimForge Cloud** | The hosted product (separate repo, simcloud-platform) | unchanged repo; display-name update only |
| **SimForge scenario format** | The portable scenario document (`ScenarioTemplateV2`) | `packages/scenario` — "UniScenario" survives only as the historical format identifier where wire/DB compatibility requires it |

Everything else is lowercase-descriptive in prose: "the training
environment", "the CARLA compatibility layer", "the evaluation harness".
No new proper nouns.

## 2. Target repository layout

```
simforge/
├── packages/              # the published TypeScript stack (@simforge/*)
│   ├── engine/            # was sim-engine        → @simforge/engine
│   ├── scenario/          # was scenario-model    → @simforge/scenario
│   ├── editor-core/       #                        → @simforge/editor-core
│   ├── web-renderer/      # was city-renderer     → @simforge/web-renderer
│   ├── browser-renderer/  #                        → @simforge/browser-renderer
│   ├── playback/ openscenario/ prop-catalog/ ambient-traffic/
│   ├── camera-rig/ xodr-tools/ map-intel/ anchor-matcher/
│   ├── scenario-materializer/ scene-state/ trace-comparator/
│   ├── render-runtime/ native-renderer/ esmini-runner/
│   ├── training-env/      # was rl-env            → @simforge/training-env
│   ├── evaluation/        # was policy-eval+examiner merged namespace: keep
│   │                      #   policy-eval → @simforge/policy-eval,
│   │                      #   examiner   → @simforge/examiner (phase 2 merge optional)
│   ├── editor-ui/         # legacy shared UI — deleted with apps/studio (see §5)
│   └── cli/               # → @simforge/cli, binary `simforge` (alias `sf`)
├── renderer/              # was native/ — SimForge Renderer (Rust workspace)
├── studio/                # was apps/cloud — SimForge Studio (Next.js product)
├── adapters/
│   ├── gym/               # was uniscenarios-gym — Python training adapter
│   └── carla/             # CARLA compatibility layer (import carla facade)
├── research/              # was tools/* research lanes + experiments/
│   ├── bridge-fidelity/ h3-reproduce/ vla-posttrain/ …
│   └── (research is NOT product; nothing here ships in releases)
├── qualification/         # frozen eval suites, golden maneuvers (unchanged)
├── catalog/ campaigns/ fixtures/ dev-assets/ examples/ services/ config/
├── scripts/               # repo tooling incl. verify-repository-naming
└── docs/
    ├── README.md          # ground-up rewrite: open-source CARLA competitor
    ├── product/           # Studio/Cloud user-facing docs
    ├── engineering/       # architecture, determinism claim, convergence,
    │                      #   renderer plans, port plans (moved, not rewritten)
    ├── research/          # research plans/verdicts (rl-hardening, teacher, …)
    └── context/           # canonical context source (kept, updated)
```

Principles:
- `apps/` disappears: Studio is THE app; promoting it to a top-level
  `studio/` matches "the product is the repo" positioning.
- `native/` → `renderer/`: the public component name wins over the
  implementation adjective.
- Research code is quarantined under `research/` so the open-source surface
  (packages, renderer, studio, adapters) reads clean to outside contributors.

## 3. Identifier map

| Current | New | Notes |
|---|---|---|
| npm scope `@uniscenarios/*` | `@simforge/*` | Phase 2 (release-coordinated, see §6) |
| `@uniscenarios/sim-engine` | `@simforge/engine` | |
| `@uniscenarios/scenario-model` | `@simforge/scenario` | exports keep `ScenarioTemplateV2` |
| `@uniscenarios/city-renderer` | `@simforge/web-renderer` | |
| `@uniscenarios/rl-env` | `@simforge/training-env` | "ML training environment" positioning |
| `@uniscenarios/cloud` (apps/cloud) | `@simforge/studio` | product app |
| CLI `uniscenarios` / `scen` | `simforge` / `sf` | old names become erroring stubs pointing at the new binary for one release |
| Repo dir `/home/path/UniScenarios` | `/home/path/simforge` | plus workspace name in package.json |
| Env vars `UNISCENARIO_*` / `UNISCENARIOS_*` | `SIMFORGE_*` | accept old names with a deprecation warning for one release (Studio/worker boot) |
| Design token names | unchanged | Mission Console system already SimForge-branded |

### Deliberately NOT renamed (compatibility contracts)
- **Postgres schemas/tables `uniscenario.*`** and API route paths
  `/api/uniscenario/**`: these are the wire/DB contract shared byte-for-byte
  with SimCloud production. Renaming them forks the product. They become
  internal legacy identifiers, documented once, invisible to users.
- **Scenario format identifiers** inside documents (`mapId`, template ids):
  frozen for interchange stability.
- **simforge1 cluster hostname, seablue, service names**: operational, out of
  scope.

## 4. Documentation reorganization

1. **README.md — ground-up rewrite** (the storefront): what SimForge is
   (open-source, deterministic, fast, CARLA-compatible ML training
   environment), 60-second quickstart (`pnpm dev` → Studio on :5199;
   `simforge run` for headless), component table (Engine / Renderer / Studio /
   training adapters), benchmark claims with receipts (4.5× realtime native
   rendering, byte-stable determinism CI), license.
2. `docs/` re-filed into `product/ engineering/ research/ context/` per §2 —
   files move, content edits limited to naming.
3. Naming sweep across all docs: "UniScenarios" → "SimForge" except (a) the
   scenario-format identifier, (b) historical records (program history,
   verdicts) which keep their original names with a one-line note.
4. `docs/repository-transition.md` superseded by this plan +
   `verify:naming` updated to enforce the NEW contract (scope `@simforge`,
   binary `simforge`, workspace names, README naming).
5. `docs/simcloud-convergence.md`: update naming and the release/consumption
   story for the scope change (§6).
6. Context MCP: refresh mirrors + record the reorganization as work; Project
   Paper update after the cutover lands.

## 5. Code changes beyond renames

- **Delete `apps/studio` (legacy Vite) and `packages/editor-ui`** — the
  rebrand is the natural cutover point; parity soak completed by the E2E
  program. Engine-adjacent modules still imported from studio server code (if
  any) migrate into their owning packages first (audit step).
- **CLI**: rename binary + command namespace; `simforge studio`,
  `simforge render run --engine native|web`, `simforge maps …`,
  `simforge train …` (gym adapter entry). Update all scripts/docs invocations.
- **Workspace/lockfile**: one atomic rename commit for scope + imports
  (lsp/ast-grep sweep), lockfile regenerated, full build+test gate.
- **verify:naming** rewritten as the executable contract of this plan.

## 6. SimCloud coordination (the one real risk)

SimCloud vendors `@uniscenarios/*@rc.45` tarballs via `stack-lock.json`.
Scope rename therefore ships as a **major stack release**:
1. Phase 1 (repo-internal, no npm impact): directory moves, docs, README,
   CLI rename, env-var aliases, verify:naming. SimCloud unaffected.
2. Phase 2 (release): publish the stack once under `@simforge/*` with a
   rename manifest (old→new name map inside the release notes);
   `release:manifest` and packaging scripts updated.
3. Phase 3 (SimCloud sync): one SimCloud change swaps vendored names +
   stack-lock + import specifiers (mechanical, the API surface is unchanged);
   its divergence audit updated to the new scope. Until Phase 3 lands,
   SimCloud stays pinned to the last `@uniscenarios` release — the one-way
   consumption contract makes this safe.

## 7. Execution plan (worktree lanes)

| Lane | Scope | Depends on |
|---|---|---|
| R1 StructureMove | git mv: packages/dirs, native→renderer, apps/cloud→studio, tools→research; path fixes in workspace/tsconfig/turbo/scripts | — |
| R2 ScopeRename | @uniscenarios→@simforge + package dir renames in §3, import sweep, lockfile, CLI binary | R1 |
| R3 StudioCutover | delete apps/studio + editor-ui, migrate stragglers, env-var aliases | R1 |
| R4 DocsRewrite | README ground-up, docs re-filing, naming sweep, verify:naming rewrite | R1 (text refs to new paths) |
| R5 Verification | full build, all package tests, Studio E2E smoke (:5199), `simforge` CLI smoke, verify:naming green | R1–R4 |
| R6 ReleasePrep | stack manifest/packaging updates, rename manifest, SimCloud sync checklist (executed in simcloud-platform separately) | R2 |

Lanes R1–R4 are sequential-ish on shared files (R1 first, then R2/R3/R4 in
parallel worktrees is NOT safe — same files everywhere). Recommended: R1+R2+R3
as ONE lane (the mechanical rename is atomic by nature), R4 parallel-safe
(docs only), R5 by the integrator, R6 after.
