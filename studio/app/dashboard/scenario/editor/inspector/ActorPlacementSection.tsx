"use client";

import { Copy, Focus, Trash2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import type { ActorRecord, EditorController } from "@simforge/editor";
import { Heading, NumberField } from "../authoring/fields";
import { Readout } from "../regions/Readout";

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Placement: world pose, lane anchor, and the three actions that operate on the
 * selected actor.
 *
 * These were four read-only readouts, which is the defect worth naming: the
 * controller has exposed `setWorldPose` and `setLanePose` all along, so an
 * author could drag an actor to roughly the right place but never type an exact
 * one. Scenario authoring is a numeric discipline — "12.5 m behind the subject at
 * lane offset 0" is the requirement, not "about there" — so every figure here is
 * an input.
 *
 * Lane s/t only appear when the actor is lane-anchored. A free-placed prop has
 * no lane frame, and showing zeroed fields would imply it could be given one by
 * typing into them.
 */
export function ActorPlacementSection({
  actor,
  controller,
}: {
  actor: ActorRecord;
  controller: EditorController | null;
}) {
  const lane = actor.laneRef;

  return (
    <section aria-labelledby="scenario-placement-heading" className="space-y-3">
      <Heading>
        <span id="scenario-placement-heading">Placement</span>
      </Heading>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="X (m)"
          step={0.1}
          value={round(actor.x)}
          onChange={(x) => controller?.setWorldPose(actor.id, { x })}
        />
        <NumberField
          label="Z (m)"
          step={0.1}
          value={round(actor.z)}
          onChange={(z) => controller?.setWorldPose(actor.id, { z })}
        />
        <NumberField
          label="Heading (°)"
          step={1}
          value={round(actor.headingRad * RAD_TO_DEG, 1)}
          onChange={(headingDeg) => controller?.setWorldPose(actor.id, { headingDeg })}
        />
        {/* Y is ground-contact height, sampled from the terrain rather than
            authored. Typing into it would be overwritten on the next move. */}
        <Readout label="Y (ground)" value={`${round(actor.y, 2)} m`} />
      </div>

      {lane ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Lane s (m)"
            step={0.5}
            value={round(lane.s)}
            onChange={(s) => controller?.setLanePose(actor.id, { s })}
          />
          <NumberField
            label="Lane t (m)"
            step={0.1}
            value={round(lane.t)}
            onChange={(t) => controller?.setLanePose(actor.id, { t })}
          />
          <Readout label="Road" value={lane.roadId} />
          <Readout label="Lane" value={`${lane.laneId} · sec ${lane.section}`} />
        </div>
      ) : (
        <p className="text-muted-foreground">
          Free placement — not anchored to a lane. Drag onto a road to snap.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          className="flex-1"
          size="sm"
          variant="outline"
          onClick={() => controller?.frameActor(actor.id)}
        >
          <Focus aria-hidden="true" />
          Frame
        </Button>
        <Button
          className="flex-1"
          size="sm"
          variant="outline"
          onClick={() => controller?.duplicateSelection()}
        >
          <Copy aria-hidden="true" />
          Duplicate
        </Button>
        <Button
          aria-label={`Delete ${actor.label ?? actor.catalogId}`}
          size="sm"
          variant="outline"
          onClick={() => controller?.deleteSelection()}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}

/**
 * Inputs are rounded for display only.
 *
 * The stored pose keeps full precision — re-rounding on every render would let
 * a value drift each time the panel repainted, and a lane `s` that creeps is a
 * scenario that stops reproducing.
 */
function round(value: number, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
