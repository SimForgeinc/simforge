import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const INVENTORY_SCHEMA = 'uniscenario.render-qualification-inventory/v1';
export const MANIFEST_SCHEMA = 'uniscenario.render-qualification-manifest/v1';
export const REQUEST_SET_SCHEMA = 'uniscenario.render-qualification-request-set/v1';
export const BENCHMARK_SCHEMA = 'uniscenario.render-benchmark-report/v1';
export const COMPARISON_SCHEMA = 'uniscenario.render-qualification-comparison/v1';
export const MATRIX_SCHEMA = 'uniscenario.render-eight-camera-conformance/v1';
const DIGEST = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const PROGRAM_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../qualification/render-qualification-program.v1.json');
const SECRET_KEY = /(password|secret|token|credential|authorization|cookie|private.?key|database.?url)/i;
const REDACTION_PATTERNS = [
  /postgres(?:ql)?:\/\/[^\s'"@]+:[^\s'"@]+@[^\s'"/]+/gi,
  /(?:password|secret|token|authorization|cookie|credential)\s*[=:]\s*[^\s,;]+/gi,
  /\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/g,
];

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonicalize(value))).digest('hex');
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  assertSecretSafe(value);
  writeFileSync(path, canonicalJson(value), { mode: 0o600 });
}

export function program() {
  const value = readJson(PROGRAM_PATH);
  if (value.schema !== 'uniscenario.render-qualification-program/v1') throw new Error('qualification program schema mismatch');
  if (value.prontoRig?.sensors?.length !== 18) throw new Error('Pronto port-E rig must contain exactly 18 sensors');
  if (value.prontoRig.sensors.filter((sensor) => sensor.type === 'dash_camera').length !== 8
    || value.prontoRig.sensors.filter((sensor) => sensor.type === 'lidar').length !== 6
    || value.prontoRig.sensors.filter((sensor) => sensor.type === 'radar').length !== 4) {
    throw new Error('Pronto port-E rig must contain exactly 8 cameras, 6 lidar, and 4 radar');
  }
  const host = value.qualificationHost;
  if (host?.assetId !== 'vehicle.kia.carnival' || host?.carlaBlueprintId !== 'vehicle.kia.carnival'
    || host?.carlaClassPath !== '/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C'
    || host?.make !== 'Kia' || host?.model !== 'Carnival' || host?.baseType !== 'van'
    || host?.image?.ociIndexDigest !== 'sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5'
    || host?.image?.linuxAmd64ManifestDigest !== 'sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64') {
    throw new Error('qualification host must be the exact evidence-backed Kia Carnival identity');
  }
  return value;
}

function assertSecretSafe(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertSecretSafe(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`refusing to persist credential-shaped field ${path}.${key}`);
    assertSecretSafe(child, `${path}.${key}`);
  }
}

function redact(message) {
  let safe = String(message);
  for (const pattern of REDACTION_PATTERNS) safe = safe.replace(pattern, '[REDACTED]');
  return safe;
}

function databaseProcessEnvironment(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('UNISCENARIO_DEV_DATABASE_URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('dev inventory requires a PostgreSQL URL');
  if (!url.hostname || !url.pathname.slice(1)) throw new Error('dev database URL must name a host and database');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (SECRET_KEY.test(key) || /^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|PASSFILE)$/i.test(key)) delete env[key];
  }
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || '5432';
  env.PGUSER = decodeURIComponent(url.username);
  env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
  env.PGSSLMODE = url.searchParams.get('sslmode') || 'prefer';
  return {
    env,
    publicIdentity: {
      environment: 'dev',
      databaseFingerprint: sha256(`${url.hostname.toLowerCase()}:${env.PGPORT}/${env.PGDATABASE}`),
    },
  };
}

async function runProcess(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== 'string')) throw new Error('command argv must be a non-empty string array');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      options.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      options.onStderr?.(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({
      code,
      signal,
      pid: child.pid,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    options.onSpawn?.(child);
  });
}

const INVENTORY_SQL = String.raw`
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';
SELECT jsonb_build_object(
  'documentId', d.id,
  'title', d.title,
  'revisionId', r.id,
  'revisionNumber', r.revision_number,
  'revisionContentSha256', r.content_sha256,
  'schemaVersion', r.schema_version,
  'canonicalContent', r.canonical_content,
  'capabilityReport', r.capability_report,
  'map', jsonb_build_object(
    'mapVersionId', mv.id,
    'sourceMapId', mv.source_map_id,
    'label', mv.label,
    'locality', mv.locality,
    'xodrSha256', mv.xodr_sha256,
    'retired', mv.retired_at IS NOT NULL,
    'carlaMapName', COALESCE(ma.ue5_carla_map_name, ma.carla_map_name),
    'carlaMapActive', COALESCE(ma.is_active, false),
    'assetCatalogVersionId', mv.asset_catalog_version_id,
    'assetCatalogStatus', acv.status
  ),
  'package', CASE WHEN ep.id IS NULL THEN NULL ELSE jsonb_build_object(
    'executionPackageId', ep.id,
    'manifestSha256', ep.manifest_sha256,
    'xoscSha256', xa.sha256,
    'xoscSizeBytes', xa.byte_length,
    'sourceInputDigest', ep.source_input_digest,
    'runtimeContractVersion', ep.runtime_contract_version,
    'compilerVersion', ep.compiler_version,
    'capabilityProfile', ep.capability_profile,
    'xoscArtifactAvailable', xa.artifact_state = 'available' AND xa.deleted_at IS NULL,
    'packageArtifactAvailable', pa.artifact_state = 'available' AND pa.deleted_at IS NULL,
    'xoscValidationPassed', EXISTS (
      SELECT 1 FROM uniscenario.validation_runs vr
      WHERE vr.workspace_id = r.workspace_id AND vr.revision_id = r.id
        AND vr.validation_state = 'passed'
        AND (vr.validator_kind ILIKE '%xosc%' OR vr.validator_kind ILIKE '%openscenario%' OR vr.validator_kind ILIKE '%xsd%')
    ),
    'assetCatalogMatchesMap', ep.asset_catalog_version_id = mv.asset_catalog_version_id
  ) END
)::text
FROM uniscenario.documents d
JOIN uniscenario.revisions r ON r.id = d.latest_revision_id AND r.workspace_id = d.workspace_id
LEFT JOIN uniscenario.map_versions mv ON mv.id = r.map_version_id
LEFT JOIN public.map_assets ma ON ma.id = mv.source_map_id
LEFT JOIN uniscenario.asset_catalog_versions acv ON acv.id = mv.asset_catalog_version_id
LEFT JOIN LATERAL (
  SELECT candidate.* FROM uniscenario.execution_packages candidate
  WHERE candidate.workspace_id = r.workspace_id AND candidate.revision_id = r.id
  ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
) ep ON true
LEFT JOIN uniscenario.artifacts xa ON xa.id = ep.xosc_artifact_id
LEFT JOIN uniscenario.artifacts pa ON pa.id = ep.package_artifact_id
WHERE d.deleted_at IS NULL
ORDER BY d.id;
COMMIT;
`;

