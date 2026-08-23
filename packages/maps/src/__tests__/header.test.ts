import { describe, expect, it } from 'vitest';
import { parseXodrHeader } from '../header.js';
import { yaleHeaderText } from './fixtures.js';

describe('parseXodrHeader', () => {
  it('extracts the PROJ string from the CDATA geoReference', () => {
    const header = parseXodrHeader(yaleHeaderText());
    expect(header.projString).toBe(
      '+proj=tmerc +lat_0=37.4100548676094 +lon_0=-122.154771275882 +k=1 +x_0=0 +y_0=0 ' +
        '+datum=WGS84 +units=m +vunits=m +no_defs',
    );
    expect(header.projString).not.toContain('CDATA');
  });

  it('extracts the road-network extents and header metadata', () => {
    const header = parseXodrHeader(yaleHeaderText());
    expect(header.extents.west).toBeCloseTo(328.2025162684058, 6);
    expect(header.extents.east).toBeCloseTo(996.5177973282405, 6);
    expect(header.extents.south).toBeCloseTo(1454.0891650042126, 6);
    expect(header.extents.north).toBeCloseTo(2029.3416434094254, 6);
    expect(header.revision).toBe('1.4');
    expect(header.vendor).toBe('MathWorks');
  });

  it('only needs a prefix of the document', () => {
    const prefix = yaleHeaderText().slice(0, 1024);
    expect(parseXodrHeader(prefix).extents.north).toBeCloseTo(2029.3416434094254, 6);
  });

  it('throws on documents without a georeference', () => {
    expect(() => parseXodrHeader('<OpenDRIVE></OpenDRIVE>')).toThrow(/no <header/);
    expect(() =>
      parseXodrHeader('<OpenDRIVE><header north="1" south="0" east="1" west="0"></header>'),
    ).toThrow(/geoReference/);
  });
});
