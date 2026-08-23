/**
 * Slugging for handles.
 *
 * Handles are typed by humans and emitted by LLMs, so they are aggressively
 * normalised: lowercase, ASCII, hyphen-separated, common street-type words
 * abbreviated so `junction/west-el-camino-real-at-cambridge-ave` stays short
 * enough to read at a glance.
 */

const STREET_ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bavenue\b/g, 'ave'],
  [/\bstreet\b/g, 'st'],
  [/\bboulevard\b/g, 'blvd'],
  [/\bdrive\b/g, 'dr'],
  [/\broad\b/g, 'rd'],
  [/\bcourt\b/g, 'ct'],
  [/\bplace\b/g, 'pl'],
  [/\blane\b/g, 'ln'],
  [/\bhighway\b/g, 'hwy'],
  [/\bparkway\b/g, 'pkwy'],
  [/\bterrace\b/g, 'ter'],
  [/\bcircle\b/g, 'cir'],
  [/\bexpressway\b/g, 'expy'],
];

/** Normalise a display string into a handle-safe slug. */
export function slugify(input: string): string {
  let s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[@&]/g, ' at ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  for (const [re, rep] of STREET_ABBREVIATIONS) s = s.replace(re, rep);
  return s
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72)
    .replace(/-$/, '');
}

const COMPASS_8 = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

/** Eight-point compass abbreviation for a bearing in degrees (0 = north, CW). */
export function compass8(bearingDeg: number): string {
  const idx = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return COMPASS_8[idx] as string;
}

const COMPASS_8_LONG: Record<string, string> = {
  n: 'north',
  ne: 'northeast',
  e: 'east',
  se: 'southeast',
  s: 'south',
  sw: 'southwest',
  w: 'west',
  nw: 'northwest',
};

/** Spelled-out compass direction, for descriptions. */
export function compassLong(bearingDeg: number): string {
  return COMPASS_8_LONG[compass8(bearingDeg)] as string;
}
