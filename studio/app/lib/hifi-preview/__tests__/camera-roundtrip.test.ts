/**
 * Parity-fixture tie-in for the hifi-preview camera exchange: the request and
 * response carry contract camera matrices, and the pose that comes back from
 * the worker (the provenance echo the Bevy frame was rendered from) must
 * equal the Three viewport pose within the fixture tolerances.
 *
 * Flow under test, per fixture camera case:
 *   Three viewport (headless CameraRig-semantics host)
 *     -> cameraStateReport()                       [contract CameraStateReport]
 *     -> CreateHifiPreviewSchema + JSON round trip [the POST body]
 *     -> worker ServiceCamera mapping + verbatim provenance echo
 *     -> re-applied to a fresh Three camera        [the round-tripped pose]
 *   and every stop reproduces the fixture's expected view/projection
 *   matrices within `tolerances.matrixAbs`, poses within `tolerances.pointAbs`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PerspectiveCamera, Vector3 } from "three";
import {
  cameraStateReport,
  frameCameraPose,
  validateParityFixture,
  type CameraIntrinsics,
  type CameraPoseCommand,
  type FixtureCameraCase,
  type Mat4,
} from "@simforge-oss/viewer";

import { CreateHifiPreviewSchema, contractCameraReportAsWire, type WireCameraStateReport } from "../contracts";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../../../packages/viewer/fixtures/renderer-contract/basic-intersection.v1.json",
    import.meta.url,
  ),
);
const fixture = validateParityFixture(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));

interface HeadlessHost {
  camera: PerspectiveCamera;
  controls: {
    getView: () => { position: [number, number, number]; target: [number, number, number]; fov: number };
    applyView: (view: { position: readonly number[]; target: readonly number[]; fov: number }) => void;
    setEnabled: () => void;
  };
}

/** Headless CityViewer camera surface with CameraRig applyView semantics. */
function headlessHost(): HeadlessHost {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 4000);
  const target = new Vector3();
  return {
    camera,
    controls: {
      getView: () => ({
        position: [camera.position.x, camera.position.y, camera.position.z] as [number, number, number],
        target: [target.x, target.y, target.z] as [number, number, number],
        fov: camera.fov,
      }),
      applyView: (view: { position: readonly number[]; target: readonly number[]; fov: number }) => {
        camera.fov = view.fov;
        camera.updateProjectionMatrix();
        camera.position.set(view.position[0]!, view.position[1]!, view.position[2]!);
        target.set(view.target[0]!, view.target[1]!, view.target[2]!);
        camera.up.set(0, 1, 0);
        camera.lookAt(target);
        camera.updateMatrixWorld(true);
      },
      setEnabled: () => {},
    },
  };
}

function applyCameraCase(
  host: HeadlessHost,
  intrinsics: CameraIntrinsics,
  pose: CameraPoseCommand,
): void {
  host.camera.fov = intrinsics.fovYDeg;
  host.camera.aspect = intrinsics.aspect;
  host.camera.near = intrinsics.near;
  host.camera.far = intrinsics.far;
  host.camera.updateProjectionMatrix();
  host.controls.applyView({ position: pose.position, target: pose.target, fov: intrinsics.fovYDeg });
}

function casePose(cameraCase: FixtureCameraCase): CameraPoseCommand {
  return cameraCase.command.kind === "set-pose"
    ? cameraCase.command.pose
    : frameCameraPose(
        cameraCase.command.bounds,
        { fovYDeg: cameraCase.intrinsics.fovYDeg, aspect: cameraCase.intrinsics.aspect },
        cameraCase.command.azimuthRad,
        cameraCase.command.elevationRad,
      );
}

function assertMat4Close(actual: Mat4, expected: Mat4, tolerance: number, label: string): void {
  assert.equal(actual.length, 16, `${label}: expected 16 elements`);
  for (let index = 0; index < 16; index++) {
    const delta = Math.abs(actual[index]! - expected[index]!);
    assert.ok(
      delta <= tolerance,
      `${label}[${index}] |${actual[index]} - ${expected[index]}| = ${delta} > ${tolerance}`,
    );
  }
}

function assertVec3Close(
  actual: readonly number[],
  expected: readonly number[],
  tolerance: number,
  label: string,
): void {
  for (let axis = 0; axis < 3; axis++) {
    const delta = Math.abs(actual[axis]! - expected[axis]!);
    assert.ok(delta <= tolerance, `${label}[${axis}] delta ${delta} > ${tolerance}`);
  }
}

