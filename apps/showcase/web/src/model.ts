import type { Artifact, CellVerdict, GalleryCard, IndexedFile, JobIndex, Rate, RawJobIndex, StageEvent } from './types';

export const STAGES = [
  ['00', 'Brief'], ['10', 'Route'], ['15', 'Precheck'], ['20', 'Author'], ['30', 'Sites'],
  ['40', 'Simulate'], ['50', 'Gate'], ['60', 'Render 2D'], ['62', 'Semantic'], ['65', 'Render 3D'], ['75', 'Decision'], ['90', 'Gallery'],
] as const;

export function stageNumber(value: string): string {
  return (value.match(/\d{2}/)?.[0] ?? value).padStart(2, '0');
}

export function stageList(job: JobIndex | null, live: Record<string, StageEvent>): StageEvent[] {
  const source = job?.stages;
  const indexed: Record<string, StageEvent> = {};
  if (Array.isArray(source)) source.forEach((item) => { indexed[stageNumber(item.stage)] = item; });
  else if (source && typeof source === 'object') Object.entries(source).forEach(([key, value]) => {
    indexed[stageNumber(key)] = typeof value === 'object' && value ? { stage: key, ...(value as object) } as StageEvent : { stage: key, status: String(value) };
  });
  Object.values(live).forEach((item) => { indexed[stageNumber(item.stage)] = { ...indexed[stageNumber(item.stage)], ...item }; });
  return STAGES.map(([stage]) => indexed[stage] ?? { stage, status: 'pending' });
}

export function cells(job: JobIndex | null): CellVerdict[] {
  if (!job?.cells) return [];
  return Array.isArray(job.cells) ? job.cells : Object.entries(job.cells).map(([id, cell]) => ({ cellId: id, ...cell }));
}

export function threeDVideos(job: JobIndex | null): Array<{ cell: CellVerdict; artifact: Artifact }> {
  if (job?.status !== 'complete') return [];
  return cells(job).flatMap((cell) => {
    if (cell.product?.accepted !== true) return [];
    const candidates = (cell.artifacts ?? []).filter((artifact) => {
      const path = artifact.path ?? artifact.url ?? '';
      return path.includes('/65-render3d/') && artifactKind(artifact) === 'video';
    });
    const artifact = candidates.find((item) => /\/rollout\.mp4(?:\?|$)/.test(item.path ?? item.url ?? ''))
      ?? candidates.find((item) => /\/video\.mp4(?:\?|$)/.test(item.path ?? item.url ?? ''))
      ?? candidates[0];
    return artifact ? [{ cell, artifact }] : [];
  });
}

/**
 * A rate is only readable together with its denominator. An absent rate, an
 * empty denominator, or a null value all render as `n/a`: never as `0%`, which
 * would read as a measured failure instead of an absent measurement.
 */
export function formatRate(rate: Rate | null | undefined): string {
  if (!rate || rate.denominator === 0 || rate.value === null) return 'n/a';
  return `${rate.numerator}/${rate.denominator} (${(rate.value * 100).toFixed(1)}%)`;
}

export function artifactKind(artifact: Artifact | string): 'image' | 'video' | 'download' {
  const value = typeof artifact === 'string' ? artifact : `${artifact.type ?? ''} ${artifact.path ?? artifact.url ?? ''}`;
  if (/\.(png|jpe?g|webp|gif)(\?|$)|\bimage\b/i.test(value)) return 'image';
  if (/\.(mp4|webm|mov)(\?|$)|\bvideo\b/i.test(value)) return 'video';
  return 'download';
}

export function artifacts(value: unknown): Artifact[] {
  if (!value || typeof value !== 'object') return [];
  const direct = (value as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(direct)) return [];
  return direct.map((item) => typeof item === 'string' ? { path: item } : item as Artifact);
}

export function cardId(card: GalleryCard): string { return card.jobId ?? card.id ?? ''; }
export function cardMedia(card: GalleryCard): string | undefined {
  return card.media ?? card.headlineArtifact ?? card.artifacts?.find((item) => artifactKind(item) !== 'download')?.url ?? card.artifacts?.find((item) => artifactKind(item) !== 'download')?.path;
}

