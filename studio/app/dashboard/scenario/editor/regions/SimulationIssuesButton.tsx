"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleQuestionMark,
  Dot,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/app/components/ui/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import { cn } from "@/app/lib/utils";
import type { SimulationIssue } from "../simulation-issues";

export function SimulationIssuesButton({
  issues,
}: {
  issues: readonly SimulationIssue[];
}) {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const hasIssues = issues.length > 0;
  const issueState = errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "clear";
  const Icon = issueState === "error"
    ? CircleQuestionMark
    : issueState === "warning"
      ? TriangleAlert
      : Dot;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          aria-label={
            hasIssues
              ? `Simulation issues: ${errorCount} errors, ${warningCount} warnings`
              : "Simulation issues: none"
          }
          className="h-8 gap-2 rounded-none border border-border bg-card/90 px-3 shadow-sm backdrop-blur"
          data-error-count={errorCount}
          data-issue-state={issueState}
          data-testid="simulation-issues-button"
          data-warning-count={warningCount}
          size="sm"
          title="Open simulation errors and warnings"
          type="button"
          variant="outline"
        >
          <Icon
            aria-hidden="true"
            className={cn(
              "size-4",
              issueState === "clear" && "text-emerald-400",
              issueState === "error" && "text-destructive",
              issueState === "warning" && "text-amber-300",
            )}
            data-testid={`simulation-issues-icon-${issueState}`}
          />
          <span>Simulation warnings</span>
          <span
            className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground"
            data-testid="simulation-issues-count"
          >
            {issues.length}
          </span>
        </Button>
      </SheetTrigger>
      <SheetContent
        className="flex w-[min(440px,calc(100vw-1rem))] flex-col gap-0 overflow-hidden border-border bg-background p-0 sm:max-w-[440px]"
        data-testid="simulation-issues-drawer"
        side="right"
      >
        <SheetHeader className="border-b border-border px-5 py-5 pr-12">
          <SheetTitle>Simulation issues</SheetTitle>
          <SheetDescription>
            Errors and warnings from scenario preparation, omitted interactions,
            and browser playback.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {hasIssues ? (
            <Tabs defaultValue={errorCount > 0 ? "errors" : "warnings"}>
              <TabsList className="grid w-full grid-cols-2" data-testid="simulation-issues-tabs">
                <TabsTrigger value="errors">Errors {errorCount}</TabsTrigger>
                <TabsTrigger value="warnings">Warnings {warningCount}</TabsTrigger>
              </TabsList>
              <TabsContent data-testid="simulation-errors-panel" value="errors">
                <IssueList emptyLabel="No simulation errors" issues={errors} />
              </TabsContent>
              <TabsContent data-testid="simulation-warnings-panel" value="warnings">
                <IssueList emptyLabel="No simulation warnings" issues={warnings} />
              </TabsContent>
            </Tabs>
          ) : (
            <div
              className="grid min-h-48 place-items-center border border-dashed border-border p-6 text-center"
              data-testid="simulation-issues-empty"
            >
              <div>
                <CheckCircle2 aria-hidden="true" className="mx-auto size-6 text-emerald-400" />
                <p className="mt-3 text-sm font-medium text-foreground">
                  No simulation issues
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  New playback or submission failures will appear here.
                </p>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function IssueList({
  emptyLabel,
  issues,
}: {
  emptyLabel: string;
  issues: readonly SimulationIssue[];
}) {
  if (issues.length === 0) {
    return (
      <p className="border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {issues.map((issue) => {
        const IssueIcon = issue.severity === "error" ? CircleAlert : AlertTriangle;
        return (
          <article
            className={cn(
              "border p-3",
              issue.severity === "error"
                ? "border-destructive/50 bg-destructive/10"
                : "border-amber-400/40 bg-amber-500/10",
            )}
            data-severity={issue.severity}
            data-testid="simulation-issue"
            key={issue.id}
            role={issue.severity === "error" ? "alert" : "status"}
          >
            <div className="flex items-start gap-2.5">
              <IssueIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{issue.title}</p>
                <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                  {issue.detail}
                </p>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
