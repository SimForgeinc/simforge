"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/app/components/ui/sheet";
import { cn } from "@/app/lib/utils";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import type { SimulationIssue } from "../simulation-issues";
import {
  buildReadinessSummary,
  READINESS_SECTIONS,
  type ReadinessItem,
  type ReadinessSection,
} from "./readiness-model";

const SECTION_COPY: Record<
  ReadinessSection,
  { readonly title: string; readonly empty: string }
> = {
  behavior: {
    title: "Scenario behavior",
    empty: "The preview can run as authored.",
  },
  realism: {
    title: "Realism",
    empty: "No driving realism warnings found.",
  },
  export: {
    title: "Export",
    empty: "No export limitations found.",
  },
};

export function ScenarioReadinessButton({
  issues,
  onSelectIssue,
}: {
  readonly issues: readonly SimulationIssue[];
  readonly onSelectIssue?: (issue: SimulationIssue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<ReadinessSection>("realism");
  const summary = buildReadinessSummary(issues);
  const ready = summary.status === "ready";
  const label = ready ? "Ready" : "Simulation Warnings";

  return (
    <Sheet
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setActiveSection("realism");
      }}
      open={open}
    >
      <SheetTrigger asChild>
        <Button
          aria-label={
            ready
              ? "Scenario readiness: Ready"
              : `Scenario readiness: Simulation warnings, ${summary.issueCount} ${summary.issueCount === 1 ? "item" : "items"}`
          }
          className={cn(
            "h-8 gap-2 rounded-none border bg-card/90 px-3 shadow-sm backdrop-blur",
            ready
              ? "border-emerald-400/35 text-emerald-300 hover:bg-emerald-500/10"
              : "border-amber-400/45 text-amber-200 hover:bg-amber-500/10",
          )}
          data-readiness-status={summary.status}
          data-testid="scenario-readiness-button"
          size="sm"
          title="Check scenario readiness"
          type="button"
          variant="outline"
        >
          {ready ? (
            <CheckCircle2 aria-hidden="true" className="size-4" />
          ) : (
            <AlertTriangle aria-hidden="true" className="size-4" />
          )}
          <span>{label}</span>
          {!ready ? (
            <span
              className="font-mono text-[9px] text-amber-100/70"
              data-testid="scenario-readiness-count"
            >
              {summary.issueCount}
            </span>
          ) : null}
        </Button>
      </SheetTrigger>

      <SheetContent
        className="flex w-[min(420px,calc(100vw-1rem))] flex-col gap-0 overflow-hidden border-border bg-background p-0 sm:max-w-[420px]"
        data-testid="scenario-readiness-drawer"
        side="right"
      >
        <SheetHeader className="border-b border-border px-5 py-5 pr-12">
          <SheetTitle>Scenario readiness</SheetTitle>
          <SheetDescription>
            {ready
              ? "The preview is ready. New concerns will appear here."
              : `${summary.issueCount} ${summary.issueCount === 1 ? "item needs" : "items need"} attention before this scenario is finished.`}
          </SheetDescription>
        </SheetHeader>

        <Tabs
          className="flex min-h-0 flex-1 flex-col"
          onValueChange={(value) => setActiveSection(value as ReadinessSection)}
          value={activeSection}
        >
          <div className="shrink-0 overflow-x-auto border-b border-border px-4 py-3">
            <TabsList
              aria-label="Scenario readiness sections"
              className="grid h-auto min-w-[360px] grid-cols-3 rounded-none bg-muted/60 p-1"
            >
              {READINESS_SECTIONS.map((section) => (
                <TabsTrigger
                  aria-label={summary.groups[section].length > 0
                    ? `${SECTION_COPY[section].title}, ${summary.groups[section].length} ${summary.groups[section].length === 1 ? "item" : "items"}`
                    : SECTION_COPY[section].title}
                  className="gap-1.5 rounded-none px-2 py-2 text-[11px]"
                  key={section}
                  onClick={() => setActiveSection(section)}
                  value={section}
                >
                  {SECTION_COPY[section].title}
                  {summary.groups[section].length > 0 ? (
                    <span className="font-mono text-[9px] text-muted-foreground">
                      {summary.groups[section].length}
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {READINESS_SECTIONS.map((section) => (
              <TabsContent className="m-0" key={section} value={section}>
                <ReadinessGroup
                  items={summary.groups[section]}
                  onSelectIssue={onSelectIssue}
                  section={section}
                />
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function ReadinessGroup({
  items,
  onSelectIssue,
  section,
}: {
  readonly items: readonly ReadinessItem[];
  readonly onSelectIssue?: (issue: SimulationIssue) => void;
  readonly section: ReadinessSection;
}) {
  const copy = SECTION_COPY[section];
  return (
    <section
      aria-labelledby={`readiness-${section}-heading`}
      className="border border-border bg-card/45"
      data-testid={`scenario-readiness-${section}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
        <h3
          className="text-xs font-semibold text-foreground"
          id={`readiness-${section}-heading`}
        >
          {copy.title}
        </h3>
        {items.length === 0 ? (
          <CheckCircle2 aria-label="Looks good" className="size-3.5 text-emerald-400" />
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">{copy.empty}</p>
      ) : (
        <div className="divide-y divide-border/70">
          {items.map((item) => (
            <ReadinessIssueRow
              item={item}
              key={item.issue.id}
              onSelectIssue={onSelectIssue}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReadinessIssueRow({
  item,
  onSelectIssue,
}: {
  readonly item: ReadinessItem;
  readonly onSelectIssue?: (issue: SimulationIssue) => void;
}) {
  const Icon = item.issue.severity === "error" ? CircleAlert : AlertTriangle;
  const content = (
    <div className="flex items-start gap-2.5 text-left">
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          item.issue.severity === "error" ? "text-destructive" : "text-amber-300",
        )}
      />
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{item.title}</p>
        <p className="mt-1 break-words text-[11px] leading-relaxed text-muted-foreground">
          {item.detail}
        </p>
        <div className="mt-2 border-l-2 border-[#E8E044]/70 pl-2.5">
          <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#E8E044]">
            How to fix it
          </p>
          <p className="mt-1 break-words text-[11px] leading-relaxed text-foreground/85">
            {item.solution}
          </p>
        </div>
      </div>
    </div>
  );

  if (onSelectIssue) {
    return (
      <button
        className="block w-full px-3 py-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        data-testid="scenario-readiness-issue"
        onClick={() => onSelectIssue(item.issue)}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <article
      className="px-3 py-3"
      data-testid="scenario-readiness-issue"
      role={item.issue.severity === "error" ? "alert" : "status"}
    >
      {content}
    </article>
  );
}
