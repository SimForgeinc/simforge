"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  deriveEnrichmentTags,
} from "@simforge/studio-shared";
import type { MapStats, MapStatsSignalization } from "@simforge/studio-shared";
import {
  extractMapSourceFromXodr,
  extractCoordinateRefFromXodr,
  extractXodrRoadStats,
} from "@/app/lib/maps/metadata/xodr";
import { extractGeojsonDerivedStats } from "@/app/lib/maps/metadata/geojson-stats";
import {
  extractRrdataSchemaVersion,
  extractSignalizationFromRrdata,
} from "@/app/lib/maps/metadata/rrdata-xml";
import { deriveIngestTagsFromMapStats } from "@/app/lib/maps/metadata/ingest-tags";
import { ChevronDown, Paperclip, MapPin, Camera } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import {
  generateMapAssetId,
  parseGeoJson,
  artifactTypeFromExtension,
  sha256Hex,
  buildDefaultMapName,
  mapLaneCountsLocal,
  type ComputedGeo,
} from "@/app/lib/maps/frontend/add-map-utils";
import AddMapPreviewMapDynamic from "./AddMapPreviewMapDynamic";
import { FieldLabel } from "./FieldLabel";
import { UploadStatusBadge, type TrackedUpload } from "./UploadStatusBadge";
import { LocationOverrideFields } from "./LocationOverrideFields";
import { ScenarioTagsPanel } from "./ScenarioTagsPanel";
import { AdditionalArtifactsPanel } from "./AdditionalArtifactsPanel";
import { buildDebugPayload } from "./AddMapDebugPayload";

const CRS_OPTIONS = [{ value: "EPSG:4326", label: "EPSG:4326 — WGS84 (lat, long)" }];

// ─── Types ──────────────────────────────────────────────────────────────────

export type FormState = {
  name: string;
  description: string;
  crs: string;
  tags: string[];
  geojsonFile: File | null;
  geojsonData: object | null;
  xodrFile: File | null;
  rrdataXmlFile: File | null;
  artifactFiles: File[];
  computed: ComputedGeo | null;
  geojsonParseError: string | null;
  /** Optional manual override for reverse-geocoded location. Empty = auto-fill from coordinates. */
  placeCity: string;
  placeState: string;
  placeCountry: string;
  /** Optional CARLA simulator map name for this asset. Empty = none. */
  carlaMapName: string;
};

