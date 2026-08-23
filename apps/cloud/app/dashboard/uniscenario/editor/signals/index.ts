/** Shared pieces for the single-reference-light authoring flow. */
export { ReferenceLightEditor } from "./ReferenceLightEditor";
export { useSignalProjection, type SignalProjectionState } from "./use-signal-projection";
export {
  applySignalHeadHighlights,
  applySignalHeadStates,
  selectSignalHeadFromHit,
} from "./orb-layer";
export {
  AUTHORABLE_INDICATIONS,
  formatSeconds,
  indicationFlashes,
  indicationLabel,
  indicationSwatch,
} from "./indication-style";
