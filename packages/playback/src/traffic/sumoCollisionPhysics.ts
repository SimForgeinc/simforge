import type { ActorView } from "@simforge-oss/viewer";
import {
  obbOverlap,
  sweptObbTimeOfImpact,
  type Obb,
  type StaticMapCollider,
  type SumoAuthoredOccupancySource,
} from "@simforge-oss/engine";
import type { ExternalTrafficActor } from "../index.js";

type SumoExternalActorView = SumoAuthoredOccupancySource & {
  readonly render?: ActorView;
};

const AUTHORED_VEHICLE_KINDS = new Set([
  "vehicle",
  "car",
  "truck",
  "bus",
  "van",
  "motorcycle",
]);
const MIN_IMPACT_SPEED_MPS = 1.25;
const COLLISION_RESTITUTION = 0.18;
const LINEAR_DRAG_PER_SECOND = 0.7;
const ROLLING_DECELERATION_MPS2 = 2.8;
const ANGULAR_DRAG_PER_SECOND = 2.8;
const MAX_KNOCKBACK_SPEED_MPS = 32;
const MAX_ANGULAR_SPEED_RAD_S = 1.8;
const PHYSICS_SUBSTEP_SECONDS = 1 / 60;

interface KnockedVehicle {
  readonly source: ActorView;
  x: number;
  z: number;
  headingRad: number;
  velocityX: number;
  velocityZ: number;
  angularVelocityRadS: number;
}

interface KnockedAuthoredVehicle {
  readonly source: SumoExternalActorView;
  readonly render: ActorView;
  x: number;
  z: number;
  headingRad: number;
  velocityX: number;
  velocityZ: number;
  angularVelocityRadS: number;
}

/**
 * Browser collision handoff for authored vehicles striking SUMO traffic.
 * SUMO remains authoritative until first contact; the impacted vehicle then
 * becomes a deterministic 2D rigid body and is mirrored back as occupancy.
 */
export class SumoCollisionPhysics {
  private readonly knocked = new Map<string, KnockedVehicle>();
  private readonly knockedAuthored = new Map<string, KnockedAuthoredVehicle>();
  private previousAuthored = new Map<string, SumoExternalActorView>();
  private previousSumo = new Map<string, ActorView>();
  private staticColliders: readonly StaticMapCollider[] = [];

  setStaticColliders(colliders: readonly StaticMapCollider[]): void {
    this.staticColliders = colliders;
  }

  step(
    deltaSeconds: number,
    authored: readonly SumoExternalActorView[],
    sumoActors: readonly ActorView[],
  ): void {
    if (!(deltaSeconds > 0) || !Number.isFinite(deltaSeconds)) return;
    this.integrate(deltaSeconds);
    this.resolveDynamicContacts();

    for (const source of authored) {
      if (
        this.knockedAuthored.has(source.id) ||
        source.present === false ||
        source.static ||
        !AUTHORED_VEHICLE_KINDS.has(source.kind) ||
        source.speedMps < MIN_IMPACT_SPEED_MPS
      )
        continue;
      const priorSource = this.previousAuthored.get(source.id) ??
        projectAuthoredBackward(source, deltaSeconds);
      for (const sumo of sumoActors) {
        if (this.knocked.has(sumo.id)) continue;
        const priorSumo = this.previousSumo.get(sumo.id) ??
          projectSumoBackward(sumo, deltaSeconds);
        const hit = sweptObbTimeOfImpact(
          authoredObb(priorSource),
          authoredObb(source),
          sumoObb(priorSumo),
          sumoObb(sumo),
        );
        if (!hit && !obbOverlap(authoredObb(source), sumoObb(sumo))) continue;
        if (
          this.handoff(
            priorSource,
            source,
            priorSumo,
            sumo,
            hit?.toi ?? 1,
          )
        )
          break;
      }
    }

    // A vehicle already released from command ownership can trigger the same
    // handoff in nearby SUMO traffic, allowing deterministic pile-ups without
    // promoting the rest of the traffic population.
    for (const body of this.dynamicBodies()) {
      for (const sumo of sumoActors) {
        if (this.knocked.has(sumo.id)) continue;
        if (!obbOverlap(dynamicBodyObb(body), sumoObb(sumo))) continue;
        if (this.handoffDynamicToSumo(body, sumo)) break;
      }
    }

    this.previousAuthored = new Map(
      authored.map((actor) => [actor.id, actor] as const),
    );
    this.previousSumo = new Map(
      sumoActors.map((actor) => [actor.id, actor] as const),
    );
  }