export async function inventoryDev({ output, databaseUrl = process.env.UNISCENARIO_DEV_DATABASE_URL } = {}) {
  if (!databaseUrl) throw new Error('UNISCENARIO_DEV_DATABASE_URL is required; generic DATABASE_URL is deliberately ignored');
  const connection = databaseProcessEnvironment(databaseUrl);
  const result = await runProcess(['psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--quiet', '--command', INVENTORY_SQL], {
    env: connection.env,
  });
  if (result.code !== 0) throw new Error(`read-only inventory failed: ${redact(result.stderr.trim() || `psql exited ${result.code}`)}`);
  const rows = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  const scenarios = rows.map(summarizeInventoryRow).filter((item) => item.authoredRoleCount > 5);
  const inventory = {
    schema: INVENTORY_SCHEMA,
    source: connection.publicIdentity,
    readOnly: true,
    eligibilityPolicy: program().eligibility,
    scenarios,
    inventorySha256: sha256(scenarios),
  };
  if (output) writeJson(output, inventory);
  return inventory;
}

function isGeneratedAmbientRole(role) {
  if (!role || typeof role !== 'object') return true;
  if (role.id === '@world') return true;
  if (role.generated === true || role.authored === false) return true;
  const origin = String(role.origin ?? role.source ?? role.provenance?.source ?? '').toLowerCase();
  if (origin.includes('ambient') || origin.includes('sumo') || origin.includes('generated')) return true;
  const tags = Array.isArray(role.tags) ? role.tags.map((value) => String(value).toLowerCase()) : [];
  return tags.some((tag) => tag === 'ambient' || tag === 'generated-ambient' || tag === 'sumo');
}

function walk(value, visit) {
  if (Array.isArray(value)) return value.forEach((item) => walk(item, visit));
  if (!value || typeof value !== 'object') return;
  visit(value);
  Object.values(value).forEach((child) => walk(child, visit));
}

function summarizeInventoryRow(row) {
  const content = row.canonicalContent ?? {};
  const roles = (Array.isArray(content.roles) ? content.roles : []).filter((role) => !isGeneratedAmbientRole(role));
  const roleIds = new Set(roles.map((role) => role.id));
  const interactions = (Array.isArray(content.choreography?.interactions) ? content.choreography.interactions : [])
    .filter((interaction) => interaction.actor === '@world' || interaction.actor == null || roleIds.has(interaction.actor));
  const actorClasses = [...new Set(roles.map((role) => role.actor?.class).filter(Boolean))].sort();
  const interactionKinds = [...new Set(interactions.flatMap((item) => [item.verb, item.trigger?.kind, item.until?.kind].filter(Boolean)))].sort();
  const signalKinds = new Set();
  for (const control of Array.isArray(content.trafficControls) ? content.trafficControls : []) signalKinds.add(`portable:${control.kind ?? control.type ?? 'control'}`);
  for (const plan of Array.isArray(content.mapSignalPlans) ? content.mapSignalPlans : []) {
    signalKinds.add(`map-plan:${plan.mode ?? 'authored'}`);
    for (const clip of Array.isArray(plan.clips) ? plan.clips : []) signalKinds.add(`indication:${clip.indication ?? 'unknown'}`);
  }
  for (const item of interactions) {
    if (item.verb === 'set' && typeof item.target?.key === 'string' && /(?:control:|signal|indication)/i.test(item.target.key)) signalKinds.add(`interaction:${item.target.key}`);
  }
  const lifecycle = new Set();
  if (roles.length > 0) lifecycle.add('initial-presence');
  for (const item of interactions) {
    if (item.verb === 'exist') lifecycle.add(String(item.target?.mode ?? item.target?.value ?? 'exist-change'));
  }
  let collisionCondition = false;
  walk({ interactions, invariants: content.invariants ?? [] }, (node) => {
    if (node.kind === 'collision') collisionCondition = true;
  });
  const collisionAvoidanceDisabled = interactions.some((item) => item.verb === 'set' && item.target?.key === 'rules.collisionAvoidance' && item.target?.value === false);
  const collisionCoverage = [
    ...(collisionCondition ? ['collision-condition'] : []),
    ...(collisionAvoidanceDisabled ? ['collision-avoidance-disabled'] : []),
  ];
  const packageStatus = row.package ?? null;
  const validXoscPackage = Boolean(packageStatus?.xoscArtifactAvailable && packageStatus?.packageArtifactAvailable
    && packageStatus?.xoscValidationPassed && packageStatus?.assetCatalogMatchesMap
    && packageStatus?.capabilityProfile === 'xml-1.4-trajectory-replay'
    && DIGEST.test(packageStatus?.manifestSha256 ?? '') && DIGEST.test(packageStatus?.xoscSha256 ?? '')
    && Number(packageStatus?.xoscSizeBytes) > 0);
  const carlaAssetClasses = new Set(['car', 'truck', 'bus', 'van', 'motorcycle', 'bicycle', 'pedestrian', 'static_object']);
  const unsupportedCarlaActorClasses = actorClasses.filter((actorClass) => !carlaAssetClasses.has(actorClass));
  const prontoCars = roles.filter((role) => role.actor?.class === 'car').map((role) => role.id).sort();
  const carlaMapEligible = Boolean(row.map && !row.map.retired && row.map.carlaMapActive && row.map.carlaMapName);
  const carlaAssetEligible = Boolean(packageStatus?.assetCatalogMatchesMap && row.map?.assetCatalogVersionId
    && ['active', 'available', 'published'].includes(String(row.map?.assetCatalogStatus ?? '').toLowerCase())
    && unsupportedCarlaActorClasses.length === 0);
  const hardGateFailures = [
    ...(roles.length > 5 ? [] : ['authored-role-count']),
    ...(validXoscPackage ? [] : ['valid-openscenario-1.4-package']),
    ...(prontoCars.length > 0 ? [] : ['pronto-capable-car']),
    ...(carlaMapEligible ? [] : ['carla-cooked-map']),
    ...(carlaAssetEligible ? [] : ['carla-asset-catalog']),
  ];
  const durationSeconds = Number(content.choreography?.clipSeconds ?? content.durationSeconds ?? content.simulation?.durationSeconds ?? 0);
  return {
    documentId: row.documentId,
    title: row.title,
    revision: {
      id: row.revisionId,
      number: Number(row.revisionNumber),
      contentSha256: row.revisionContentSha256,
      schemaVersion: row.schemaVersion,
    },
    package: packageStatus ? {
      id: packageStatus.executionPackageId,
      manifestSha256: packageStatus.manifestSha256,
      sourceInputDigest: packageStatus.sourceInputDigest ?? null,
      openScenarioSha256: packageStatus.xoscSha256,
      openScenarioSizeBytes: Number(packageStatus.xoscSizeBytes),
      runtimeContractVersion: packageStatus.runtimeContractVersion,
      compilerVersion: packageStatus.compilerVersion,
      capabilityProfile: packageStatus.capabilityProfile,
      validOpenScenario14: validXoscPackage,
      validationStatus: {
        xoscArtifactAvailable: Boolean(packageStatus.xoscArtifactAvailable),
        packageArtifactAvailable: Boolean(packageStatus.packageArtifactAvailable),
        xsdPassed: Boolean(packageStatus.xoscValidationPassed),
        assetCatalogMatchesMap: Boolean(packageStatus.assetCatalogMatchesMap),
      },
    } : null,
    map: row.map,
    authoredEnvironment: canonicalize({
      weather: content.environment?.weather ?? 'cloudy',
      timeOfDay: content.environment?.timeOfDay ?? 'dusk',
      ...(content.environment?.frictionScale === undefined ? {} : { frictionScale: content.environment.frictionScale }),
      ...(content.environment?.sunAzimuthDeg === undefined ? {} : { sunAzimuthDeg: content.environment.sunAzimuthDeg }),
      ...(content.environment?.sunElevationDeg === undefined ? {} : { sunElevationDeg: content.environment.sunElevationDeg }),
      surfacePatches: Array.isArray(content.environment?.surfacePatches) ? content.environment.surfacePatches : [],
    }),
    durationSeconds,
    authoredRoleCount: roles.length,
    authoredRoleIds: roles.map((role) => role.id).sort(),
    actorClasses,
    interactionKinds,
    interactionCount: interactions.length,
    signalCoverage: [...signalKinds].sort(),
    lifecycleCoverage: [...lifecycle].sort(),
    collisionCoverage,
    prontoCapableCars: prontoCars,
    carlaEligibility: { map: carlaMapEligible, assets: carlaAssetEligible, unsupportedActorClasses: unsupportedCarlaActorClasses },
    eligible: hardGateFailures.length === 0,
    hardGateFailures,
  };
}

