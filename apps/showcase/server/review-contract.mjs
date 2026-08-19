import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Canonical showcase acceptance contract: semantic fidelity vs 3D presentation.
//
// `config/showcase-review-contract.json` is the single source of truth for the review prompt, the
// acceptance predicates, the defect taxonomy, and the retry policy. `tools/research/showcase/
// review_contract.py` is the Python mirror of this module: both hash the same canonical body and
// must agree on every conformance vector the contract carries.
//
// Semantic acceptance answers "does this render show the requested scenario". Presentation
// acceptance additionally answers "is this footage usable". Every rejection is attributable to a
// defect code, and evidence that cannot be attributed is reported through `unsupportedReason`
// instead of silently passing.

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const CONTRACT_PATH = join(REPO_ROOT, 'config', 'showcase-review-contract.json');

const STRING_ESCAPES = {
  '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t',
};

function canonicalString(text) {
  let out = '"';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const escape = STRING_ESCAPES[character];
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const code = text.charCodeAt(index);
    out += code >= 0x20 && code <= 0x7e ? character : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
}

/** Hashing form: keys sorted at every depth, no whitespace, ASCII escapes -- byte-identical to
 *  Python's `json.dumps(value, sort_keys=True, separators=(',', ':'))`. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot hold a non-finite number');
    return String(value);
  }
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${canonicalString(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error(`canonical JSON cannot hold ${typeof value}`);
}

export function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function loadContract() {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  const { sha256: declared, ...body } = contract;
  const computed = sha256Text(canonicalJson(body));
  if (declared !== computed) {
    throw new Error(`review contract sha256 ${declared} != canonical ${computed}; refresh the frozen hash deliberately`);
  }
  return Object.freeze(contract);
}

export const REVIEW_CONTRACT = loadContract();
export const CONTRACT_VERSION = REVIEW_CONTRACT.version;
export const CONTRACT_SHA256 = REVIEW_CONTRACT.sha256;
export const REVIEW_VERSION = REVIEW_CONTRACT.reviewVersion;
export const PROMPT_SHA256 = sha256Text(REVIEW_CONTRACT.prompt);

const SEMANTIC = REVIEW_CONTRACT.acceptance.semantic;
const PRESENTATION = REVIEW_CONTRACT.acceptance.presentation;
const UNSUPPORTED = REVIEW_CONTRACT.acceptance.unsupported;
const DEFECTS = REVIEW_CONTRACT.defects;
const RETRY = REVIEW_CONTRACT.retry;
const HISTORICAL = REVIEW_CONTRACT.historical;

const FALLBACK_CODE = DEFECTS.fallbackCode;
const CODES = new Set(DEFECTS.codes);
const AXIS_CODES = DEFECTS.axisCodes;
const FULL_TIER = '3d';
const TIER_AXES = Object.keys(SEMANTIC.axes);
const RULES = DEFECTS.rules.map((rule) => ({ code: rule.code, pattern: new RegExp(rule.pattern, 'i') }));

/** The one defect code the pipeline itself contributes: the frozen physical gate's verdict. */
export const GATE_DEFECT_CODE = DEFECTS.axisCodes.gate;

/**
 * The contract's declared defect vocabulary, plus the code it falls back to when
 * reviewer prose matches no rule. This is the only defect taxonomy in the
 * system: it is covered by the contract hash, so a report that counts these
 * codes is describing the same contract the verdicts were produced under.
 */
export const DEFECT_CODE_VOCABULARY = Object.freeze([...new Set([...DEFECTS.codes, FALLBACK_CODE])].sort());

/** The review code whose change must invalidate a cached 70-judge artifact. */
export const REVIEW_CODE_PATHS = Object.freeze([
  'apps/showcase/server/review-contract.mjs',
  'tools/research/showcase/review_contract.py',
  'tools/research/showcase/stages.py',
]);

export function contractIdentity() {
  return {
    version: CONTRACT_VERSION,
    sha256: CONTRACT_SHA256,
    reviewVersion: REVIEW_VERSION,
    promptSha256: PROMPT_SHA256,
  };
}

/** First taxonomy rule whose pattern the raw defect text matches. */
export function classifyText(text) {
  let value = String(text ?? '');
  for (const prefix of DEFECTS.legacyTextPrefixes) {
    if (value.toLowerCase().startsWith(prefix)) value = value.slice(prefix.length);
  }
  const stripped = value.trim();
  const legacy = DEFECTS.legacyCodes[stripped.toLowerCase()];
  if (legacy) return legacy;
  if (CODES.has(stripped)) return stripped;
  for (const rule of RULES) {
    if (rule.pattern.test(stripped)) return rule.code;
  }
  return null;
}