  composeViews(
    sumoActors: readonly ActorView[],
    sampleHeight: (x: number, z: number) => number | null,
  ): readonly ActorView[] {
    const native = sumoActors.filter((actor) => !this.knocked.has(actor.id));
    const physical = [...this.knocked.values()].map((body) => ({
      ...body.source,
      x: body.x,
      y: sampleHeight(body.x, body.z) ?? body.source.y,
      z: body.z,
      headingRad: body.headingRad,
      speedMps: Math.hypot(body.velocityX, body.velocityZ),
      indicator: "hazard" as const,
    }));
    return [...native, ...physical];
  }

  /** Replace trace-owned authored poses after their first physical contact. */
  authoredViews(
    sampleHeight: (x: number, z: number) => number | null,
  ): readonly ActorView[] {
    return [...this.knockedAuthored.values()].map((body) => ({
      ...body.render,
      x: body.x,
      y: sampleHeight(body.x, body.z) ?? body.render.y,
      z: body.z,
      headingRad: body.headingRad,
      speedMps: Math.hypot(body.velocityX, body.velocityZ),
      indicator: "hazard" as const,
    }));
  }

  /** Feed post-impact authored occupancy to SUMO instead of future trace commands. */
  composeAuthoredSources(
    authored: readonly SumoExternalActorView[],
  ): readonly SumoExternalActorView[] {
    return authored.map((source) => {
      const body = this.knockedAuthored.get(source.id);
      if (!body) return source;
      return {
        ...source,
        x: body.x,
        z: body.z,
        headingRad: body.headingRad,
        speedMps: Math.hypot(body.velocityX, body.velocityZ),
        render: {
          ...body.render,
          x: body.x,
          z: body.z,
          headingRad: body.headingRad,
          speedMps: Math.hypot(body.velocityX, body.velocityZ),
        },
      };
    });
  }

  externalActors(): readonly ExternalTrafficActor[] {
    return [...this.knocked.values()].map((body) => ({
      id: `physics:${body.source.id}`,
      kind: "vehicle" as const,
      routeId: "proxy-route",
      x: body.x,
      z: body.z,
      headingDegrees: 90 + (body.headingRad * 180) / Math.PI,
      speedMetersPerSecond: Math.hypot(body.velocityX, body.velocityZ),
      lengthMeters: body.source.dims.l,
      widthMeters: body.source.dims.w,
    }));
  }

  clear(): void {
    this.knocked.clear();
    this.knockedAuthored.clear();
    this.previousAuthored.clear();
    this.previousSumo.clear();
  }

  get actorCount(): number {
    return this.knocked.size;
  }

