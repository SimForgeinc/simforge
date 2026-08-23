/**
 * The legacy `EditorWorkspaceStatus` publish shape, ported for v2.
 *
 * ~30 v1 panels publish through this signature. Keeping it means every one of
 * those ports is a data-layer rewire rather than also a status-API rewrite. The
 * only thing it drops is `priority`, which stopped deciding anything the moment
 * statuses started stacking instead of competing for one slot.
 */
export {
  clampStatusProgress,
  userSafeErrorDetail as userSafeUniScenarioErrorDetail,
} from "./notification-model";

export type UniScenarioWorkspaceStatusKind =
  | "loading"
  | "progress"
  | "warning"
  | "error";

export type UniScenarioWorkspaceStatus = {
  kind: UniScenarioWorkspaceStatusKind;
  label: string;
  detail?: string | null;
  progress?: number | null;
  /**
   * @deprecated Ignored. Kept so ported publishers still typecheck; ordering is
   * severity-then-recency across a stack, not a single slot.
   */
  priority?: number;
  actionLabel?: string | null;
  action?: (() => void) | null;
  /**
   * The editor is unusable until this resolves, so it renders in
   * `UniScenarioBootGate` as an overlay rather than as a dismissable card.
   */
  blocking?: boolean;
};
