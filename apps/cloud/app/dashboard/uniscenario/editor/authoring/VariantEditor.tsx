"use client";

import type { Variant } from "@uniscenarios/scenario-model";
import type { EditorDocument } from "@uniscenarios/editor-core";
import { DeleteButton, Heading, MiniAdd, TextField, uniqueId } from "./fields";

/**
 * Variants — named renditions expressed as override paths on the base document.
 *
 * Only the first override's path is editable here. That is a real limitation, not
 * a simplification: manifest section 10 (cross-map variations) is the port that
 * gives this a full override list, and until then editing override[0] is the one
 * operation that cannot corrupt the rest of the list.
 */
export function VariantEditor({ document }: { document: EditorDocument }) {
  const add = () => {
    const variant: Variant = {
      id: uniqueId(
        "variant",
        document.data.variants.map((item) => item.id),
      ),
      label: "Authored rendition",
      when: [{ left: 1, op: ">=", right: 1 }],
      overrides: [{ path: "environment.weather", op: "set", value: "clear" }],
    };
    document.addVariant(variant);
  };

  return (
    <section data-testid="variant-editor">
      <div className="flex items-center">
        <Heading>Variants</Heading>
        <MiniAdd label="Add variant" onClick={add} />
      </div>
      {document.data.variants.map((variant) => (
        <div key={variant.id} className="mt-2 bg-muted/30 p-2">
          <div className="flex items-center">
            <span className="truncate">{variant.label ?? variant.id}</span>
            <DeleteButton
              label={`Remove variant ${variant.label ?? variant.id}`}
              onClick={() => document.removeVariant(variant.id)}
            />
          </div>
          <div className="mt-2 space-y-2">
            <TextField
              label="Variant label"
              value={variant.label ?? ""}
              placeholder="Variant label"
              onChange={(label) =>
                document.replaceVariant(variant.id, { ...variant, label })
              }
            />
            <TextField
              label="Override path"
              value={variant.overrides[0]?.path ?? "environment.weather"}
              className="font-mono text-micro"
              onChange={(path) => {
                const first =
                  variant.overrides[0] ??
                  ({ op: "set", value: "clear", path: "environment.weather" } as const);
                document.replaceVariant(variant.id, {
                  ...variant,
                  overrides: [{ ...first, path }, ...variant.overrides.slice(1)],
                });
              }}
            />
          </div>
        </div>
      ))}
    </section>
  );
}