/** Exactly the worker's request handling: JSON round trip + verbatim echo. */
function roundTripThroughRequest(camera: WireCameraStateReport) {
  const body = {
    mapVersionId: "map-version-test",
    profile: "cinematic" as const,
    tick: fixture.tick,
    width: 1280,
    height: 720,
    camera,
    scene: {
      version: "scene-state.v1" as const,
      mapId: fixture.sceneState.mapId,
      tick: fixture.tick,
      tickHz: fixture.sceneState.tickHz,
      groundY: fixture.sceneState.groundY,
      actors: [],
    },
  };
  // The POST body crosses HTTP as JSON and is re-validated server-side.
  const request = CreateHifiPreviewSchema.parse(JSON.parse(JSON.stringify(body)));
  // studio/worker/hifi-preview.ts: ServiceCamera derives from the request
  // camera and provenance.camera is the request camera echoed verbatim.
  const serviceCamera = {
    eye: request.camera.pose.position,
    target: request.camera.pose.target,
    fovDeg: request.camera.intrinsics.fovYDeg,
  };
  return { echoedCamera: request.camera, serviceCamera };
}

describe("hifi-preview camera round trip (simforge.renderer-parity-fixture/v1)", () => {
  assert.ok(fixture.cameras.length > 0, "fixture must define camera cases");

  for (const cameraCase of fixture.cameras) {
    it(`case ${cameraCase.id}: round-tripped pose equals the viewport pose within tolerances`, () => {
      const { matrixAbs, pointAbs } = fixture.tolerances;
      const pose = casePose(cameraCase);

      // 1. The Three viewport reports the contract camera state...
      const viewport = headlessHost();
      applyCameraCase(viewport, cameraCase.intrinsics, pose);
      const report = cameraStateReport(viewport);
      // ...which reproduces the fixture's normative matrices.
      assertMat4Close(report.viewMatrix, cameraCase.expected.viewMatrix, matrixAbs, `${cameraCase.id}.report.view`);
      assertMat4Close(
        report.projectionMatrix,
        cameraCase.expected.projectionMatrix,
        matrixAbs,
        `${cameraCase.id}.report.projection`,
      );

      // 2. Request wire round trip + worker echo.
      const { echoedCamera, serviceCamera } = roundTripThroughRequest(contractCameraReportAsWire(report));
      assertVec3Close(echoedCamera.pose.position, report.pose.position, pointAbs, `${cameraCase.id}.echo.position`);
      assertVec3Close(echoedCamera.pose.target, report.pose.target, pointAbs, `${cameraCase.id}.echo.target`);
      assertMat4Close(echoedCamera.viewMatrix, report.viewMatrix, matrixAbs, `${cameraCase.id}.echo.view`);
      assertMat4Close(
        echoedCamera.projectionMatrix,
        report.projectionMatrix,
        matrixAbs,
        `${cameraCase.id}.echo.projection`,
      );

      // 3. The ServiceCamera pose handed to the Bevy renderer, re-applied to a
      // fresh Three camera, lands on the same matrices — the rendered pose IS
      // the viewport pose within contract tolerances.
      const roundTripped = headlessHost();
      applyCameraCase(roundTripped, echoedCamera.intrinsics, {
        position: serviceCamera.eye as unknown as CameraPoseCommand["position"],
        target: serviceCamera.target as unknown as CameraPoseCommand["target"],
      });
      assert.equal(serviceCamera.fovDeg, cameraCase.intrinsics.fovYDeg, `${cameraCase.id}.service.fov`);
      const rendered = cameraStateReport(roundTripped);
      assertVec3Close(rendered.pose.position, report.pose.position, pointAbs, `${cameraCase.id}.rendered.position`);
      assertVec3Close(rendered.pose.target, report.pose.target, pointAbs, `${cameraCase.id}.rendered.target`);
      assertMat4Close(rendered.viewMatrix, cameraCase.expected.viewMatrix, matrixAbs, `${cameraCase.id}.rendered.view`);
      assertMat4Close(
        rendered.projectionMatrix,
        cameraCase.expected.projectionMatrix,
        matrixAbs,
        `${cameraCase.id}.rendered.projection`,
      );
    });
  }
});
