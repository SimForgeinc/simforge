import { lerp, lerpAngle, type Obb, type Vec2 } from '../core/math.js';
import { sweptObbTimeOfImpact } from './pairs.js';

const CONTACT_SLOP_M = 0.002;
const MAX_POSITION_CORRECTION_M = 0.25;
const VELOCITY_ITERATIONS = 8;
const POSITION_ITERATIONS = 4;
const EPSILON = 1e-9;

export interface PlanarCollisionBody {
  readonly id: string;
  readonly lengthM: number;
  readonly widthM: number;
  readonly inverseMass: number;
  readonly inverseInertia: number;
  readonly previous: { x: number; y: number; yawRad: number };
  x: number;
  y: number;
  yawRad: number;
  vx: number;
  vy: number;
  angularVelocity: number;
}

export interface PlanarStaticCollider {
  readonly id: string;
  readonly obb: Obb;
  /** Kinematic surface velocity. Static props/map geometry leave this omitted. */
  readonly velocity?: Vec2;
  readonly angularVelocity?: number;
}

export interface CollisionImpulse {
  readonly a: string;
  readonly b: string;
  readonly normalImpulseNs: number;
  readonly tangentImpulseNs: number;
}

interface Contact {
  readonly a: PlanarCollisionBody;
  readonly b: PlanarCollisionBody;
  readonly normal: Vec2;
  readonly point: Vec2;
  readonly penetrationM: number;
}

function obbOf(body: PlanarCollisionBody): Obb {
  return {
    center: { x: body.x, y: body.y },
    lengthM: body.lengthM,
    widthM: body.widthM,
    headingRad: body.yawRad,
  };
}

function previousObbOf(body: PlanarCollisionBody): Obb {
  return {
    center: { x: body.previous.x, y: body.previous.y },
    lengthM: body.lengthM,
    widthM: body.widthM,
    headingRad: body.previous.yawRad,
  };
}

function axes(obb: Obb): readonly Vec2[] {
  const c = Math.cos(obb.headingRad);
  const s = Math.sin(obb.headingRad);
  return [{ x: c, y: s }, { x: -s, y: c }];
}

function radiusOn(obb: Obb, axis: Vec2): number {
  const basis = axes(obb);
  return Math.abs(axis.x * basis[0]!.x + axis.y * basis[0]!.y) * obb.lengthM / 2 +
    Math.abs(axis.x * basis[1]!.x + axis.y * basis[1]!.y) * obb.widthM / 2;
}

/** SAT manifold. The normal always points from A toward B. */
function manifold(a: Obb, b: Obb, toleranceM = 0): Omit<Contact, 'a' | 'b'> | null {
  const delta = { x: b.center.x - a.center.x, y: b.center.y - a.center.y };
  let minimum = Infinity;
  let normal: Vec2 = { x: 1, y: 0 };
  for (const axis of [...axes(a), ...axes(b)]) {
    const signedDistance = delta.x * axis.x + delta.y * axis.y;
    const overlap = radiusOn(a, axis) + radiusOn(b, axis) - Math.abs(signedDistance);
    if (overlap < -toleranceM) return null;
    if (overlap < minimum) {
      minimum = overlap;
      const sign = signedDistance < 0 ? -1 : 1;
      normal = { x: axis.x * sign, y: axis.y * sign };
    }
  }
  const ra = radiusOn(a, normal);
  const rb = radiusOn(b, normal);
  const pointA = { x: a.center.x + normal.x * ra, y: a.center.y + normal.y * ra };
  const pointB = { x: b.center.x - normal.x * rb, y: b.center.y - normal.y * rb };
  return {
    normal,
    point: { x: (pointA.x + pointB.x) / 2, y: (pointA.y + pointB.y) / 2 },
    penetrationM: Math.max(0, minimum),
  };
}

function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

function velocityAt(body: PlanarCollisionBody, point: Vec2): Vec2 {
  const rx = point.x - body.x;
  const ry = point.y - body.y;
  return { x: body.vx - body.angularVelocity * ry, y: body.vy + body.angularVelocity * rx };
}