export function normalizeGallery(cards: GalleryCard[]): GalleryCard[] {
  return cards.map((card) => {
    const gate = card.gate as { passed?: number; cells?: number } | undefined;
    const scores = card.scores as { realism?: number; dynamism?: number } | undefined;
    const headline = typeof card.headline === 'string' ? card.headline : undefined;
    const headlineIsMedia = Boolean(headline && (/^\/artifacts\//.test(headline) || /\.(mp4|webm|png|jpe?g)(\?|$)/i.test(headline)));
    return {
      ...card,
      headline: headlineIsMedia ? undefined : headline,
      media: card.media ?? card.headlineArtifact ?? (headlineIsMedia ? headline : undefined),
      admittedCells: card.admittedCells ?? gate?.passed ?? (typeof card.admitted === 'number' ? card.admitted : undefined),
      totalCells: card.totalCells ?? gate?.cells,
      realism: card.realism ?? scores?.realism,
      dynamism: card.dynamism ?? scores?.dynamism,
    };
  });
}

function fileJson(files: IndexedFile[], path: string): Record<string, unknown> | undefined {
  const value = files.find((file) => file.path === path)?.json;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jobArtifact(jobId: string, path: string): Artifact {
  return { path: `jobs/${jobId}/${path}`, name: path };
}

export function normalizeJob(raw: RawJobIndex | JobIndex): JobIndex {
  if (!('files' in raw) || !Array.isArray(raw.files)) return raw as JobIndex;
  const jobId = String(raw.jobId);
  const files = raw.files as IndexedFile[];
  const brief = fileJson(files, '00-brief.json');
  const route = fileJson(files, '10-route.json');
  const gallery = fileJson(files, '90-gallery.json');
  const gate = fileJson(files, '50-gate.json');
  const product = fileJson(files, '75-product.json');
  const cellIndex = fileJson(files, '40-cells/index.json');
  const render2d = fileJson(files, '60-render2d/index.json');
  const render3d = fileJson(files, '65-render3d/index.json');

  const stages = STAGES.map(([number, label]) => {
    const stageFiles = files.filter((file) => stageNumber(file.path) === number);
    const rawJson = Object.fromEntries(stageFiles.filter((file) => file.json !== undefined).map((file) => [file.path, file.json]));
    const explicitStatus = stageFiles.map((file) => file.json && typeof file.json === 'object' && !Array.isArray(file.json) ? (file.json as { status?: unknown }).status : undefined)
      .find((status): status is string => typeof status === 'string');
    return {
      stage: `${number}-${label.toLowerCase().replace(/\s+/g, '')}`,
      status: explicitStatus ?? (stageFiles.length ? 'complete' : 'pending'),
      artifacts: stageFiles.map((file) => jobArtifact(jobId, file.path)),
      raw: Object.keys(rawJson).length === 1 ? Object.values(rawJson)[0] : rawJson,
    } satisfies StageEvent;
  });

  const gateRows = Array.isArray(gate?.cells) ? gate.cells as CellVerdict[] : [];
  const productRows = Array.isArray(product?.cells) ? product.cells as CellVerdict[] : [];
  const renderedRows = [render2d, render3d].flatMap((index) => Array.isArray(index?.cells) ? index.cells as CellVerdict[] : []);
  const baseCells = Array.isArray(cellIndex?.cells) ? cellIndex.cells as CellVerdict[] : [];
  const cellIds = new Set([...baseCells, ...gateRows, ...productRows, ...renderedRows].map((row) => row.cellId ?? row.id).filter(Boolean) as string[]);
  const normalizedCells = [...cellIds].map((cellId) => {
    const base = baseCells.find((row) => (row.cellId ?? row.id) === cellId) ?? {};
    const gateRow = gateRows.find((row) => (row.cellId ?? row.id) === cellId);
    const productRow = productRows.find((row) => (row.cellId ?? row.id) === cellId);
    const cellArtifacts = files.filter((file) => file.path.includes(`/${cellId}/`) && /\.(png|jpe?g|mp4|webm|json|gz)$/i.test(file.path));
    return {
      ...base,
      cellId,
      map: (base.map ?? base.mapId) as string | undefined,
      gate: gateRow ? { ...gateRow, pass: (gateRow.pass ?? gateRow.admitted) as boolean | undefined } : undefined,
      product: productRow,
      artifacts: cellArtifacts.map((file) => jobArtifact(jobId, file.path)),
    } as CellVerdict;
  });

  return {
    ...raw,
    brief: brief?.brief as string | undefined,
    engine: (route?.engine ?? gallery?.engine ?? brief?.engine) as JobIndex['engine'],
    options: brief,
    status: files.some((file) => file.path === '90-gallery.json') ? 'complete' : 'running',
    stages,
    cells: normalizedCells,
  };
}

export function scopeStageArtifacts(jobId: string, event: StageEvent): StageEvent {
  return {
    ...event,
    artifacts: event.artifacts?.map((artifact) => {
      const path = typeof artifact === 'string' ? artifact : artifact.path ?? artifact.url ?? '';
      if (!path || /^(data:|blob:|https?:\/\/|\/artifacts\/)/.test(path) || path.startsWith(`jobs/${jobId}/`)) return typeof artifact === 'string' ? { path } : artifact;
      return { ...(typeof artifact === 'string' ? {} : artifact), path: `jobs/${jobId}/${path}`, name: typeof artifact === 'string' ? artifact : artifact.name };
    }),
  };
}