/** -> { code, source } preferring the reviewer's own attribution. */
export function attribute(declared, text) {
  if (typeof declared === 'string' && CODES.has(declared.trim())) {
    return { code: declared.trim(), source: 'model' };
  }
  const matched = classifyText(text);
  if (matched) return { code: matched, source: 'rules' };
  return { code: FALLBACK_CODE, source: 'unattributed' };
}

function clamp(value, low, high, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, number));
}

function defectRecords(review, confidence) {
  const raw = review.defects;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, DEFECTS.maxDefects).map((item) => {
    const object = item !== null && typeof item === 'object';
    const text = String((object ? item.text ?? item.defect ?? item.description : item) ?? '')
      .slice(0, DEFECTS.maxTextLength);
    const { code, source } = attribute(object ? item.code : null, text);
    const itemConfidence = object && item.confidence !== undefined ? item.confidence : confidence;
    return { code, text, confidence: clamp(itemConfidence, 0, 1), source };
  });
}

function axisRecord(axis, value, code) {
  return { code, text: `${axis}=${value}`, confidence: null, source: 'axis' };
}

function hasEvidenceText(review, records) {
  for (const key of ['explanation', 'mechanismObserved', 'description']) {
    if (String(review[key] ?? '').trim()) return true;
  }
  return records.some((record) => record.text.trim());
}

function blockedBy(codes, prefixes) {
  return codes.some((code) => prefixes.some((prefix) => code.startsWith(prefix)));
}

/** Does this defect-code set condemn the scenario itself? The contract's prefixes are the rule. */
export function blocksSemantic(codes) {
  return blockedBy(codes ?? [], SEMANTIC.blockingPrefixes);
}

/**
 * -> the shared acceptance contract for one reviewed cell: semanticAccepted, presentationAccepted,
 * defectCodes, unsupportedReason, plus the attributable evidence (defects, axes, tier) behind them.
 */
export function evaluateReview(review, tier) {
  const result = {
    tier: tier ?? null,
    semanticAccepted: false,
    presentationAccepted: false,
    defectCodes: [],
    unsupportedReason: null,
    defects: [],
    axes: {},
  };
  if (review === null || typeof review !== 'object' || Array.isArray(review)) {
    result.unsupportedReason = 'no review evidence for this cell';
    result.defectCodes = [FALLBACK_CODE];
    result.defects = [{ code: FALLBACK_CODE, text: '', confidence: null, source: 'missing' }];
    return result;
  }

  const declaredTier = String(review.tier ?? '').toLowerCase();
  result.tier = tier
    ?? (declaredTier in UNSUPPORTED.tiers
      ? declaredTier
      : (TIER_AXES.some((axis) => axis in review) ? FULL_TIER : '2d'));

  const reasons = [];
  const codes = new Set();
  const error = review.error;
  if (error) reasons.push(`review error: ${String(error).slice(0, DEFECTS.maxTextLength)}`);

  const confidence = clamp(review.confidence, 0, 1);
  const records = defectRecords(review, confidence);
  for (const record of records) {
    codes.add(record.code);
    if (record.source === 'unattributed') {
      reasons.push(`unattributable defect text: ${record.text || '(empty)'}`);
    } else if (record.code === FALLBACK_CODE) {
      reasons.push('reviewer reported an unattributable defect');
    }
  }

  if (UNSUPPORTED.requireEvidenceText && !hasEvidenceText(review, records)) {
    reasons.push('review returned no explanatory text');
  }

  if (result.tier !== FULL_TIER) {
    reasons.push(UNSUPPORTED.blindTierReason);
  } else if (!error) {
    for (const [axis, allowed] of Object.entries({ ...SEMANTIC.axes, ...PRESENTATION.axes })) {
      if (!(axis in review)) {
        reasons.push(`review omitted the ${axis} verdict`);
        continue;
      }
      const value = String(review[axis] ?? '').trim().toLowerCase();
      result.axes[axis] = value;
      if (!allowed.includes(value)) {
        codes.add(AXIS_CODES[axis]);
        records.push(axisRecord(axis, value, AXIS_CODES[axis]));
      }
    }
    if (SEMANTIC.requirePlausible) {
      if (!('plausible' in review)) reasons.push('review omitted the plausible verdict');
      else {
        result.axes.plausible = Boolean(review.plausible);
        if (!result.axes.plausible) {
          codes.add(AXIS_CODES.plausible);
          records.push(axisRecord('plausible', 'false', AXIS_CODES.plausible));
        }
      }
    }
    if (!('realism' in review)) reasons.push('review omitted the realism score');
    else {
      const realism = clamp(review.realism, 0, 10);
      result.axes.realism = realism;
      if (realism < SEMANTIC.realismMin) {
        codes.add(AXIS_CODES.realism);
        records.push(axisRecord('realism', String(realism), AXIS_CODES.realism));
      }
    }
    if (!('confidence' in review)) reasons.push('review omitted its confidence');
    else {
      result.axes.confidence = confidence;
      if (confidence < SEMANTIC.confidenceMin) {
        codes.add(AXIS_CODES.confidence);
        records.push(axisRecord('confidence', String(confidence), AXIS_CODES.confidence));
        reasons.push(`review confidence ${confidence} is below the ${SEMANTIC.confidenceMin} floor`);
      }
    }
  }

  for (const code of UNSUPPORTED.blockingCodes) {
    if (codes.has(code) && reasons.length === 0) {
      reasons.push(`${code} defect blocks an attributable verdict`);
    }
  }
  if (reasons.length && codes.size === 0) {
    codes.add(FALLBACK_CODE);
    records.push({ code: FALLBACK_CODE, text: reasons[0], confidence: null, source: 'unsupported' });
  }

  result.defects = records;
  result.defectCodes = [...codes].sort();
  result.unsupportedReason = reasons.length ? reasons[0] : null;
  if (!reasons.length && result.tier === FULL_TIER) {
    result.semanticAccepted = !blockedBy(result.defectCodes, SEMANTIC.blockingPrefixes);
    result.presentationAccepted = (result.semanticAccepted || !PRESENTATION.requiresSemantic)
      && !blockedBy(result.defectCodes, PRESENTATION.blockingPrefixes);
  }
  return result;
}