function coverageTokens(scenario) {
  return new Set([
    `map:${scenario.map?.mapVersionId ?? 'none'}`,
    `duration-band:${scenario.durationSeconds < 20 ? 'short' : scenario.durationSeconds < 60 ? 'medium' : 'long'}`,
    ...scenario.actorClasses.map((value) => `actor:${value}`),
    ...scenario.interactionKinds.map((value) => `interaction:${value}`),
    ...scenario.signalCoverage.map((value) => `signal:${value}`),
    ...scenario.lifecycleCoverage.map((value) => `lifecycle:${value}`),
    ...scenario.collisionCoverage.map((value) => `collision:${value}`),
  ]);
}

export function selectQualification(inventory, { output, count = program().selectionCount } = {}) {
  if (inventory.schema !== INVENTORY_SCHEMA) throw new Error(`expected ${INVENTORY_SCHEMA}`);
  if (!Number.isInteger(count) || count < 1) throw new Error('selection count must be a positive integer');
  const candidates = inventory.scenarios.filter((item) => item.eligible).sort((a, b) => a.documentId.localeCompare(b.documentId));
  if (candidates.length < count) throw new Error(`only ${candidates.length} real eligible dev scenarios are available; ${count} required`);
  const selected = [];
  const covered = new Set();
  const p = program();
  const remaining = new Map(candidates.map((candidate) => [candidate.documentId, candidate]));
  while (selected.length < count) {
    const ranked = [...remaining.values()].map((candidate) => {
      const tokens = coverageTokens(candidate);
      const newlyCovered = [...tokens].filter((token) => !covered.has(token)).sort();
      return { candidate, tokens, newlyCovered };
    }).sort((a, b) => b.newlyCovered.length - a.newlyCovered.length
      || b.tokens.size - a.tokens.size
      || a.candidate.documentId.localeCompare(b.candidate.documentId));
    const winner = ranked[0];
    selected.push({
      rank: selected.length + 1,
      ...winner.candidate,
      qualificationHost: {
        actorId: winner.candidate.prontoCapableCars[0],
        asset: p.qualificationHost,
        replacementPolicy: 'replace-selected-host-only; preserve-all-other-authored-actors',
      },
      selectionEvidence: {
        marginalCoverageCount: winner.newlyCovered.length,
        marginalCoverage: winner.newlyCovered,
      },
    });
    winner.tokens.forEach((token) => covered.add(token));
    remaining.delete(winner.candidate.documentId);
  }
  const manifestBase = {
    schema: MANIFEST_SCHEMA,
    sourceInventorySha256: inventory.inventorySha256,
    selectionAlgorithm: 'deterministic-greedy-max-new-coverage/v1; tie=total-coverage-then-document-id',
    selectionCount: count,
    coverage: [...covered].sort(),
    qualificationHost: p.qualificationHost,
    scenarios: selected,
  };
  const manifest = { ...manifestBase, manifestSha256: sha256(manifestBase) };
  if (output) writeJson(output, manifest);
  return manifest;
}

function degToRad(value) {
  return value * Math.PI / 180;
}

function canonicalRig(programValue) {
  const sensors = programValue.prontoRig.sensors.map((sensor) => {
    const mount = {
      position: {
        x: sensor.sourceMountMm.longitudinal / 1000,
        y: sensor.sourceMountMm.up / 1000,
        z: -sensor.sourceMountMm.lateralRight / 1000,
      },
      rotation: {
        yawRad: degToRad(sensor.rotationDeg.yaw),
        pitchRad: degToRad(sensor.rotationDeg.pitch),
        rollRad: degToRad(sensor.rotationDeg.roll),
      },
    };
    if (sensor.type === 'dash_camera') {
      const verticalFovDeg = 2 * Math.atan(Math.tan(degToRad(sensor.horizontalFovDeg) / 2) / (16 / 9)) * 180 / Math.PI;
      return { id: sensor.id, type: sensor.type, label: sensor.label, enabled: true, mount, camera: {
        horizontalFovDeg: sensor.horizontalFovDeg, verticalFovDeg, nearM: 0.05, farM: 1000, aspectRatio: 16 / 9,
      } };
    }
    return { id: sensor.id, type: sensor.type, label: sensor.label, enabled: true, mount, field: {
      horizontalFovDeg: sensor.horizontalFovDeg, verticalFovDeg: sensor.verticalFovDeg, nearM: 0.5, farM: sensor.type === 'lidar' ? 200 : 100,
    } };
  });
  const base = { id: programValue.prontoRig.id, name: programValue.prontoRig.name, compatibleActorClasses: ['car'], sensors };
  return { ...base, rigSha256: sha256(base) };
}

