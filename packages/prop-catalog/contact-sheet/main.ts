/**
 * Visual contact sheet: every catalog entry plus the two composites, each in
 * its own framed cell with a 1 m ground grid so scale, ground contact and
 * silhouette are all verifiable at a glance.
 *
 * Rendered by `scripts/render-contact-sheet.mjs` into
 * `/tmp/prop-catalog-sheet.png`.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';

import { CATALOG } from '../src/catalog.js';
import { buildParkedRow, buildWorkZone } from '../src/composites.js';
import { buildProp } from '../src/registry.js';

const PAD = 24;
const HEADER = 104;
const COLS = 6;
const CELL_W = 396;
const CELL_H = 322;
const CAPTION_H = 52;
const SECTION_H = 30;
const WIDE_H = 430;

interface Cell {
  label: string;
  id: string;
  dims: string;
  tags: string;
  object: Object3D;
  x: number;
  y: number;
  w: number;
  h: number;
}

const sheet = document.getElementById('sheet') as HTMLDivElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const canvas = document.getElementById('gl') as HTMLCanvasElement;

// ---------------------------------------------------------------- cell layout
const cells: Cell[] = [];
const sections: { title: string; y: number }[] = [];
let cursorY = HEADER;
let column = 0;

// Every class the catalog defines. Robots, drones and animals were missing
// from this list, so sixteen props were never in the review sheet at all.
const classOrder = [
  'vehicle',
  'pedestrian',
  'sidewalk_robot',
  'drone',
  'animal',
  'construction',
  'occluder',
  'street',
  'hazard',
];
const grouped = classOrder.map((cls) => ({
  cls,
  entries: CATALOG.filter((entry) => entry.class === cls),
}));

for (const { cls, entries } of grouped) {
  if (column !== 0) {
    cursorY += CELL_H;
    column = 0;
  }
  sections.push({ title: `${cls} — ${entries.length}`, y: cursorY });
  cursorY += SECTION_H;
  for (const entry of entries) {
    cells.push({
      label: entry.label,
      id: entry.id,
      dims: `${entry.dims.l} × ${entry.dims.w} × ${entry.dims.h} m`,
      tags: entry.tags.join(' · '),
      object: buildProp(entry.id),
      x: PAD + column * CELL_W,
      y: cursorY,
      w: CELL_W - 8,
      h: CELL_H - 8,
    });
    column += 1;
    if (column === COLS) {
      column = 0;
      cursorY += CELL_H;
    }
  }
}
if (column !== 0) {
  cursorY += CELL_H;
  column = 0;
}

// Composites get full-width cells: their layouts are 100 m long.
sections.push({ title: 'composites — 2', y: cursorY });
cursorY += SECTION_H;
const wideWidth = (COLS * CELL_W) / 2;
const composites: { label: string; id: string; dims: string; tags: string; object: Object3D }[] = [
  {
    label: 'Work zone (right lane closed)',
    id: 'buildWorkZone({ length: 12, taperLength: 12, advanceWarning: 9, ... })',
    dims: 'sign → arrow board → taper → drums → termination (shown compressed)',
    tags: 'composite',
    object: buildWorkZone({
      length: 12,
      taperLength: 12,
      advanceWarning: 9,
      deviceSpacing: 4,
      drumSpacing: 6,
      terminationLength: 6,
    }),
  },
  {
    label: 'Parked row',
    id: 'buildParkedRow({ count: 6, gap: 1.0 })',
    dims: '6 vehicles · deterministic type and paint mix',
    tags: 'composite',
    object: buildParkedRow({ count: 6, gap: 1.0, seed: 1 }),
  },
];
composites.forEach((composite, index) => {
  cells.push({
    ...composite,
    x: PAD + index * wideWidth,
    y: cursorY,
    w: wideWidth - 8,
    h: WIDE_H - 8,
  });
});
cursorY += WIDE_H;

const SHEET_W = PAD * 2 + COLS * CELL_W;
const SHEET_H = cursorY + PAD;

sheet.style.width = `${SHEET_W}px`;
sheet.style.height = `${SHEET_H}px`;

// ------------------------------------------------------------------- overlay
const header = document.createElement('div');
header.className = 'header';
header.innerHTML = `<h1>@uniscenarios/prop-catalog</h1><p>${CATALOG.length} procedurally generated props · dimensions in metres · 1 m ground grid · origin at ground centre, +X towards the camera-right</p>`;
overlay.appendChild(header);

for (const section of sections) {
  const el = document.createElement('div');
  el.className = 'section';
  el.textContent = section.title;
  el.style.left = `${PAD}px`;
  el.style.top = `${section.y + 8}px`;
  overlay.appendChild(el);
}

for (const cell of cells) {
  const el = document.createElement('div');
  el.className = 'cell';
  el.style.left = `${cell.x}px`;
  el.style.top = `${cell.y}px`;
  el.style.width = `${cell.w}px`;
  el.style.height = `${cell.h}px`;
  el.innerHTML =
    `<div class="caption">` +
    `<div class="name"><span>${cell.label}</span><span class="dims">${cell.dims}</span></div>` +
    `<div class="id"><span>${cell.id}</span><span class="tags">${cell.tags}</span></div>` +
    `</div>`;
  overlay.appendChild(el);
}

// -------------------------------------------------------------------- render
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
renderer.setSize(SHEET_W, SHEET_H, false);
renderer.setClearColor(new Color('#f3f2ee'), 1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.autoClear = false;

const scene = new Scene();
scene.add(new HemisphereLight(0xdfe8f2, 0x9c9384, 1.6));
scene.add(new AmbientLight(0xffffff, 0.25));
const sun = new DirectionalLight(0xfff3e0, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0012;
scene.add(sun);
scene.add(sun.target);

const ground = new Mesh(
  new PlaneGeometry(1, 1),
  new MeshStandardMaterial({ color: 0xe9e7e1, roughness: 1, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
ground.position.y = -0.004;
scene.add(ground);

const stage = new Group();
scene.add(stage);

let grid: GridHelper | null = null;

/** Ground grid sized to the subject: 1 m squares for props, 5/10 m for layouts. */
function setGrid(centre: Vector3, extent: number): number {
  const step = extent < 16 ? 1 : extent < 60 ? 2 : 10;
  const span = Math.ceil((extent * 1.6) / step) * step;
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
  }
  grid = new GridHelper(span, span / step, 0xa8a49b, 0xc4c0b7);
  grid.position.set(centre.x, 0.002, centre.z);
  scene.add(grid);
  ground.scale.set(span * 12, span * 12, 1);
  ground.position.set(centre.x, -0.004, centre.z);
  return step;
}

