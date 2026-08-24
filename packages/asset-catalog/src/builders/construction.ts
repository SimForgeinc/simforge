import { Group, type Mesh } from 'three';

import {
  box,
  cone,
  cyl,
  mirrored,
  type Point2,
  profile,
  rand,
  sphere,
} from '../geometry';
import { material } from '../materials';
import { buildHumanoid } from './pedestrians';

/**
 * Temporary traffic control hardware. Sizes follow the MUTCD / US work-zone
 * norms an agent would reason about: 700 mm cones, 1070 mm drums, 8 ft type-III
 * barricades, 10 ft jersey barrier segments, 48 in orange diamond signs.
 */

/** Box spanning two side-view points — booms, sign legs, barricade frames. */
function beam(
  from: Point2,
  to: Point2,
  thickness: number,
  width: number,
  mat: ReturnType<typeof material>,
  z = 0,
): Mesh {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  const mesh = box([len, thickness, width], mat);
  mesh.rotation.z = Math.atan2(dy, dx);
  mesh.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, z);
  return mesh;
}

export interface ConeParams {
  /** Cone height, metres. 0.7 is the standard highway cone. */
  height: number;
}

export function buildTrafficCone(params: ConeParams = { height: 0.7 }): Group {
  const group = new Group();
  const s = params.height / 0.7;
  const orange = material('safetyOrange');
  const white = material('safetyWhite');
  const baseH = 0.035 * s;

  group.add(box([0.36 * s, baseH, 0.36 * s], orange, { at: [0, baseH / 2, 0] }));
  const bodyH = params.height - baseH;
  group.add(
    cyl(0.148 * s, bodyH, orange, {
      rTop: 0.028 * s,
      at: [0, baseH + bodyH / 2, 0],
      segments: 14,
    }),
  );
  const bandAt = (centre: number, height: number): void => {
    const t = (centre - baseH) / bodyH;
    const r = (0.148 - (0.148 - 0.028) * t) * s;
    const dr = ((0.148 - 0.028) * s * height) / bodyH / 2;
    group.add(
      cyl(r + dr + 0.004 * s, height, white, {
        rTop: r - dr + 0.004 * s,
        at: [0, centre, 0],
        segments: 14,
      }),
    );
  };
  bandAt(0.44 * s, 0.11 * s);
  bandAt(0.585 * s, 0.075 * s);
  return group;
}

export function buildChannelizerDrum(): Group {
  const group = new Group();
  const orange = material('safetyOrange');
  const white = material('safetyWhite');
  const black = material('plastic');

  group.add(cyl(0.29, 0.05, black, { at: [0, 0.025, 0], segments: 20 }));
  group.add(cyl(0.23, 1.02, orange, { rTop: 0.215, at: [0, 0.56, 0], segments: 20 }));
  const bands = [0.24, 0.47, 0.70, 0.93];
  for (const y of bands) {
    const t = (y - 0.05) / 1.02;
    const r = 0.23 - 0.015 * t;
    group.add(cyl(r + 0.006, 0.13, white, { rTop: r + 0.004, at: [0, y, 0], segments: 20 }));
  }
  // Lifting handle across the top.
  group.add(cyl(0.20, 0.03, black, { at: [0, 1.055, 0], segments: 20 }));
  return group;
}

/** Type III barricade: three striped rails on A-frames, facing +X. */
export function buildBarricadeTypeIII(): Group {
  const group = new Group();
  const orange = material('safetyOrange');
  const white = material('safetyWhite');
  const frame = material('plastic');
  const railW = 2.44;
  const stripes = 8;
  const seg = railW / stripes;

  [0.62, 1.02, 1.42].forEach((y, rail) => {
    for (let i = 0; i < stripes; i++) {
      const mat = (i + rail) % 2 === 0 ? orange : white;
      group.add(
        box([0.045, 0.30, seg * 0.99], mat, {
          at: [0, y, -railW / 2 + seg * (i + 0.5)],
        }),
      );
    }
  });
  // A-frames at both ends, plus feet.
  for (const z of [railW / 2 - 0.08, -railW / 2 + 0.08]) {
    group.add(beam([-0.24, 0.04], [0.05, 1.58], 0.07, 0.07, frame, z));
    group.add(beam([0.24, 0.04], [-0.05, 1.58], 0.07, 0.07, frame, z));
    group.add(box([0.62, 0.05, 0.10], frame, { at: [0, 0.025, z] }));
  }
  // Warning light on the top rail.
  group.add(cyl(0.07, 0.09, material('lamp'), { at: [0, 1.62, 0], segments: 12 }));
  return group;
}

