/**
 * Write synthesized `<controller>` / `<control>` elements into an OpenDRIVE
 * file, grouping traffic lights by movement.
 *
 * ## Offline and opt-in, by design
 *
 * This is a pure string transform. It is NOT wired into the map-asset pipeline
 * and never rewrites a stored artifact: `maps/<id>/<id>.xodr` is content-hashed
 * into `map_asset_artifacts.checksum_sha256`, is the cache-invalidation signal
 * for `getMapArtifactRevision`, and is fetched by artifact locator by the esmini
 * runner. Source artifacts are immutable house policy. Any consumer that wants
 * the enriched bytes must ask for them explicitly.
 *
 * ## Why both a top-level `<controller>` and a `<junction><controller>` ref
 *
 * CARLA's `TrafficLightManager::RegisterLightComponentFromOpenDRIVE` bails on a
 * signal whose controller has no junctions —
 * `if (Controller->GetJunctions().empty()) { error; return; }` — so a top-level
 * controller that no junction references makes things *worse* than no
 * controller at all: the lights get skipped from group registration entirely,
 * where an uncontrolled signal would at least have received its own
 * auto-generated group. Both halves are therefore emitted together, or neither.
 *
 * (esmini parses `<controller>` into `roadmanager::Controller` and then never
 * reads it — nothing in its ScenarioEngine consumes controller data, and
 * `TrafficSignalControllerAction` is explicitly "not supported yet". esmini
 * scenarios must drive lights with `TrafficSignalStateAction` against bare
 * numeric `<signal>` ids instead. The enrichment is inert for esmini, not
 * harmful.)
 *
 * ## Element ordering is schema-mandated, not cosmetic
 *
 * The `<OpenDRIVE>` root is an `xs:sequence` in the 1.4, 1.6 and 1.7 schemas:
 * `header`, `road+`, `controller*`, `junction*`, `junctionGroup*`, `station*`.
 * Controllers therefore go after the last `</road>` and before the first
 * `<junction>`. Inside a junction the order is `connection+`, `priority*`,
 * `controller*`, so junction references are appended last.
 */

import {
  deriveXodrSignalGroups,
  type DeriveXodrSignalGroupsResult,
  type XodrJunctionSignalGroup,
} from "./derive-signal-groups";

export type EnrichXodrOptions = {
  /**
   * Emit controllers for junctions that already carry `<controller>`
   * references. Off by default: an existing grouping is authored or
   * vendor-supplied data, and layering ours on top would give CARLA two
   * controllers per junction fighting over the same lights.
   */
  includeJunctionsWithExistingControllers?: boolean;
  /**
   * Emit one controller per physical signal head. This conservative mode is
   * useful for generated fixtures (and maps without authored phase metadata):
   * a controller can never accidentally combine conflicting movements.
   */
  singleSignalControllers?: boolean;
};

export type EnrichXodrResult = {
  /** The enriched document. Byte-identical to the input when nothing applied. */
  xodr: string;
  /** The grouping the controllers were built from, controller ids included. */
  groups: DeriveXodrSignalGroupsResult;
  stats: {
    junctions_enriched: number;
    junctions_skipped_existing_controllers: number;
    controllers_added: number;
    controls_added: number;
    /** Junctions whose `<junction>` element is self-closing, so unreferenceable. */
    junctions_skipped_self_closing: number;
  };
};

/** XML-escape a value destined for a double-quoted attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Leading whitespace of the first line matching `pattern`, or "". */
function detectIndent(xodr: string, pattern: RegExp): string {
  const at = xodr.search(pattern);
  if (at === -1) return "";
  const lineStart = xodr.lastIndexOf("\n", at) + 1;
  return /^[ \t]*/.exec(xodr.slice(lineStart, at))?.[0] ?? "";
}

