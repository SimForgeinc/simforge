// The showcase product acceptance contract.
//
// Acceptance is deterministic and has exactly one semantic authority: the
// brief-aware 2D semantic oracle (`62-semantic2d`). The 2D-to-3D transfer is
// deterministic -- the exporter replays the same recorded trace and fails closed
// on any instance, trace, or manifest identity mismatch -- so a completed render
// IS the proof that the footage shows the scenario the oracle reviewed.
//
// A cell is accepted when the frozen gate admitted it, the oracle matched it,
// and its deterministic render completed. Nothing here scores realism,
// materials, lighting, or camera framing: that was renderer telemetry, never a
// scenario verdict, and it is no longer an acceptance input.
//
// `config/showcase-review-contract.json` and its Python mirror
// `tools/research/showcase/review_contract.py` survive only for the deferred
// human-calibration workflow. No production decision reads them.

import { DEFECT_CODES as DETERMINISTIC_DEFECT_CODES } from '../../../scripts/trace-validity-lib.mjs';

/**
 * The acceptance contract every product decision is stamped with. A decision
 * recorded under any other version can never read as current, which is what
 * stops a verdict made under the retired acceptance split from being collected.
 */
export const PRODUCT_CONTRACT_VERSION = 'showcase-deterministic-product/v1';

/** Layout of `75-product.json`. */
export const PRODUCT_DECISION_SCHEMA = 'uniscenarios.showcase-product-decision.v2';

/** The one defect code the pipeline itself contributes: the frozen gate's verdict. */
export const GATE_DEFECT_CODE = 'scenario.gate';

/** What a cell no oracle verdict covers carries, instead of a fabricated verdict. */
export const NEVER_SCREENED_REASON = 'never screened by the 2D semantic oracle';

/**
 * The `scenario.*` codes the 2D semantic oracle may attribute. Mirrors the code
 * list in `SEMANTIC2D_PROMPT` (`tools/research/showcase/stages.py`), which is
 * the only place a semantic defect code is produced.
 */
export const SEMANTIC_DEFECT_CODES = Object.freeze([
  'scenario.actors',
  'scenario.mechanism',
  'scenario.plausibility',
  'scenario.sequence',
  'scenario.trigger',
]);

/**
 * Every defect code a job can record: the deterministic validator registry
 * (`scripts/trace-validity-lib.mjs`), the oracle's semantic codes, and the gate.
 * Assembled from the emitters themselves, so a code in a report can always be
 * traced to the stage that produced it and a code outside this set is drift.
 */
export const DEFECT_CODE_VOCABULARY = Object.freeze([...new Set([
  ...Object.keys(DETERMINISTIC_DEFECT_CODES),
  ...SEMANTIC_DEFECT_CODES,
  GATE_DEFECT_CODE,
])].sort());

export function contractIdentity() {
  return { version: PRODUCT_CONTRACT_VERSION };
}

/** Was this decision recorded under the contract that is in force now? */
export function isCurrentAcceptance(document) {
  return document?.contract?.version === PRODUCT_CONTRACT_VERSION;
}

/**
 * A campaign video is a result only when the current contract's product decision
 * accepted the cell it came from. `accepted` already carries the frozen gate, the
 * oracle's match, and a completed deterministic render, so nothing is re-derived.
 */
export function acceptsCampaignVideo(document, row) {
  return isCurrentAcceptance(document) && row?.accepted === true;
}

export function campaignVideoRow(document, cellId) {
  return (document?.cells ?? []).find((row) => row.cellId === cellId
    && acceptsCampaignVideo(document, row)) ?? null;
}

function countCodes(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const code of row.defectCodes ?? []) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** -> the counts a product decision reports over its own rows. */
export function productAcceptanceSummary(document) {
  const cells = Array.isArray(document?.cells) ? document.cells : [];
  return {
    screenedCells: cells.filter((row) => row.acceptance?.semanticScreened === true).length,
    semanticAcceptedCells: cells.filter((row) => row.semanticAccepted === true).length,
    acceptedCells: cells.filter((row) => row.accepted === true).length,
    unsupportedCells: cells.filter((row) => row.unsupportedReason != null).length,
    defectCodeCounts: countCodes(cells),
  };
}