/** Interlocking steel crowd-control barrier, extending along +X. */
export function buildPedestrianBarrier(): Group {
  const group = new Group();
  const steel = material('steel');
  const railLength = 2;
  const height = 1.1;

  group.add(box([railLength, 0.055, 0.055], steel, { at: [0, 0.16, 0] }));
  group.add(box([railLength, 0.055, 0.055], steel, { at: [0, height - 0.08, 0] }));
  for (let x = -0.9; x <= 0.901; x += 0.3) {
    group.add(box([0.035, height - 0.24, 0.035], steel, { at: [x, height / 2, 0] }));
  }
  for (const x of [-0.92, 0.92]) {
    group.add(box([0.055, height, 0.055], steel, { at: [x, height / 2, 0] }));
    group.add(box([0.1, 0.045, 0.55], steel, { at: [x, 0.0225, 0] }));
  }
  return group;
}

export interface BarrierParams {
  /** Segment length along +X. 3.05 m (10 ft) is the standard precast unit. */
  length: number;
}

/** One precast jersey barrier segment; the run direction is +X. */
export function buildJerseyBarrier(params: BarrierParams = { length: 3.05 }): Group {
  const group = new Group();
  const section: Point2[] = [
    [-0.305, 0.0],
    [0.305, 0.0],
    [0.305, 0.075],
    [0.19, 0.255],
    [0.12, 0.81],
    [-0.12, 0.81],
    [-0.19, 0.255],
    [-0.305, 0.075],
  ];
  const mesh = profile(section, params.length, material('concrete'), {
    radius: 0.025,
    bevel: 0.02,
  });
  // The section is authored in XY; spin it so the extrusion runs along +X.
  mesh.rotation.y = Math.PI / 2;
  group.add(mesh);
  return group;
}

export interface BarrierRunParams {
  /** Total run length along +X; rounded to whole segments. */
  length: number;
  segmentLength: number;
}

export function buildJerseyBarrierRun(
  params: BarrierRunParams = { length: 12.2, segmentLength: 3.05 },
): Group {
  const group = new Group();
  const gap = 0.03;
  const count = Math.max(1, Math.round(params.length / params.segmentLength));
  const pitch = params.length / count;
  const segLength = pitch - gap;
  for (let i = 0; i < count; i++) {
    const seg = buildJerseyBarrier({ length: segLength });
    seg.position.x = -params.length / 2 + pitch * (i + 0.5);
    seg.userData.catalogId = 'construction.jersey_barrier';
    group.add(seg);
  }
  group.userData.segmentCount = count;
  return group;
}

export interface SignParams {
  /** Diamond board edge length. 1.22 m (48 in) is the work-zone standard. */
  boardSize: number;
  /** Number of black text lines painted on the board. */
  textLines: number;
}

/** Orange diamond warning sign on a portable stand, facing +X. */
export function buildConstructionSign(
  params: SignParams = { boardSize: 1.22, textLines: 3 },
): Group {
  const group = new Group();
  const orange = material('signOrange');
  const black = material('plastic');
  const frame = material('metal');
  const size = params.boardSize;
  const diagonal = size * Math.SQRT2;
  const centreY = diagonal / 2 + 0.48;

  const board = box([0.05, size, size], orange, { at: [0, centreY, 0] });
  board.rotation.x = Math.PI / 4;
  group.add(board);

  // Legend, drawn as bars sized to the diamond's width at each line.
  const lines = Math.max(0, params.textLines);
  for (let i = 0; i < lines; i++) {
    const t = lines === 1 ? 0 : (i / (lines - 1)) * 2 - 1; // -1..1
    const y = centreY - t * diagonal * 0.26;
    const halfWidth = (diagonal / 2 - Math.abs(t) * diagonal * 0.26) * 0.72;
    group.add(box([0.03, size * 0.085, halfWidth * 2], black, { at: [0.04, y, 0] }));
  }

  // Portable X stand.
  for (const sign of [1, -1]) {
    group.add(beam([sign * 0.42, 0.02], [-sign * 0.24, 1.30], 0.07, 0.07, frame, 0.16 * sign));
  }
  group.add(box([0.90, 0.05, 0.12], frame, { at: [0, 0.025, 0.18] }));
  group.add(box([0.90, 0.05, 0.12], frame, { at: [0, 0.025, -0.18] }));
  group.add(box([0.08, 0.62, 0.08], frame, { at: [0, 0.62, 0] }));
  return group;
}