/**
 * Fold in attributable defect codes the reviewer could not see: the deterministic trace validators
 * and the exporter's own classified render failures. The contract's blocking prefixes stay the only
 * acceptance predicate, and evidence added here can only revoke a verdict, never grant one.
 */
export function withDefectCodes(result, ...lists) {
  const codes = new Set(result.defectCodes);
  for (const list of lists) {
    for (const code of list ?? []) {
      if (typeof code === 'string' && code) codes.add(code);
    }
  }
  const defectCodes = [...codes].sort();
  const semanticAccepted = result.semanticAccepted && !blockedBy(defectCodes, SEMANTIC.blockingPrefixes);
  return {
    ...result,
    defectCodes,
    semanticAccepted,
    presentationAccepted: result.presentationAccepted
      && (semanticAccepted || !PRESENTATION.requiresSemantic)
      && !blockedBy(defectCodes, PRESENTATION.blockingPrefixes),
  };
}

/**
 * Re-derive attributable verdicts from a pre-split review emission. The verdict is honest about the
 * evidence it had and can never satisfy the current contract: `contract` stays null so stale
 * artifacts are never current.
 */
export function normalizeHistoricalReview(review) {
  const result = evaluateReview(review);
  result.normalizedFrom = String(review?.version ?? '') || null;
  result.contract = null;
  return result;
}

/** -> the cheapest retry that could fix the dominant defect, or null. */
export function retryRecommendation(codes, { reviewed } = {}) {
  const values = (codes ?? []).filter((code) => typeof code === 'string');
  if (reviewed !== undefined && Number(reviewed) <= 0) {
    return {
      action: RETRY.noEvidenceAction,
      codes: [...new Set(values)].sort(),
      reason: RETRY.noEvidenceReason,
    };
  }
  for (const prefix of RETRY.priority) {
    const matched = [...new Set(values.filter((code) => code.startsWith(prefix)))].sort();
    if (matched.length) {
      return { action: RETRY.actions[prefix], codes: matched, reason: `dominant defect prefix ${prefix}` };
    }
  }
  return null;
}

export function retryRequiresAuthor(recommendation) {
  return RETRY.authorActions.includes(recommendation?.action);
}

/** The four shared-contract fields, flattened onto an artifact row. */
export function acceptanceFields(result) {
  return {
    semanticAccepted: result.semanticAccepted,
    presentationAccepted: result.presentationAccepted,
    defectCodes: [...result.defectCodes],
    unsupportedReason: result.unsupportedReason,
  };
}

/** The review evidence a 70-judge row carries: the 3D review when present, else the blind 2D pass. */
export function rowReview(row) {
  if (row?.threeDReview && typeof row.threeDReview === 'object') {
    return { tier: FULL_TIER, ...row.threeDReview };
  }
  if (row?.status === 'error') return { tier: '2d', error: row.error ?? 'cell review failed' };
  const { cellId: _cellId, status: _status, threeDReview: _review, ...rest } = row ?? {};
  return { tier: '2d', ...rest };
}