function applyImpulse(body: PlanarCollisionBody, impulse: Vec2, point: Vec2, sign: number): void {
  body.vx += sign * impulse.x * body.inverseMass;
  body.vy += sign * impulse.y * body.inverseMass;
  const arm = { x: point.x - body.x, y: point.y - body.y };
  body.angularVelocity += sign * cross(arm, impulse) * body.inverseInertia;
}

function effectiveMass(a: PlanarCollisionBody, b: PlanarCollisionBody, point: Vec2, axis: Vec2): number {
  const ra = { x: point.x - a.x, y: point.y - a.y };
  const rb = { x: point.x - b.x, y: point.y - b.y };
  const ca = cross(ra, axis);
  const cb = cross(rb, axis);
  return a.inverseMass + b.inverseMass + ca * ca * a.inverseInertia + cb * cb * b.inverseInertia;
}

function contactForPair(a: PlanarCollisionBody, b: PlanarCollisionBody): Contact | null {
  const value = manifold(obbOf(a), obbOf(b), CONTACT_SLOP_M);
  return value ? { a, b, ...value } : null;
}

function rewindSweptContacts(
  pairs: readonly (readonly [PlanarCollisionBody, PlanarCollisionBody])[],
  dtS: number,
): void {
  for (const [a, b] of pairs) {
      if (manifold(obbOf(a), obbOf(b))) continue;
      const hit = sweptObbTimeOfImpact(previousObbOf(a), obbOf(a), previousObbOf(b), obbOf(b));
      if (!hit || hit.toi >= 1) continue;
      const remaining = Math.max(0, 1 - hit.toi) * dtS;
      if (a.inverseMass > 0) {
        a.x = lerp(a.previous.x, a.x, hit.toi) + a.vx * Math.min(remaining, 0.001);
        a.y = lerp(a.previous.y, a.y, hit.toi) + a.vy * Math.min(remaining, 0.001);
        a.yawRad = lerpAngle(a.previous.yawRad, a.yawRad, hit.toi);
      }
      if (b.inverseMass > 0) {
        b.x = lerp(b.previous.x, b.x, hit.toi) + b.vx * Math.min(remaining, 0.001);
        b.y = lerp(b.previous.y, b.y, hit.toi) + b.vy * Math.min(remaining, 0.001);
        b.yawRad = lerpAngle(b.previous.yawRad, b.yawRad, hit.toi);
      }
  }
}

/**
 * Deterministic sequential-impulse OBB solver. Inputs must have stable ids;
 * pair ordering is canonicalized here so actor declaration order cannot alter
 * the result. Infinite-mass bodies are the explicit kinematic/static policy.
 */
