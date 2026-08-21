/**
 * Reference-light authoring types, carried from the SimCloud signals module.
 *
 * The timing editor itself stays product-side; the timeline only needs the
 * shape to type its (currently unused) `signalAuthoring` prop so a product can
 * keep passing its authoring object through unchanged.
 */

/** The three numbers an author types. Seconds. */
export type ReferenceCycleTiming = {
  greenS: number;
  yellowS: number;
  redS: number;
};

/** The three user-facing rows in a reference light cycle. */
export type ReferenceCyclePhase = "green" | "yellow" | "red";

export type TrafficLightCycleSnapshot = {
  readonly timing: ReferenceCycleTiming;
  readonly phaseOrder: readonly ReferenceCyclePhase[];
};

export type TrafficLightAuthoring = {
  readonly junctionId: string;
  readonly headId: string;
  readonly label: string;
  readonly timing: ReferenceCycleTiming;
  readonly phaseOrder: readonly ReferenceCyclePhase[];
  readonly generated: boolean;
  readonly crossingStageCount: number;
  readonly hasPlan: boolean;
  readonly warning?: string | null;
  readonly onTimingChange: (next: Partial<ReferenceCycleTiming>) => void;
  readonly onPhaseOrderChange: (next: readonly ReferenceCyclePhase[]) => void;
  readonly onReset: (snapshot: TrafficLightCycleSnapshot) => void;
  readonly onRemoveControl?: () => void;
};