function renderSources(actorId, sensors, video) {
  return sensors.map((sensor) => {
    const common = {
      actorId,
      sensorId: sensor.id,
      outputName: sensor.id,
      transform: sensor.mount,
    };
    if (sensor.type === 'dash_camera') {
      return {
        ...common,
        modality: 'rgb',
        attributes: {
          width: video.width,
          height: video.height,
          fps: video.fps,
          horizontalFovDeg: sensor.camera.horizontalFovDeg,
          nearM: sensor.camera.nearM,
          farM: sensor.camera.farM,
        },
      };
    }
    if (sensor.type === 'lidar') {
      return {
        ...common,
        modality: 'lidar',
        attributes: {
          channels: 128,
          rangeM: sensor.field.farM,
          pointsPerSecond: 1_300_000,
          rotationFrequencyHz: 10,
          upperFovDeg: sensor.field.verticalFovDeg / 2,
          lowerFovDeg: -sensor.field.verticalFovDeg / 2,
        },
      };
    }
    return {
      ...common,
      modality: 'radar',
      attributes: {
        horizontalFovDeg: sensor.field.horizontalFovDeg,
        verticalFovDeg: sensor.field.verticalFovDeg,
        rangeM: sensor.field.farM,
        pointsPerSecond: 1_500,
      },
    };
  });
}

function makeIntentSensorHost(actorId, host) {
  return {
    actorId,
    vehicleAsset: {
      catalogAssetId: host.assetId,
      carlaBlueprintId: host.carlaBlueprintId,
      carlaClassPath: host.carlaClassPath,
      make: host.make,
      model: host.model,
      baseType: host.baseType,
      sourceImage: {
        repository: host.image.reference,
        indexSha256: host.image.ociIndexDigest.replace(/^sha256:/, ''),
        linuxAmd64ManifestSha256: host.image.linuxAmd64ManifestDigest.replace(/^sha256:/, ''),
      },
    },
    sensorRig: {
      rigId: 'pronto.8-camera-6-lidar-4-radar',
      cameras: 8,
      lidars: 6,
      radars: 4,
    },
  };
}

export function prepareQualificationRequests(manifest, { output } = {}) {
  if (manifest.schema !== MANIFEST_SCHEMA || !DIGEST.test(manifest.manifestSha256 ?? '')) throw new Error(`expected hashed ${MANIFEST_SCHEMA}`);
  if (manifest.scenarios.length !== 5) throw new Error('Pronto qualification requires exactly five selected scenarios');
  const p = program();
  if (JSON.stringify(canonicalize(manifest.qualificationHost)) !== JSON.stringify(canonicalize(p.qualificationHost))) {
    throw new Error('qualification manifest does not carry the exact Kia Carnival identity');
  }
  const rig = canonicalRig(p);
  const pairs = manifest.scenarios.map((scenario) => {
    const actorId = scenario.qualificationHost?.actorId;
    if (!actorId || actorId !== scenario.prontoCapableCars[0]) throw new Error(`scenario ${scenario.documentId} has no deterministic selected Pronto host`);
    if (JSON.stringify(canonicalize(scenario.qualificationHost.asset)) !== JSON.stringify(canonicalize(p.qualificationHost))) {
      throw new Error(`scenario ${scenario.documentId} does not assert the exact Kia Carnival qualification host`);
    }
    const pairId = `qualification-${String(scenario.rank).padStart(2, '0')}-${scenario.documentId}`;
    const lineage = {
      sourceDocumentId: scenario.documentId,
      sourceRevisionId: scenario.revision.id,
      sourceRevisionContentSha256: scenario.revision.contentSha256,
      sourceExecutionPackageId: scenario.package.id,
      sourceExecutionPackageManifestSha256: scenario.package.manifestSha256,
      derivationKind: 'qualification_copy',
    };
    const video = { width: p.render.width, height: p.render.height, fps: p.render.fps, container: 'mp4', codec: 'h264', quality: 'high' };
    const intent = {
      schema: p.render.intentSchema,
      intentId: pairId,
      scenarioRevision: {
        revisionId: scenario.revision.id,
        scenarioSha256: scenario.revision.contentSha256,
        openScenario: {
          sha256: scenario.package.openScenarioSha256,
          sizeBytes: scenario.package.openScenarioSizeBytes,
        },
        map: {
          mapId: scenario.map.sourceMapId ?? scenario.map.mapVersionId,
          revisionId: scenario.map.mapVersionId,
          sha256: scenario.map.xodrSha256,
        },
      },
      sensorHost: makeIntentSensorHost(actorId, p.qualificationHost),
      renderSpec: {
        schema: 'uniscenario.render-spec/v3',
        sources: renderSources(actorId, rig.sensors, video),
        clip: { startSeconds: 0, endSeconds: scenario.durationSeconds },
        video,
        artifacts: ['video', 'manifest', 'frames', 'sensorArchive', 'trace'],
        capabilityIntent: {
          required: ['capture.multi_sensor', 'capture.rgb', 'capture.lidar', 'capture.radar', 'artifact.frame_closure'],
          preferred: [],
          fidelity: 'dataset',
        },
        authoredEnvironment: scenario.authoredEnvironment,
      },
      assets: [],
      seed: Number.parseInt(scenario.revision.contentSha256.slice(0, 8), 16),
    };
    const intentSha256 = sha256(intent);
    const derivedCopyRequest = {
      schema: 'uniscenario.qualification-derived-copy-request/v1',
      lineage,
      titleSuffix: ' — render qualification',
      expectedSourceContentSha256: scenario.revision.contentSha256,
      patch: {
        operation: 'replace-selected-host-asset-and-sensors',
        actorId,
        expectedSourceActorClass: 'car',
        vehicleAsset: {
          catalogAssetId: p.qualificationHost.assetId,
          carlaBlueprintId: p.qualificationHost.carlaBlueprintId,
          carlaClassPath: p.qualificationHost.carlaClassPath,
          sourceImage: p.qualificationHost.image,
        },
        sensors: rig.sensors,
        preserveEveryOtherActor: true,
      },
      sourceMutationAllowed: false,
    };
    const job = (backend) => ({
      schema: 'uniscenario.qualification-render-request/v1',
      backend,
      ...(backend === 'carla' ? { executionMode: 'native-controls-no-teleport-repair' } : {}),
      workerControlSchema: p.render.workerControlSchema,
      lineage,
      intent,
      intentSha256,
      executionPackageId: scenario.package.id,
      submissionMode: 'deferred-submit-only',
    });
    return {
      pairId,
      lineage,
      derivedCopyRequest,
      browser: job('browser'),
      carla: job('carla'),
    };
  });
  const requestSetBase = {
    schema: REQUEST_SET_SCHEMA,
    qualificationManifestSha256: manifest.manifestSha256,
    rig,
    jobCount: pairs.length * 2,
    liveSubmissionPerformed: false,
    pairs,
  };
  const requestSet = { ...requestSetBase, requestSetSha256: sha256(requestSetBase) };
  if (output) writeJson(output, requestSet);
  return requestSet;
}

