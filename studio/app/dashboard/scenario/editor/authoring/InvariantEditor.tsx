"use client";

import { SelectMenuField } from "@/app/components/ui/select-menu";
import type { EditorDocument } from "@simforge-oss/editor";
import { DeleteButton, Heading, MiniAdd, TextField, uniqueId } from "./fields";

const ESSENTIALITY = ["required", "preferred", "cosmetic"] as const;

/**
 * Invariants — the properties a sampled variation must still satisfy.
 *
 * Adding one needs at least one role, and the default is a headway rule between
 * the first two: an invariant with no subject cannot be evaluated, so the add
 * button is disabled rather than producing a rule that always passes.
 */
export function InvariantEditor({ document }: { document: EditorDocument }) {
  const roles = document.data.roles;
  const first = roles[0]?.id;
  const second = roles[1]?.id ?? first;
  const add = () => {
    if (!first || !second) return;
    document.addInvariant({
      id: uniqueId(
        "rule",
        document.data.invariants.map((item) => item.id),
      ),
      kind: "headway",
      of: first,
      to: second,
      range: [1, 3],
      essentiality: "required",
    });
  };

  return (
    <section data-testid="invariant-editor">
      <div className="flex items-center">
        <Heading>Invariants</Heading>
        <MiniAdd label="Add invariant" onClick={add} disabled={!first} />
      </div>
      {document.data.invariants.map((rule) => (
        <div key={rule.id} className="mt-2 bg-muted/30 p-2">
          <div className="flex items-center">
            <span className="truncate">
              {rule.label ?? rule.id} · {rule.kind}
            </span>
            <DeleteButton
              label={`Remove invariant ${rule.label ?? rule.id}`}
              onClick={() => document.removeInvariant(rule.id)}
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <TextField
              label="Label"
              value={rule.label ?? ""}
              onChange={(label) =>
                document.replaceInvariant(rule.id, { ...rule, label })
              }
            />
            <SelectMenuField
              label="Essentiality"
              value={rule.essentiality}
              options={[...ESSENTIALITY]}
              onChange={(essentiality) =>
                document.replaceInvariant(rule.id, {
                  ...rule,
                  essentiality: essentiality as typeof rule.essentiality,
                })
              }
              className="h-8 text-xs"
            />
          </div>
        </div>
      ))}
    </section>
  );
}
