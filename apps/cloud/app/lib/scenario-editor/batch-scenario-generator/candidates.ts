import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import { isHighwayStrategy, isStopJunctionStrategy, laneChangeSide } from "./types";
import type { BatchScenarioStrategy, Candidate } from "./types";
import {
  hasKnownDrivableSuccessor,
  hasTurn,
  isDrivableSegment,
  laneChangeTarget,
  segmentEndsAtJunctionEntry,
  segmentRsl,
  turnExitSegment,
} from "./graph";
import {
  buildSameDirectionLaneCounts,
  highwayEntryChainForCandidate,
  highwayExitChainForCandidate,
  isHighwayLane,
} from "./highway";
import { chainMainlineInMotorway, type MotorwayFootprint } from "./road-class-gate";

export function candidatesForStrategy(
  segments: RuntimeRoadSegment[],
  strategy: BatchScenarioStrategy,
  opts?: {
    /** Motorway street footprint for the ramp families (road-class gate,
     * dib 2026-07-17). Absent/null => highway_entry & highway_exit admit
     * NOTHING (fail-closed): the geometric chain check alone misfires on
     * arterial maps (Page Mill parking-lot "ramps"). */
    motorwayFootprint?: MotorwayFootprint | null;
  },
): Candidate[] {
  const byRsl = new Map(segments.map((segment) => [segmentRsl(segment), segment]));
  // Highway families admit only geometrically-detected highway lanes (entry:
  // narrow ramp lanes that MERGE onto one); counts built once per call.
  const highwayCounts = isHighwayStrategy(strategy)
    ? buildSameDirectionLaneCounts(segments)
    : null;
  return segments
    .filter(isDrivableSegment)
    .map((segment) => ({
      strategy,
      segment,
      hasKnownDrivableSuccessor: hasKnownDrivableSuccessor(byRsl, segment),
      endsAtJunctionEntry: segmentEndsAtJunctionEntry(byRsl, segment),
    }))
    .filter((candidate) => {
      const { segment } = candidate;
      if (highwayCounts) {
        if (strategy === "highway_entry") {
          // The on-ramp itself is NOT a highway lane; admission is "this narrow
          // lane's successor chain merges onto a mainline highway lane" AND the
          // mainline sits on a motorway-classified street (road-class gate —
          // fail-closed without a footprint).
          const chain = highwayEntryChainForCandidate(byRsl, highwayCounts, segment);
          const mainline = chain?.at(-1);
          if (!mainline) return false;
          return chainMainlineInMotorway(opts?.motorwayFootprint, mainline);
        }
        if (!isHighwayLane(highwayCounts, segment)) return false;
        if (strategy === "highway_lane_keep") return candidate.hasKnownDrivableSuccessor;
        if (strategy === "highway_exit") {
          // Exit: the candidate IS the mainline — it must sit on a motorway
          // street (road-class gate) and expose a peel-off chain.
          if (!chainMainlineInMotorway(opts?.motorwayFootprint, segment)) return false;
          return highwayExitChainForCandidate(byRsl, highwayCounts, segment) !== null;
        }
        // highway lane changes fall through to the shared lane-change target
        // check below (laneChangeSide covers the highway_* names).
      }
      if (strategy === "lane_keep") return candidate.hasKnownDrivableSuccessor;
      if (strategy === "stop") {
        // Causal stops: junction-entry segments host the line-anchored
        // variants (the subject/lead rests BEFORE the junction, so no drivable
        // successor is needed); segments with a drivable successor host the
        // mid-block lead-brake variant (vehicles may roll across the segment
        // end before resting).
        return candidate.hasKnownDrivableSuccessor || candidate.endsAtJunctionEntry;
      }
      if (isStopJunctionStrategy(strategy)) {
        // Infrastructure-triggered stop: the subject approaches a junction and the control
        // device there (stop sign / yield / traffic light) makes the TM stop it. The site
        // is an APPROACH lane that ends at a junction entry AND has a resolvable proceed
        // branch (so the subject has somewhere to go through the junction). Which control the
        // junction actually carries is confirmed at sim time by stopOutcome.detected_cause;
        // scenes whose detected cause doesn't match the family are dropped in validation.
        return candidate.endsAtJunctionEntry;
      }
      // Lane changes AND overtakes both need a same-direction target lane to merge
      // into on the requested side (overtake additionally spawns a lead — placed in
      // emit — but the candidate geometry is identical).
      const lcSide = laneChangeSide(strategy);
      if (lcSide) return Boolean(laneChangeTarget(byRsl, segment, lcSide));
      if (strategy === "turn_left") return hasTurn(byRsl, segment, "Left");
      if (strategy === "turn_right") return hasTurn(byRsl, segment, "Right");
      return false;
    })
}

/**
 * Pool for the line-anchored stop variants (A/B): junction-entry candidates
 * that ALSO expose at least one resolvable proceed branch in turn_options.
 * Real-map probing showed ~all-relation `no_branch` rejections dominating:
 * the runtime map builder's fork scan caps at 80m from the segment START, so
 * long approach segments — exactly the ones the length-sorted quadratic draw
 * bias prefers — often carry EMPTY turn_options and can never host a
 * post-stop proceed. Gating the pool stops wasting resample attempts on them
 * (and stops the variant fallback they caused).
 */
export function stopAnchorableJunctionEntryCandidates(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidates: Candidate[],
): Candidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.endsAtJunctionEntry &&
      ["Right", "Straight", "Left"].some(
        (relation) =>
          turnExitSegment(
            segments,
            candidate.segment,
            relation as "Right" | "Straight" | "Left",
          ) !== null,
      ),
  );
}