export interface FlaggerParams {
  height: number;
  /** `stop` shows the red face, `slow` the orange one. */
  paddle: 'stop' | 'slow';
}

/** Work-zone flagger holding a paddle out to the side of the road. */
export function buildFlagger(params: FlaggerParams = { height: 1.78, paddle: 'stop' }): Group {
  const h = params.height;
  const group = new Group();
  const figure = buildHumanoid({
    height: h,
    pose: 'standing',
    vest: true,
    pants: { key: 'pants', color: '#3b4048' },
    rightArmPitch: 1.25,
  });
  const headR = h * 0.066;
  // Hard hat.
  figure.add(
    sphere(headR * 1.12, material('safetyOrange'), {
      at: [0, h - headR * 1.15, 0],
      scale: [1, 0.72, 1],
      segments: 14,
    }),
  );
  figure.add(
    cyl(headR * 1.5, 0.02, material('safetyOrange'), {
      at: [0.01, h - headR * 1.25, 0],
      segments: 16,
    }),
  );

  // Paddle: octagonal face on a staff, held in the −Z hand.
  const armZ = -(h * 0.195) / 2 - h * 0.031 * 0.6;
  const handX = Math.sin(1.25) * h * 0.31 * 1.05;
  const handY = h * 0.75;
  figure.add(cyl(0.018, 0.52, material('plastic'), { at: [handX, handY + 0.18, armZ], segments: 8 }));
  const face = params.paddle === 'stop' ? material('taillight') : material('signOrange');
  figure.add(
    cyl(0.23, 0.035, face, {
      axis: 'x',
      at: [handX, handY + 0.62, armZ],
      segments: 8,
    }),
  );
  // Nudge the figure back so the assembly (body + outstretched paddle) is
  // centred on the placement point; the feet stay within 10 cm of it.
  figure.position.x = -0.10;
  group.add(figure);
  return group;
}

export interface ArrowBoardParams {
  /**
   * Which way the arrow tells traffic to move, as read by the driver facing the
   * board. `left` lights up towards the board's local +Z.
   */
  direction: 'left' | 'right';
  /** Board height above ground at its centre. */
  raised: boolean;
}

/** Trailer-mounted arrow board, board face towards +X (oncoming traffic). */
export function buildArrowBoard(
  params: ArrowBoardParams = { direction: 'left', raised: true },
): Group {
  const group = new Group();
  const steel = material('steel');
  const orange = material('safetyOrange');
  const black = material('plastic');
  const boardW = 2.44;
  const boardH = 1.22;
  const boardCentre = params.raised ? 1.92 : 1.30;

  // Trailer: deck, tongue, wheels, outriggers.
  group.add(box([2.30, 0.18, 1.40], orange, { at: [-0.45, 0.62, 0] }));
  group.add(beam([0.70, 0.62], [1.75, 0.50], 0.14, 0.16, orange));
  group.add(box([0.16, 0.30, 0.16], steel, { at: [1.76, 0.35, 0] }));
  group.add(...mirrored(0.86, (z) => cyl(0.30, 0.20, material('tire'), { axis: 'z', at: [-0.55, 0.30, z], segments: 16 })));
  group.add(...mirrored(0.86, (z) => cyl(0.14, 0.22, material('rim'), { axis: 'z', at: [-0.55, 0.30, z], segments: 10 })));
  group.add(...mirrored(0.78, (z) => box([0.16, 0.42, 0.16], steel, { at: [-1.44, 0.30, z] })));
  group.add(...mirrored(0.78, (z) => box([0.34, 0.08, 0.30], steel, { at: [-1.44, 0.04, z] })));

  // Mast and board.
  group.add(box([0.16, boardCentre - 0.55, 0.20], steel, { at: [-0.60, (boardCentre + 0.15) / 2, 0] }));
  group.add(box([0.12, boardH, boardW], black, { at: [-0.60, boardCentre, 0] }));

  // Lamp matrix: shaft plus chevron. The driver reads the board from +X looking
  // back along −X, so their left is the board's local +Z.
  const dir = params.direction === 'left' ? 1 : -1;
  const lamp = material('lamp');
  const lamps: Point2[] = [];
  for (let i = 0; i < 5; i++) lamps.push([-0.62 + i * 0.28, 0]);
  for (let i = 1; i <= 3; i++) {
    lamps.push([0.78 - i * 0.22, i * 0.17]);
    lamps.push([0.78 - i * 0.22, -i * 0.17]);
  }
  lamps.push([0.80, 0]);
  for (const [z, y] of lamps) {
    group.add(
      sphere(0.055, lamp, { at: [-0.53, boardCentre + y, dir * z], segments: 8 }),
    );
  }
  return group;
}

