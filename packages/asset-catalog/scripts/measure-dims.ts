/**
 * Print the measured bounding box of every catalog entry next to its
 * catalogued dims. The test suite asserts the two agree within 10%; this script
 * is how you find out *which* number to move when they do not.
 */
import { Box3, Vector3 } from 'three';

import { CATALOG } from '../src/catalog.js';
import { buildProp } from '../src/registry.js';

const rows: string[] = [];
let worst = 0;
for (const entry of CATALOG) {
  const object = buildProp(entry.id);
  object.updateMatrixWorld(true);
  const bbox = new Box3().setFromObject(object);
  const size = bbox.getSize(new Vector3());
  const measured = { l: size.x, w: size.z, h: size.y };
  const err = (a: number, b: number): number => Math.abs(a - b) / b;
  const errors = [
    err(measured.l, entry.dims.l),
    err(measured.w, entry.dims.w),
    err(measured.h, entry.dims.h),
  ];
  const maxErr = Math.max(...errors);
  worst = Math.max(worst, maxErr);
  const centre = { x: (bbox.min.x + bbox.max.x) / 2, z: (bbox.min.z + bbox.max.z) / 2 };
  rows.push(
    [
      entry.id.padEnd(34),
      `cat ${entry.dims.l.toFixed(2)}x${entry.dims.w.toFixed(2)}x${entry.dims.h.toFixed(2)}`.padEnd(24),
      `got ${measured.l.toFixed(2)}x${measured.w.toFixed(2)}x${measured.h.toFixed(2)}`.padEnd(24),
      `err ${(maxErr * 100).toFixed(1)}%`.padEnd(12),
      `y0 ${bbox.min.y.toFixed(3)}`.padEnd(12),
      `c ${centre.x.toFixed(2)},${centre.z.toFixed(2)}`,
      maxErr > 0.1 ? '  <-- OUT OF TOLERANCE' : '',
    ].join(' '),
  );
}
process.stdout.write(`${rows.join('\n')}\nworst error ${(worst * 100).toFixed(1)}%\n`);
