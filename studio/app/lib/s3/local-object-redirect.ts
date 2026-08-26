import { NextResponse } from "next/server";

/**
 * Redirect to an object without leaving the caller's origin.
 *
 * Real object storage returns an absolute presigned URL, which must stay
 * absolute. The local-objects dev fallback does not: `s3-presign.ts` builds its
 * URL from a configured base and defaults to `http://127.0.0.1:<port>`. That
 * host is the *client's* own machine whenever Studio is reached over a LAN or a
 * tunnel, and pinning it to any other fixed host makes the follow-up fetch
 * cross-origin and CORS-blocked. Either way the asset never loads, and the
 * failure surfaces far from its cause — as a missing map, absent collision data
 * or an unavailable SUMO runtime.
 *
 * Emitting a **relative** `Location` fixes it for every client at once: the
 * browser resolves it against whichever origin the request arrived on, so
 * localhost, a LAN address and a tunnelled hostname all work with no
 * configuration. A relative Location is valid per RFC 7231.
 *
 * `NextResponse.redirect` rejects relative URLs, so the header is set directly.
 */
export function objectRedirect(url: string, status: 302 | 307): NextResponse {
  return new NextResponse(null, { status, headers: { Location: sameOriginWhenLocal(url) } });
}

/** Strip the origin from a local-objects URL; leave any other URL untouched. */
export function sameOriginWhenLocal(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/api/local-objects/")) return url;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
