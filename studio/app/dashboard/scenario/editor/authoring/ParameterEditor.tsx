"use client";

import { SelectMenuField } from "@/app/components/ui/select-menu";
import type { ParamDecl } from "@simforge-oss/scenario";
import type { EditorDocument } from "@simforge-oss/editor";
import {
  DeleteButton,
  Heading,
  MiniAdd,
  NumberField,
  TextField,
  numberOr,
  uniqueId,
} from "./fields";

const PARAM_TYPES = ["continuous", "discrete", "categorical", "derived"] as const;

/**
 * Parameter declarations — the variation surface the sampler draws from.
 *
 * Changing a parameter's type replaces the declaration rather than patching it,
 * because the shape differs per type (a range, a value list, an expression) and
 * a patched-over declaration would carry fields its own type does not have.
 */
export function ParameterEditor({ document }: { document: EditorDocument }) {
  const declarations = document.data.params.declarations;
  const add = () =>
    document.addParameter({
      id: uniqueId(
        "parameter",
        declarations.map((item) => item.id),
      ),
      type: "continuous",
      range: [0, 1],
      default: 0.5,
      distribution: "uniform",
      tier: 2,
    });

  return (
    <section data-testid="parameter-editor">
      <div className="flex items-center">
        <Heading>Parameters</Heading>
        <MiniAdd label="Add parameter" onClick={add} />
      </div>
      {declarations.map((param) => (
        <div
          key={param.id}
          className="mt-2 border border-border bg-muted/20 p-2"
        >
          <div className="flex items-center">
            <span className="font-mono">{param.id}</span>
            <DeleteButton
              label={`Remove parameter ${param.id}`}
              onClick={() => document.removeParameter(param.id)}
            />
          </div>
          <div className="mt-2">
            <TextField
              label="Description"
              value={param.description ?? ""}
              placeholder="Description"
              onChange={(description) =>
                document.replaceParameter(param.id, { ...param, description })
              }
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <SelectMenuField
              label="Type"
              value={param.type}
              options={[...PARAM_TYPES]}
              onChange={(type) =>
                document.replaceParameter(
                  param.id,
                  parameterAs(type as ParamDecl["type"], param.id),
                )
              }
              className="h-8 text-xs"
            />
            {param.type === "continuous" ? (
              <>
                <NumberField
                  label="Minimum"
                  value={numberOr(param.range[0], 0)}
                  onChange={(min) =>
                    document.replaceParameter(param.id, {
                      ...param,
                      range: [min, param.range[1]],
                    })
                  }
                />
                <NumberField
                  label="Maximum"
                  value={numberOr(param.range[1], 1)}
                  onChange={(max) =>
                    document.replaceParameter(param.id, {
                      ...param,
                      range: [param.range[0], max],
                    })
                  }
                />
              </>
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}

function parameterAs(type: ParamDecl["type"], id: string): ParamDecl {
  if (type === "continuous") {
    return {
      id,
      type,
      range: [0, 1],
      default: 0.5,
      distribution: "uniform",
      tier: 2,
    };
  }
  if (type === "discrete") return { id, type, values: [0, 1], default: 0, tier: 2 };
  if (type === "categorical") {
    return { id, type, values: ["default"], default: "default", tier: 2 };
  }
  return { id, type, expr: { kind: "num", value: 0 }, tier: 2 };
}
