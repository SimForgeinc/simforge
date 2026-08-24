"use client";

import { Badge } from "@/app/components/ui/badge";
import type { LlmToolCallRecord } from "@/app/lib/maps/frontend/use-map-search-llm";

const RELATION_OP_LABEL: Record<
  NonNullable<LlmToolCallRecord["structured"]["relation"]>["op"],
  string
> = {
  near: "near",
  adjacent_to: "adjacent to",
  within: "within",
  leads_to: "leading to",
  connected_to: "connected to",
  upstream_of: "before",
  downstream_of: "after",
};

/**
 * Renders the model's extended-thinking output, one card per tool-loop
 * iteration. Populated only when `ANTHROPIC_THINKING_ENABLED=true`
 * (dev only by default). On staging/prod or when thinking is otherwise
 * off, `reasoning` is empty and this returns null.
 */
export function ReasoningDebug({ reasoning }: { reasoning: string[] }) {
  if (reasoning.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 p-2 text-[10px]">
      <p className="font-semibold text-foreground">
        Reasoning — {reasoning.length} iteration{reasoning.length === 1 ? "" : "s"}
      </p>
      {reasoning.map((text, idx) => (
        <details
          key={idx}
          className="space-y-1 rounded-sm border border-amber-500/30 bg-background/40 p-1.5"
        >
          <summary className="cursor-pointer text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
            #{idx + 1} — {text.length} chars
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-muted-foreground">
            {text}
          </pre>
        </details>
      ))}
    </div>
  );
}

/**
 * Debug-mode rendering of every `search_map` invocation the LLM made for
 * the current assistant turn.
 */
export function ToolCallsDebug({ toolCalls }: { toolCalls: LlmToolCallRecord[] }) {
  if (toolCalls.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/70 bg-secondary/20 px-2 py-1.5 text-[10px] text-muted-foreground">
        No <span className="font-mono">search_map</span> calls — answered from the catalog fast-path.
      </div>
    );
  }
  return (
    <div className="space-y-1.5 rounded-md border border-dashed border-border/70 bg-secondary/20 p-2 text-[10px]">
      <p className="font-semibold text-foreground">
        {toolCalls.length} <span className="font-mono">search_map</span> call{toolCalls.length === 1 ? "" : "s"}
      </p>
      {toolCalls.map((call) => (
        <div
          key={call.callIndex}
          className="space-y-1 rounded-sm border border-border/40 bg-background/40 p-1.5"
        >
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              #{call.callIndex + 1}
            </span>
            <StructuredQueryPills structured={call.structured} />
          </div>
          <p className="pl-6 text-muted-foreground">
            <span className="text-foreground">{call.result.resultCount}</span> results
            {" / "}
            <span className="text-foreground">{call.result.totalDocuments}</span> docs
            {call.limit != null ? (
              <>
                {" · "}limit <span className="text-foreground">{call.limit}</span>
              </>
            ) : null}
          </p>
          {call.result.parseHints && call.result.parseHints.length > 0 ? (
            <div className="space-y-0.5 pl-6">
              {call.result.parseHints.map((h, i) => (
                <p
                  key={`${call.callIndex}-hint-${i}`}
                  className="text-amber-300"
                  title={h.message}
                >
                  ⚠ <span className="font-mono">{h.code}</span> — {h.message}
                </p>
              ))}
            </div>
          ) : null}
          {call.result.topResults.length > 0 ? (
            <div className="space-y-0.5 pl-6 text-muted-foreground">
              {call.result.topResults.slice(0, 3).map((r) => (
                <p key={`${call.callIndex}-top-${r.id}`} className="truncate">
                  <span className="font-mono text-foreground/80">{r.id}</span>{" "}
                  <span className="text-foreground">{r.title}</span>{" "}
                  <span>· {r.subtype}</span>
                </p>
              ))}
              {call.result.topResults.length > 3 ? (
                <p className="italic text-muted-foreground/80">
                  + {call.result.topResults.length - 3} more
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function StructuredQueryPills({
  structured,
}: {
  structured: LlmToolCallRecord["structured"];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <ObjectIntentPills intent={structured.subject} />
      {structured.relation ? (
        <>
          <Badge
            variant="outline"
            className="border-primary/40 bg-primary/10 px-1 py-0 text-[10px] text-primary"
          >
            {RELATION_OP_LABEL[structured.relation.op] ?? structured.relation.op}
            {structured.relation.distance_m != null
              ? ` ${structured.relation.distance_m} m`
              : null}
          </Badge>
          <ObjectIntentPills intent={structured.relation.object} />
        </>
      ) : null}
    </div>
  );
}

function ObjectIntentPills({
  intent,
}: {
  intent: LlmToolCallRecord["structured"]["subject"];
}) {
  const families = intent.families ?? [];
  const semantic = intent.semantic ?? [];
  const freeText = intent.freeText ?? [];
  if (families.length === 0 && semantic.length === 0 && freeText.length === 0) {
    return (
      <span className="font-mono italic text-muted-foreground/70">∅</span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {families.map((f) => (
        <Badge
          key={`fam-${f}`}
          variant="secondary"
          className="border-transparent bg-muted/60 px-1 py-0 font-mono text-[10px] text-foreground"
        >
          {f}
        </Badge>
      ))}
      {semantic.map((s) => (
        <Badge
          key={`sem-${s}`}
          variant="secondary"
          className="border-transparent bg-secondary/60 px-1 py-0 font-mono text-[10px] text-foreground"
        >
          {s}
        </Badge>
      ))}
      {freeText.map((t) => (
        <Badge
          key={`ft-${t}`}
          variant="outline"
          className="border-dashed bg-transparent px-1 py-0 font-mono text-[10px] text-muted-foreground"
        >
          {t}
        </Badge>
      ))}
    </div>
  );
}
