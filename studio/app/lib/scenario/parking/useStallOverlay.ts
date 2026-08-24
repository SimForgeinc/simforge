"use client";

import { useEffect } from "react";
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
} from "three";
import type { CityViewer } from "@simforge/viewer";
import type { ParkedCar } from "@simcloud/shared/parked-cars";

import type { ParkingStall } from "./stalls";

/**
 * Outline every parking stall, so occupancy is something you can see.
 *
 * Without this the author is configuring a number against an unreadable scene:
 * an empty stall, a stall too small for any model, and a stall deliberately kept
 * clear all look identical, which makes a placement bug indistinguishable from a
 * map with no parking. The stalls are drawn from the same derived artifact the
 * planner uses, so the outline and the cars cannot disagree.
 *
 * Three colours only: filled, free, and unusable. Anything finer is noise at the
 * zoom levels where a whole car park is on screen.
 */
const FILLED_COLOR = 0x7fcf9b;
const FREE_COLOR = 0x8f98a6;
const UNUSABLE_COLOR = 0xd5a45e;

/** Outline height above the sampled surface, metres — clear of z-fighting. */
const LIFT_M = 0.06;

function rectangle(
  stall: ParkingStall,
  y: number,
  into: number[],
): void {
  const halfLength = stall.lengthM / 2;
  const halfWidth = stall.widthM / 2;
  const cos = Math.cos(stall.headingRad);
  const sin = Math.sin(stall.headingRad);
  // Scene heading h runs along (cos h, -sin h) in (x, z); the stall's width axis
  // is perpendicular to it.
  const corners = [
    [halfLength, halfWidth],
    [halfLength, -halfWidth],
    [-halfLength, -halfWidth],
    [-halfLength, halfWidth],
  ].map(([along, across]) => ({
    x: stall.x + along! * cos + across! * sin,
    z: stall.z - along! * sin + across! * cos,
  }));

  for (let index = 0; index < corners.length; index += 1) {
    const from = corners[index]!;
    const to = corners[(index + 1) % corners.length]!;
    into.push(from.x, y, from.z, to.x, y, to.z);
  }
}

function segments(
  stalls: readonly ParkingStall[],
  color: number,
  sampleHeight: ((x: number, z: number) => number | null) | null,
): LineSegments | null {
  if (stalls.length === 0) return null;
  const positions: number[] = [];
  for (const stall of stalls) {
    rectangle(stall, (sampleHeight?.(stall.x, stall.z) ?? stall.y) + LIFT_M, positions);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  const material = new LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const lines = new LineSegments(geometry, material);
  lines.frustumCulled = false;
  return lines;
}

/**
 * Draw the stall outlines, classified by what the planner did with each one.
 *
 * Keyed on a content signature rather than array identity. The settings object
 * is re-derived from the document, so `cars` is a fresh array on many renders
 * while describing the identical scene; rebuilding a few thousand line segments
 * and re-sampling ground height for every stall on each of those was pure cost.
 */
export function useStallOverlay(
  viewer: CityViewer | null,
  stalls: readonly ParkingStall[],
  cars: readonly ParkedCar[],
  sampleHeight: ((x: number, z: number) => number | null) | null,
  visible: boolean,
): void {
  // Which stalls are filled is all the geometry depends on, and a parked car
  // never moves, so the ids alone decide whether anything must be redrawn.
  const filledSignature = cars
    .map((car) => car.stallId)
    .sort()
    .join(",");

  useEffect(() => {
    if (!viewer || !visible || stalls.length === 0) return;

    const filledStallIds = new Set(filledSignature.length > 0 ? filledSignature.split(",") : []);
    const filled: ParkingStall[] = [];
    const free: ParkingStall[] = [];
    const unusable: ParkingStall[] = [];
    for (const stall of stalls) {
      if (filledStallIds.has(stall.id)) filled.push(stall);
      // The planner's own fit rule: nothing in the catalog is shorter than a
      // motorcycle, so a stall under that can never hold anything.
      else if (stall.lengthM < 2.2 || stall.widthM < 0.85) unusable.push(stall);
      else free.push(stall);
    }

    const group = new Group();
    group.name = "parking-stall-overlay";
    for (const [subset, color] of [
      [filled, FILLED_COLOR],
      [free, FREE_COLOR],
      [unusable, UNUSABLE_COLOR],
    ] as const) {
      const lines = segments(subset, color, sampleHeight);
      if (lines) group.add(lines);
    }
    viewer.scene.add(group);

    return () => {
      viewer.scene.remove(group);
      for (const child of group.children) {
        const lines = child as LineSegments;
        lines.geometry.dispose();
        (lines.material as LineBasicMaterial).dispose();
      }
    };
  }, [filledSignature, sampleHeight, stalls, viewer, visible]);
}