  private handoff(
    priorSource: SumoExternalActorView,
    source: SumoExternalActorView,
    priorSumo: ActorView,
    sumo: ActorView,
    timeOfImpact: number,
  ): boolean {
    const authorVelocityX = Math.cos(source.headingRad) * source.speedMps;
    const authorVelocityZ = Math.sin(source.headingRad) * source.speedMps;
    const sumoSpeed = sumo.speedMps ?? 0;
    const sumoVelocityX = Math.cos(sumo.headingRad) * sumoSpeed;
    const sumoVelocityZ = Math.sin(sumo.headingRad) * sumoSpeed;
    const impactAuthorX = lerp(
      priorSource.x,
      source.x,
      timeOfImpact,
    );
    const impactAuthorZ = lerp(
      priorSource.z,
      source.z,
      timeOfImpact,
    );
    const impactSumoX = lerp(priorSumo.x, sumo.x, timeOfImpact);
    const impactSumoZ = lerp(priorSumo.z, sumo.z, timeOfImpact);
    let normalX = impactSumoX - impactAuthorX;
    let normalZ = impactSumoZ - impactAuthorZ;
    const normalLength = Math.hypot(normalX, normalZ);
    if (normalLength < 1e-6) {
      normalX = Math.cos(source.headingRad);
      normalZ = Math.sin(source.headingRad);
    } else {
      normalX /= normalLength;
      normalZ /= normalLength;
    }
    const closingSpeed =
      (authorVelocityX - sumoVelocityX) * normalX +
      (authorVelocityZ - sumoVelocityZ) * normalZ;
    if (closingSpeed < MIN_IMPACT_SPEED_MPS) return false;

    const authoredMassKg = vehicleMassKg(
      source.kind,
      source.lengthM,
      source.widthM,
    );
    const sumoMassKg = vehicleMassKg(
      sumo.kind ?? "car",
      sumo.dims.l,
      sumo.dims.w,
    );
    const impulse =
      ((1 + COLLISION_RESTITUTION) * closingSpeed) /
      (1 / authoredMassKg + 1 / sumoMassKg);
    let velocityX = sumoVelocityX +
      (impulse / sumoMassKg) * normalX;
    let velocityZ = sumoVelocityZ +
      (impulse / sumoMassKg) * normalZ;
    const speed = Math.hypot(velocityX, velocityZ);
    if (speed > MAX_KNOCKBACK_SPEED_MPS) {
      velocityX *= MAX_KNOCKBACK_SPEED_MPS / speed;
      velocityZ *= MAX_KNOCKBACK_SPEED_MPS / speed;
    }
    const tangentX = -Math.sin(sumo.headingRad);
    const tangentZ = Math.cos(sumo.headingRad);
    const lateralImpact = normalX * tangentX + normalZ * tangentZ;
    const angularVelocityRadS = clamp(
      -lateralImpact * closingSpeed * 0.12,
      -MAX_ANGULAR_SPEED_RAD_S,
      MAX_ANGULAR_SPEED_RAD_S,
    );
    const penetrationM = overlapAlongNormal(
      authoredObb(source),
      sumoObb(sumo),
      normalX,
      normalZ,
    );
    const correctionM = Math.max(0.08, penetrationM + 0.02);
    const totalMassKg = authoredMassKg + sumoMassKg;
    const authoredCorrectionM = correctionM * (sumoMassKg / totalMassKg);
    const sumoCorrectionM = correctionM * (authoredMassKg / totalMassKg);
    this.knocked.set(sumo.id, {
      source: sumo,
      x: sumo.x + normalX * sumoCorrectionM,
      z: sumo.z + normalZ * sumoCorrectionM,
      headingRad: sumo.headingRad,
      velocityX,
      velocityZ,
      angularVelocityRadS,
    });
    const authoredVelocityX = authorVelocityX -
      (impulse / authoredMassKg) * normalX;
    const authoredVelocityZ = authorVelocityZ -
      (impulse / authoredMassKg) * normalZ;
    this.knockedAuthored.set(source.id, {
      source,
      render: source.render ?? authoredRenderFallback(source),
      x: source.x - normalX * authoredCorrectionM,
      z: source.z - normalZ * authoredCorrectionM,
      headingRad: source.headingRad,
      velocityX: authoredVelocityX,
      velocityZ: authoredVelocityZ,
      angularVelocityRadS: clamp(
        lateralImpact * closingSpeed * 0.1,
        -MAX_ANGULAR_SPEED_RAD_S,
        MAX_ANGULAR_SPEED_RAD_S,
      ),
    });
    return true;
  }

  private integrate(deltaSeconds: number): void {
    let remaining = Math.min(deltaSeconds, 1);
    while (remaining > 1e-9) {
      const dt = Math.min(PHYSICS_SUBSTEP_SECONDS, remaining);
      for (const body of [
        ...this.knocked.values(),
        ...this.knockedAuthored.values(),
      ]) {
        const priorX = body.x;
        const priorZ = body.z;
        body.x += body.velocityX * dt;
        body.z += body.velocityZ * dt;
        body.headingRad = normalizeRadians(
          body.headingRad + body.angularVelocityRadS * dt,
        );
        const speed = Math.hypot(body.velocityX, body.velocityZ);
        const nextSpeed = Math.max(
          0,
          (speed - ROLLING_DECELERATION_MPS2 * dt) *
            Math.exp(-LINEAR_DRAG_PER_SECOND * dt),
        );
        if (speed > 1e-9) {
          body.velocityX *= nextSpeed / speed;
          body.velocityZ *= nextSpeed / speed;
        }
        body.angularVelocityRadS *= Math.exp(-ANGULAR_DRAG_PER_SECOND * dt);
        if (
          this.staticColliders.some((collider) =>
            obbOverlap(dynamicBodyObb(body), {
              center: {
                x: collider.obb.center.x,
                y: collider.obb.center.z,
              },
              lengthM: collider.obb.lengthM,
              widthM: collider.obb.widthM,
              headingRad: collider.obb.headingRad,
            })
          )
        ) {
          body.x = priorX;
          body.z = priorZ;
          body.velocityX *= -0.08;
          body.velocityZ *= -0.08;
          body.angularVelocityRadS *= 0.35;
        }
        if (nextSpeed < 0.03) {
          body.velocityX = 0;
          body.velocityZ = 0;
        }
        if (Math.abs(body.angularVelocityRadS) < 0.01)
          body.angularVelocityRadS = 0;
      }
      remaining -= dt;
    }
  }

