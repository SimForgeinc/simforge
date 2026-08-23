import type { ControlIndication, MapSignalIndication } from "@/app/lib/uniscenario/signals";

/**
 * How every signal surface names and colours an indication.
 *
 * One module because the panel, the movement diagram and the timeline lane must
 * agree: an author who sees a `flashing_yellow` band on the lane and a
 * "Flashing yellow" row in the phase list has to be able to tell they are the
 * same thing, and v1's three separate colour tables in
 * `signal-plan-model.ts` and the timeline signal lane
 * are why its own surfaces disagreed on grey.
 *
 * Colours come from the `--signal-*` tokens (plan §5.1), not from hex literals.
 * The classes are written out rather than interpolated because Tailwind's
 * scanner reads source text: `bg-signal-${indication}` compiles to nothing.
 */

/** Eleven, not six: the lane draws whatever the compiled result carries. */
const INDICATION_LABELS: Readonly<Record<ControlIndication, string>> = {
  green: "Green",
  yellow: "Yellow",
  red: "Red",
  flashing_yellow: "Flashing yellow",
  flashing_red: "Flashing red",
  flashing_yellow_arrow: "Flashing yellow arrow",
  flashing_red_arrow: "Flashing red arrow",
  off: "Off",
  green_arrow: "Green arrow",
  yellow_arrow: "Yellow arrow",
  red_x: "Red X",
  proceed: "Proceed",
  stop: "Stop",
};

export function indicationLabel(indication: ControlIndication): string {
  return INDICATION_LABELS[indication];
}

/**
 * The six an author may write, in lamp order.
 *
 * Ordered top-to-bottom as the housing is, so a picker reads like the hardware.
 * There is deliberately **no arrow entry**: an arrow is a lens derived from the
 * plan's protected turns (`signalLensKindIndex`), and `MapSignalPlanClipSchema`
 * refines the enum down to exactly these six — offering `green_arrow` here would
 * be rejected at save time. See `lib/uniscenario/signals/types.ts`.
 */
export const AUTHORABLE_INDICATIONS: readonly MapSignalIndication[] = [
  "green",
  "yellow",
  "red",
  "flashing_yellow",
  "flashing_red",
  "off",
];

type IndicationSwatch = {
  /** Solid fill, for a swatch or an authored band. */
  readonly fill: string;
  /** Faint fill, for a baseline band the author cannot retime. */
  readonly ghost: string;
  /** Border, so a dark `off` lamp is still visible against the card. */
  readonly border: string;
  readonly text: string;
};

const NEUTRAL: IndicationSwatch = {
  fill: "bg-signal-unknown",
  ghost: "bg-signal-unknown/25",
  border: "border-signal-unknown",
  text: "text-signal-unknown",
};

const SWATCHES: Readonly<Record<ControlIndication, IndicationSwatch>> = {
  green: {
    fill: "bg-signal-green",
    ghost: "bg-signal-green/25",
    border: "border-signal-green",
    text: "text-signal-green",
  },
  // The two arrows share their ball colour: the glyph carries the difference,
  // and tinting an arrow differently from a ball would imply the lamp is a
  // different colour than it is.
  green_arrow: {
    fill: "bg-signal-green",
    ghost: "bg-signal-green/25",
    border: "border-signal-green",
    text: "text-signal-green",
  },
  proceed: {
    fill: "bg-signal-green",
    ghost: "bg-signal-green/25",
    border: "border-signal-green",
    text: "text-signal-green",
  },
  yellow: {
    fill: "bg-signal-yellow",
    ghost: "bg-signal-yellow/25",
    border: "border-signal-yellow",
    text: "text-signal-yellow",
  },
  yellow_arrow: {
    fill: "bg-signal-yellow",
    ghost: "bg-signal-yellow/25",
    border: "border-signal-yellow",
    text: "text-signal-yellow",
  },
  flashing_yellow: {
    fill: "bg-signal-yellow",
    ghost: "bg-signal-yellow/25",
    border: "border-signal-yellow",
    text: "text-signal-yellow",
  },
  flashing_yellow_arrow: {
    fill: "bg-signal-yellow",
    ghost: "bg-signal-yellow/25",
    border: "border-signal-yellow",
    text: "text-signal-yellow",
  },
  red: {
    fill: "bg-signal-red",
    ghost: "bg-signal-red/25",
    border: "border-signal-red",
    text: "text-signal-red",
  },
  red_x: {
    fill: "bg-signal-red",
    ghost: "bg-signal-red/25",
    border: "border-signal-red",
    text: "text-signal-red",
  },
  stop: {
    fill: "bg-signal-red",
    ghost: "bg-signal-red/25",
    border: "border-signal-red",
    text: "text-signal-red",
  },
  flashing_red: {
    fill: "bg-signal-red",
    ghost: "bg-signal-red/25",
    border: "border-signal-red",
    text: "text-signal-red",
  },
  flashing_red_arrow: {
    fill: "bg-signal-red",
    ghost: "bg-signal-red/25",
    border: "border-signal-red",
    text: "text-signal-red",
  },
  off: {
    fill: "bg-signal-off",
    ghost: "bg-signal-off/50",
    border: "border-signal-unknown",
    text: "text-signal-unknown",
  },
};

/** Swatch classes for an indication; the neutral set when nothing is stated. */
export function indicationSwatch(indication: ControlIndication | null): IndicationSwatch {
  return indication ? SWATCHES[indication] : NEUTRAL;
}

/**
 * Whether an indication flashes, so a band can carry the `editor-pulse`
 * utility. That utility is already `prefers-reduced-motion`-guarded in
 * `globals.css`, which is why this returns a flag rather than an animation.
 */
export function indicationFlashes(indication: ControlIndication): boolean {
  return indication === "flashing_red" || indication === "flashing_yellow"
    || indication === "flashing_red_arrow" || indication === "flashing_yellow_arrow";
}

/** `12.3` rather than `12.300000000000001`, for a readout or a label. */
export function formatSeconds(seconds: number): string {
  return seconds.toFixed(1);
}
