/**
 * Is this failure the infrastructure having a bad second, or the answer?
 *
 * ## Why this exists
 *
 * Routes that read a map's runtime topology used to collapse everything that
 * was not a `TopologyUnavailableError` into one 422 — "CARLA runtime topology
 * is unavailable" — which is the same response a map that genuinely has no
 * CARLA binding gets. So an S3 timeout and an unbound map were indistinguishable
 * to the client, to the operator reading logs, and to any retry policy: the
 * editor showed "this map has no runtime topology" and stopped, when the honest
 * answer was "ask again in a moment".
 *
 * A transient fault is a 503 with `Retry-After`, and it must never be cached —
 * neither as a negative result server-side nor by an intermediary.
 *
 * This is deliberately a WHITELIST of faults we can name. Anything unrecognised
 * is treated as permanent, because guessing "transient" on an unknown error
 * turns a hard bug into an infinite client retry loop.
 */

/** Node/undici socket-level faults. */
const TRANSIENT_ERRNO = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** AWS SDK v3 error names/codes that the SDK itself classifies as retryable. */
const TRANSIENT_AWS_NAMES = new Set([
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "RequestThrottled",
  "RequestThrottledException",
  "ThrottlingException",
  "Throttling",
  "TooManyRequestsException",
  "ProvisionedThroughputExceededException",
  "TransactionInProgressException",
  "SlowDown",
  "PriorRequestNotComplete",
  "ServiceUnavailable",
  "InternalError",
  "InternalFailure",
  "InternalServerError",
  "NetworkingError",
  "AbortError",
  "TimeoutOverflowWarning",
  "EndpointConnectionError",
  "ConnectionError",
]);

type ErrorLike = {
  name?: unknown;
  code?: unknown;
  errno?: unknown;
  message?: unknown;
  cause?: unknown;
  $retryable?: { throttling?: boolean } | undefined;
  $metadata?: { httpStatusCode?: number } | undefined;
};

function transientOnce(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as ErrorLike;

  // The SDK's own verdict, when it has one, beats any list we keep here.
  if (candidate.$retryable) return true;

  const status = candidate.$metadata?.httpStatusCode;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;

  const name = typeof candidate.name === "string" ? candidate.name : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const errno = typeof candidate.errno === "string" ? candidate.errno : "";
  if (TRANSIENT_AWS_NAMES.has(name) || TRANSIENT_AWS_NAMES.has(code)) return true;
  if (TRANSIENT_ERRNO.has(code) || TRANSIENT_ERRNO.has(errno)) return true;
  if (TRANSIENT_ERRNO.has(name)) return true;

  return false;
}

/**
 * True when `error` (or anything it wraps) is a network/service fault that a
 * later identical request could plausibly survive.
 *
 * Follows `cause` a bounded number of hops: the AWS SDK, undici and `fetch` all
 * wrap the socket error that actually explains the failure.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  let current: unknown = error;
  for (let hop = 0; hop < 5 && current; hop += 1) {
    if (transientOnce(current)) return true;
    current = (current as ErrorLike | undefined)?.cause;
  }
  return false;
}

/** Seconds to put in `Retry-After` for a transient failure. */
export const TRANSIENT_RETRY_AFTER_SECONDS = 5;

/**
 * The headers a transient-failure response must carry: tell the client when to
 * come back, and make sure nobody stores the answer.
 */
export function transientFailureHeaders(): Record<string, string> {
  return {
    "retry-after": String(TRANSIENT_RETRY_AFTER_SECONDS),
    "cache-control": "no-store",
  };
}