/** sha256 over the identity of the review code, so an implementation edit invalidates the cache. */
export async function reviewCodeDigest(root = REPO_ROOT, paths = REVIEW_CODE_PATHS) {
  const entries = [];
  for (const path of [...paths].sort()) {
    entries.push(`${path}:${sha256Text(await readFile(join(root, path), 'utf8'))}`);
  }
  return sha256Text(entries.join('\n'));
}

/**
 * -> { key, inputs } binding a judged artifact to the contract, prompt, review code, request text,
 * model, and the review flags that change what acceptance means. Any drift retires the artifact.
 */
export function acceptanceCache({ codeSha256, requestSha256, model, effort, flags }) {
  const inputs = {
    contractVersion: CONTRACT_VERSION,
    contractSha256: CONTRACT_SHA256,
    reviewVersion: REVIEW_VERSION,
    promptSha256: PROMPT_SHA256,
    codeSha256: codeSha256 ?? null,
    requestSha256: requestSha256 ?? null,
    model: model ?? null,
    effort: effort ?? null,
    flags: flags ?? null,
  };
  return { key: sha256Text(canonicalJson(inputs)), inputs };
}

export function isCurrentAcceptance(document) {
  return document?.contract?.sha256 === CONTRACT_SHA256;
}

/**
 * A campaign video is a result only when a full 3D review accepted both verdicts under the current
 * contract with nothing left unattributed. Historical and stale judgements carry a null contract
 * identity, so an artifact from a superseded contract can never read as current.
 */
export function acceptsCampaignVideo(document, row) {
  return isCurrentAcceptance(document)
    && row?.semanticAccepted === true
    && row?.presentationAccepted === true
    && (row.defectCodes ?? []).length === 0
    && row.unsupportedReason === null
    && row.acceptance?.tier === FULL_TIER;
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

/**
 * Historical normalization: a 70-judge document written before the split is re-derived on read so
 * every consumer sees the current field shape. The legacy `productAccepted` flag is dropped and the
 * contract identity stays null, so a normalized artifact can never pass a current-contract check.
 */
export function normalizeJudgeDocument(document) {
  if (!document || typeof document !== 'object') return document;
  if (isCurrentAcceptance(document)) return document;
  const legacyVersion = String(document.productReviewVersion ?? '') || null;
  const cells = (Array.isArray(document.cells) ? document.cells : []).map((row) => {
    const { productAccepted: _legacy, ...rest } = row ?? {};
    const result = normalizeHistoricalReview(rowReview(rest));
    return {
      ...rest,
      ...acceptanceFields(result),
      acceptance: {
        tier: result.tier,
        defects: result.defects,
        axes: result.axes,
        contract: null,
        normalizedFrom: result.normalizedFrom ?? legacyVersion,
      },
    };
  });
  return {
    ...document,
    productReviewVersion: undefined,
    contract: {
      version: null,
      sha256: null,
      reviewVersion: legacyVersion,
      normalizedFrom: legacyVersion ?? HISTORICAL.reason,
    },
    acceptedCells: undefined,
    semanticAcceptedCells: cells.filter((row) => row.semanticAccepted).length,
    presentationAcceptedCells: cells.filter((row) => row.presentationAccepted).length,
    unsupportedCells: cells.filter((row) => row.unsupportedReason !== null).length,
    defectCodeCounts: countCodes(cells),
    cells,
  };
}

/** -> counts and the retry recommendation for a 70-judge document, current or historical. */
export function judgeAcceptanceSummary(document) {
  const normalized = normalizeJudgeDocument(document);
  const cells = Array.isArray(normalized?.cells) ? normalized.cells : [];
  const reviewed = cells.filter((row) => row.acceptance?.tier === FULL_TIER).length;
  const semanticAcceptedCells = cells.filter((row) => row.semanticAccepted === true).length;
  const presentationAcceptedCells = cells.filter((row) => row.presentationAccepted === true).length;
  const codes = cells.flatMap((row) => row.defectCodes ?? []);
  return {
    reviewed,
    semanticAcceptedCells,
    presentationAcceptedCells,
    unsupportedCells: cells.filter((row) => row.unsupportedReason !== null && row.unsupportedReason !== undefined).length,
    defectCodeCounts: countCodes(cells),
    retry: retryRecommendation(codes, { reviewed }),
  };
}
