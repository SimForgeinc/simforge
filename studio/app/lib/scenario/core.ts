import { createHash, randomUUID } from "node:crypto";
import { canonicalize, serializeTemplate, type ScenarioTemplateV2 } from "@simforge/scenario";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalContentSha256(value: ScenarioTemplateV2): string {
  return sha256(serializeTemplate(value));
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function scenarioId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
