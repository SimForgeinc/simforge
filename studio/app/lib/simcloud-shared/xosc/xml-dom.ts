/**
 * The tolerant tag scanner shared by the .xosc security parser and the importer.
 *
 * `parser.ts` walks this tag stream once to make a security decision and pull
 * out entity names; the importer needs the same stream shaped as a tree so it
 * can read positions, actions and conditions. Both run on ONE scanner on
 * purpose: two scanners would be two answers to "what does this file contain",
 * and the security walk would eventually be looking at a different document
 * than the extraction does.
 *
 * Scope is the same narrow subset it always was — nested elements and
 * double/single-quoted attributes. No CDATA, no mixed text content, no
 * namespaces, no DOCTYPE (which `parseXoscText` rejects outright before any of
 * this runs). Text content is not collected because the OSC 1.0 subset we
 * emit and ingest carries every value in an attribute.
 */

export type XmlAttrs = Record<string, string>;

export type TagInfo = {
  name: string;
  attrs: XmlAttrs;
  selfClosing: boolean;
  closing: boolean;
  start: number;
  end: number;
  raw: string;
};

/** One element of the tree. `children` is in document order. */
export type XmlElement = {
  name: string;
  attrs: XmlAttrs;
  children: XmlElement[];
};

const ATTR_REGEX =
  /([A-Za-z_][A-Za-z0-9_\-:.]*)\s*=\s*"([^"]*)"|([A-Za-z_][A-Za-z0-9_\-:.]*)\s*=\s*'([^']*)'/g;

export function parseAttributes(raw: string): XmlAttrs {
  const attrs: XmlAttrs = {};
  ATTR_REGEX.lastIndex = 0;
  for (;;) {
    const match = ATTR_REGEX.exec(raw);
    if (!match) break;
    const key = match[1] ?? match[3];
    const value = match[2] ?? match[4] ?? "";
    if (key) attrs[key] = value;
  }
  return attrs;
}

export function* iterateTags(text: string): Generator<TagInfo> {
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    // Skip comments
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end < 0) {
        // Unterminated comment — bail out; security scan already ran.
        return;
      }
      i = end + 3;
      continue;
    }
    // Skip processing instructions and declarations
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end < 0) return;
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      // DOCTYPE/ENTITY blocked earlier. Skip any other declaration.
      const end = text.indexOf(">", lt + 2);
      if (end < 0) return;
      i = end + 1;
      continue;
    }
    const gt = text.indexOf(">", lt + 1);
    if (gt < 0) return;
    const body = text.slice(lt + 1, gt);
    const closing = body.startsWith("/");
    const selfClosing = body.endsWith("/");
    const nameBody = closing ? body.slice(1) : selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_\-:.]*)/.exec(nameBody);
    if (!nameMatch) {
      i = gt + 1;
      continue;
    }
    const name = nameMatch[1] ?? "";
    if (!name) {
      i = gt + 1;
      continue;
    }
    const attrPart = nameBody.slice(nameMatch[0].length);
    yield {
      name,
      attrs: closing ? {} : parseAttributes(attrPart),
      selfClosing,
      closing,
      start: lt,
      end: gt + 1,
      raw: text.slice(lt, gt + 1),
    };
    i = gt + 1;
  }
}

/**
 * Build the element tree, or `null` when the text carries no element at all.
 *
 * Mismatched close tags are tolerated exactly the way the security walk
 * tolerates them (pop until the name matches), because by the time this runs
 * the dangerous constructs are already rejected and being strict here would
 * only turn a recoverable file into a blank import.
 */
export function parseXmlDocument(text: string): XmlElement | null {
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];
  for (const tag of iterateTags(text)) {
    if (tag.closing) {
      while (stack.length > 0) {
        const popped = stack.pop()!;
        if (popped.name === tag.name) break;
      }
      continue;
    }
    const element: XmlElement = { name: tag.name, attrs: tag.attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (!root) root = element;
    if (!tag.selfClosing) stack.push(element);
  }
  return root;
}

/** First child with this tag name, or `null`. */
export function childEl(parent: XmlElement | null, name: string): XmlElement | null {
  if (!parent) return null;
  return parent.children.find((child) => child.name === name) ?? null;
}

/** Every child with this tag name, in document order. */
export function childrenEl(parent: XmlElement | null, name: string): XmlElement[] {
  if (!parent) return [];
  return parent.children.filter((child) => child.name === name);
}

/** Walk a chain of single-child tag names (`descendantEl(root, "A", "B")`). */
export function descendantEl(
  parent: XmlElement | null,
  ...path: string[]
): XmlElement | null {
  let cursor = parent;
  for (const name of path) {
    cursor = childEl(cursor, name);
    if (!cursor) return null;
  }
  return cursor;
}

/** Every element in the subtree with this tag name, in document order. */
export function findAllEl(parent: XmlElement | null, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (element: XmlElement): void => {
    if (element.name === name) out.push(element);
    for (const child of element.children) visit(child);
  };
  if (parent) visit(parent);
  return out;
}

/** A numeric attribute, or `null` when absent or not a finite number. */
export function attrNumber(element: XmlElement | null, name: string): number | null {
  const raw = element?.attrs[name];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** A string attribute, or `null` when absent. */
export function attrString(element: XmlElement | null, name: string): string | null {
  const raw = element?.attrs[name];
  return raw === undefined ? null : raw;
}
