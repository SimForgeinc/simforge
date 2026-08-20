import { describe, expect, it } from 'vitest';

import { readXml } from './xml.js';

describe('readXml', () => {
  it('reads declarations, comments, CDATA, self-closing elements, and predefined entities deterministically', () => {
    const root = readXml('<?xml version="1.0" encoding="UTF-8"?><!--before--><root a="&quot;&amp;&apos;&lt;&gt;"><empty/><value>left<![CDATA[<&raw>]]>right</value></root>');
    expect(root).toEqual({
      name: 'root',
      attributes: { a: "\"&'<>" },
      text: '',
      children: [
        { name: 'empty', attributes: {}, text: '', children: [] },
        { name: 'value', attributes: {}, text: 'left<&raw>right', children: [] },
      ],
    });
  });

  it('rejects malformed XML and non-predefined entities precisely', () => {
    expect(() => readXml('<root>&copy;</root>')).toThrow(/unsupported entity.*&copy;/);
    expect(() => readXml('<root><child></root>')).toThrow(/does not match <child>/);
  });
});
