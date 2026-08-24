# SimCloud Local Port Plan
> **Historical plan:** Pre-rebrand UniScenarios package and `apps/cloud` paths
> are retained verbatim; the resulting product now lives at `studio/`.


Goal: the app you get when you run UniScenarios locally IS the SimCloud product —
1:1 UI (dashboard, app switcher, scenario editor) — with every cloud dependency
replaced by a local equivalent, and an optional local render worker that
executes scenario render jobs.

Grounding: three reconnaissance reports (2026-08-22) over
`/home/path/simcloud-platform` and `apps/studio`:
- SimCloud editor surface: `apps/web/app/dashboard/uniscenario/editor/**` is a
  fully SimCloud-owned presentation layer over vendored `@uniscenarios/*`
  runtime packages (rc.45 tarballs). It does NOT consume
  `@uniscenarios/editor-ui`. The editor header portals into the shared
  `AppTopBar`; there is no separate in-editor top bar.
- Backend: handwritten SQL through one adapter
  (`app/lib/db/data-api.ts`, Aurora RDS Data API), storage through S3 helpers
  (`app/lib/s3/*`), auth through Better Auth at
  `app/lib/auth/route-session.ts` + `app/lib/db/app-context.ts`.
- Render pipeline: `POST /api/uniscenario/render-jobs` inserts
  `uniscenario.render_jobs`; workers are HTTP clients (native: lease protocol
  under `/api/uniscenario/internal/render-jobs/*`; browser: CPU claim protocol
  under `/api/uniscenario/internal/cpu-jobs/*`). Workers never touch Postgres.

## Architecture decisions

1. **New app `apps/cloud`** in the UniScenarios workspace: a Next.js 16 (App
   Router, React 19, Tailwind 3.4) port of `simcloud-platform/apps/web`'s
   product surface. Source is copied verbatim wherever possible; only imports
   and the three seams below are adapted. Internal structure mirrors
   `app/**` with the same tsconfig path aliases so copied files need no
   rewrites.
2. **Vendored tarballs → workspace packages.** SimCloud pins
   `@uniscenarios/*@0.1.0-rc.45` tarballs; `apps/cloud` uses `workspace:*` on
   the same package names (editor-core, city-renderer, scenario-model,
   playback, sim-engine, ambient-traffic, prop-catalog, openscenario,
   camera-rig, map-intel, anchor-matcher, scenario-materializer, xodr-tools).
   API drift between rc.45 and workspace HEAD is fixed forward in the port.
3. **Local DB = embedded Postgres (PGlite)** behind the *unchanged*
   `queryRows/queryOne/execute/batchExecute/withTransaction` adapter API.
   SQLite rejected: the SQL uses JSONB, casts, partial indexes,
   `FOR UPDATE SKIP LOCKED`, advisory locks, views. `DATABASE_URL` escape
   hatch selects a real `pg` pool with the same adapter. Data dir:
   `~/.uniscenarios/cloud/db`. Migrations: the `uniscenario.*`,
   `asset_gallery.*`, `public.map_assets`, and map-upload subsets of
   `simcloud-platform/migrations/*.sql` are curated into
   `apps/cloud/migrations/` and run verbatim at boot; cloud-only families
   (stripe/billing, gpu fleet, ba_* Better Auth org plumbing beyond the seeded
   rows, pipeline reconciliation) are excluded.
4. **Local object store** keyed `{bucket,key}` under
   `~/.uniscenarios/cloud/artifacts`, implemented behind the existing
   `s3-presign.ts` / `s3-object.ts` / `s3-delete.ts` API surfaces. "Presigned"
   URLs become local routes (`/api/local-objects/[bucket]/[...key]`) for GET
   and checksum-bound PUT; HEAD/SHA-256/size verification reads the file.
5. **Authless local identity.** `requireRouteSession` / `requireAppContext` /
   `requireUniScenarioContext` return one fixed owner user + workspace,
   seeded at boot. No per-handler bypasses. `/api/auth/session` returns the
   fixed session; `/api/billing/balance` returns free/unlimited.