const camera = new PerspectiveCamera(26, 1, 0.1, 4000);

function frame(cell: Cell): void {
  stage.clear();
  stage.add(cell.object);
  cell.object.updateMatrixWorld(true);

  const bbox = new Box3().setFromObject(cell.object);
  const centre = bbox.getCenter(new Vector3());
  const size = bbox.getSize(new Vector3());
  const radius = Math.max(size.length() / 2, 0.4);
  const footprint = Math.max(size.x, size.z);

  const aspect = cell.w / (cell.h - CAPTION_H);
  camera.aspect = aspect;

  // A consistent three-quarter view, lifted for sprawling layouts so a 170 m
  // work zone reads as a plan rather than as a line on the horizon.
  // Sprawling layouts are viewed more across their run and from higher up, so
  // a work zone reads as a plan rather than as a line on the horizon.
  const sprawling = footprint > 25;
  const azimuth = sprawling ? Math.PI * 0.42 : Math.PI * 0.30;
  const elevation = sprawling ? Math.PI * 0.24 : Math.PI * 0.12;
  const dir = new Vector3(
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth),
  );
  const target = centre.clone();

  // Fit by projecting the eight bbox corners onto the camera basis and solving
  // for the distance that keeps every one of them inside both FOVs.
  const right = new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize();
  const up = new Vector3().crossVectors(right, dir).normalize();
  const tanV = Math.tan((camera.fov * Math.PI) / 360);
  const tanH = tanV * aspect;
  let fitDistance = radius;
  for (let i = 0; i < 8; i++) {
    const corner = new Vector3(
      i & 1 ? bbox.max.x : bbox.min.x,
      i & 2 ? bbox.max.y : bbox.min.y,
      i & 4 ? bbox.max.z : bbox.min.z,
    ).sub(target);
    const depth = corner.dot(dir);
    fitDistance = Math.max(
      fitDistance,
      depth + Math.abs(corner.dot(right)) / tanH,
      depth + Math.abs(corner.dot(up)) / tanV,
    );
  }
  fitDistance *= 1.1;

  setGrid(centre, Math.max(footprint, size.y));

  camera.position.copy(target).addScaledVector(dir, fitDistance);
  camera.near = Math.max(fitDistance - radius * 4, 0.05);
  camera.far = fitDistance + radius * 8;
  camera.lookAt(target);
  camera.updateProjectionMatrix();

  sun.position.copy(centre).add(new Vector3(radius * 1.4, radius * 2.6, radius * 1.8));
  sun.target.position.copy(centre);
  sun.target.updateMatrixWorld();
  const shadowSpan = radius * 1.4;
  const cam = sun.shadow.camera;
  cam.left = -shadowSpan;
  cam.right = shadowSpan;
  cam.top = shadowSpan;
  cam.bottom = -shadowSpan;
  cam.near = 0.1;
  cam.far = radius * 8;
  cam.updateProjectionMatrix();
}

const dpr = renderer.getPixelRatio();
renderer.setScissorTest(true);
renderer.clear();

for (const cell of cells) {
  frame(cell);
  const viewportH = cell.h - CAPTION_H;
  const x = cell.x * dpr;
  // WebGL's origin is bottom-left; the layout is measured from the top.
  const y = (SHEET_H - cell.y - viewportH) * dpr;
  const w = cell.w * dpr;
  const h = viewportH * dpr;
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  renderer.render(scene, camera);
}
renderer.setScissorTest(false);

(globalThis as { __SHEET_READY?: boolean }).__SHEET_READY = true;
(globalThis as { __SHEET_SIZE?: [number, number] }).__SHEET_SIZE = [SHEET_W, SHEET_H];
