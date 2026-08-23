import * as THREE from 'three/webgpu';
import { sunPositionFrom } from './renderer/sun-position';
import type { LiveRenderHandles } from './renderer/renderer';
import type { VisualConfig } from './visual-config';

/**
 * Pure mutator: pushes every LIVE Central-tab knob value from `config` onto
 * the renderer/scene/light handles. Subscribes to `visual-config` from the
 * viewer so dragging a slider in the HUD updates the canvas in real time.
 *
 * What's LIVE here vs. what's RELOAD (issue #05):
 *   - LIVE: sun direction/color/intensity, ambient + hemi, tone-mapping
 *     exposure, fog color/density (when fog is on), environment intensity,
 *     background blurriness, GTAO radius/distanceExponent, denoise lumaPhi/
 *     depthPhi/normalPhi/radius, shadow bias / normalBias.
 *   - RELOAD (skipped here): tone-mapping algorithm, fog on/off,
 *     post-processing on/off, GTAO sample count, SMAA on/off, shadows on/off,
 *     shadow resolution.
 *
 * Shadow re-bake policy: `enableShadows()` sets `sun.shadow.autoUpdate=false`
 * for performance, so changing `sun.position` or `sun.shadow.bias` does not
 * re-render the shadow map until `needsUpdate=true` is set. This applier
 * therefore does *not* trigger a re-bake — sliders feel smooth even with
 * shadows on. The HUD's slider `onMouseUp` calls `applySunCommit` to commit
 * the new shadow once the user stops dragging.
 */
export function applyLiveConfig(
  handles: LiveRenderHandles,
  config: VisualConfig,
): void {
  const c = config.central;
  const { renderer, scene, sun, ambient, hemi, gtaoNode, denoiseNode } = handles;

  sunPositionFrom(c.sunAzimuthDeg, c.sunElevationDeg, sun.position);
  sun.color.setRGB(c.sunColor.r, c.sunColor.g, c.sunColor.b);
  sun.intensity = c.sunIntensity;

  ambient.intensity = c.ambientIntensity;

  hemi.color.setRGB(c.hemiSkyColor.r, c.hemiSkyColor.g, c.hemiSkyColor.b);
  hemi.groundColor.setRGB(
    c.hemiGroundColor.r,
    c.hemiGroundColor.g,
    c.hemiGroundColor.b,
  );
  hemi.intensity = c.hemiIntensity;

  renderer.toneMappingExposure = c.toneMappingExposure;

  // Fog color/density are LIVE only when fog already exists. Fog on/off is
  // RELOAD (#05); a flip false→true won't materialise a FogExp2 here.
  if (scene.fog instanceof THREE.FogExp2) {
    scene.fog.color.setRGB(c.fogColor.r, c.fogColor.g, c.fogColor.b);
    scene.fog.density = c.fogDensity;
  }

  scene.environmentIntensity = c.environmentIntensity;
  scene.backgroundBlurriness = c.backgroundBlurriness;

  if (gtaoNode) {
    gtaoNode.radius.value = c.gtaoRadius;
    gtaoNode.distanceExponent.value = c.gtaoDistanceExponent;
  }
  if (denoiseNode) {
    denoiseNode.lumaPhi.value = c.denoiseLumaPhi;
    denoiseNode.depthPhi.value = c.denoiseDepthPhi;
    denoiseNode.normalPhi.value = c.denoiseNormalPhi;
    denoiseNode.radius.value = c.denoiseRadius;
  }

  // Bias values are read by the shadow renderer at the next bake. Pushing
  // them here is harmless during a drag (autoUpdate=false) and lets the
  // mouseup commit pick them up without re-reading the config.
  if (sun.shadow) {
    sun.shadow.bias = c.shadowBias;
    sun.shadow.normalBias = c.shadowNormalBias;
  }
}

/**
 * Commit the directional-light state to the shadow map: triggers a one-shot
 * re-bake on the next render frame. Wired to slider `onMouseUp` for sun
 * azim/elev and shadow bias so dragging stays smooth and the shadow updates
 * once the user stops dragging.
 */
export function applySunCommit(handles: LiveRenderHandles): void {
  if (handles.sun.shadow) {
    handles.sun.shadow.needsUpdate = true;
  }
}
