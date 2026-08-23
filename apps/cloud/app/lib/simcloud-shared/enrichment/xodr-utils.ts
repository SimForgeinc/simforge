/**
 * XODR XML parsing utilities — pure string helpers for attribute extraction.
 * Moved from apps/web to packages/shared for use by scene graph builders.
 */

/** Extract an XML attribute value by name from an attribute string. */
export function attr(xml: string, name: string): string | undefined {
  // \b anchors the attribute name so e.g. `attr(s, "t")` can't match the
  // trailing `t="` inside `height="…"`, or `type` inside `subtype`.
  const re = new RegExp(`\\b${name}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m?.[1]?.trim();
}

/** Strip XML comments from a string. */
export function stripXmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

/** Extract the geoReference text from an XODR header. Handles CDATA and namespaces. */
export function extractGeoReferenceText(xodr: string): string | undefined {
  const cleaned = stripXmlComments(xodr);
  const m = cleaned.match(/<geoReference[^>]*>([\s\S]*?)<\/geoReference>/i);
  if (!m?.[1]) return undefined;
  let inner = m[1].trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata?.[1]) inner = cdata[1].trim();
  return inner.replace(/\s+/g, " ").trim() || undefined;
}