/** The newline convention actually in the file, so we do not mix CRLF and LF. */
function detectEol(xodr: string): string {
  return xodr.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Add `<controller>` blocks and their junction references.
 *
 * Deterministic: identical input bytes and options always produce identical
 * output bytes. Idempotent in the default configuration — a second run sees the
 * `<junction><controller>` references the first run wrote and skips those
 * junctions, so `enrich(enrich(x)) === enrich(x)`.
 */
export function enrichXodrWithSignalControllers(
  xodr: string,
  options: EnrichXodrOptions = {},
): EnrichXodrResult {
  const derivedGroups = deriveXodrSignalGroups(xodr);
  let nextSingleControllerId = derivedGroups.controller_id_base;
  const groups: DeriveXodrSignalGroupsResult = options.singleSignalControllers
    ? {
        ...derivedGroups,
        junctions: derivedGroups.junctions.map((junction) => {
          const phaseGroups = junction.phase_groups.flatMap((group) =>
            group.signal_ids.map((signalId) => ({
              ...group,
              key: `${group.key}:signal-${signalId}`,
              signal_ids: [signalId],
              controller_id: String(nextSingleControllerId++),
              controller_name: `${group.controller_name}:signal-${signalId}`,
            })),
          );
          return { ...junction, phase_groups: phaseGroups };
        }),
      }
    : derivedGroups;
  const eol = detectEol(xodr);
  const stats: EnrichXodrResult["stats"] = {
    junctions_enriched: 0,
    junctions_skipped_existing_controllers: 0,
    controllers_added: 0,
    controls_added: 0,
    junctions_skipped_self_closing: 0,
  };

  const applicable: XodrJunctionSignalGroup[] = [];
  for (const junction of groups.junctions) {
    if (junction.had_existing_controllers && !options.includeJunctionsWithExistingControllers) {
      stats.junctions_skipped_existing_controllers += 1;
      continue;
    }
    if (junction.phase_groups.length === 0) continue;
    applicable.push(junction);
  }
  if (applicable.length === 0) return { xodr, groups, stats };

  // ---- Junction back-references, written first so the offsets used to place
  // the top-level block are computed against the original string.
  const referencesByJunction = new Map<string, XodrJunctionSignalGroup>();
  for (const junction of applicable) referencesByJunction.set(junction.junction_id, junction);

  const junctionIndent = detectIndent(xodr, /<junction\b/);
  const childIndent = `${junctionIndent}  `;

  // Self-closing first: `<junction id="1"/>` must not be read as an opening tag
  // whose body runs to some *later* junction's `</junction>`.
  const withReferences = xodr.replace(
    /<junction\b([^>]*?)\/>|<junction\b([^>]*)>([\s\S]*?)<\/junction>/gi,
    (match, selfAttrs: string | undefined, openAttrs: string | undefined, body: string | undefined) => {
      const attrs = openAttrs ?? selfAttrs ?? "";
      const idMatch = /\bid="([^"]*)"/.exec(attrs);
      const junctionId = idMatch?.[1]?.trim();
      if (!junctionId) return match;
      const junction = referencesByJunction.get(junctionId);
      if (!junction) return match;
      // A self-closing `<junction .../>` has no body to append to. It also has
      // no `<connection>` children, so it cannot have produced approaches —
      // reaching here means the document is malformed; leave it untouched.
      if (selfAttrs !== undefined || body === undefined) {
        stats.junctions_skipped_self_closing += 1;
        return match;
      }
      const refs = junction.phase_groups
        .map(
          (group, index) =>
            `${childIndent}<controller id="${escapeAttr(group.controller_id)}" sequence="${index}"/>`,
        )
        .join(eol);
      const trailing = /[ \t]*$/.exec(body)?.[0] ?? "";
      const trimmedBody = body.slice(0, body.length - trailing.length);
      stats.junctions_enriched += 1;
      return `<junction${attrs}>${trimmedBody}${refs}${eol}${junctionIndent}</junction>`;
    },
  );

  // ---- Top-level controller definitions.
  const controllerIndent = detectIndent(xodr, /<road\b/);
  const controlIndent = `${controllerIndent}  `;
  const blocks: string[] = [];
  for (const junction of applicable) {
    for (const group of junction.phase_groups) {
      const controls = group.signal_ids.map(
        (signalId) => `${controlIndent}<control signalId="${escapeAttr(signalId)}" type="0"/>`,
      );
      stats.controllers_added += 1;
      stats.controls_added += controls.length;
      blocks.push(
        [
          `${controllerIndent}<controller id="${escapeAttr(group.controller_id)}" name="${escapeAttr(group.controller_name)}">`,
          ...controls,
          `${controllerIndent}</controller>`,
        ].join(eol),
      );
    }
  }

  const insertion = `${blocks.join(eol)}${eol}`;
  return { xodr: insertControllerBlock(withReferences, insertion, eol), groups, stats };
}

/**
 * Splice the controller block into the one position the root `xs:sequence`
 * allows: after the last `</road>`, before the first `<junction>`.
 *
 * Existing controllers are kept ahead of the new ones (`controller*` is a
 * repeatable slot, so appending is valid and keeps the diff minimal).
 */
function insertControllerBlock(xodr: string, insertion: string, eol: string): string {
  const lastControllerEnd = xodr.lastIndexOf("</controller>");
  if (lastControllerEnd !== -1) {
    const after = lastControllerEnd + "</controller>".length;
    return `${xodr.slice(0, after)}${eol}${insertion.replace(/\r?\n$/, "")}${xodr.slice(after)}`;
  }

  const firstJunction = xodr.search(/<junction\b/);
  if (firstJunction !== -1) {
    const lineStart = xodr.lastIndexOf("\n", firstJunction) + 1;
    return `${xodr.slice(0, lineStart)}${insertion}${xodr.slice(lineStart)}`;
  }

  const lastRoadEnd = xodr.lastIndexOf("</road>");
  if (lastRoadEnd !== -1) {
    const after = lastRoadEnd + "</road>".length;
    return `${xodr.slice(0, after)}${eol}${insertion.replace(/\r?\n$/, "")}${xodr.slice(after)}`;
  }

  const close = xodr.search(/<\/OpenDRIVE>/);
  if (close === -1) return xodr;
  const lineStart = xodr.lastIndexOf("\n", close) + 1;
  return `${xodr.slice(0, lineStart)}${insertion}${xodr.slice(lineStart)}`;
}
