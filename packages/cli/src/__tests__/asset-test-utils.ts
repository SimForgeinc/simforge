import { existsSync } from 'node:fs';
import path from 'node:path';

import { ARTIFACTS, DEV_ASSETS } from '@uniscenarios/scenario-materializer';

const REQUIRED_MAP_ARTIFACTS = [
  ARTIFACTS.topology,
  ARTIFACTS.derived,
  ARTIFACTS.locations,
  'map.xodr',
  'signals.geojson.gz',
] as const;

export function localMapAssetRequirement(mapIds: readonly string[]): {
  available: boolean;
  missingReason: string;
} {
  const missingMapIds = mapIds.filter((mapId) => {
    const mapDir = path.join(DEV_ASSETS, mapId);
    return REQUIRED_MAP_ARTIFACTS.some((artifact) => !existsSync(path.join(mapDir, artifact)));
  });
  return {
    available: missingMapIds.length === 0,
    missingReason: missingMapIds.length === 0
      ? ''
      : ` [requires local gitignored dev-assets map bundle; missing ${missingMapIds.join(', ')}]`,
  };
}