export function solvePlanarCollisions(
  dynamicBodies: readonly PlanarCollisionBody[],
  staticColliders: readonly PlanarStaticCollider[],
  dtS: number,
  restitution = 0.08,
  friction = 0.65,
): CollisionImpulse[] {
  const bodies = [...dynamicBodies];
  for (const collider of staticColliders) {
    bodies.push({
      id: collider.id,
      lengthM: collider.obb.lengthM,
      widthM: collider.obb.widthM,
      inverseMass: 0,
      inverseInertia: 0,
      previous: { x: collider.obb.center.x, y: collider.obb.center.y, yawRad: collider.obb.headingRad },
      x: collider.obb.center.x,
      y: collider.obb.center.y,
      yawRad: collider.obb.headingRad,
      vx: collider.velocity?.x ?? 0,
      vy: collider.velocity?.y ?? 0,
      angularVelocity: collider.angularVelocity ?? 0,
    });
  }
  bodies.sort((a, b) => a.id.localeCompare(b.id));
  const pairs: Array<readonly [PlanarCollisionBody, PlanarCollisionBody]> = [];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i]!;
      const b = bodies[j]!;
      if (a.inverseMass > 0 || b.inverseMass > 0) pairs.push([a, b]);
    }
  }
  rewindSweptContacts(pairs, dtS);

  const totals = new Map<string, { a: string; b: string; normal: number; tangent: number }>();
  for (let iteration = 0; iteration < VELOCITY_ITERATIONS; iteration++) {
    for (const [a, b] of pairs) {
        const contact = contactForPair(a, b);
        if (!contact) continue;
        const va = velocityAt(a, contact.point);
        const vb = velocityAt(b, contact.point);
        const rv = { x: vb.x - va.x, y: vb.y - va.y };
        const closing = rv.x * contact.normal.x + rv.y * contact.normal.y;
        const normalMass = effectiveMass(a, b, contact.point, contact.normal);
        if (normalMass <= EPSILON) continue;
        // Restitution is only applied to genuine impacts. Persistent/resting
        // contacts use zero bounce, preventing energy injection and chatter.
        const bounce = closing < -1 ? restitution : 0;
        const bias = contact.penetrationM > CONTACT_SLOP_M
          ? Math.min(2, 0.15 * (contact.penetrationM - CONTACT_SLOP_M) / Math.max(dtS, EPSILON))
          : 0;
        const normalImpulse = Math.max(0, (-(1 + bounce) * closing + bias) / normalMass);
        if (normalImpulse <= EPSILON) continue;
        const impulse = { x: contact.normal.x * normalImpulse, y: contact.normal.y * normalImpulse };
        applyImpulse(a, impulse, contact.point, -1);
        applyImpulse(b, impulse, contact.point, 1);

        const tangent = { x: -contact.normal.y, y: contact.normal.x };
        const va2 = velocityAt(a, contact.point);
        const vb2 = velocityAt(b, contact.point);
        const tangentSpeed = (vb2.x - va2.x) * tangent.x + (vb2.y - va2.y) * tangent.y;
        const tangentMass = effectiveMass(a, b, contact.point, tangent);
        const rawTangent = tangentMass > EPSILON ? -tangentSpeed / tangentMass : 0;
        const tangentImpulse = Math.max(-friction * normalImpulse, Math.min(friction * normalImpulse, rawTangent));
        const frictionImpulse = { x: tangent.x * tangentImpulse, y: tangent.y * tangentImpulse };
        applyImpulse(a, frictionImpulse, contact.point, -1);
        applyImpulse(b, frictionImpulse, contact.point, 1);

        const key = `${a.id}|${b.id}`;
        const total = totals.get(key) ?? { a: a.id, b: b.id, normal: 0, tangent: 0 };
        total.normal += normalImpulse;
        total.tangent += Math.abs(tangentImpulse);
        totals.set(key, total);
    }
  }

  for (let iteration = 0; iteration < POSITION_ITERATIONS; iteration++) {
    for (const [a, b] of pairs) {
        const contact = contactForPair(a, b);
        if (!contact || contact.penetrationM <= CONTACT_SLOP_M) continue;
        const inverseMass = a.inverseMass + b.inverseMass;
        if (inverseMass <= EPSILON) continue;
        const correction = Math.min(
          MAX_POSITION_CORRECTION_M,
          0.8 * (contact.penetrationM - CONTACT_SLOP_M),
        );
        const ax = contact.normal.x * correction * a.inverseMass / inverseMass;
        const ay = contact.normal.y * correction * a.inverseMass / inverseMass;
        const bx = contact.normal.x * correction * b.inverseMass / inverseMass;
        const by = contact.normal.y * correction * b.inverseMass / inverseMass;
        a.x -= ax;
        a.y -= ay;
        b.x += bx;
        b.y += by;
    }
  }
  return [...totals.values()]
    .sort((a, b) => `${a.a}|${a.b}`.localeCompare(`${b.a}|${b.b}`))
    .map((value) => ({
      a: value.a,
      b: value.b,
      normalImpulseNs: value.normal,
      tangentImpulseNs: value.tangent,
    }));
}
