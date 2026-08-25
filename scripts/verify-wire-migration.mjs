import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pattern = String.raw`uniscenario\.[[:alnum:]_./-]+|/api/uniscenario|UNISCENARIO_|scene-state\.v1|schemas\.uniscenarios\.dev|application/vnd\.(uniscenarios|simforge\.uniscenario)`;
const output = execFileSync('git', ['grep', '-nE', pattern], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const matches = output.trim().split('\n').filter(Boolean).map((line) => {
  const first = line.indexOf(':');
  const second = line.indexOf(':', first + 1);
  return {
    path: line.slice(0, first),
    line: Number(line.slice(first + 1, second)),
    text: line.slice(second + 1),
  };
});

function isEvidence(path) {
  return path.endsWith('.md')
    || path === 'README.md'
    || path.includes('/tests/')
    || path.includes('/__tests__/')
    || /\.test\.[cm]?[jt]sx?$/.test(path)
    || path.startsWith('fixtures/')
    || path.includes('/fixtures/')
    || path.startsWith('qualification/')
    || path.startsWith('run/evidence/')
    || path.startsWith('scripts/native-evidence/')
    || path === 'scripts/verify-wire-migration.mjs';
}

const failures = [];
for (const match of matches) {
  if (isEvidence(match.path)) continue;
  const location = `${match.path}:${match.line}`;

  if (match.text.includes('/api/uniscenario')
    && match.path !== 'studio/next.config.ts') {
    failures.push(`${location}: legacy HTTP path is outside the deprecated rewrite`);
  }

  if (match.text.includes('UNISCENARIO_')
    && !match.path.endsWith('compat-env.ts')
    && !match.path.endsWith('compat-env.mjs')
    && !match.path.endsWith('_compat_env.py')) {
    failures.push(`${location}: legacy environment name is outside an env compatibility helper`);
  }

  if (/application\/vnd\.(?:uniscenarios|simforge\.uniscenario)/.test(match.text)
    && match.path !== 'studio/app/lib/scenario/stored-wire-compat.ts') {
    failures.push(`${location}: legacy media type is outside stored-wire-compat`);
  }

  for (const identifier of match.text.matchAll(/uniscenario\.([A-Za-z0-9_./-]+)/g)) {
    const suffix = identifier[1];
    const historicalMigration = match.path.startsWith('studio/migrations/');
    const databaseCompat = match.path === 'studio/migrations/20260824190000_simforge_schema_compat.sql';
    const storedIdentifier = suffix.includes('/')
      || suffix.includes('-')
      || /[A-Z]/.test(suffix)
      || /\.v[0-9]+$/.test(suffix)
      || suffix === 'tag'
      || suffix === 'xosc';
    if (!historicalMigration && !databaseCompat && !storedIdentifier) {
      failures.push(`${location}: legacy database identifier ${identifier[0]} is live code`);
    }
  }
}

const requiredCoverage = [
  ['database object move', 'studio/migrations/20260824190000_simforge_schema_compat.sql', 'SET SCHEMA simforge'],
  ['database compatibility views', 'studio/migrations/20260824190000_simforge_schema_compat.sql', 'CREATE VIEW uniscenario.%I AS SELECT * FROM simforge.%I'],
  ['route rewrite', 'studio/next.config.ts', 'destination: "/api/simforge/:path*"'],
  ['Node environment fallback', 'studio/lib/compat-env.ts', 'const legacyName = `UNISCENARIO_${name}`'],
  ['Python environment fallback', 'adapters/carla-exec/simforge_carla_exec/_compat_env.py', 'legacy_name = f"UNISCENARIO_{name}"'],
  ['scene-state dual read', 'packages/engine/src/scene-state/schema.ts', 'LEGACY_SCENE_STATE_VERSION'],
  ['artifact schema dual read', 'packages/scenario/src/render-intent.ts', 'LEGACY_RENDER_INTENT_V1_SCHEMA'],
  ['JSON Schema dual read', 'packages/scenario/src/json-schema.ts', 'LEGACY_JSON_SCHEMA_ID'],
  ['media type dual read', 'studio/app/lib/scenario/stored-wire-compat.ts', 'isAcceptedStoredMediaType'],
];
for (const [label, path, marker] of requiredCoverage) {
  const content = readFileSync(resolve(root, path), 'utf8');
  if (!content.includes(marker)) failures.push(`${path}: missing ${label} marker`);
}

const emissionSwitches = [
  ['packages/engine/src/scene-state/schema.ts', 'EMIT_CANONICAL_SCENE_STATE_VERSION'],
  ['packages/scenario/src/render-intent.ts', 'EMIT_CANONICAL_RENDER_INTENT_SCHEMA'],
  ['packages/scenario/src/render-spec.ts', 'EMIT_CANONICAL_RENDER_SCHEMAS'],
  ['packages/scenario/src/json-schema.ts', 'EMIT_CANONICAL_JSON_SCHEMA_ID'],
  ['packages/scenario/src/json-schema-v2.ts', 'EMIT_CANONICAL_V2_SCHEMA_IDS'],
  ['studio/app/lib/scenario/stored-wire-compat.ts', 'EMIT_CANONICAL_STORED_MEDIA_TYPES'],
];
for (const [path, name] of emissionSwitches) {
  const content = readFileSync(resolve(root, path), 'utf8');
  if (!new RegExp(`export const ${name} = false;`).test(content)) {
    failures.push(`${path}: ${name} must remain false`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`wire migration verified: ${matches.length} legacy inventory lines are historical, tested, documented, or compatibility-owned`);
