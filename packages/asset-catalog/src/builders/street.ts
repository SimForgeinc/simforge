import { Group } from 'three';

import { box, cyl, mirrored, type Point2, profile, rand, sphere } from '../geometry';
import { material } from '../materials';

/**
 * Roadside furniture and sightline blockers. These exist so a scenario author
 * can hide the thing the ego is supposed to be surprised by: a dumpster at a
 * driveway mouth, a hedge along a stop-controlled approach, a shelter at a
 * crosswalk.
 */

export function buildDumpster(): Group {
  const group = new Group();
  const shell = material('paint', '#3f6b4f');
  const dark = material('plastic');
  const steel = material('steel');

  group.add(
    profile(
      [
        [-0.78, 0.14],
        [-0.915, 1.14],
        [0.915, 1.14],
        [0.78, 0.14],
      ],
      1.52,
      shell,
      { radius: 0.06, bevel: 0.05 },
    ),
  );
  // Two plastic lids, hinged along the centreline.
  group.add(
    ...mirrored(0.37, (z) => box([1.86, 0.07, 0.76], dark, { at: [0, 1.20, z], rot: [z > 0 ? 0.05 : -0.05, 0, 0] })),
  );
  // Forklift pockets and casters.
  group.add(...mirrored(0.42, (z) => box([0.10, 0.16, 0.30], steel, { at: [0.92, 0.55, z] })));
  group.add(
    ...mirrored(0.60, (z) => cyl(0.07, 0.05, dark, { axis: 'z', at: [0.62, 0.07, z], segments: 10 })),
  );
  group.add(
    ...mirrored(0.60, (z) => cyl(0.07, 0.05, dark, { axis: 'z', at: [-0.62, 0.07, z], segments: 10 })),
  );
  group.add(box([1.70, 0.06, 1.40], steel, { at: [0, 0.14, 0] }));
  return group;
}

/** A car under a fitted cover: recognisable car mass, no readable vehicle. */
export function buildCoveredCar(): Group {
  const group = new Group();
  const tarp = material('tarp');
  const tire = material('tire');

  group.add(
    profile(
      [
        [-2.30, 0.28],
        [-2.16, 1.06],
        [-1.18, 1.46],
        [0.28, 1.48],
        [1.48, 1.12],
        [2.28, 0.82],
        [2.30, 0.28],
      ],
      1.90,
      tarp,
      { radius: 0.30, bevel: 0.16, curveSegments: 6 },
    ),
  );
  // Tyres peeking out below the cover keep the ground contact honest.
  for (const x of [1.42, -1.40]) {
    group.add(
      ...mirrored(0.78, (z) => cyl(0.31, 0.22, tire, { axis: 'z', at: [x, 0.31, z], segments: 14 })),
    );
  }
  // Elastic hem line.
  group.add(
    profile(
      [
        [-2.28, 0.26],
        [-2.28, 0.34],
        [2.28, 0.34],
        [2.28, 0.26],
      ],
      1.93,
      material('fabric'),
      { radius: 0.03, bevel: 0.03 },
    ),
  );
  return group;
}

export interface RunParams {
  /** Run length along +X. */
  length: number;
  height: number;
}

/** Clipped hedge run — a soft, opaque sightline blocker. */
export function buildHedgeRun(params: RunParams = { length: 6, height: 1.2 }): Group {
  const group = new Group();
  const foliage = material('foliage');
  const l = params.length;
  const h = params.height;
  const w = 0.8;

  const body = profile(
    [
      [-w / 2, 0.06],
      [-w / 2 + 0.04, h - 0.10],
      [w / 2 - 0.04, h - 0.10],
      [w / 2, 0.06],
    ],
    l,
    foliage,
    { radius: 0.16, bevel: 0.10 },
  );
  body.rotation.y = Math.PI / 2;
  group.add(body);

  // Lumpy crown, clamped so the run keeps its catalogued envelope.
  const random = rand(Math.round(l * 100) + 3);
  const lumps = Math.max(3, Math.round(l / 0.7));
  for (let i = 0; i < lumps; i++) {
    const x = -l / 2 + (l * (i + 0.5)) / lumps;
    const r = Math.min(w * 0.42, 0.20 + random() * 0.14);
    group.add(
      sphere(r, foliage, {
        at: [x, h - r * 0.92, (random() - 0.5) * (w * 0.5 - r)],
        scale: [1, 0.85, 1],
        segments: 10,
      }),
    );
  }
  // Trunk shadow line at the base.
  group.add(box([l, 0.08, w * 0.6], material('dirt'), { at: [0, 0.04, 0] }));
  return group;
}

/** Chain-link fence run: posts, rails and a translucent mesh panel. */
export function buildFenceRun(params: RunParams = { length: 6, height: 1.8 }): Group {
  const group = new Group();
  const steel = material('steel');
  const mesh = material('chainlink');
  const l = params.length;
  const h = params.height;

  const posts = Math.max(2, Math.round(l / 3) + 1);
  for (let i = 0; i < posts; i++) {
    const x = -l / 2 + (l * i) / (posts - 1);
    group.add(cyl(0.032, h, steel, { at: [x, h / 2, 0], segments: 10 }));
  }
  group.add(cyl(0.026, l, steel, { axis: 'x', at: [0, h - 0.04, 0], segments: 8 }));
  group.add(cyl(0.026, l, steel, { axis: 'x', at: [0, 0.10, 0], segments: 8 }));
  group.add(box([l, h - 0.16, 0.012], mesh, { at: [0, h / 2 + 0.02, 0] }));
  return group;
}

