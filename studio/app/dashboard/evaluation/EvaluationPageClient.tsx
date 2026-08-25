"use client";

import { FlaskConical, GitCompareArrows } from "lucide-react";
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
import { EmptyState } from "@/app/components/ui/empty-state";
import { PageHeader } from "@/app/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import type { EvalCampaignSummary } from "@/app/lib/evaluation/contracts";
import type { ModelVersionRecord } from "@/app/lib/models/contracts";
import { formatScore, PanelMessage, StatusBadge, useJsonFetch } from "./shared";

function CampaignCard({ campaign }: { campaign: EvalCampaignSummary }) {
  const [policyA, policyB] = campaign.policies;
  return (
    <Card data-testid={`campaign-${campaign.campaignId}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">{campaign.name}</CardTitle>
          <CardDescription>
            {campaign.campaignId} · {campaign.episodes} episodes
            {campaign.createdAt ? ` · created ${new Date(campaign.createdAt).toLocaleString()}` : ""}
            {campaign.hasReport ? " · report ready" : ""}
          </CardDescription>
        </div>
        {policyA && policyB ? (
          <Button asChild variant="outline" size="sm">
            <Link
              href={{
                pathname: `/dashboard/evaluation/${campaign.campaignId}/compare`,
                query: { a: policyA.policyId, b: policyB.policyId },
              }}
            >
              <GitCompareArrows className="mr-1.5 h-4 w-4" />
              Compare A/B
            </Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Policy (run)</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Model version</TableHead>
              <TableHead className="text-right">Driving score</TableHead>
              <TableHead className="text-right">Route completion</TableHead>
              <TableHead className="text-right">Episodes</TableHead>
              <TableHead className="text-right">Last completed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaign.policies.map((policy) => (
              <TableRow key={policy.policyId}>
                <TableCell>
                  <Link
                    className="font-medium text-foreground hover:underline"
                    href={`/dashboard/evaluation/${campaign.campaignId}/policies/${policy.policyId}`}
                  >
                    {policy.policyId}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge status="complete" />
                </TableCell>
                <TableCell>
                  {policy.modelVersionId ? (
                    <Link
                      className="font-mono text-xs text-muted-foreground hover:underline"
                      href={`/dashboard/evaluation/versions/${policy.modelVersionId}`}
                    >
                      {policy.modelVersionId.slice(0, 12)}…
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">unregistered</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatScore(policy.meanScore)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatScore(policy.meanRouteCompletion)}
                </TableCell>
                <TableCell className="text-right font-mono">{policy.episodes}</TableCell>
                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                  {policy.lastCompletedAt
                    ? new Date(policy.lastCompletedAt).toLocaleTimeString()
                    : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ModelVersionsCard({ versions }: { versions: ModelVersionRecord[] }) {
  return (
    <Card data-testid="model-versions">
      <CardHeader>
        <CardTitle className="text-base">Model versions</CardTitle>
        <CardDescription>
          Registry state and promotion gates — promote from a version&apos;s detail page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {versions.length === 0 ? (
          <PanelMessage>No registered model versions.</PanelMessage>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Family</TableHead>
                <TableHead>Quant</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Promoted run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((version) => (
                <TableRow key={version.id}>
                  <TableCell>
                    <Link
                      className="font-medium hover:underline"
                      href={`/dashboard/evaluation/versions/${version.id}`}
                    >
                      {version.name}
                    </Link>
                  </TableCell>
                  <TableCell>{version.family}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{version.quant}</Badge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={version.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {version.promotedRunId ? `${version.promotedRunId.slice(0, 12)}…` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function EvaluationPageClient() {
  useSetPageTitle("Evaluation");
  const campaigns = useJsonFetch<{ campaigns: EvalCampaignSummary[] }>(
    "/api/evaluation/campaigns",
  );
  const versions = useJsonFetch<{ versions: ModelVersionRecord[] }>("/api/models/versions");

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title="Evaluation"
        description="Closed-loop eval campaigns, episode playback, and model promotion gates."
      />
      <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        {campaigns.kind === "loading" ? <PanelMessage>Loading campaigns…</PanelMessage> : null}
        {campaigns.kind === "error" ? (
          <PanelMessage>Failed to load campaigns: {campaigns.message}</PanelMessage>
        ) : null}
        {campaigns.kind === "ready" && campaigns.data.campaigns.length === 0 ? (
          <EmptyState
            icon={<FlaskConical className="h-8 w-8" />}
            title="No eval campaigns yet"
            description="Campaign ledgers are read from the runs root (simforge-assets/runs/<campaignId>/ledger.jsonl)."
          />
        ) : null}
        {campaigns.kind === "ready"
          ? campaigns.data.campaigns.map((campaign) => (
              <CampaignCard key={campaign.campaignId} campaign={campaign} />
            ))
          : null}
        {versions.kind === "ready" ? (
          <ModelVersionsCard versions={versions.data.versions} />
        ) : null}
      </div>
    </div>
  );
}
