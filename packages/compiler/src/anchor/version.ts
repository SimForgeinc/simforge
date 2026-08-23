/**
 * Version of the *match semantics* — bump whenever a change to candidate
 * generation, frame construction or the site-id tuple would make previously
 * cached `siteId`s point at different structure.
 *
 * Deliberately **not** bumped for scoring/weight tuning: `siteId` excludes soft
 * clauses precisely so preference tuning never orphans a stored SiteBinding
 * (`docs/research/retargeting.md` § Determinism rules).
 */
export const MATCH_SEMANTICS_VERSION = '1.0.0';

/** Version of the derived-index contract this package normalizes onto. */
export const DERIVED_INDEX_CONTRACT_VERSION = '1.0.0';