export function buildExcavator(): Group {
  const group = new Group();
  const body = new Group();
  const yellow = material('paint', '#d8a41c');
  const steel = material('steel');
  const black = material('plastic');

  // Tracks.
  const trackProfile: Point2[] = [
    [-1.72, 0.10],
    [-1.55, 0.62],
    [1.55, 0.62],
    [1.72, 0.10],
    [1.45, 0.0],
    [-1.45, 0.0],
  ];
  body.add(
    ...mirrored(0.86, (z) => profile(trackProfile, 0.52, black, { radius: 0.14, bevel: 0.05, at: [0, 0, z] })),
  );
  body.add(box([2.90, 0.22, 1.30], steel, { at: [0, 0.55, 0] }));

  // Upper house with counterweight and cab.
  body.add(cyl(0.55, 0.14, steel, { at: [0, 0.74, 0], segments: 16 }));
  body.add(
    profile(
      [
        [-1.42, 0.80],
        [-1.42, 1.62],
        [0.90, 1.62],
        [1.05, 1.30],
        [1.05, 0.80],
      ],
      1.90,
      yellow,
      { radius: 0.12, bevel: 0.08 },
    ),
  );
  body.add(box([0.62, 0.94, 1.92], steel, { at: [-1.70, 1.22, 0] }));
  body.add(
    profile(
      [
        [-0.10, 1.60],
        [-0.10, 2.62],
        [0.90, 2.62],
        [0.98, 1.60],
      ],
      0.94,
      yellow,
      { radius: 0.10, bevel: 0.07, at: [0, 0, -0.44] },
    ),
  );
  body.add(box([0.06, 0.78, 0.80], material('glass'), { at: [0.98, 2.16, -0.44] }));

  // Boom, dipper, bucket reaching forward over the tracks.
  body.add(beam([0.90, 1.55], [2.05, 2.60], 0.30, 0.36, yellow, 0.42));
  body.add(beam([2.05, 2.58], [2.78, 1.30], 0.26, 0.30, yellow, 0.42));
  body.add(
    profile(
      [
        [2.60, 1.28],
        [3.02, 1.30],
        [3.14, 0.62],
        [2.76, 0.36],
        [2.58, 0.72],
      ],
      0.62,
      steel,
      { radius: 0.06, bevel: 0.05, at: [0, 0, 0.42] },
    ),
  );
  body.add(cyl(0.08, 1.00, material('chrome'), { at: [1.42, 1.90, 0.42], rot: [0, 0, -0.75], segments: 10 }));
  // Boom forward, counterweight aft: the machine is asymmetric, so the whole
  // assembly is shifted to sit centred on its placement point.
  body.position.x = -0.57;
  group.add(body);
  return group;
}

