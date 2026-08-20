export type XmlElement = {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly text: string;
};

export class XmlReadError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`XML parse error at offset ${offset}: ${message}`);
    this.name = 'XmlReadError';
    this.offset = offset;
  }
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CONTINUE = /[A-Za-z0-9_.:-]/;
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

type MutableElement = {
  name: string;
  attributes: Record<string, string>;
  children: MutableElement[];
  text: string;
};

export function readXml(source: string): XmlElement {
  let offset = 0;
  const stack: MutableElement[] = [];
  let root: MutableElement | null = null;

  const fail = (message: string, at = offset): never => { throw new XmlReadError(message, at); };
  const starts = (value: string): boolean => source.startsWith(value, offset);
  const whitespace = (): void => { while (offset < source.length && /\s/.test(source[offset]!)) offset += 1; };
  const name = (): string => {
    const start = offset;
    if (!NAME_START.test(source[offset] ?? '')) fail('expected an XML name');
    offset += 1;
    while (offset < source.length && NAME_CONTINUE.test(source[offset]!)) offset += 1;
    return source.slice(start, offset);
  };
  const decode = (value: string, baseOffset: number): string => value.replace(/&([^;]*);/g, (match, entity: string, index: number) => {
    const decoded = PREDEFINED_ENTITIES[entity];
    if (decoded === undefined) fail(`unsupported entity ${JSON.stringify(match)}`, baseOffset + index);
    return decoded!;
  });
  const appendText = (value: string, decodeEntities: boolean, at: number): void => {
    if (stack.length === 0) {
      if (value.trim() !== '') fail('text is not allowed outside the document element', at);
      return;
    }
    stack[stack.length - 1]!.text += decodeEntities ? decode(value, at) : value;
  };

  if (source.charCodeAt(0) === 0xfeff) offset = 1;
  whitespace();
  if (starts('<?xml')) {
    const end = source.indexOf('?>', offset + 5);
    if (end < 0) fail('unterminated XML declaration');
    const declaration = source.slice(offset + 5, end);
    if (!/^\s+version\s*=\s*(['"])1\.[01]\1(?:\s+encoding\s*=\s*(['"])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*$/.test(declaration)) {
      fail('malformed XML declaration');
    }
    offset = end + 2;
  }

  while (offset < source.length) {
    if (!starts('<')) {
      const start = offset;
      const end = source.indexOf('<', offset);
      offset = end < 0 ? source.length : end;
      appendText(source.slice(start, offset), true, start);
      continue;
    }
    if (starts('<!--')) {
      const end = source.indexOf('-->', offset + 4);
      if (end < 0) fail('unterminated comment');
      if (source.slice(offset + 4, end).includes('--')) fail('comment body may not contain "--"');
      offset = end + 3;
      continue;
    }
    if (starts('<![CDATA[')) {
      const start = offset;
      const end = source.indexOf(']]>', offset + 9);
      if (end < 0) fail('unterminated CDATA section');
      if (stack.length === 0) fail('CDATA is not allowed outside the document element');
      appendText(source.slice(offset + 9, end), false, start + 9);
      offset = end + 3;
      continue;
    }
    if (starts('<?')) fail('processing instructions are not supported');
    if (starts('<!')) fail('document types and declarations are not supported');
    if (starts('</')) {
      const start = offset;
      offset += 2;
      const closing = name();
      whitespace();
      if (!starts('>')) fail('expected ">" after closing tag');
      offset += 1;
      const open = stack.pop();
      if (!open) fail(`unexpected closing tag </${closing}>`, start);
      if (open!.name !== closing) fail(`closing tag </${closing}> does not match <${open!.name}>`, start);
      continue;
    }

    const start = offset;
    offset += 1;
    const element: MutableElement = { name: name(), attributes: {}, children: [], text: '' };
    while (true) {
      whitespace();
      if (starts('/>')) {
        offset += 2;
        if (stack.length > 0) stack[stack.length - 1]!.children.push(element);
        else if (root) fail('multiple document elements', start);
        else root = element;
        break;
      }
      if (starts('>')) {
        offset += 1;
        if (stack.length > 0) stack[stack.length - 1]!.children.push(element);
        else if (root) fail('multiple document elements', start);
        else root = element;
        stack.push(element);
        break;
      }
      const attributeStart = offset;
      const attributeName = name();
      if (Object.hasOwn(element.attributes, attributeName)) fail(`duplicate attribute ${JSON.stringify(attributeName)}`, attributeStart);
      whitespace();
      if (!starts('=')) fail(`expected "=" after attribute ${JSON.stringify(attributeName)}`);
      offset += 1;
      whitespace();
      const quote = source[offset];
      if (quote !== '"' && quote !== "'") fail(`expected quoted value for attribute ${JSON.stringify(attributeName)}`);
      offset += 1;
      const valueStart = offset;
      const valueEnd = source.indexOf(quote!, offset);
      if (valueEnd < 0) fail(`unterminated value for attribute ${JSON.stringify(attributeName)}`, valueStart);
      const raw = source.slice(offset, valueEnd);
      if (raw.includes('<')) fail('attribute values may not contain "<"', valueStart);
      element.attributes[attributeName] = decode(raw, valueStart);
      offset = valueEnd + 1;
    }
  }

  if (stack.length > 0) fail(`unclosed element <${stack[stack.length - 1]!.name}>`);
  if (!root) fail('missing document element');
  return root!;
}
