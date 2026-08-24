/**
 * Single env gate for every dev-only HUD in the city viewer (StatsPanel,
 * ViewerAuditHud, VisualConfigHud, …). Visible on dev and staging Amplify
 * deploys; absent from production bundles.
 *
 * `NEXT_PUBLIC_ENV` is defined per-environment in `env-matrix.yml` and is
 * inlined by Next.js's DefinePlugin at build time, so the same expression
 * serves as both the build-time tree-shake guard and the runtime check —
 * production builds constant-fold this to `false` and webpack drops the
 * entire dev-HUD branch (including dynamic imports wrapped in the same
 * literal expression) from the production graph.
 */
export const IS_DEV_HUD_BUILD = process.env.NEXT_PUBLIC_ENV !== 'prod';
