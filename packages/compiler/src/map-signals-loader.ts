import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parseMapSignalCatalog, type MapSignalCatalog } from './map-signals.js';

export async function loadMapSignalCatalog(xodrFile: string, signalsFile: string): Promise<MapSignalCatalog> {
  const [xodr, signalBytes] = await Promise.all([readFile(xodrFile, 'utf8'), readFile(signalsFile)]);
  const plain = signalBytes[0] === 0x1f && signalBytes[1] === 0x8b ? gunzipSync(signalBytes) : signalBytes;
  return parseMapSignalCatalog(xodr, JSON.parse(plain.toString('utf8')));
}
