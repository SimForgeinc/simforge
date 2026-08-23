/**
 * Dependency-free OpenSCENARIO self-check for documents emitted by SimForge.
 *
 * This is intentionally not a general OpenSCENARIO importer. It performs a
 * small well-formedness walk, records Action/Condition element names, and
 * checks those names against the ScenarioRunner 1.0 surface used by our
 * writer. Attributes and schema cardinality remain the writer's responsibility.
 *
 * ## Why this remains separate from canonical import
 *
 * Inbound third-party files are parsed and bounded by
 * `@simforge/openscenario/import`. This checker has the opposite trust
 * boundary: it reads a file we DID write and asks only whether our own
 * emission stayed inside the ScenarioRunner surface. It is an assertion about
 * our writer, not a defence against an attacker, and must never be used as one.
 *
 * The sets below intentionally name only what our writer emits, not everything
 * the canonical importer can analyze.
 */

/**
 * Action elements emitted by xosc-writer:
 *
 * - Action: storyboard action wrapper
 * - PrivateAction / GlobalAction: OSC action scope wrappers
 * - TeleportAction: actor world-coordinate initialization
 * - LongitudinalAction / SpeedAction: initial and timeline speeds
 * - RoutingAction / FollowTrajectoryAction: authored world trajectories
 * - LateralAction / LaneChangeAction: relative one-lane changes
 * - EnvironmentAction: sun, fog, and precipitation initialization
 */
export const SCENARIO_RUNNER_1_0_ACTION_ALLOWLIST = new Set([
  "Action",
  "PrivateAction",
  "GlobalAction",
  "TeleportAction",
  "LongitudinalAction",
  "SpeedAction",
  "RoutingAction",
  "FollowTrajectoryAction",
  "LateralAction",
  "LaneChangeAction",
  "EnvironmentAction",
]);

/**
 * Condition elements emitted by xosc-writer:
 *
 * - Condition: trigger condition wrapper
 * - ByValueCondition: value-condition wrapper
 * - SimulationTimeCondition: act, event, and stop timing
 * - RoadCondition: environment friction wrapper
 */
export const SCENARIO_RUNNER_1_0_CONDITION_ALLOWLIST = new Set([
  "Condition",
  "ByValueCondition",
  "SimulationTimeCondition",
  "RoadCondition",
]);

export type XoscAllowlistClassification = {
  verdict: "faithful" | "approximated" | "unsupported";
  actions: string[];
  conditions: string[];
  unknownElements: string[];
};

function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function tagEnd(xml: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  throw new Error(`Malformed OpenSCENARIO XML: unterminated tag at offset ${start - 1}.`);
}

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}

function classifyElement(
  name: string,
  actions: string[],
  conditions: string[],
  unknownElements: string[],
): void {
  const element = localName(name);
  if (element === "Action" || element.endsWith("Action")) {
    pushUnique(actions, element);
    if (!SCENARIO_RUNNER_1_0_ACTION_ALLOWLIST.has(element)) {
      pushUnique(unknownElements, element);
    }
  }
  if (element === "Condition" || element.endsWith("Condition")) {
    pushUnique(conditions, element);
    if (!SCENARIO_RUNNER_1_0_CONDITION_ALLOWLIST.has(element)) {
      pushUnique(unknownElements, element);
    }
  }
}

export function classifyXoscDocument(
  xml: string,
): XoscAllowlistClassification {
  if (typeof xml !== "string" || xml.trim().length === 0) {
    throw new Error("Malformed OpenSCENARIO XML: document is empty.");
  }

  const stack: string[] = [];
  const actions: string[] = [];
  const conditions: string[] = [];
  const unknownElements: string[] = [];
  let root: string | null = null;
  let rootClosed = false;
  let cursor = xml.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) {
      if (xml.slice(cursor).trim()) {
        throw new Error("Malformed OpenSCENARIO XML: text appears outside the root element.");
      }
      break;
    }
    if (stack.length === 0 && xml.slice(cursor, open).trim()) {
      throw new Error("Malformed OpenSCENARIO XML: text appears outside the root element.");
    }

    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end === -1) {
        throw new Error("Malformed OpenSCENARIO XML: unterminated comment.");
      }
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end === -1) {
        throw new Error("Malformed OpenSCENARIO XML: unterminated processing instruction.");
      }
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end === -1) {
        throw new Error("Malformed OpenSCENARIO XML: unterminated CDATA section.");
      }
      if (stack.length === 0 && xml.slice(open + 9, end).trim()) {
        throw new Error("Malformed OpenSCENARIO XML: CDATA appears outside the root element.");
      }
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<!", open)) {
      throw new Error("Malformed OpenSCENARIO XML: declarations are not supported.");
    }

    const end = tagEnd(xml, open + 1);
    const body = xml.slice(open + 1, end).trim();
    if (!body) {
      throw new Error(`Malformed OpenSCENARIO XML: empty tag at offset ${open}.`);
    }

    if (body.startsWith("/")) {
      const closeMatch = body.match(/^\/\s*([A-Za-z_][\w:.-]*)\s*$/);
      if (!closeMatch) {
        throw new Error(`Malformed OpenSCENARIO XML: invalid closing tag at offset ${open}.`);
      }
      const closing = closeMatch[1]!;
      const expected = stack.pop();
      if (!expected || expected !== closing) {
        throw new Error(
          `Malformed OpenSCENARIO XML: closing </${closing}> does not match <${expected ?? "none"}>.`,
        );
      }
      if (stack.length === 0) rootClosed = true;
      cursor = end + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(body);
    const openBody = selfClosing ? body.replace(/\/\s*$/, "").trimEnd() : body;
    const nameMatch = openBody.match(/^([A-Za-z_][\w:.-]*)(?:\s|$)/);
    if (!nameMatch) {
      throw new Error(`Malformed OpenSCENARIO XML: invalid opening tag at offset ${open}.`);
    }
    const name = nameMatch[1]!;
    if (stack.length === 0) {
      if (root || rootClosed) {
        throw new Error("Malformed OpenSCENARIO XML: document has multiple root elements.");
      }
      root = name;
    }
    classifyElement(name, actions, conditions, unknownElements);
    if (!selfClosing) stack.push(name);
    else if (stack.length === 0) rootClosed = true;
    cursor = end + 1;
  }

  if (stack.length > 0) {
    throw new Error(
      `Malformed OpenSCENARIO XML: unclosed <${stack[stack.length - 1]}> element.`,
    );
  }
  if (!root || localName(root) !== "OpenSCENARIO") {
    throw new Error("Malformed OpenSCENARIO XML: root element must be OpenSCENARIO.");
  }
  if (!rootClosed) {
    throw new Error("Malformed OpenSCENARIO XML: root element is not closed.");
  }

  return {
    verdict: unknownElements.length > 0 ? "unsupported" : "faithful",
    actions,
    conditions,
    unknownElements,
  };
}
