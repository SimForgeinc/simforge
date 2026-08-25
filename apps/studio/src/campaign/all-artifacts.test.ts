import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TemplateDocument } from '@uniscenarios/scenario-model';
import { readPlaybackFiles } from '@uniscenarios/playback';
import { galleryCameraChoice } from '@uniscenarios/playback';
import { GENERATED_CAMPAIGN_ENTRIES } from './generated';
import { assertCampaignEntryIdentity, editableCampaignTemplate } from './catalog';

const root = path.resolve(process.cwd(), '../..');
const manifests = path.join(root, 'examples/edge-cases/manifests');

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function first(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

async function bytes(file: string): Promise<ArrayBuffer> {
  const data = await readFile(file);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

describe('all checked-in campaign artifacts', () => {
  it('strictly parses every canonical template and exact 20-second evidence pair', async () => {
    const found: number[] = [];
    const failures: string[] = [];
    for (const name of (await readdir(manifests)).filter((item) => item.endsWith('.json')).sort()) {
      const manifestFile = path.join(manifests, name);
      const manifest = record(JSON.parse(await readFile(manifestFile, 'utf8')));
      const entries = manifest.entries ?? manifest.projects ?? manifest.scenarios;
      expect(Array.isArray(entries), `${name} has an entry array`).toBe(true);
      for (const item of entries as unknown[]) {
        const entry = record(item);
        const ordinal = Number(entry.ordinal ?? entry.number);
        found.push(ordinal);
        const templateRel = first(entry.template, entry.sourceTemplate)!;
        const templateFile = path.resolve(path.dirname(manifestFile), templateRel);
        const directory = path.dirname(templateFile);
        const instanceRel = first(entry.instance, entry.sourceInstance, entry.baselineInstance);
        const traceRel = first(entry.trace, entry.sourceTrace, entry.baselineTrace);
        const instanceFile = instanceRel ? path.resolve(path.dirname(manifestFile), instanceRel)
          : path.join(directory, ordinal === 5 || ordinal === 6 ? 'instance.baseline.json' : 'instance.json');
        const traceFile = traceRel ? path.resolve(path.dirname(manifestFile), traceRel)
          : path.join(directory, ordinal === 5 || ordinal === 6 ? 'trace.baseline.json.gz' : 'trace.json.gz');

        try {
          const templateValue: unknown = JSON.parse(await readFile(templateFile, 'utf8'));
          const template = TemplateDocument.fromJSON(templateValue).data;
          const bundle = await readPlaybackFiles(
            { name: path.basename(instanceFile), arrayBuffer: () => bytes(instanceFile) },
            { name: path.basename(traceFile), arrayBuffer: () => bytes(traceFile) },
          );
          if (bundle.startTime !== 0 || bundle.endTime !== 20 || bundle.instance.input.clipSeconds !== 20) {
            failures.push(`scenario ${ordinal}: expected exact 0–20 second evidence`);
          }
          const galleryCamera = galleryCameraChoice(bundle);
          if (galleryCamera.policy !== 'all-actors' || galleryCamera.subjectActorId !== null) {
            failures.push(`scenario ${ordinal}: expected neutral all-actors Gallery replay`);
          }
          const catalogEntry = GENERATED_CAMPAIGN_ENTRIES.find((candidate) => candidate.ordinal === ordinal);
          if (!catalogEntry) throw new Error('generated catalog card is missing');
          assertCampaignEntryIdentity(catalogEntry, template, bundle);
          const editable = editableCampaignTemplate(catalogEntry, template, bundle);
          expect(editable.sourceMap?.mapId).toBe(bundle.instance.input.mapId);
          expect(editable.roles.map((role) => role.id).sort())
            .toEqual(bundle.actors.map((actor) => actor.id).sort());
          expect(editable.roles.every((role) => role.kind === 'scene_absolute')).toBe(true);
          expect(editable.choreography).toEqual(template.choreography);
        } catch (reason) {
          failures.push(`scenario ${ordinal}: ${reason instanceof Error ? reason.message : String(reason)}`);
        }
      }
    }
    expect(found.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(failures).toEqual([]);
  }, 60_000);
});