  private dynamicBodies(): Array<KnockedVehicle | KnockedAuthoredVehicle> {
    return [
      ...this.knocked.values(),
      ...this.knockedAuthored.values(),
    ];
  }

  private resolveDynamicContacts(): void {
    const bodies = this.dynamicBodies();
    for (let left = 0; left < bodies.length; left += 1) {
      for (let right = left + 1; right < bodies.length; right += 1) {
        const a = bodies[left]!;
        const b = bodies[right]!;
        if (!obbOverlap(dynamicBodyObb(a), dynamicBodyObb(b))) continue;
        resolveDynamicImpulse(a, b);
      }
    }
  }

  private handoffDynamicToSumo(
    body: KnockedVehicle | KnockedAuthoredVehicle,
    sumo: ActorView,
  ): boolean {
    let normalX = sumo.x - body.x;
    let normalZ = sumo.z - body.z;
    const length = Math.hypot(normalX, normalZ);
    if (length < 1e-6) {
      normalX = Math.cos(body.headingRad);
      normalZ = Math.sin(body.headingRad);
    } else {
      normalX /= length;
      normalZ /= length;
    }
    const sumoSpeed = sumo.speedMps ?? 0;
    const targetVelocityX = Math.cos(sumo.headingRad) * sumoSpeed;
    const targetVelocityZ = Math.sin(sumo.headingRad) * sumoSpeed;
    const closingSpeed =
      (body.velocityX - targetVelocityX) * normalX +
      (body.velocityZ - targetVelocityZ) * normalZ;
    if (closingSpeed < MIN_IMPACT_SPEED_MPS) return false;
    const bodyMassKg = dynamicBodyMassKg(body);
    const targetMassKg = vehicleMassKg(
      sumo.kind ?? "car",
      sumo.dims.l,
      sumo.dims.w,
    );
    const impulse = ((1 + COLLISION_RESTITUTION) * closingSpeed) /
      (1 / bodyMassKg + 1 / targetMassKg);
    body.velocityX -= (impulse / bodyMassKg) * normalX;
    body.velocityZ -= (impulse / bodyMassKg) * normalZ;
    const velocityX = targetVelocityX + (impulse / targetMassKg) * normalX;
    const velocityZ = targetVelocityZ + (impulse / targetMassKg) * normalZ;
    const penetrationM = overlapAlongNormal(
      dynamicBodyObb(body),
      sumoObb(sumo),
      normalX,
      normalZ,
    );
    const correctionM = Math.max(0.08, penetrationM + 0.02);
    const totalMassKg = bodyMassKg + targetMassKg;
    body.x -= normalX * correctionM * (targetMassKg / totalMassKg);
    body.z -= normalZ * correctionM * (targetMassKg / totalMassKg);
    this.knocked.set(sumo.id, {
      source: sumo,
      x: sumo.x + normalX * correctionM * (bodyMassKg / totalMassKg),
      z: sumo.z + normalZ * correctionM * (bodyMassKg / totalMassKg),
      headingRad: sumo.headingRad,
      velocityX,
      velocityZ,
      angularVelocityRadS: clamp(
        closingSpeed * Math.sin(sumo.headingRad - body.headingRad) * 0.08,
        -MAX_ANGULAR_SPEED_RAD_S,
        MAX_ANGULAR_SPEED_RAD_S,
      ),
    });
    return true;
  }
}