/** Cluster mailbox unit (USPS CBU) on a pedestal, doors facing +X. */
export function buildMailboxCluster(): Group {
  const group = new Group();
  const shell = material('metal');
  const dark = material('plastic');

  group.add(box([0.26, 0.70, 0.34], shell, { at: [0, 0.35, 0] }));
  group.add(box([0.46, 0.74, 0.90], shell, { at: [0, 1.03, 0] }));
  // Door grid on the front face.
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      group.add(
        box([0.04, 0.18, 0.19], dark, {
          at: [0.24, 0.78 + row * 0.22, -0.33 + col * 0.22],
        }),
      );
    }
  }
  // Peaked hood.
  group.add(box([0.54, 0.06, 0.98], shell, { at: [0, 1.42, 0] }));
  group.add(
    profile(
      [
        [-0.27, 1.42],
        [0, 1.52],
        [0.27, 1.42],
      ],
      0.98,
      shell,
      { radius: 0.03, bevel: 0.03 },
    ),
  );
  return group;
}

/** Transit shelter: roof, back and side glass, bench. A tall, wide occluder. */
export function buildBusShelter(): Group {
  const group = new Group();
  const steel = material('steel');
  const glass = material('glassPanel');
  const bench = material('wood');

  const l = 4.0;
  const w = 1.6;
  const h = 2.5;
  // Corner posts.
  for (const x of [l / 2 - 0.06, -l / 2 + 0.06]) {
    group.add(...mirrored(w / 2 - 0.06, (z) => box([0.09, h - 0.08, 0.09], steel, { at: [x, (h - 0.08) / 2, z] })));
  }
  // Roof with a small overhang, kept inside the catalogued footprint.
  group.add(box([l, 0.10, w], steel, { at: [0, h - 0.05, 0] }));
  group.add(box([l - 0.24, 0.05, w - 0.20], material('metal'), { at: [0, h - 0.13, 0] }));
  // Back wall (−Z, the kerb side is open) and one end panel.
  group.add(box([l - 0.20, h - 0.55, 0.04], glass, { at: [0, (h - 0.55) / 2 + 0.18, -w / 2 + 0.05] }));
  group.add(box([0.04, h - 0.55, w - 0.22], glass, { at: [-l / 2 + 0.10, (h - 0.55) / 2 + 0.18, 0] }));
  // Advertising panel at the far end.
  group.add(box([0.08, 1.70, w - 0.30], material('signWhite'), { at: [l / 2 - 0.10, 1.10, 0] }));
  // Bench.
  group.add(box([l - 0.80, 0.07, 0.42], bench, { at: [0, 0.45, -w / 2 + 0.34] }));
  group.add(box([l - 0.80, 0.42, 0.05], bench, { at: [0, 0.66, -w / 2 + 0.14] }));
  group.add(
    ...mirrored((l - 1.2) / 2, (x) => box([0.06, 0.45, 0.40], steel, { at: [x, 0.225, -w / 2 + 0.34] })),
  );
  return group;
}

/** Sidewalk food cart with a canopy — a compact pedestrian-scale occluder. */
export function buildFoodCart(): Group {
  const group = new Group();
  const shell = material('metal');
  const canopy = material('paint', '#c0392b');
  const dark = material('plastic');

  group.add(box([1.60, 0.72, 0.86], shell, { at: [0, 0.72, 0] }));
  group.add(box([1.76, 0.07, 1.00], material('chrome'), { at: [0, 1.12, 0] }));
  group.add(box([0.50, 0.26, 0.60], material('steel'), { at: [-0.40, 1.28, 0] }));
  // Menu board on the serving side.
  group.add(box([0.05, 0.42, 0.80], material('signWhite'), { at: [0.82, 1.36, 0] }));
  // Canopy on four poles.
  group.add(
    ...mirrored(0.44, (z) =>
      cyl(0.022, 0.90, shell, { at: [0.74, 1.60, z], segments: 8 }),
    ),
  );
  group.add(
    ...mirrored(0.44, (z) =>
      cyl(0.022, 0.90, shell, { at: [-0.74, 1.60, z], segments: 8 }),
    ),
  );
  const top: Point2[] = [
    [-0.92, 2.00],
    [0, 2.18],
    [0.92, 2.00],
    [0.92, 1.94],
    [0, 2.10],
    [-0.92, 1.94],
  ];
  group.add(profile(top, 1.00, canopy, { radius: 0.03, bevel: 0.03 }));
  // Wheels and handle.
  group.add(
    ...mirrored(0.40, (z) => cyl(0.18, 0.09, dark, { axis: 'z', at: [0.50, 0.18, z], segments: 12 })),
  );
  group.add(
    ...mirrored(0.40, (z) => cyl(0.18, 0.09, dark, { axis: 'z', at: [-0.50, 0.18, z], segments: 12 })),
  );
  return group;
}

export function buildShoppingCart(): Group {
  const group = new Group();
  const steel = material('steel');
  const dark = material('plastic');
  group.add(box([0.72, 0.04, 0.58], steel, { at: [0.02, 0.30, 0] }));
  group.add(box([0.70, 0.52, 0.04], steel, { at: [0, 0.60, -0.29] }));
  group.add(box([0.70, 0.52, 0.04], steel, { at: [0, 0.60, 0.29] }));
  group.add(box([0.04, 0.52, 0.58], steel, { at: [0.35, 0.60, 0] }));
  group.add(box([0.04, 0.76, 0.65], steel, { at: [-0.50, 0.66, 0] }));
  group.add(box([0.12, 0.06, 0.65], dark, { at: [-0.50, 1.02, 0] }));
  for (const x of [-0.36, 0.36]) group.add(...mirrored(0.25, (z) => cyl(0.08, 0.06, dark, { axis: 'z', at: [x, 0.08, z], segments: 8 })));
  return group;
}
