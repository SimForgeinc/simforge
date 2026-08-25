"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSetPageTitle } from "@/app/components/TopBarSlot";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { PageHeader } from "@/app/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import type { EvalPolicySummary, EvalRunComparison } from "@/app/lib/evaluation/contracts";
import { cn } from "@/app/lib/utils";
import { formatDelta, formatScore, PanelMessage, useJsonFetch } from "../../shared";

function PolicySummaryCard({
  label,
  campaignId,
  policy,
}: {
  label: "A" | "B";
  campaignId: string;
  policy: EvalPolicySummary;
}) {
  return (
    <Card data-testid={`compare-${label}`}>
      <CardHeader className="pb-2">
        <CardDescription>Policy {label}</CardDescription>
        <CardTitle className="text-base">
          <Link
            className="hover:underline"
            href={`/dashboard/evaluation/${campaignId}/policies/${policy.policyId}`}
          >
            {policy.policyId}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-x-4 text-sm">
          {(
            [
              ["Score", formatScore(policy.meanScore)],
              ["Route", formatScore(policy.meanRouteCompletion)],
              ["Episodes", String(policy.episodes)],
            ] as const
          ).map(([term, value]) => (
            <div key={term}>
              <dt className="text-xs text-muted-foreground">{term}</dt>
              <dd className="font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export function CompareClient({
  campaignId,
  a,
  b,
}: {
  campaignId: string;
  a: string | null;
  b: string | null;
}) {
  useSetPageTitle("Evaluation");
  const url =
    a && b
      ? `/api/evaluation/campaigns/${campaignId}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`
      : null;
  const state = useJsonFetch<EvalRunComparison>(url);

  if (!a || !b) {
    return <PanelMessage>Pick two policies to compare: ?a=&lt;policyId&gt;&amp;b=&lt;policyId&gt;</PanelMessage>;
  }
  if (state.kind === "loading") return <PanelMessage>Comparing runs…</PanelMessage>;
  if (state.kind === "error") {
    return <PanelMessage>Failed to compare: {state.message}</PanelMessage>;
  }
  const comparison = state.data;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        eyebrow={campaignId}
        title="A/B comparison"
        description={`${a} vs ${b} · divergence threshold ${comparison.divergenceThresholdM} m`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/evaluation">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              All campaigns
            </Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PolicySummaryCard label="A" campaignId={campaignId} policy={comparison.a} />
          <PolicySummaryCard label="B" campaignId={campaignId} policy={comparison.b} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-scenario deltas</CardTitle>
            <CardDescription>
              Score delta is B − A. Divergence is the first trace step where the ego positions
              drift apart by more than {comparison.divergenceThresholdM} m.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {comparison.episodes.length === 0 ? (
              <PanelMessage>No overlapping scenario+seed episodes between these runs.</PanelMessage>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scenario</TableHead>
                    <TableHead className="text-right">Seed</TableHead>
                    <TableHead className="text-right">A score</TableHead>
                    <TableHead className="text-right">B score</TableHead>
                    <TableHead className="text-right">Δ</TableHead>
                    <TableHead>Divergence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparison.episodes.map((episode) => (
                    <TableRow key={`${episode.scenarioId}-${episode.seed}`}>
                      <TableCell className="font-medium">{episode.scenarioId}</TableCell>
                      <TableCell className="text-right font-mono">{episode.seed}</TableCell>
                      <TableCell className="text-right font-mono">
                        {episode.aEpisodeId ? (
                          <Link
                            className="hover:underline"
                            href={`/dashboard/evaluation/${campaignId}/episodes/${episode.aEpisodeId}`}
                          >
                            {formatScore(episode.aScore)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {episode.bEpisodeId ? (
                          <Link
                            className="hover:underline"
                            href={`/dashboard/evaluation/${campaignId}/episodes/${episode.bEpisodeId}`}
                          >
                            {formatScore(episode.bScore)}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono",
                          episode.scoreDelta !== null && episode.scoreDelta > 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : null,
                          episode.scoreDelta !== null && episode.scoreDelta < 0
                            ? "text-destructive"
                            : null,
                        )}
                      >
                        {formatDelta(episode.scoreDelta)}
                      </TableCell>
                      <TableCell>
                        {episode.divergenceStep !== null ? (
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            step {episode.divergenceStep} · {episode.divergenceTS?.toFixed(1)}s
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {episode.aEpisodeId && episode.bEpisodeId ? "none" : "incomplete pair"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
