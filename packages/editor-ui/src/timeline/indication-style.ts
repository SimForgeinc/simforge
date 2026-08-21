import type { ControlIndication } from "@uniscenarios/sim-engine";
import type { MapSignalIndication } from "@uniscenarios/scenario-model";

export type { ControlIndication, MapSignalIndication };

/**
 * How every signal surface names and colours an indication.
 *
 * One module because the panel, the movement diagram and the timeline lane must
 * agree: an author who sees a `flashing_yellow` band on the lane and a
 * "Flashing yellow" row in the phase list has to be able to tell they are the
 * same thing.
 *
 * The SimCloud original returned Tailwind classes over `--signal-*` tokens; the
 * portable package returns concrete colours read from the same token values,
 * so the lane renders identically without a Tailwind build.
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
 * plan's protected turns, and the plan schema refines the enum down to exactly
 * these six — offering `green_arrow` here would be rejected at save time.
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

const SIGNAL_GREEN = "hsl(140 60% 53%)";
const SIGNAL_YELLOW = "hsl(42 87% 55%)";
const SIGNAL_RED = "hsl(0 84% 62%)";
const SIGNAL_OFF = "hsl(220 8% 28%)";
const SIGNAL_UNKNOWN = "hsl(220 8% 46%)";

const NEUTRAL: IndicationSwatch = {
  fill: SIGNAL_UNKNOWN,
  ghost: "color-mix(in srgb, " + SIGNAL_UNKNOWN + " 25%, transparent)",
  border: SIGNAL_UNKNOWN,
  text: SIGNAL_UNKNOWN,
};

// The two arrows share their ball colour: the glyph carries the difference,
// and tinting an arrow differently from a ball would imply the lamp is a
// different colour than it is.
const SWATCHES: Readonly<Record<ControlIndication, IndicationSwatch>> = {
  green: swatch(SIGNAL_GREEN),
  green_arrow: swatch(SIGNAL_GREEN),
  proceed: swatch(SIGNAL_GREEN),
  yellow: swatch(SIGNAL_YELLOW),
  yellow_arrow: swatch(SIGNAL_YELLOW),
  flashing_yellow: swatch(SIGNAL_YELLOW),
  flashing_yellow_arrow: swatch(SIGNAL_YELLOW),
  red: swatch(SIGNAL_RED),
  red_x: swatch(SIGNAL_RED),
  stop: swatch(SIGNAL_RED),
  flashing_red: swatch(SIGNAL_RED),
  flashing_red_arrow: swatch(SIGNAL_RED),
  off: {
    fill: SIGNAL_OFF,
    ghost: "color-mix(in srgb, " + SIGNAL_OFF + " 50%, transparent)",
    border: SIGNAL_UNKNOWN,
    text: SIGNAL_UNKNOWN,
  },
};

function swatch(color: string): IndicationSwatch {
  return {
    fill: color,
    ghost: "color-mix(in srgb, " + color + " 25%, transparent)",
    border: color,
    text: color,
  };
}

/** Swatch colours for an indication; the neutral set when nothing is stated. */
export function indicationSwatch(indication: ControlIndication | null): IndicationSwatch {
  return indication ? SWATCHES[indication] : NEUTRAL;
}

/**
 * Whether an indication flashes, so a band can carry the pulse utility. That
 * utility is already `prefers-reduced-motion`-guarded in `editor-ui.css`, which
 * is why this returns a flag rather than an animation.
 */
export function indicationFlashes(indication: ControlIndication): boolean {
  return indication === "flashing_red" || indication === "flashing_yellow"
    || indication === "flashing_red_arrow" || indication === "flashing_yellow_arrow";
}

/** `12.3` rather than `12.300000000000001`, for a readout or a label. */
export function formatIndicationSeconds(seconds: number): string {
  return seconds.toFixed(1);
}