export function materializeRunBundle(requestSet, outputDirectory) {
  if (requestSet.schema !== REQUEST_SET_SCHEMA || !DIGEST.test(requestSet.requestSetSha256 ?? '')) throw new Error(`expected hashed ${REQUEST_SET_SCHEMA}`);
  const root = resolve(outputDirectory);
  const intentDirectory = resolve(root, 'intents');
  const copyDirectory = resolve(root, 'derived-copy-requests');
  mkdirSync(intentDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(copyDirectory, { recursive: true, mode: 0o700 });
  const jobs = [];
  for (const pair of requestSet.pairs) {
    const safePairId = String(pair.pairId).replace(/[^A-Za-z0-9_.-]/g, '_');
    const intentPath = resolve(intentDirectory, `${safePairId}.json`);
    writeJson(intentPath, pair.browser.intent);
    writeJson(resolve(copyDirectory, `${safePairId}.json`), pair.derivedCopyRequest);
    for (const engine of ['browser', 'carla']) {
      const outputPath = resolve(root, 'results', safePairId, engine);
      jobs.push({
        pairId: pair.pairId,
        engine,
        intentSha256: pair.browser.intentSha256,
        argv: ['simforge', 'render', 'run', intentPath, '--engine', engine, '--out', outputPath],
        resultManifestPath: resolve(outputPath, 'render-artifact-manifest.json'),
      });
    }
  }
  const planBase = {
    schema: 'uniscenario.render-qualification-local-run-plan/v1',
    requestSetSha256: requestSet.requestSetSha256,
    liveSubmissionPerformed: false,
    executionPolicy: { order: 'manifest-order', gpuConcurrency: 1, requiredGpuLock: '/tmp/scenario-rtx5080-render.lock' },
    jobs,
  };
  const plan = { ...planBase, planSha256: sha256(planBase) };
  writeJson(resolve(root, 'local-run-plan.json'), plan);
  writeJson(resolve(root, 'request-set.json'), requestSet);
  return plan;
}

export function createBenchmarkSpec(requestSet, { pairId, engine, imageDigest, sourceRevision, outputDirectory, output }) {
  if (requestSet.schema !== REQUEST_SET_SCHEMA) throw new Error(`expected ${REQUEST_SET_SCHEMA}`);
  if (!['browser', 'carla'].includes(engine)) throw new Error('benchmark engine must be browser or carla');
  if (!IMAGE_DIGEST.test(imageDigest ?? '')) throw new Error('image digest must be a lowercase sha256 digest');
  const pair = requestSet.pairs.find((candidate) => candidate.pairId === pairId);
  if (!pair) throw new Error(`pair ${pairId} does not exist in request set`);
  const root = resolve(outputDirectory);
  mkdirSync(resolve(root, 'intents'), { recursive: true, mode: 0o700 });
  const intentPath = resolve(root, 'intents', `${pairId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  writeJson(intentPath, pair[engine].intent);
  const resultDirectory = resolve(root, 'benchmark-results', pairId.replace(/[^A-Za-z0-9_.-]/g, '_'), engine);
  const spec = {
    schema: 'uniscenario.local-render-benchmark/v1',
    id: `${pairId}-${engine}`,
    sourceRevision,
    imageDigest,
    command: ['simforge', 'render', 'run', intentPath, '--engine', engine, '--out', resultDirectory],
    outputDirectory: resultDirectory,
    scratchDirectory: resolve(root, 'scratch'),
    lockPath: '/tmp/scenario-rtx5080-render.lock',
    warmRuns: 3,
    sampleIntervalMs: 500,
  };
  if (output) writeJson(output, spec);
  return spec;
}


export function acquireGpuLock(path = '/tmp/scenario-rtx5080-render.lock') {
  const owner = { schema: 'uniscenario.local-gpu-lock/v1', pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString(), gpuClass: 'RTX 5080' };
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, canonicalJson(owner));
    closeSync(fd);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existing;
    try { existing = readJson(path); } catch { throw new Error(`GPU lock ${path} exists and is unreadable; refusing to contend`); }
    throw new Error(`RTX 5080 is exclusively locked by pid ${existing.pid ?? 'unknown'} on ${existing.hostname ?? 'unknown'}; stale locks require explicit operator removal`);
  }
  let released = false;
  return () => {
    if (released) return;
    const current = readJson(path);
    if (current.pid !== owner.pid || current.hostname !== owner.hostname || current.acquiredAt !== owner.acquiredAt) throw new Error('GPU lock ownership changed; refusing to remove it');
    rmSync(path);
    released = true;
  };
}

function directoryBytes(path) {
  if (!path || !existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  const entries = readdirSync(path);
  return entries.reduce((total, entry) => total + directoryBytes(resolve(path, entry)), 0);
}


function procSample(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(/\s+/);
    const kb = (name) => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
    return { rssBytes: kb('VmRSS') * 1024, peakRssBytes: kb('VmHWM') * 1024, cpuTicks: Number(stat[13] ?? 0) + Number(stat[14] ?? 0) };
  } catch { return null; }
}

async function gpuSample() {
  const result = await runProcess(['nvidia-smi', '--query-gpu=uuid,name,driver_version,memory.used,memory.total,utilization.gpu,power.draw', '--format=csv,noheader,nounits']);
  if (result.code !== 0) return null;
  const [uuid, name, driverVersion, memoryUsedMiB, memoryTotalMiB, utilizationPercent, powerW] = result.stdout.trim().split(',').map((item) => item.trim());
  return { uuid, name, driverVersion, memoryUsedMiB: Number(memoryUsedMiB), memoryTotalMiB: Number(memoryTotalMiB), utilizationPercent: Number(utilizationPercent), powerW: Number(powerW) };
}

function parseProgress(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (typeof value.schema === 'string' && /^scenario\.render(?:-worker)?-progress(?:-jsonl)?\/v\d+$/.test(value.schema)) events.push(value);
    } catch {}
  }
  return events;
}

function stageTimings(events) {
  const starts = new Map();
  const timings = {};
  for (const event of events) {
    const stage = event.stage ?? event.name;
    if (!stage) continue;
    const time = Number(event.monotonicMs ?? event.elapsedMs ?? 0);
    if (event.state === 'started' || event.type === 'stage-start') starts.set(stage, time);
    if (event.state === 'completed' || event.type === 'stage-complete') {
      const duration = Number(event.durationMs ?? (starts.has(stage) ? time - starts.get(stage) : NaN));
      if (Number.isFinite(duration) && duration >= 0) timings[stage] = duration;
    }
  }
  return timings;
}

async function runBenchmarkIteration(spec, index, kind) {
  const scratchBefore = directoryBytes(spec.scratchDirectory);
  const outputBefore = directoryBytes(spec.outputDirectory);
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const gpuSamples = [];
  const procSamples = [];
  let child;
  const sampler = setInterval(async () => {
    if (!child?.pid) return;
    const proc = procSample(child.pid);
    if (proc) procSamples.push(proc);
    const gpu = await gpuSample();
    if (gpu) gpuSamples.push(gpu);
  }, Math.max(250, Number(spec.sampleIntervalMs ?? 1000)));
  const result = await runProcess(spec.command, {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.environment ?? {}), UNISCENARIO_BENCHMARK_RUN: kind, UNISCENARIO_BENCHMARK_ITERATION: String(index) },
    onSpawn(value) { child = value; },
    onStdout(chunk) { if (spec.echoOutput !== false) process.stdout.write(chunk); },
    onStderr(chunk) { if (spec.echoOutput !== false) process.stderr.write(chunk); },
  });
  clearInterval(sampler);
  const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  const events = parseProgress(`${result.stdout}\n${result.stderr}`);
  return {
    index,
    kind,
    startedAt,
    elapsedMs,
    exitCode: result.code,
    signal: result.signal,
    stageTimingsMs: stageTimings(events),
    scenePasses: events.filter((event) => event.type === 'scene-pass' || event.scenePass != null).length,
    progressEventCount: events.length,
    resources: {
      gpuUtilizationPeakPercent: Math.max(0, ...gpuSamples.map((item) => item.utilizationPercent)),
      gpuMemoryPeakMiB: Math.max(0, ...gpuSamples.map((item) => item.memoryUsedMiB)),
      gpuPowerPeakW: Math.max(0, ...gpuSamples.map((item) => item.powerW)),
      cpuTicks: procSamples.length ? procSamples.at(-1).cpuTicks - procSamples[0].cpuTicks : 0,
      processRssPeakBytes: Math.max(0, ...procSamples.map((item) => item.peakRssBytes || item.rssBytes)),
      systemRamBytes: totalmem(),
      scratchDeltaBytes: directoryBytes(spec.scratchDirectory) - scratchBefore,
      outputDeltaBytes: directoryBytes(spec.outputDirectory) - outputBefore,
      outputTotalBytes: directoryBytes(spec.outputDirectory),
    },
    stderrSha256: sha256(result.stderr),
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function benchmark5080(spec, { output } = {}) {
  if (spec.schema !== 'uniscenario.local-render-benchmark/v1') throw new Error('benchmark spec schema mismatch');
  if (!Array.isArray(spec.command) || spec.command.length === 0) throw new Error('benchmark command is required');
  if (!IMAGE_DIGEST.test(spec.imageDigest ?? '')) throw new Error('benchmark imageDigest must be a sha256 digest');
  if (!spec.sourceRevision) throw new Error('benchmark sourceRevision is required');
  const warmRuns = Number(spec.warmRuns ?? 3);
  if (!Number.isInteger(warmRuns) || warmRuns < 1) throw new Error('warmRuns must be a positive integer');
  const release = acquireGpuLock(spec.lockPath);
  try {
    const gpuIdentity = await gpuSample();
    if (!gpuIdentity || !/RTX\s*5080/i.test(gpuIdentity.name)) throw new Error(`benchmark requires the local RTX 5080, found ${gpuIdentity?.name ?? 'no NVIDIA GPU'}`);
    const runs = [];
    runs.push(await runBenchmarkIteration(spec, 0, 'cold'));
    for (let index = 1; index <= warmRuns; index += 1) runs.push(await runBenchmarkIteration(spec, index, 'warm'));
    const failed = runs.filter((run) => run.exitCode !== 0);
    const warm = runs.filter((run) => run.kind === 'warm' && run.exitCode === 0);
    const reportBase = {
      schema: BENCHMARK_SCHEMA,
      benchmarkId: spec.id,
      sourceRevision: spec.sourceRevision,
      imageDigest: spec.imageDigest,
      driverIdentity: { gpuUuid: gpuIdentity.uuid, gpuName: gpuIdentity.name, driverVersion: gpuIdentity.driverVersion },
      commandSha256: sha256(spec.command),
      exclusiveGpuLock: spec.lockPath ?? '/tmp/scenario-rtx5080-render.lock',
      timingDefinitions: {
        cold: 'first fresh worker process before any runner-managed warm iteration',
        warm: 'subsequent fresh worker process with engine/image/host caches retained',
        stageSource: 'typed JSONL render progress emitted by the engine',
      },
      runs,
      medianWarm: {
        elapsedMs: median(warm.map((run) => run.elapsedMs)),
        gpuMemoryPeakMiB: median(warm.map((run) => run.resources.gpuMemoryPeakMiB)),
        cpuTicks: median(warm.map((run) => run.resources.cpuTicks)),
        processRssPeakBytes: median(warm.map((run) => run.resources.processRssPeakBytes)),
        scratchDeltaBytes: median(warm.map((run) => run.resources.scratchDeltaBytes)),
        outputDeltaBytes: median(warm.map((run) => run.resources.outputDeltaBytes)),
        stageTimingsMs: Object.fromEntries([...new Set(warm.flatMap((run) => Object.keys(run.stageTimingsMs)))].sort().map((stage) => [stage, median(warm.map((run) => run.stageTimingsMs[stage]))])),
      },
      passed: failed.length === 0,
    };
    const report = { ...reportBase, reportSha256: sha256(reportBase) };
    if (output) writeJson(output, report);
    if (failed.length) throw new Error(`benchmark command failed in ${failed.map((run) => run.kind === 'cold' ? 'cold' : `warm-${run.index}`).join(', ')}`);
    return report;
  } finally {
    release();
  }
}

function getPath(value, alternatives) {
  for (const path of alternatives) {
    let current = value;
    for (const key of path.split('.')) current = current?.[key];
    if (current !== undefined) return current;
  }
  return undefined;
}

function equalityCheck(name, left, right) {
  const passed = left !== undefined && right !== undefined && JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
  return { name, passed, browserSha256: left === undefined ? null : sha256(left), carlaSha256: right === undefined ? null : sha256(right) };
}

function expectationCheck(name, expected, browserValue, carlaValue) {
  const expectedJson = JSON.stringify(canonicalize(expected));
  const browserPassed = browserValue !== undefined && JSON.stringify(canonicalize(browserValue)) === expectedJson;
  const carlaPassed = carlaValue !== undefined && JSON.stringify(canonicalize(carlaValue)) === expectedJson;
  return {
    name,
    passed: browserPassed && carlaPassed,
    expectedSha256: sha256(expected),
    browserSha256: browserValue === undefined ? null : sha256(browserValue),
    carlaSha256: carlaValue === undefined ? null : sha256(carlaValue),
  };
}

function artifactClosure(result, expectedSources, expectedFrames) {
  const artifacts = getPath(result, ['artifacts', 'manifest.artifacts']) ?? [];
  const errors = [];
  const seen = new Set();
  for (const artifact of artifacts) {
    const identity = artifact.identity ?? artifact;
    const key = `${identity.role ?? ''}\0${identity.actorId ?? ''}\0${identity.sensorId ?? ''}\0${identity.modality ?? ''}`;
    if (seen.has(key)) errors.push(`duplicate-artifact:${key}`);
    seen.add(key);
    if (!DIGEST.test(artifact.sha256 ?? artifact.checksumSha256 ?? '')) errors.push(`invalid-checksum:${key}`);
    const frames = Number(artifact.frameCount ?? artifact.metadata?.frameCount);
    if (Number.isFinite(expectedFrames) && frames !== expectedFrames) errors.push(`frame-count:${key}:${frames}`);
  }
  for (const source of expectedSources) {
    const key = `${source.role}\0${source.actorId}\0${source.sensorId}\0${source.modality}`;
    if (!seen.has(key)) errors.push(`missing-artifact:${key}`);
  }
  return { passed: errors.length === 0, artifactCount: artifacts.length, errors };
}

function mediaCheck(result, expected) {
  const media = getPath(result, ['media', 'playableMedia', 'manifest.media']);
  const errors = [];
  if (!media || typeof media !== 'object') return { passed: false, errors: ['missing-playable-media-metadata'] };
  if (!media.container || !media.codec) errors.push('missing-container-or-codec');
  if (Number(media.width) !== expected.width || Number(media.height) !== expected.height) errors.push('resolution');
  if (Number(media.fps) !== expected.fps) errors.push('fps');
  const tolerance = 1 / expected.fps;
  if (!Number.isFinite(Number(media.durationSeconds)) || Math.abs(Number(media.durationSeconds) - expected.durationSeconds) > tolerance) errors.push('duration');
  return { passed: errors.length === 0, errors, metadata: media };
}

function projectSensorHostEvidence(value) {
  if (!value || typeof value !== 'object') return undefined;
  const vehicle = value.vehicleAsset ?? value;
  const sourceImage = vehicle.sourceImage ?? value.sourceImage;
  const rig = value.sensorRig ?? value.rig;
  return {
    actorId: value.actorId,
    vehicleAsset: {
      catalogAssetId: vehicle.catalogAssetId,
      carlaBlueprintId: vehicle.carlaBlueprintId,
      carlaClassPath: vehicle.carlaClassPath,
      make: vehicle.make,
      model: vehicle.model,
      baseType: vehicle.baseType,
      sourceImage: {
        repository: sourceImage?.repository,
        indexSha256: sourceImage?.indexSha256,
        linuxAmd64ManifestSha256: sourceImage?.linuxAmd64ManifestSha256,
      },
    },
    sensorRig: {
      rigId: rig?.rigId,
      cameras: rig?.cameras,
      lidars: rig?.lidars,
      radars: rig?.radars,
    },
  };
}


function carlaKiaEvidenceCheck(result, expected) {
  const readback = getPath(result, ['carlaEvidence.sensorHostReadback']);
  const runtimeImage = getPath(result, ['carlaEvidence.runtimeImage']);
  const vehicle = expected.vehicleAsset;
  const image = vehicle.sourceImage ?? expected.sourceImage;
  const errors = [];
  if (!readback || readback.actorId !== expected.actorId
    || readback.catalogId !== vehicle.catalogAssetId
    || readback.requiredCatalogId !== vehicle.catalogAssetId
    || readback.requestedBlueprintId !== vehicle.carlaBlueprintId
    || readback.observedBlueprintId !== vehicle.carlaBlueprintId
    || readback.requiredBlueprintId !== vehicle.carlaBlueprintId
    || readback.classPath !== vehicle.carlaClassPath
    || readback.make !== vehicle.make || readback.model !== vehicle.model || readback.baseType !== vehicle.baseType
    || readback.verification !== 'catalog-binding-and-runtime-type-id-readback') {
    errors.push('kia-carnival-catalog-blueprint-runtime-readback');
  }
  if (!runtimeImage || runtimeImage.repository !== image.repository
    || runtimeImage.indexSha256 !== image.indexSha256
    || runtimeImage.linuxAmd64ManifestSha256 !== image.linuxAmd64ManifestSha256
    || runtimeImage.configuredManifestSha256 !== image.linuxAmd64ManifestSha256
    || runtimeImage.configuredBlueprintId !== vehicle.carlaBlueprintId
    || runtimeImage.configuredClassPath !== vehicle.carlaClassPath
    || runtimeImage.managed !== true || runtimeImage.exact !== true) {
    errors.push('kia-carnival-managed-image-runtime-readback');
  }
  return { passed: errors.length === 0, errors, sensorHostReadback: readback ?? null, runtimeImage: runtimeImage ?? null };
}

export function comparePair(requestPair, browser, carla, { output } = {}) {
  if (requestPair.browser?.intentSha256 !== requestPair.carla?.intentSha256 || !DIGEST.test(requestPair.browser?.intentSha256 ?? '')) throw new Error('paired request does not carry one valid shared intentSha256');
  const intent = requestPair.browser.intent;
  const browserRevision = getPath(browser, ['scenarioRevision.revisionId', 'lineage.sourceRevisionId', 'revisionId']);
  const carlaRevision = getPath(carla, ['scenarioRevision.revisionId', 'lineage.sourceRevisionId', 'revisionId']);
  const browserPackage = getPath(browser, ['lineage.sourceExecutionPackageId', 'executionPackageId']);
  const carlaPackage = getPath(carla, ['lineage.sourceExecutionPackageId', 'executionPackageId']);
  const browserIntent = getPath(browser, ['intentSha256']);
  const carlaIntent = getPath(carla, ['intentSha256']);
  const browserHostEvidence = projectSensorHostEvidence(getPath(browser, ['browserEvidence.sensorHost']));
  const carlaHostEvidence = projectSensorHostEvidence(getPath(carla, ['carlaEvidence.sensorHost']));
  const identities = [
    expectationCheck('revision-identity', intent.scenarioRevision.revisionId, browserRevision, carlaRevision),
    expectationCheck('package-identity', requestPair.lineage.sourceExecutionPackageId, browserPackage, carlaPackage),
    expectationCheck('intent-identity', requestPair.browser.intentSha256, browserIntent, carlaIntent),
    expectationCheck('kia-carnival-sensor-host-evidence', intent.sensorHost, browserHostEvidence, carlaHostEvidence),
    equalityCheck('actors', getPath(browser, ['actors', 'semantic.actors']), getPath(carla, ['actors', 'semantic.actors'])),
    equalityCheck('lifecycle', getPath(browser, ['lifecycle', 'semantic.lifecycle']), getPath(carla, ['lifecycle', 'semantic.lifecycle'])),
    equalityCheck('signals', getPath(browser, ['signals', 'semantic.signals']), getPath(carla, ['signals', 'semantic.signals'])),
    equalityCheck('capture-schedule', getPath(browser, ['schedule', 'capture.schedule']), getPath(carla, ['schedule', 'capture.schedule'])),
    equalityCheck('sensor-calibration', getPath(browser, ['calibration', 'capture.calibration', 'resolvedSources']), getPath(carla, ['calibration', 'capture.calibration', 'resolvedSources'])),
  ];
  const renderSpec = intent.renderSpec;
  const expectedFrames = Math.round((renderSpec.clip.endSeconds - renderSpec.clip.startSeconds) * renderSpec.video.fps);
  const expectedSources = renderSpec.sources.map((source) => ({ role: 'sensor-output', actorId: source.actorId, sensorId: source.sensorId, modality: source.modality }));
  const browserArtifacts = artifactClosure(browser, expectedSources, expectedFrames);
  const carlaArtifacts = artifactClosure(carla, expectedSources, expectedFrames);
  const carlaKiaEvidence = carlaKiaEvidenceCheck(carla, intent.sensorHost);
  const divergence = getPath(carla, ['classifiedDivergence', 'divergence']) ?? [];
  const divergenceErrors = [];
  if (!Array.isArray(divergence)) divergenceErrors.push('classified-divergence-not-an-array');
  else for (const item of divergence) {
    if (!item?.classification || !item?.semantic || !['within-tolerance', 'explained-nonblocking', 'blocking'].includes(item?.severity)) divergenceErrors.push('unclassified-divergence');
    if (/teleport/i.test(`${item?.classification ?? ''} ${item?.repair ?? ''}`)) divergenceErrors.push('runtime-teleport-repair-forbidden');
    if (item?.severity === 'blocking') divergenceErrors.push(`blocking:${item.classification}`);
  }
  const expectedMedia = { ...renderSpec.video, durationSeconds: renderSpec.clip.endSeconds - renderSpec.clip.startSeconds };
  const browserMedia = mediaCheck(browser, expectedMedia);
  const carlaMedia = mediaCheck(carla, expectedMedia);
  const checks = {
    intentionIdentity: identities,
    browserFrameAndChecksumClosure: browserArtifacts,
    carlaFrameAndChecksumClosure: carlaArtifacts,
    carlaKiaRuntimeEvidence: carlaKiaEvidence,
    carlaClassifiedDivergence: { passed: divergenceErrors.length === 0, errors: divergenceErrors, entries: divergence },
    browserPlayableMedia: browserMedia,
    carlaPlayableMedia: carlaMedia,
    pixelEqualityRequired: false,
  };
  const reportBase = {
    schema: COMPARISON_SCHEMA,
    pairId: requestPair.pairId,
    intentSha256: requestPair.browser.intentSha256,
    sensorHost: intent.sensorHost,
    expectedSensorCount: 18,
    expectedFramesPerSensor: expectedFrames,
    checks,
    passed: identities.every((item) => item.passed) && browserArtifacts.passed && carlaArtifacts.passed
      && carlaKiaEvidence.passed && divergenceErrors.length === 0 && browserMedia.passed && carlaMedia.passed,
  };
  const report = { ...reportBase, reportSha256: sha256(reportBase) };
  if (output) writeJson(output, report);
  return report;
}

export function eightCameraMatrix(reports, { output } = {}) {
  if (!Array.isArray(reports) || reports.length !== 5 || reports.some((report) => report.schema !== COMPARISON_SCHEMA)) throw new Error('camera conformance matrix requires exactly five pair comparison reports');
  const cameraIds = program().prontoRig.sensors.filter((sensor) => sensor.type === 'dash_camera').map((sensor) => sensor.id);
  const matrix = cameraIds.map((sensorId) => {
    const pairResults = reports.map((report) => {
      const browserErrors = report.checks.browserFrameAndChecksumClosure.errors.filter((error) => error.includes(`\0${sensorId}\0`));
      const carlaErrors = report.checks.carlaFrameAndChecksumClosure.errors.filter((error) => error.includes(`\0${sensorId}\0`));
      return { pairId: report.pairId,
        kiaCarnivalHost: report.checks.intentionIdentity.find((item) => item.name === 'kia-carnival-sensor-host-evidence')?.passed === true
          && report.checks.carlaKiaRuntimeEvidence?.passed === true,
        schedule: report.checks.intentionIdentity.find((item) => item.name === 'capture-schedule')?.passed === true,
        calibration: report.checks.intentionIdentity.find((item) => item.name === 'sensor-calibration')?.passed === true,
        browserClosure: browserErrors.length === 0, carlaClosure: carlaErrors.length === 0,
        playableMedia: report.checks.browserPlayableMedia.passed && report.checks.carlaPlayableMedia.passed };
    });
    return { sensorId, pairs: pairResults, passed: pairResults.every((value) => Object.entries(value).every(([key, item]) => key === 'pairId' || item === true)) };
  });
  const resultBase = { schema: MATRIX_SCHEMA, scope: 'eight-Pronto-cameras-only; separate-from-five-full-rig-runs', pairCount: 5, matrix, passed: matrix.every((row) => row.passed) };
  const result = { ...resultBase, reportSha256: sha256(resultBase) };
  if (output) writeJson(output, result);
  return result;
}
