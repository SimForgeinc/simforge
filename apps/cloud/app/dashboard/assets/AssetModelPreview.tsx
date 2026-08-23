"use client";

import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  Sphere,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Material, Object3D } from "three";
import type { GalleryCatalogEntryDto } from "@/app/lib/asset-gallery/contracts";

function disposeMaterial(material: Material) {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose();
  }
  material.dispose();
}

export default function AssetModelPreview({ catalogId }: { catalogId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const previewHost: HTMLDivElement = host;
    setLoaded(false);
    setError(null);
    let cancelled = false;
    let frame = 0;
    let renderer: WebGLRenderer | null = null;
    let model: Object3D | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function mountPreview() {
      try {
        const response = await fetch("/api/asset-gallery/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ catalogIds: [catalogId] }),
        });
        if (!response.ok) throw new Error("Could not resolve the model download.");
        const payload = (await response.json()) as { entries: GalleryCatalogEntryDto[] };
        const entry = payload.entries[0];
        if (!entry) throw new Error("This model version is no longer available.");

        // The preview is its own next/dynamic chunk; the loader is fetched only after the drawer opens.
        const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
        const gltf = await new GLTFLoader().loadAsync(entry.model.url);
        if (cancelled) return;
        const loadedModel = gltf.scene;
        model = loadedModel;

        const scene = new Scene();
        scene.background = new Color(0x101317);
        scene.add(loadedModel);
        scene.add(new AmbientLight(0xffffff, 1.4));
        const key = new DirectionalLight(0xffffff, 3);
        key.position.set(4, 7, 5);
        scene.add(key);
        const fill = new DirectionalLight(0x91b5ff, 1.1);
        fill.position.set(-4, 2, -3);
        scene.add(fill);

        const bounds = new Box3().setFromObject(loadedModel);
        const sphere = bounds.getBoundingSphere(new Sphere());
        const radius = Math.max(sphere.radius, 0.001);
        const camera = new PerspectiveCamera(36, 1, radius / 100, radius * 30);
        camera.position
          .copy(sphere.center)
          .addScaledVector(new Vector3(1.4, 0.9, 1.4).normalize(), radius * 3.2);
        camera.lookAt(sphere.center);

        renderer = new WebGLRenderer({ antialias: true });
        renderer.outputColorSpace = SRGBColorSpace;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        previewHost.appendChild(renderer.domElement);

        const resize = () => {
          if (!renderer) return;
          const width = Math.max(previewHost.clientWidth, 1);
          const height = Math.max(previewHost.clientHeight, 1);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(previewHost);
        resize();

        const firstClip = gltf.animations[0];
        const mixer = firstClip ? new AnimationMixer(loadedModel) : null;
        if (firstClip) mixer?.clipAction(firstClip).play();
        setLoaded(true);
        const clock = new Clock();
        const render = () => {
          if (cancelled || !renderer) return;
          mixer?.update(Math.min(clock.getDelta(), 0.1));
          renderer.render(scene, camera);
          frame = requestAnimationFrame(render);
        };
        render();
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not preview this model.");
        }
      }
    }

    void mountPreview();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      if (model) {
        model.traverse((object) => {
          const mesh = object as Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) disposeMaterial(material);
        });
      }
      if (renderer) {
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      }
    };
  }, [catalogId]);

  return (
    <div
      className="relative h-72 overflow-hidden rounded-xl border border-white/10 bg-[#101317]"
      aria-label="Interactive model preview"
    >
      <div ref={hostRef} className="absolute inset-0" />
      {!error && !loaded ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-white/35">
          Loading model…
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 grid place-items-center px-8 text-center text-sm text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}
