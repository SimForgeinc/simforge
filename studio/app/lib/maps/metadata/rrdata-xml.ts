import type { MapStatsSignalization } from "@simforge-oss/studio-shared";

function stripXmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

/** Root `RoadRunnerMetadata` @Version */
export function extractRrdataSchemaVersion(xml: string): string | undefined {
  const cleaned = stripXmlComments(xml);
  const m = cleaned.match(/<RoadRunnerMetadata[^>]*\bVersion="([^"]+)"/i);
  return m?.[1];
}

/**
 * Signalization block parse: junction counts and signal phase timing.
 *
 * RoadRunner rrdata XML structure:
 *
 *   <Signalization>
 *     <Junction>
 *       <ID>{guid}</ID>
 *     </Junction>
 *     ...
 *     <Junction>
 *       <ID>{guid}</ID>
 *       <SignalPhase>
 *         <Interval><Time>20</Time></Interval>
 *         <Interval><Time>4</Time></Interval>
 *         <Interval><Time>1</Time></Interval>
 *       </SignalPhase>
 *       <SignalPhase>...</SignalPhase>
 *     </Junction>
 *     ...
 *   </Signalization>
 *   <SignalConfigurations/>
 *
 * Key findings from schema analysis:
 *
 * 1. signalized_junction_ids are NOT emitted. The GUIDs in the Signalization
 *    block are RoadRunner internal scene-graph object IDs — a third independent
 *    ID space that does not correspond to xodr junction id= attributes (which
 *    are plain integers) or geojson Junction.Id values (a different GUID set).
 *    Emitting them as "signalized_junction_ids" is misleading because they
 *    cannot be joined to any other field in the metadata.
 *
 * 2. has_signal_phase_timing is derived from <SignalPhase> child elements on
 *    Junction entries within the Signalization block — NOT from
 *    <SignalConfigurations>, which is a separate concept and is self-closing
 *    (empty) even on maps that have full phase timing authored. The previous
 *    implementation checked only SignalConfigurations and would always return
 *    false on maps with phases defined.
 *
 * 3. signal_phase_count is the total number of <SignalPhase> elements across
 *    all junctions — useful for understanding how much timing has been authored.
 *
 * 4. junctions_with_phases is the count of Junction entries that have at least
 *    one <SignalPhase> child — the subset of signalized junctions with authored
 *    timing.
 */
export function extractSignalizationFromRrdata(xml: string): MapStatsSignalization {
  const cleaned = stripXmlComments(xml);

  // Isolate the <Signalization>...</Signalization> block.
  const sigBlockMatch = cleaned.match(
    /<Signalization\b[^>]*>([\s\S]*?)<\/Signalization>/i,
  );

  let signal_controlled_object_count = 0;
  let junctions_with_phases = 0;
  let signal_phase_count = 0;

  if (sigBlockMatch?.[1]) {
    const sigBlock = sigBlockMatch[1];

    // Process each <Junction>...</Junction> entry individually so we can
    // count phases per junction without cross-contamination between entries.
    const junctionRe = /<Junction>([\s\S]*?)<\/Junction>/gi;
    let jm: RegExpExecArray | null;
    while ((jm = junctionRe.exec(sigBlock)) !== null) {
      signal_controlled_object_count += 1;
      const junctionBody = jm[1] ?? "";
      const phases = junctionBody.match(/<SignalPhase\b/gi);
      if (phases && phases.length > 0) {
        junctions_with_phases += 1;
        signal_phase_count += phases.length;
      }
    }
  }

  // has_signal_phase_timing: true if any junction has <SignalPhase> children.
  // <SignalConfigurations> is a separate block for programmatic signal configs
  // and is self-closing even on maps with full phase timing authored — do not
  // use it to determine whether phase timing has been defined.
  const has_signal_phase_timing = signal_phase_count > 0;

  // signal_configurations_count: kept for completeness; self-closing in all
  // observed RoadRunner exports regardless of whether phases are authored.
  const signal_configurations_count = countTagOccurrences(cleaned, "SignalConfiguration");

  return {
    signal_controlled_object_count: signal_controlled_object_count > 0
      ? signal_controlled_object_count
      : undefined,
    has_signal_phase_timing,
    signal_configurations_count,
    junctions_with_phases: junctions_with_phases > 0 ? junctions_with_phases : undefined,
    signal_phase_count: signal_phase_count > 0 ? signal_phase_count : undefined,
  };
}

/** Count opening (or self-closing) occurrences of a tag by local name. */
function countTagOccurrences(xml: string, localName: string): number {
  const re = new RegExp(`<${localName}(?:[\\s>/])`, "gi");
  return xml.match(re)?.length ?? 0;
}
