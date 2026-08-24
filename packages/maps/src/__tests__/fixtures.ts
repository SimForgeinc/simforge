import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeMaybeGzippedJson } from '../gzip.js';
import type { FeatureCollection } from '../geojson.js';
import type { SignalProperties } from '../signals.js';
import type { LanePolygonProperties } from '../lanes.js';
import type { SceneManifestLike } from '../coordinate-frame.js';

/** Absolute path to a file under the repo-root `fixtures/` directory. */
export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url));
}

export function readFixtureText(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

export function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(name)));
}

export const yaleHeaderText = (): string => readFixtureText('yale-header.xodr');

export const yaleManifest = (): SceneManifestLike =>
  JSON.parse(readFixtureText('yale-3d-manifest.json')) as SceneManifestLike;

export const yaleSignals = (): Promise<FeatureCollection<SignalProperties>> =>
  decodeMaybeGzippedJson<FeatureCollection<SignalProperties>>(
    readFixtureBytes('yale-signals.geojson.gz'),
  );

/** 32 real lane polygons sampled across every lane type and both windings. */
export const yaleLanePolygonSample = (): Promise<FeatureCollection<LanePolygonProperties>> =>
  decodeMaybeGzippedJson<FeatureCollection<LanePolygonProperties>>(
    readFixtureBytes('yale-lane-polygons-sample.geojson.gz'),
  );
