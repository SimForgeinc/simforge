"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

const CLOUD_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec2 uPointer;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.52;
    mat2 rotation = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise(p);
      p = rotation * p * 2.03 + 9.7;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
    p += uPointer * vec2(0.12, 0.06);

    vec2 farDrift = vec2(uTime * 0.028, uTime * 0.006);
    vec2 nearDrift = vec2(-uTime * 0.045, uTime * 0.009);

    float farShape = fbm(p * 2.15 + farDrift);
    float farDetail = fbm(p * 5.2 - farDrift * 0.7 + farShape);
    float farCloud = smoothstep(0.54, 0.73, farShape * 0.72 + farDetail * 0.42);

    float nearShape = fbm((p + vec2(0.7, -0.28)) * 1.55 + nearDrift);
    float nearDetail = fbm(p * 3.7 - nearDrift * 0.55 + nearShape * 1.3);
    float nearCloud = smoothstep(0.55, 0.76, nearShape * 0.76 + nearDetail * 0.40);

    float lowerBank = 1.0 - smoothstep(0.13, 0.68, uv.y);
    float upperWisps = smoothstep(0.56, 0.98, uv.y) * 0.56;
    float sideBanks = smoothstep(0.28, 0.98, abs(uv.x - 0.5) * 2.0) * 0.5;
    float cloudMask = clamp(lowerBank + upperWisps + sideBanks, 0.0, 1.0);

    float cloud = clamp(farCloud * 0.65 + nearCloud * 0.92, 0.0, 1.0) * cloudMask;
    float softHaze = fbm(p * 1.1 + farDrift * 0.4) * lowerBank * 0.13;
    vec3 shadowColor = vec3(0.22, 0.24, 0.25);
    vec3 lightColor = vec3(0.93, 0.94, 0.94);
    vec3 cloudColor = mix(shadowColor, lightColor, smoothstep(0.16, 0.82, cloud));
    float alpha = cloud * 0.72 + softHaze;

    gl_FragColor = vec4(cloudColor, alpha);
  }
`;

export function AppSwitcherSkyScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof WebGLRenderingContext === "undefined") return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: "low-power",
      });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.35));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x050607, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
    camera.position.set(0, 1.2, 17);

    const cloudGeometry = new THREE.PlaneGeometry(34, 19);
    const cloudUniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uPointer: { value: new THREE.Vector2(0, 0) },
    };
    const cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERTEX_SHADER,
      fragmentShader: CLOUD_FRAGMENT_SHADER,
      uniforms: cloudUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const cloudPlane = new THREE.Mesh(cloudGeometry, cloudMaterial);
    cloudPlane.position.set(0, 0.2, 0);
    scene.add(cloudPlane);

    const resize = () => {
      const { clientWidth, clientHeight } = canvas;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight, false);
      cloudUniforms.uResolution.value.set(clientWidth, clientHeight);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const pointerTarget = new THREE.Vector2();
    const handlePointerMove = (event: PointerEvent) => {
      pointerTarget.set(
        event.clientX / Math.max(window.innerWidth, 1) - 0.5,
        event.clientY / Math.max(window.innerHeight, 1) - 0.5,
      );
    };
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    const clock = new THREE.Clock();
    const render = () => {
      const elapsed = clock.getElapsedTime();
      if (!reducedMotion) {
        cloudUniforms.uTime.value = elapsed;
        cloudUniforms.uPointer.value.lerp(pointerTarget, 0.018);
        camera.position.z = 17 + Math.min(elapsed, 2.4) * 0.12;
      }
      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(reducedMotion ? null : render);
    render();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("pointermove", handlePointerMove);
      renderer.setAnimationLoop(null);
      cloudGeometry.dispose();
      cloudMaterial.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="app-switcher-three-sky"
      className="pointer-events-none absolute inset-0 size-full"
    />
  );
}