6. **Maps seeded from dev-assets.** A seed step ingests the five local maps
   (yale-street, belmont-research-center, el-camino-road,
   easterbrook-discovery-school, richmond-field-station) into
   `public.map_assets` + `uniscenario.map_versions` + browser asset set
   tables, with blobs registered in the local object store, so the dashboard
   map picker and editor world load work exactly as in production.
7. **Local render worker, optional.** Launching the app can also start a
   worker (`--with-worker` / `UNISCENARIOS_LOCAL_WORKER=1`):
   - `browser` engine jobs: a worker speaking the existing CPU claim HTTP
     protocol against localhost, executing with the repo's render runtime
     (three.js recorder), finalizing mp4 + manifest artifacts through the
     local object store.
   - `native` engine (Bevy `render run --engine native`) wired behind the same
     executor boundary where the job spec allows it.
   The HTTP contract is kept (not in-process DB claiming) so the production
   worker code path stays exercised and multi-process claiming stays fenced.
8. **Cutover.** The repo's launch path (`pnpm dev` at root / studio launch
   scripts / port 5199) serves `apps/cloud`. The Vite `apps/studio` UI is
   removed from all entry points; deletion of the directory happens after the
   new app passes end-to-end verification (world load, actor placement,
   timeline, save/revision, render job round-trip).

## What is explicitly cloud-only (dropped or stubbed)

Better Auth UI + orgs, Stripe/billing ledgers, GPU fleet/CARLA provider pools,
map enrichment fleet (Lambda/ECS/SQS), Meshy asset generation (UI shows
disabled state), Sentry, Payload CMS/marketing pages, Vercel runtime config.

## Workstreams

| WS | Name | Owns (in `apps/cloud`) | Depends on |
|----|------|------------------------|------------|
| SC1 | LocalPlatform | App scaffold, theme (globals.css, tailwind.config, fonts, `components/ui/**`), `AppTopBar` + `AppSwitcherOverlay` + `dashboard-nav` + public art, `lib/db/*` (PGlite adapter), `lib/s3/*` (fs store), `lib/auth/*` + app-context (fixed identity), migration runner, seed (user/workspace + 5 maps), `apps/cloud/package.json` | — |
| SC2 | EditorPort | `app/dashboard/uniscenario/editor/**`, `app/lib/uniscenario/editor/**` (use-editor-runtime, client api.ts) | SC1 seams (contract-frozen) |
| SC3 | DatasetsDashboard | `app/dashboard/uniscenario/*` non-editor (DatasetsClient, world host/session, notification dock, boot gate, layout), `app/dashboard/layout` shell | SC1 |
| SC4 | ApiControlPlane | `app/api/uniscenario/**`, `app/api/asset-gallery/**`, `app/api/map-assets/**`, `app/lib/uniscenario/*` stores (document, render-intent, control-plane, cpu-control, render-worker-control, artifact stores), billing/auth stub routes | SC1 |
| SC5 | MapsAssetsApps | `/dashboard/map-assets` + `/dashboard/assets` surfaces (app-switcher targets), Meshy-disabled gallery | SC1, SC4 routes |
| SC6 | LocalRenderWorker | Worker process (CPU-claim client + render-runtime executor + native engine hook), launcher flag wiring | SC4 protocol routes |
| SC7 | LauncherCutover + verification | Root scripts, port 5199 serving `apps/cloud`, optional worker spawn, browser-driven end-to-end verification, `apps/studio` retirement | all |

Contract freeze that enables concurrency: every seam module keeps the exact
file path and export signature it has in `simcloud-platform/apps/web`
(`app/lib/db/data-api.ts`, `app/lib/s3/s3-presign.ts`, `s3-object.ts`,
`s3-delete.ts`, `app/lib/auth/route-session.ts`, `app/lib/db/app-context.ts`,
`app/lib/uniscenario/http.ts`). SC2–SC6 copy code that imports those paths
unchanged; only SC1 implements them.
