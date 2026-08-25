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
import type { EvalPolicyDetail } from "@/app/lib/evaluation/contracts";
import { formatScore, PanelMessage, StatusBadge, useJsonFetch } from "../../../shared";

function ProvenanceCard({ detail }: { detail: EvalPolicyDetail }) {
  const provenance = detail.provenanceSample;
  if (!provenance) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provenance</CardTitle>
        </CardHeader>
        <CardContent>
          <PanelMessage>No provenance.json recorded for this policy.</PanelMessage>
        </CardContent>
      </Card>
    );
  }
  const rows: Array<[string, React.ReactNode]> = [
    ["Policy kind", provenance.policy.kind ?? "—"],
    ["Adapter", provenance.policy.adapterVersion ?? "—"],
    [
      "Checkpoint digest",
      provenance.policy.checkpointDigest
        ? `${provenance.policy.checkpointDigest.slice(0, 16)}…`
        : "—",
    ],
    ["Seed", String(provenance.seed)],
    ["Decision rate", provenance.decisionHz ? `${provenance.decisionHz} Hz` : "—"],
    [
      "Model version",
      detail.policy.modelVersionId ? (
        <Link
          className="font-mono text-xs hover:underline"
          href={`/dashboard/evaluation/versions/${detail.policy.modelVersionId}`}
        >
          {detail.policy.modelVersionId}
        </Link>
      ) : (
        "not in registry"
      ),
    ],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Provenance</CardTitle>
        <CardDescription>From the first completed episode of this policy</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 break-all text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export function PolicyDetailClient({
  campaignId,
  policyId,
}: {
  campaignId: string;
  policyId: string;
}) {
  useSetPageTitle("Evaluation");
  const state = useJsonFetch<EvalPolicyDetail>(
    `/api/evaluation/campaigns/${campaignId}/policies/${policyId}`,
  );

  if (state.kind === "loading") return <PanelMessage>Loading policy run…</PanelMessage>;
  if (state.kind === "error") {
    return <PanelMessage>Failed to load policy run: {state.message}</PanelMessage>;
  }
  const detail = state.data;
  const infractionsTotal = detail.episodes.reduce(
    (sum, episode) =>
      sum +
      Object.values(episode.score?.infractions ?? {}).reduce((inner, count) => inner + count, 0),
    0,
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        eyebrow={campaignId}
        title={policyId}
        description="Policy run — one column of the campaign"
        actions={
          <>
            <StatusBadge status="complete" />
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/evaluation">
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                All campaigns
              </Link>
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(
            [
              ["Mean driving score", formatScore(detail.policy.meanScore)],
              ["Mean route completion", formatScore(detail.policy.meanRouteCompletion)],
              ["Episodes", String(detail.policy.episodes)],
              ["Infractions", String(infractionsTotal)],
            ] as const
          ).map(([label, value]) => (
            <Card key={label}>
              <CardHeader className="pb-2">
                <CardDescription>{label}</CardDescription>
                <CardTitle className="font-mono text-2xl">{value}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>

        <ProvenanceCard detail={detail} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Episodes</CardTitle>
            <CardDescription>Per-scenario scores and infractions</CardDescription>
          </CardHeader>
          <CardContent>
            {detail.episodes.length === 0 ? (
              <PanelMessage>No completed episodes in the ledger yet.</PanelMessage>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scenario</TableHead>
                    <TableHead className="text-right">Seed</TableHead>
                    <TableHead className="text-right">Driving score</TableHead>
                    <TableHead className="text-right">Route</TableHead>
                    <TableHead className="text-right">Steps</TableHead>
                    <TableHead>Infractions</TableHead>
                    <TableHead className="text-right">Completed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.episodes.map((episode) => (
                    <TableRow key={episode.episodeId}>
                      <TableCell>
                        <Link
                          className="font-medium hover:underline"
                          href={`/dashboard/evaluation/${campaignId}/episodes/${episode.episodeId}`}
                        >
                          {episode.scenarioId}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right font-mono">{episode.seed}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatScore(episode.score?.drivingScore ?? episode.ledgerScore)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatScore(episode.score?.routeCompletion ?? episode.ledgerRouteCompletion)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {episode.score?.steps ?? "—"}
                      </TableCell>
                      <TableCell>
                        {Object.keys(episode.score?.infractions ?? {}).length === 0 ? (
                          <span className="text-xs text-muted-foreground">none</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(episode.score?.infractions ?? {}).map(
                              ([type, count]) => (
                                <Badge
                                  key={type}
                                  variant="destructive"
                                  className="font-mono text-[10px]"
                                >
                                  {type}
                                  {count > 1 ? ` ×${count}` : ""}
                                </Badge>
                              ),
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {new Date(episode.completedAt).toLocaleTimeString()}
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
