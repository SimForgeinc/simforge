/**
 * Typed failure classification shared by the pipeline, the job runner, and the campaign runner.
 *
 * Operational failures describe infrastructure the campaign does not control: the model
 * provider, the local model gateway, credential/quota access, and the vision review path.
 * They are recorded separately from generation outcomes and never consume a case's
 * generation attempt budget, because no generation work was performed.
 *
 * Generation failures describe work the stack actually attempted and got wrong; they are
 * the only failures that spend a case's attempts. An `unsupportedReason` is a terminal
 * declaration that the requested behavior cannot be produced at all, so the case is
 * retired instead of retried.
 */

export const OPERATIONAL_FAILURE_KINDS = Object.freeze(['provider', 'gateway', 'model-access', 'vision']);
export const FAILURE_KINDS = Object.freeze([...OPERATIONAL_FAILURE_KINDS, 'generation', 'unsupported']);

const MAX_DETAIL = 500;
const MAX_REASON = 500;
const MAX_DEFECT_CODES = 32;

/** First match wins; the most specific infrastructure signal is listed first. */
const OPERATIONAL_RULES = Object.freeze([
  Object.freeze(['vision', 'vision_preflight_failed', /vision preflight failed/i]),
  Object.freeze(['vision', 'vision_review_unavailable', /model access unavailable during (?:2d|3d) review/i]),
  Object.freeze(['model-access', 'no_credential', /no credential available|authentication_error|invalid_api_key|permission_denied|\bhttp (?:401|403)\b/i]),
  Object.freeze(['model-access', 'usage_limit', /usage limit|quota exceeded|insufficient_quota/i]),
  Object.freeze(['provider', 'rate_limited', /rate_limit_error|\bhttp 429\b|too many requests/i]),
  Object.freeze(['provider', 'provider_unavailable', /\bhttp 5\d\d\b|server_error|service unavailable|bad gateway|overloaded/i]),
  Object.freeze(['gateway', 'gateway_unreachable', /econnrefused|econnreset|enotfound|eai_again|socket hang up|fetch failed|gateway unavailable/i]),
  Object.freeze(['gateway', 'gateway_timeout', /\betimedout\b/i]),
]);

/** Generation defects the pipeline reports as thrown stage errors. */
const GENERATION_RULES = Object.freeze([
  Object.freeze(['contract_violation', /violated semantic contract/i]),
  Object.freeze(['no_matching_sites', /no matching sites for authored template/i]),
  Object.freeze(['batch_failed', /batch wrote no summary/i]),
  Object.freeze(['gate_failed', /gate returned no json/i]),
  Object.freeze(['render_failed', /renderer wrote no (?:mp4|manifest)|renderer is not capture-ready/i]),
  Object.freeze(['author_failed', /(?:precheck|semantic contract|site matcher) returned no json/i]),
]);

export function truncateDetail(value) {
  const text = String(value ?? '').trim();
  return text ? text.slice(-MAX_DETAIL) : null;
}

/** Canonical `unsupportedReason` field: a non-empty trimmed string, otherwise null. */
export function normalizeUnsupportedReason(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, MAX_REASON) : null;
}

/** Canonical `defectCodes` field: unique non-empty strings, tolerating the legacy `defects` array. */
export function normalizeDefectCodes(value) {
  const source = Array.isArray(value?.defectCodes) ? value.defectCodes
    : Array.isArray(value?.defects) ? value.defects
      : Array.isArray(value) ? value : [];
  const codes = new Set();
  for (const entry of source) {
    const code = typeof entry === 'string' ? entry.trim() : typeof entry?.code === 'string' ? entry.code.trim() : '';
    if (code) codes.add(code);
    if (codes.size >= MAX_DEFECT_CODES) break;
  }
  return [...codes];
}

function errorText(error) {
  const parts = [String(error.message ?? '')];
  if (error.code != null) parts.push(String(error.code));
  if (error.httpStatus != null) parts.push(`HTTP ${error.httpStatus}`);
  let cause = error.cause;
  for (let depth = 0; cause != null && depth < 4; depth += 1) {
    if (typeof cause !== 'object') {
      parts.push(String(cause));
      break;
    }
    if (cause.code != null) parts.push(String(cause.code));
    if (cause.message != null) parts.push(String(cause.message));
    cause = cause.cause;
  }
  return parts.filter(Boolean).join(' ');
}

export function failureText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return errorText(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function verdict({ operational, kind, code, detail, defectCodes = [], unsupportedReason = null }) {
  return Object.freeze({
    operational,
    kind,
    code,
    detail: truncateDetail(detail),
    defectCodes: Object.freeze(defectCodes),
    unsupportedReason,
  });
}

/**
 * An upstream stage may declare its own classification by attaching fields to the thrown
 * error or the persisted error document. Declarations are authoritative: only text that
 * carries no declaration is pattern matched.
 */
function declared(value, text) {
  if (value == null || typeof value === 'string') return null;
  const defectCodes = normalizeDefectCodes(value);
  const kind = typeof value.failureKind === 'string' ? value.failureKind : null;
  if (value.operational === true || OPERATIONAL_FAILURE_KINDS.includes(kind)) {
    const resolved = OPERATIONAL_FAILURE_KINDS.includes(kind) ? kind : 'provider';
    return verdict({
      operational: true,
      kind: resolved,
      code: typeof value.code === 'string' && value.code ? value.code : `${resolved}_failure`,
      detail: value.error ?? value.message ?? text,
      defectCodes,
    });
  }
  const unsupportedReason = normalizeUnsupportedReason(value.unsupportedReason);
  if (unsupportedReason) {
    return verdict({
      operational: false,
      kind: 'unsupported',
      code: typeof value.code === 'string' && value.code ? value.code : 'unsupported',
      detail: value.error ?? value.message ?? text,
      defectCodes,
      unsupportedReason,
    });
  }
  return null;
}

/**
 * Classify a failure signal (message, thrown error, judge row, or persisted error document)
 * into the canonical contract: `{ operational, kind, code, detail, defectCodes, unsupportedReason }`.
 */
export function classifyFailure(value) {
  const text = failureText(value);
  const declaration = declared(value, text);
  if (declaration) return declaration;
  const defectCodes = typeof value === 'object' && value !== null ? normalizeDefectCodes(value) : [];
  for (const [kind, code, pattern] of OPERATIONAL_RULES) {
    if (pattern.test(text)) return verdict({ operational: true, kind, code, detail: text, defectCodes });
  }
  for (const [code, pattern] of GENERATION_RULES) {
    if (pattern.test(text)) return verdict({ operational: false, kind: 'generation', code, detail: text, defectCodes });
  }
  return verdict({
    operational: false,
    kind: 'generation',
    code: text ? 'job_failed' : 'unknown',
    detail: text,
    defectCodes,
  });
}

/** Predicate form for scanning review rows: did infrastructure fail rather than the scenario? */
export function operationalFailure(value) {
  if (value == null) return false;
  return classifyFailure(value).operational;
}