// UploadStatus + TrackedUpload types imported from ./UploadStatusBadge

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ParsedMetaState = {
  xodr: Record<string, any> | null;
  geojson: Record<string, any> | null;
  rrdata_xml: Record<string, any> | null;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Constants & helpers ────────────────────────────────────────────────────

const initialState: FormState = {
  name: "",
  description: "",
  crs: "EPSG:4326",
  tags: [],
  geojsonFile: null,
  geojsonData: null,
  xodrFile: null,
  rrdataXmlFile: null,
  artifactFiles: [],
  computed: null,
  geojsonParseError: null,
  placeCity: "",
  placeState: "",
  placeCountry: "",
  carlaMapName: "",
};

const initialParsedMeta: ParsedMetaState = { xodr: null, geojson: null, rrdata_xml: null };

// Pure utilities (slugify, formatTimestamp, generateMapAssetId, collectCoordinates,
// parseGeoJson, artifactTypeFromExtension, sha256Hex, displayTag, buildDefaultMapName,
// mapLaneCountsLocal) extracted to @/app/lib/maps/frontend/add-map-utils.ts

const selectCls =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// FieldLabel + UploadStatusBadge extracted to ./FieldLabel.tsx and ./UploadStatusBadge.tsx

// ─── Component ──────────────────────────────────────────────────────────────

/** Multi-step form for uploading and registering a new map asset with metadata. */
export default function AddMapForm() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);

  // Upload tracking (keyed by fileId: "geojson" | "xodr" | "rrdata_xml" | "artifact-N")
  const [uploads, setUploads] = useState<Record<string, TrackedUpload>>({});
  // Parsed metadata from parse-artifact API
  const [parsedMeta, setParsedMeta] = useState<ParsedMetaState>(initialParsedMeta);

  // Auto-tag state
  const [autoTagSet, setAutoTagSet] = useState<Set<string>>(new Set());
  const [autoTagsLoading, setAutoTagsLoading] = useState(false);

  // Tag dropdown state

  // Refs
  const geojsonInputRef = useRef<HTMLInputElement>(null);
  const xodrInputRef = useRef<HTMLInputElement>(null);
  const rrdataInputRef = useRef<HTMLInputElement>(null);
  const artifactsInputRef = useRef<HTMLInputElement>(null);

  // Thumbnail blob captured from the map preview canvas
  const thumbnailBlobRef = useRef<Blob | null>(null);
  const [thumbnailCaptured, setThumbnailCaptured] = useState(false);
  const handleThumbnailReady = useCallback((blob: Blob) => {
    thumbnailBlobRef.current = blob;
    setThumbnailCaptured(true);
  }, []);

  /** Fixed timestamp for the session — ensures consistent mapAssetId across the form lifecycle. */
  const sessionTs = useRef(new Date());
  /** Ref to always access latest form state from async callbacks. */
  const formRef = useRef(form);
  formRef.current = form;
  /** Ref to always access latest parsedMeta from async callbacks. */
  const parsedMetaRef = useRef(parsedMeta);
  parsedMetaRef.current = parsedMeta;
  /** The mapAssetId that current uploads target. */
  const uploadMapAssetIdRef = useRef<string | null>(null);
  /** Tracks which "mapAssetId:fileId" combos have an active upload in flight. */
  const activeUploadsRef = useRef(new Set<string>());
  /** Promises for in-flight uploads — resolved with { sha256, key }. */
  const uploadPromisesRef = useRef(new Map<string, Promise<{ sha256: string; key: string }>>());
  /** Tracks whether the user has manually typed into the name field. */
  const userTouchedNameRef = useRef(false);

  // ─── Upload helpers ─────────────────────────────────────────────────────

  /** Start uploading a single file to S3 in the background. Idempotent per mapAssetId + fileId. */
  const startFileUpload = useCallback(
    (mapAssetId: string, fileId: string, file: File, contentType: string) => {
      const uploadKey = `${mapAssetId}:${fileId}`;
      if (activeUploadsRef.current.has(uploadKey)) return; // Already in flight
      activeUploadsRef.current.add(uploadKey);

      const promise = (async (): Promise<{ sha256: string; key: string }> => {
        // 1. Hash
        setUploads((prev) => ({ ...prev, [fileId]: { status: "hashing", sha256: null, key: null, error: null } }));
        const hash = await sha256Hex(file);

        // 2. Get presigned URL
        setUploads((prev) => ({ ...prev, [fileId]: { status: "uploading", sha256: hash, key: null, error: null } }));
        const urlRes = await fetch("/api/map-assets/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mapAssetId, fileId, filename: file.name, contentType }),
        });
        if (!urlRes.ok) {
          const body = await urlRes.json().catch(() => ({}));
          throw new Error((body as { error?: string })?.error ?? `Upload URL failed (${urlRes.status})`);
        }
        const { url, key } = (await urlRes.json()) as { url: string; key: string };

        // 3. PUT to S3
        const putRes = await fetch(url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": contentType },
        });
        if (!putRes.ok) {
          throw new Error(`S3 upload failed for ${file.name}: ${putRes.status}`);
        }

        // 4. Done
        setUploads((prev) => ({ ...prev, [fileId]: { status: "done", sha256: hash, key, error: null } }));
        return { sha256: hash, key };
      })();

      uploadPromisesRef.current.set(fileId, promise);

      // On error: clear the active guard so the user can retry
      promise.catch((err) => {
        setUploads((prev) => ({
          ...prev,
          [fileId]: { status: "error", sha256: null, key: null, error: err instanceof Error ? err.message : String(err) },
        }));
        activeUploadsRef.current.delete(uploadKey);
      });
    },
    [],
  );

  /**
   * Try to start an upload for a single file.
   * No-op if name isn't set yet (uploads will be triggered when name is committed).
   */
  const tryStartUpload = useCallback(
    (fileId: string, file: File, contentType: string) => {
      const name = formRef.current.name;
      if (!name.trim()) return;
      const mapAssetId = generateMapAssetId(name, sessionTs.current);

      // If mapAssetId changed since last upload batch, reset tracking
      if (mapAssetId !== uploadMapAssetIdRef.current) {
        uploadMapAssetIdRef.current = mapAssetId;
        activeUploadsRef.current.clear();
        uploadPromisesRef.current.clear();
        setUploads({});
      }

      startFileUpload(mapAssetId, fileId, file, contentType);
    },
    [startFileUpload],
  );

  /** Start uploads for all files that haven't been uploaded yet. Called on name commit. */
  const tryUploadAllPending = useCallback(() => {
    const f = formRef.current;
    if (!f.name.trim()) return;
    if (f.geojsonFile) tryStartUpload("geojson", f.geojsonFile, "application/geo+json");
    if (f.xodrFile) tryStartUpload("xodr", f.xodrFile, "application/xml");
    if (f.rrdataXmlFile) tryStartUpload("rrdata_xml", f.rrdataXmlFile, "application/xml");
    f.artifactFiles.forEach((af, i) =>
      tryStartUpload(`artifact-${i}`, af, af.type || "application/octet-stream"),
    );
  }, [tryStartUpload]);

  // ─── Metadata parsing — runs entirely client-side (no network call) ────

  const parseArtifactFile = useCallback(
    (artifactType: "xodr" | "geojson" | "rrdata_xml", text: string) => {
      try {
        switch (artifactType) {
          case "xodr": {
            const roadStats = extractXodrRoadStats(text);
            const mapSource = extractMapSourceFromXodr(text);
            const coordinateRef = extractCoordinateRefFromXodr(text);
            setParsedMeta((prev) => ({
              ...prev,
              xodr: { artifactType, roadStats, mapSource, coordinateRef },
            }));
            break;
          }
          case "geojson": {
            const stats = extractGeojsonDerivedStats(text);
            setParsedMeta((prev) => ({
              ...prev,
              geojson: { artifactType, ...stats },
            }));
            break;
          }
          case "rrdata_xml": {
            const schemaVersion = extractRrdataSchemaVersion(text);
            const signalization = extractSignalizationFromRrdata(text);
            setParsedMeta((prev) => ({
              ...prev,
              rrdata_xml: { artifactType, schemaVersion, signalization },
            }));
            break;
          }
        }
      } catch {
        // Non-critical — just for preview
      }
    },
    [],
  );

  // ─── deriveTags — runs entirely client-side (no network call) ──────────

  const deriveTags = useCallback(
    (enrichmentFeatureCounts?: Record<string, number>) => {
      const pm = parsedMetaRef.current;
      if (!pm.xodr || !pm.geojson || !pm.rrdata_xml) return;

      setAutoTagsLoading(true);
      try {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const xodrRoadStats = (pm.xodr as any).roadStats ?? {};
        const xodrSignalization = ((pm.rrdata_xml as any).signalization ?? {}) as Partial<MapStatsSignalization>;
        const geo = pm.geojson as any;
        /* eslint-enable @typescript-eslint/no-explicit-any */

        const laneCounts = mapLaneCountsLocal(xodrRoadStats.lane_counts ?? {});
        const parkingSpaceCount = (geo.parking_space_count ?? 0) > 0 ? geo.parking_space_count : undefined;
        const crosswalkTotal = xodrRoadStats.crosswalk_count ?? 0;
        const totalJ = xodrRoadStats.total_junctions ?? 0;

        const mapStats: MapStats = {
          map_asset_id: "_derive",
          computed_at: new Date().toISOString(),
          road_network: {
            total_roads: xodrRoadStats.total_roads || undefined,
            total_junctions: totalJ || undefined,
            total_centerline_length_m:
              (xodrRoadStats.total_centerline_length_m ?? 0) > 0
                ? xodrRoadStats.total_centerline_length_m
                : undefined,
            lane_counts: laneCounts,
            roads_with_bike_lanes: xodrRoadStats.roads_with_bike_lanes || undefined,
            roads_with_sidewalks: xodrRoadStats.roads_with_sidewalks || undefined,
            signal_count: xodrRoadStats.signal_count || undefined,
            crosswalk_count: crosswalkTotal,
            parking_space_count: parkingSpaceCount,
            speed_limits_mph:
              Array.isArray(xodrRoadStats.speed_limits_mph) && xodrRoadStats.speed_limits_mph.length > 0
                ? xodrRoadStats.speed_limits_mph
                : undefined,
            max_grade_pct: (xodrRoadStats.max_grade_pct ?? 0) > 0 ? xodrRoadStats.max_grade_pct : undefined,
            segments_above_4pct_grade:
              (xodrRoadStats.segments_above_4pct_grade ?? 0) > 0
                ? xodrRoadStats.segments_above_4pct_grade
                : undefined,
            junction_road_degree_counts: xodrRoadStats.junction_road_degree_counts,
          },
          signalization: {
            signal_controlled_object_count: xodrSignalization.signal_controlled_object_count,
            has_signal_phase_timing: xodrSignalization.has_signal_phase_timing,
            signal_configurations_count: xodrSignalization.signal_configurations_count,
            junctions_with_phases: xodrSignalization.junctions_with_phases,
            signal_phase_count: xodrSignalization.signal_phase_count,
          },
          feature_inventory: {
            junctions: { total: totalJ || undefined },
            crosswalks: { total: crosswalkTotal, signalized: 0, unsignalized: crosswalkTotal },
            lanes: {
              driving_total: laneCounts.driving,
              bike_total: laneCounts.biking,
              sidewalk_total: laneCounts.sidewalk,
              shoulder_total: laneCounts.shoulder,
            },
            signals: xodrRoadStats.signal_count || undefined,
            parking_spaces: parkingSpaceCount,
            turn_movements: {
              straight: geo.turn_straight ?? 0,
              left: geo.turn_left ?? 0,
              right: geo.turn_right ?? 0,
              uturn_left: geo.turn_uturn_left ?? 0,
              uturn_right: geo.turn_uturn_right ?? 0,
            },
          },
        };

        const ingestTags = deriveIngestTagsFromMapStats(mapStats);
        const enrichTags = enrichmentFeatureCounts
          ? deriveEnrichmentTags(enrichmentFeatureCounts)
          : [];
        const allAutoTags = [...new Set([...ingestTags, ...enrichTags])].sort();

        const newAutoSet = new Set(allAutoTags);
        setAutoTagSet(newAutoSet);
        setForm((f) => {
          const merged = new Set(f.tags);
          for (const t of allAutoTags) merged.add(t);
          return { ...f, tags: [...merged] };
        });
      } catch {
        // Non-critical
      } finally {
        setAutoTagsLoading(false);
      }
    },
    [],
  );

  // ─── Debounced name commit: trigger uploads when user stops typing ──────

  useEffect(() => {
    if (!form.name.trim()) return;
    const timer = setTimeout(() => {
      tryUploadAllPending();
    }, 800);
    return () => clearTimeout(timer);
  }, [form.name, tryUploadAllPending]);

  // ─── Auto-populate location from xodr origin coordinates ────────────────
  // The xodr coordinateRef origin (proj string +lat_0/+lon_0) is more
  // authoritative than the geojson bbox center.  When xodr metadata becomes
  // available, reverse-geocode and update the location fields.

  useEffect(() => {
    const coordRef = parsedMeta.xodr?.coordinateRef;
    if (!coordRef) return;
    const lat = coordRef.origin_lat as number | undefined;
    const lon = coordRef.origin_lon as number | undefined;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

    let cancelled = false;
    fetch(`/api/map-assets/reverse-geocode?lat=${lat}&lon=${lon}`)
      .then((res) => res.json())
      .then((place: { city?: string; state?: string; country?: string }) => {
        if (cancelled) return;
        setForm((f) => {
          const update: Partial<FormState> = {
            placeCity: place.city ?? f.placeCity,
            placeState: place.state ?? f.placeState,
            placeCountry: place.country ?? f.placeCountry,
          };
          // Update default name with more authoritative xodr-origin location
          if (!userTouchedNameRef.current) {
            const defaultName = buildDefaultMapName(
              place.city ?? f.placeCity,
              place.state ?? f.placeState,
              place.country ?? f.placeCountry,
            );
            if (defaultName) update.name = defaultName;
          }
          return { ...f, ...update };
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [parsedMeta.xodr]);

  // ─── Auto-derive tags when all three artifacts are parsed ─────────────
  // Overture-driven tags are merged into the map asset asynchronously by the
  // third-party-enrichment Lambda after submit.
  useEffect(() => {
    if (!parsedMeta.xodr || !parsedMeta.geojson || !parsedMeta.rrdata_xml) return;
    deriveTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedMeta.xodr, parsedMeta.geojson, parsedMeta.rrdata_xml]);

  // ─── File change handlers ───────────────────────────────────────────────

  function handleGeoJsonChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setForm((f) => ({ ...f, geojsonFile: null, geojsonData: null, computed: null, geojsonParseError: null }));
      setParsedMeta((prev) => ({ ...prev, geojson: null }));
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const result = parseGeoJson(text);
      if ("error" in result) {
        setForm((f) => ({ ...f, geojsonFile: file, geojsonData: null, computed: null, geojsonParseError: result.error }));
      } else {
        setForm((f) => ({ ...f, geojsonFile: file, geojsonData: result.data, computed: result.geo, geojsonParseError: null }));
        // Auto-populate location from the computed center
        const { lat, lng } = result.geo.center;
        fetch(`/api/map-assets/reverse-geocode?lat=${lat}&lon=${lng}`)
          .then((res) => {
            if (!res.ok) throw new Error(`reverse-geocode ${res.status}`);
            return res.json();
          })
          .then((place: { city?: string; state?: string; country?: string }) => {
            setForm((f) => {
              const update: Partial<FormState> = {
                placeCity: place.city ?? "",
                placeState: place.state ?? "",
                placeCountry: place.country ?? "",
              };
              // Auto-fill name if the user hasn't manually typed one
              if (!userTouchedNameRef.current) {
                const defaultName = buildDefaultMapName(place.city, place.state, place.country);
                if (defaultName) update.name = defaultName;
              }
              return { ...f, ...update };
            });
          })
          .catch((err) => {
            console.warn("[AddMapForm] reverse-geocode failed:", err);
          });
      }
      // Kick off metadata parsing immediately
      void parseArtifactFile("geojson", text);
      // Kick off upload if name is available
      tryStartUpload("geojson", file, "application/geo+json");
    };
    reader.readAsText(file);
  }

  function handleXodrChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setForm((f) => ({ ...f, xodrFile: null }));
      setParsedMeta((prev) => ({ ...prev, xodr: null }));
      return;
    }
    setForm((f) => ({ ...f, xodrFile: file }));
    // Read file for metadata parsing (reverse-geocode handled by effect below)
    file.text().then((text) => {
      void parseArtifactFile("xodr", text);
    });
    // Kick off upload if name is available
    tryStartUpload("xodr", file, "application/xml");
  }

  function handleRrdataChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setForm((f) => ({ ...f, rrdataXmlFile: null }));
      setParsedMeta((prev) => ({ ...prev, rrdata_xml: null }));
      return;
    }
    setForm((f) => ({ ...f, rrdataXmlFile: file }));
    // Read file for metadata parsing
    file.text().then((text) => {
      void parseArtifactFile("rrdata_xml", text);
    });
    // Kick off upload if name is available
    tryStartUpload("rrdata_xml", file, "application/xml");
  }

  function handleArtifactsChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setForm((f) => ({ ...f, artifactFiles: files }));
    // Kick off uploads for each artifact if name is available
    files.forEach((file, i) => {
      tryStartUpload(`artifact-${i}`, file, file.type || "application/octet-stream");
    });
  }

  // ─── Tag helpers ────────────────────────────────────────────────────────

  function removeTag(tagId: string) {
    setForm((f) => ({ ...f, tags: f.tags.filter((t) => t !== tagId) }));
  }

  // ─── Submit ─────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) { setError("Name is required."); return; }
    if (!form.geojsonFile) { setError("GeoJSON file is required."); return; }
    if (!form.xodrFile) { setError("OpenDRIVE (.xodr) file is required."); return; }
    if (!form.rrdataXmlFile) { setError("RoadRunner metadata (.xml) file is required."); return; }
    if (!form.computed) { setError("GeoJSON could not be parsed. Please upload a valid GeoJSON file."); return; }

    const extraUnknown = form.artifactFiles.filter((f) => artifactTypeFromExtension(f.name) == null);
    if (extraUnknown.length > 0) {
      setError(
        `Unsupported file type(s): ${extraUnknown.map((f) => f.name).join(", ")}. Use fbx, mp4, or an image.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const mapAssetId = generateMapAssetId(form.name, sessionTs.current);

      // Ensure mapAssetId tracking is current — if name changed right before submit
      if (mapAssetId !== uploadMapAssetIdRef.current) {
        uploadMapAssetIdRef.current = mapAssetId;
        activeUploadsRef.current.clear();
        uploadPromisesRef.current.clear();
        setUploads({});
      }

      // Start uploads for any files not yet tracked (e.g., artifacts, or if name was just committed)
      const requiredFiles: { id: string; file: File; ct: string }[] = [
        { id: "geojson", file: form.geojsonFile, ct: "application/geo+json" },
        { id: "xodr", file: form.xodrFile, ct: "application/xml" },
        { id: "rrdata_xml", file: form.rrdataXmlFile, ct: "application/xml" },
      ];
      const artifactFileSpecs = form.artifactFiles.map((f, i) => ({
        id: `artifact-${i}`,
        file: f,
        ct: f.type || "application/octet-stream",
      }));
      const allFiles = [...requiredFiles, ...artifactFileSpecs];

      // Add thumbnail if the preview map captured one
      if (thumbnailBlobRef.current) {
        const thumbFile = new File([thumbnailBlobRef.current], "thumbnail.png", { type: "image/png" });
        allFiles.push({ id: "thumbnail", file: thumbFile, ct: "image/png" });
      }

      for (const f of allFiles) {
        if (!uploadPromisesRef.current.has(f.id)) {
          startFileUpload(mapAssetId, f.id, f.file, f.ct);
        }
      }

      // Wait for ALL uploads to complete
      const results = new Map<string, { sha256: string; key: string }>();
      for (const f of allFiles) {
        const promise = uploadPromisesRef.current.get(f.id);
        if (!promise) throw new Error(`No upload tracked for ${f.id}`);
        results.set(f.id, await promise);
      }

      // Build artifacts array from upload results
      const artifacts = allFiles.map((f) => {
        const r = results.get(f.id)!;
        if (f.id === "thumbnail") {
          return { key: r.key, artifact_type: "thumbnail" as const, sha256: r.sha256, size_bytes: f.file.size };
        }
        const t = artifactTypeFromExtension(f.file.name);
        if (t == null) throw new Error(`Unsupported artifact: ${f.file.name}`);
        return { key: r.key, artifact_type: t, sha256: r.sha256, size_bytes: f.file.size };
      });

      // Build optional place context override — only include if at least one field is set
      const placeOverride =
        form.placeCity.trim() || form.placeState.trim() || form.placeCountry.trim()
          ? {
              city: form.placeCity.trim() || undefined,
              state: form.placeState.trim() || undefined,
              country: form.placeCountry.trim() || undefined,
            }
          : undefined;

      const completeRes = await fetch("/api/map-assets/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mapAssetId,
          name: form.name.trim(),
          description: form.description.trim(),
          carlaMapName: form.carlaMapName.trim() || null,
          crs: form.crs,
          tags: form.tags,
          mapCenter: form.computed.center,
          bbox: form.computed.bbox,
          artifacts,
          ...(placeOverride ? { placeContextOverride: placeOverride } : {}),
        }),
      });
      if (!completeRes.ok) {
        const body = await completeRes.json().catch(() => ({}));
        throw new Error((body as { error?: string })?.error ?? `Complete failed (${completeRes.status})`);
      }

      // Local map ingestion publishes synchronously. There is no enrichment
      // fleet job to enqueue or poll after the map becomes available.
      router.push(`/dashboard/map-assets/${mapAssetId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  // ─── Derived state for UI ───────────────────────────────────────────────

  const anyUploading = Object.values(uploads).some(
    (u) => u.status === "hashing" || u.status === "uploading",
  );

  const pendingWork = autoTagsLoading || anyUploading;
  const submitDisabled = submitting || pendingWork;
  const submitLabel = submitting
    ? "Creating…"
    : autoTagsLoading
      ? "Deriving tags…"
      : anyUploading
        ? "Uploading…"
        : "Create map";


  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <form onSubmit={handleSubmit} className="flex h-full w-full min-h-0 flex-col">

      {/* ── Top section: fields (left) + map preview (top-right) ─────── */}
      <div className="flex min-h-[400px] shrink-0 border-b border-border">

        {/* Left: basic map info fields */}
        <div className="flex-1 min-w-0 overflow-y-auto border-r border-border px-6 py-5 space-y-4">
          {error && (
            <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          {/* GeoJSON upload — first step */}
          <div>
            <FieldLabel htmlFor="map-geojson" required>GeoJSON file</FieldLabel>
            <p className="mb-2 text-xs text-muted-foreground">
              Required. Center and bounding box are computed automatically and previewed on the map.
            </p>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => geojsonInputRef.current?.click()}
              >
                <Paperclip className="mr-1.5 size-3.5" />
                {form.geojsonFile ? "Replace file" : "Choose file"}
              </Button>
              {form.geojsonFile && (
                <span className="truncate text-xs text-muted-foreground">{form.geojsonFile.name}</span>
              )}
              <UploadStatusBadge upload={uploads["geojson"]} />
            </div>
            <input
              id="map-geojson"
              type="file"
              accept=".geojson,.json"
              ref={geojsonInputRef}
              className="hidden"
              onChange={handleGeoJsonChange}
            />
            {form.geojsonParseError && (
              <p className="mt-1.5 text-xs text-destructive">{form.geojsonParseError}</p>
            )}
            {form.computed && (
              <div className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <span className="font-medium text-foreground">Center</span>
                  <span className="font-mono">
                    {form.computed.center.lat.toFixed(6)}, {form.computed.center.lng.toFixed(6)}
                  </span>
                  <span className="font-medium text-foreground">Bbox</span>
                  <span className="font-mono">
                    {form.computed.bbox.min_lat.toFixed(5)}, {form.computed.bbox.min_lng.toFixed(5)} →{" "}
                    {form.computed.bbox.max_lat.toFixed(5)}, {form.computed.bbox.max_lng.toFixed(5)}
                  </span>
                  {parsedMeta.geojson && (
                    <>
                      <span className="font-medium text-foreground">Features</span>
                      <span className="font-mono">
                        {parsedMeta.geojson.parking_space_count > 0 && `${parsedMeta.geojson.parking_space_count} parking · `}
                        {(parsedMeta.geojson.turn_straight > 0 || parsedMeta.geojson.turn_left > 0 || parsedMeta.geojson.turn_right > 0) && (
                          `turns: ${parsedMeta.geojson.turn_straight}↑ ${parsedMeta.geojson.turn_left}← ${parsedMeta.geojson.turn_right}→`
                        )}
                        {parsedMeta.geojson.parking_space_count === 0 &&
                          parsedMeta.geojson.turn_straight === 0 &&
                          parsedMeta.geojson.turn_left === 0 &&
                          parsedMeta.geojson.turn_right === 0 &&
                          "none detected"}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <div>
            <FieldLabel htmlFor="map-xodr" required>OpenDRIVE file (.xodr)</FieldLabel>
            <p className="mb-2 text-xs text-muted-foreground">
              Required. Used for coordinate reference, provenance, and road-network statistics.
            </p>
            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={() => xodrInputRef.current?.click()}>
                <Paperclip className="mr-1.5 size-3.5" />
                {form.xodrFile ? "Replace file" : "Choose file"}
              </Button>
              {form.xodrFile && (
                <span className="truncate text-xs text-muted-foreground">{form.xodrFile.name}</span>
              )}
              <UploadStatusBadge upload={uploads["xodr"]} />
            </div>
            <input
              id="map-xodr"
              type="file"
              accept=".xodr"
              ref={xodrInputRef}
              className="hidden"
              onChange={handleXodrChange}
            />
            {parsedMeta.xodr && (
              <div className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <span className="font-medium text-foreground">Road network</span>
                  <span className="font-mono">
                    {parsedMeta.xodr.roadStats?.total_roads ?? 0} roads · {parsedMeta.xodr.roadStats?.total_junctions ?? 0} junctions · {parsedMeta.xodr.roadStats?.signal_count ?? 0} signals
                    {(parsedMeta.xodr.roadStats?.total_centerline_length_m ?? 0) > 0 &&
                      ` · ${(parsedMeta.xodr.roadStats.total_centerline_length_m / 1000).toFixed(1)} km`}
                  </span>
                  {parsedMeta.xodr.mapSource?.tool && (
                    <>
                      <span className="font-medium text-foreground">Source</span>
                      <span className="font-mono">
                        {parsedMeta.xodr.mapSource.tool}
                        {parsedMeta.xodr.mapSource.tool_version && ` ${parsedMeta.xodr.mapSource.tool_version}`}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <div>
            <FieldLabel htmlFor="map-rrdata" required>RoadRunner metadata (.xml)</FieldLabel>
            <p className="mb-2 text-xs text-muted-foreground">
              Required. Typically <span className="font-mono">*_rrdata.xml</span> from the export. Used for signalization metadata.
            </p>
            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={() => rrdataInputRef.current?.click()}>
                <Paperclip className="mr-1.5 size-3.5" />
                {form.rrdataXmlFile ? "Replace file" : "Choose file"}
              </Button>
              {form.rrdataXmlFile && (
                <span className="truncate text-xs text-muted-foreground">{form.rrdataXmlFile.name}</span>
              )}
              <UploadStatusBadge upload={uploads["rrdata_xml"]} />
            </div>
            <input
              id="map-rrdata"
              type="file"
              accept=".xml,text/xml,application/xml"
              ref={rrdataInputRef}
              className="hidden"
              onChange={handleRrdataChange}
            />
            {parsedMeta.rrdata_xml && (
              <div className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <span className="font-medium text-foreground">Signalization</span>
                  <span className="font-mono">
                    {parsedMeta.rrdata_xml.signalization?.signal_controlled_object_count ?? 0} controlled junctions · phase timing: {parsedMeta.rrdata_xml.signalization?.has_signal_phase_timing ? "yes" : "no"}
                  </span>
                  {parsedMeta.rrdata_xml.schemaVersion && (
                    <>
                      <span className="font-medium text-foreground">Schema</span>
                      <span className="font-mono">{parsedMeta.rrdata_xml.schemaVersion}</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Name */}
          <div>
            <FieldLabel htmlFor="map-name" required>Name</FieldLabel>
            <Input
              id="map-name"
              value={form.name}
              onChange={(e) => {
                userTouchedNameRef.current = true;
                setForm((f) => ({ ...f, name: e.target.value }));
              }}
              onBlur={() => tryUploadAllPending()}
              placeholder="e.g. University District"
              required
            />
          </div>

          {/* Description */}
          <div>
            <FieldLabel htmlFor="map-description">Description</FieldLabel>
            <textarea
              id="map-description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of the map area"
              rows={3}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {/* CARLA map name */}
          <div>
            <FieldLabel htmlFor="map-carla-map-name">Carla Map Name</FieldLabel>
            <Input
              id="map-carla-map-name"
              value={form.carlaMapName}
              onChange={(e) => setForm((f) => ({ ...f, carlaMapName: e.target.value }))}
              placeholder="e.g. Belmont_Office_Park_Belmont_CA"
              className="font-mono"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Identifier used by the CARLA simulator for this map. Optional.
            </p>
          </div>

          {/* Location override */}
          <LocationOverrideFields
            city={form.placeCity}
            state={form.placeState}
            country={form.placeCountry}
            onCityChange={(v) => setForm((f) => ({ ...f, placeCity: v }))}
            onStateChange={(v) => setForm((f) => ({ ...f, placeState: v }))}
            onCountryChange={(v) => setForm((f) => ({ ...f, placeCountry: v }))}
          />

          {/* CRS */}
          <div>
            <FieldLabel htmlFor="map-crs">Coordinate reference system (CRS)</FieldLabel>
            <select
              id="map-crs"
              className={selectCls}
              value={form.crs}
              onChange={(e) => setForm((f) => ({ ...f, crs: e.target.value }))}
            >
              {CRS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

        </div>

        {/* Right: 400x400 map preview square */}
        <div className="relative h-[400px] w-[400px] shrink-0 self-start">
          {form.geojsonData ? (
            <>
              <AddMapPreviewMapDynamic geojson={form.geojsonData} bbox={form.computed?.bbox ?? null} onThumbnailReady={handleThumbnailReady} />
              {thumbnailCaptured && (
                <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-[10px] text-emerald-400">
                  <Camera className="size-3" />
                  Thumbnail captured
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <MapPin className="size-8 opacity-30" />
              <p className="text-sm">Upload a GeoJSON file to preview the map</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom section: scenario tags + artifacts + actions ─────── */}
      <div className="p-6 space-y-6">

        {/* Scenario tags */}
        <ScenarioTagsPanel
          tags={form.tags}
          autoTagSet={autoTagSet}
          autoTagsLoading={autoTagsLoading}
          onAddTag={(tagId) => setForm((f) => ({ ...f, tags: f.tags.includes(tagId) ? f.tags : [...f.tags, tagId] }))}
          onRemoveTag={removeTag}
          onBulkAddCsv={(ids) => setForm((f) => ({ ...f, tags: [...new Set([...f.tags, ...ids])] }))}
        />

        {/* Additional artifacts */}
        <AdditionalArtifactsPanel
          files={form.artifactFiles}
          uploads={uploads}
          inputRef={artifactsInputRef}
          onFilesChange={handleArtifactsChange}
        />

        {/* Actions */}
        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button type="submit" disabled={submitDisabled}>
            {submitLabel}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/map-assets">Cancel</Link>
          </Button>
        </div>
      </div>

      {/* ── Debug: full-width, outside scroll area ────────────────────── */}
      <div className="shrink-0 border-t border-border px-6 py-3">
        <button
          type="button"
          onClick={() => setDebugOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-3.5 shrink-0 transition-transform", !debugOpen && "-rotate-90")}
          />
          Debug: full map payload (asset + metadata + stats)
        </button>
        {debugOpen && (
          <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
            {JSON.stringify(buildDebugPayload({ form, parsedMeta, autoTagSet, uploads }), null, 2)}
          </pre>
        )}
      </div>
    </form>
  );
}