function resolveDynamicImpulse(
  a: KnockedVehicle | KnockedAuthoredVehicle,
  b: KnockedVehicle | KnockedAuthoredVehicle,
): void {
  let normalX = b.x - a.x;
  let normalZ = b.z - a.z;
  const length = Math.hypot(normalX, normalZ);
  if (length < 1e-6) {
    normalX = Math.cos(a.headingRad);
    normalZ = Math.sin(a.headingRad);
  } else {
    normalX /= length;
    normalZ /= length;
  }
  const closingSpeed =
    (a.velocityX - b.velocityX) * normalX +
    (a.velocityZ - b.velocityZ) * normalZ;
  const aMassKg = dynamicBodyMassKg(a);
  const bMassKg = dynamicBodyMassKg(b);
  if (closingSpeed > 0) {
    const impulse = ((1 + COLLISION_RESTITUTION) * closingSpeed) /
      (1 / aMassKg + 1 / bMassKg);
    a.velocityX -= (impulse / aMassKg) * normalX;
    a.velocityZ -= (impulse / aMassKg) * normalZ;
    b.velocityX += (impulse / bMassKg) * normalX;
    b.velocityZ += (impulse / bMassKg) * normalZ;
  }
  const penetrationM = overlapAlongNormal(
    dynamicBodyObb(a),
    dynamicBodyObb(b),
    normalX,
    normalZ,
  );
  const correctionM = penetrationM + 0.01;
  const totalMassKg = aMassKg + bMassKg;
  a.x -= normalX * correctionM * (bMassKg / totalMassKg);
  a.z -= normalZ * correctionM * (bMassKg / totalMassKg);
  b.x += normalX * correctionM * (aMassKg / totalMassKg);
  b.z += normalZ * correctionM * (aMassKg / totalMassKg);
}

function dynamicBodyMassKg(
  body: KnockedVehicle | KnockedAuthoredVehicle,
): number {
  const view = "render" in body ? body.render : body.source;
  return vehicleMassKg(
    view.kind ?? "car",
    view.dims.l,
    view.dims.w,
  );
}

function dynamicBodyObb(
  body: KnockedVehicle | KnockedAuthoredVehicle,
): Obb {
  const dims = "render" in body
    ? body.render.dims
    : body.source.dims;
  return {
    center: { x: body.x, y: body.z },
    lengthM: dims.l,
    widthM: dims.w,
    headingRad: body.headingRad,
  };
}

function vehicleMassKg(
  kind: string,
  lengthM: number,
  widthM: number,
): number {
  const classScale = kind === "bus"
    ? 3.8
    : kind === "truck"
      ? 2.8
      : kind === "van"
        ? 1.35
        : kind === "motorcycle" || kind === "bicycle"
          ? 0.18
          : 1;
  return clamp(lengthM * widthM * 180 * classScale, 220, 18_000);
}

function overlapAlongNormal(
  a: Obb,
  b: Obb,
  normalX: number,
  normalZ: number,
): number {
  const radius = (obb: Obb) => {
    const forwardX = Math.cos(obb.headingRad);
    const forwardZ = Math.sin(obb.headingRad);
    const lateralX = -forwardZ;
    const lateralZ = forwardX;
    return (obb.lengthM / 2) * Math.abs(forwardX * normalX + forwardZ * normalZ) +
      (obb.widthM / 2) * Math.abs(lateralX * normalX + lateralZ * normalZ);
  };
  const centerDistance =
    (b.center.x - a.center.x) * normalX +
    (b.center.y - a.center.y) * normalZ;
  return Math.max(0, radius(a) + radius(b) - Math.abs(centerDistance));
}

function authoredRenderFallback(source: SumoExternalActorView): ActorView {
  return {
    id: source.id,
    catalogId: "vehicle.sedan",
    kind: source.kind,
    x: source.x,
    y: 0,
    z: source.z,
    headingRad: source.headingRad,
    speedMps: source.speedMps,
    dims: { l: source.lengthM, w: source.widthM, h: 1.5 },
  };
}

function authoredObb(actor: SumoExternalActorView): Obb {
  return {
    center: { x: actor.x, y: actor.z },
    lengthM: actor.lengthM,
    widthM: actor.widthM,
    headingRad: actor.headingRad,
  };
}

function sumoObb(actor: ActorView): Obb {
  return {
    center: { x: actor.x, y: actor.z },
    lengthM: actor.dims.l,
    widthM: actor.dims.w,
    headingRad: actor.headingRad,
  };
}

function projectAuthoredBackward(
  actor: SumoExternalActorView,
  deltaSeconds: number,
): SumoExternalActorView {
  return {
    ...actor,
    x: actor.x - Math.cos(actor.headingRad) * actor.speedMps * deltaSeconds,
    z: actor.z - Math.sin(actor.headingRad) * actor.speedMps * deltaSeconds,
  };
}

function projectSumoBackward(
  actor: ActorView,
  deltaSeconds: number,
): ActorView {
  const speed = actor.speedMps ?? 0;
  return {
    ...actor,
    x: actor.x - Math.cos(actor.headingRad) * speed * deltaSeconds,
    z: actor.z - Math.sin(actor.headingRad) * speed * deltaSeconds,
  };
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeRadians(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}