export function buildPortableToilet(): Group {
  const group = new Group();
  const shell = material('paint', '#2f7d63');
  const roof = material('safetyWhite');
  const dark = material('plastic');

  group.add(
    profile(
      [
        [-0.58, 0.0],
        [-0.55, 2.16],
        [0.55, 2.16],
        [0.58, 0.0],
      ],
      1.16,
      shell,
      { radius: 0.07, bevel: 0.05 },
    ),
  );
  group.add(box([1.22, 0.10, 1.22], roof, { at: [0, 2.21, 0] }));
  group.add(box([0.06, 1.78, 0.70], dark, { at: [0.575, 1.02, 0] }));
  group.add(box([0.05, 0.13, 0.09], dark, { at: [0.60, 1.05, 0.28] }));
  // Vent slots below the roof.
  for (let i = 0; i < 3; i++) {
    group.add(box([0.04, 0.035, 0.86], dark, { at: [0.58, 2.02 - i * 0.07, 0] }));
  }
  return group;
}

export interface SpoilPileParams {
  /** Nominal base diameter, metres; the lumps spread a little beyond it. */
  length: number;
  height: number;
  seed: number;
}

export interface PipeParams { length: number; diameter: number }

export function buildTemporaryStopSign(): Group {
  const group = new Group();
  const steel = material('steel');
  group.add(box([0.82, 0.08, 0.72], steel, { at: [0, 0.04, 0] }));
  group.add(cyl(0.035, 1.45, steel, { at: [0, 0.78, 0], segments: 8 }));
  group.add(cyl(0.46, 0.055, material('taillight'), { axis: 'x', at: [0, 1.70, 0], segments: 8 }));
  group.add(box([0.04, 0.10, 0.55], material('signWhite'), { at: [0.03, 1.70, 0] }));
  return group;
}

export function buildPortableSignal(): Group {
  const group = new Group();
  const steel = material('steel');
  group.add(box([1.45, 0.18, 1.2], material('safetyOrange'), { at: [0, 0.23, 0] }));
  group.add(...mirrored(0.48, (z) => cyl(0.20, 0.14, material('tire'), { axis: 'z', at: [-0.35, 0.20, z], segments: 12 })));
  group.add(cyl(0.06, 2.35, steel, { at: [0, 1.48, 0], segments: 10 }));
  group.add(box([0.30, 1.02, 0.50], material('plastic'), { at: [0, 2.72, 0] }));
  const colors = [material('taillight'), material('lamp'), material('lamp', '#48b460')];
  colors.forEach((mat, i) => group.add(cyl(0.105, 0.07, mat, { axis: 'x', at: [0.185, 3.03 - i * 0.31, 0], segments: 14 })));
  return group;
}

export function buildLongPipe(params: PipeParams = { length: 8, diameter: 0.62 }): Group {
  const group = new Group();
  const pipe = cyl(params.diameter / 2, params.length, material('steel'), { axis: 'x', at: [0, params.diameter / 2, 0], segments: 16 });
  group.add(pipe);
  return group;
}

/** Excavated spoil / broken pavement heap. */
export function buildSpoilPile(
  params: SpoilPileParams = { length: 2.5, height: 0.9, seed: 7 },
): Group {
  const group = new Group();
  const dirt = material('dirt');
  const rock = material('concrete');
  const random = rand(params.seed);
  const l = params.length;
  const h = params.height;

  group.add(
    cone(l * 0.42, h, dirt, {
      at: [0, h / 2, 0],
      rot: [0, random() * Math.PI, 0],
      scale: [1, 1, 0.82],
      segments: 7,
    }),
  );
  // Overlapping sub-heaps break the single-cone silhouette; a spoil pile is
  // several dumps of material, not a sandcastle.
  for (let i = 0; i < 7; i++) {
    const angle = random() * Math.PI * 2;
    const radius = l * (0.10 + random() * 0.16);
    const size = h * (0.3 + random() * 0.32);
    group.add(
      cone(size * 0.9, size, dirt, {
        at: [Math.cos(angle) * radius, size / 2, Math.sin(angle) * radius * 0.8],
        rot: [0, random() * Math.PI, 0],
        segments: 6,
      }),
    );
  }
  for (let i = 0; i < 6; i++) {
    const angle = random() * Math.PI * 2;
    const radius = l * (0.15 + random() * 0.19);
    const size = 0.12 + random() * 0.16;
    group.add(
      box([size * 1.6, size * 0.5, size], rock, {
        at: [Math.cos(angle) * radius, size * 0.42, Math.sin(angle) * radius * 0.8],
        rot: [0, random() * Math.PI, random() * 0.3 - 0.15],
      }),
    );
  }
  return group;
}
