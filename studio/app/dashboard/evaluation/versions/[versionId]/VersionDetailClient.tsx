"use client";

import { ArrowLeft, ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import type {
  ModelEndpointRecord,
  ModelRunRecord,
  ModelVersionRecord,
} from "@/app/lib/models/contracts";
import { PanelMessage, StatusBadge, useJsonFetch } from "../../shared";

type PromotionResult =
  | { kind: "promoted"; runId: string }
  | { kind: "refused"; runId: string; reason: string };

export function VersionDetailClient({ versionId }: { versionId: string }) {
  useSetPageTitle("Evaluation");
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [result, setResult] = useState<PromotionResult | null>(null);

  const version = useJsonFetch<{ version: ModelVersionRecord; endpoints: ModelEndpointRecord[] }>(
    `/api/models/versions/${versionId}`,
    refreshKey,
  );
  const runs = useJsonFetch<{ runs: ModelRunRecord[] }>(
    `/api/models/runs?modelVersionId=${encodeURIComponent(versionId)}`,
    refreshKey,
  );

  async function promote(runId: string) {
    setPendingRunId(runId);
    setResult(null);
    try {
      const response = await fetch(`/api/models/versions/${versionId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      if (response.ok) {
        setResult({ kind: "promoted", runId });
        setRefreshKey((key) => key + 1);
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        detail?: string;
      } | null;
      setResult({
        kind: "refused",
        runId,
        reason: body?.detail ?? body?.error ?? `HTTP ${response.status}`,
      });
    } catch (error) {
      setResult({
        kind: "refused",
        runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingRunId(null);
    }
  }

  if (version.kind === "loading") return <PanelMessage>Loading model version…</PanelMessage>;
  if (version.kind === "error") {
    return <PanelMessage>Failed to load version: {version.message}</PanelMessage>;
  }
  const record = version.data.version;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        eyebrow={record.family}
        title={record.name}
        description={`Model version ${record.id}`}
        actions={
          <>
            <StatusBadge status={record.status} />
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/evaluation">
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                Evaluation
              </Link>
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Version</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              {(
                [
                  ["Source", record.source],
                  ["Quant", record.quant],
                  ["License", record.license],
                  ["Checkpoint digest", `${record.checkpointDigest.slice(0, 16)}…`],
                  ["Promoted run", record.promotedRunId ?? "—"],
                  ["Registered", new Date(record.createdAt).toLocaleString()],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                  <dd className="mt-0.5 break-all font-mono text-xs text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        {result ? (
          <div
            data-testid="promotion-result"
            className={
              result.kind === "promoted"
                ? "flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
                : "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            }
          >
            {result.kind === "promoted" ? (
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>
              {result.kind === "promoted"
                ? `Promoted on evidence of run ${result.runId}.`
                : `Promotion refused for run ${result.runId}: ${result.reason}`}
            </span>
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Eval runs</CardTitle>
            <CardDescription>
              The promotion gate requires a succeeded openloop or policy_episode run of this
              version — the database trigger is the arbiter, refusals surface here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {runs.kind === "loading" ? <PanelMessage>Loading runs…</PanelMessage> : null}
            {runs.kind === "error" ? (
              <PanelMessage>Failed to load runs: {runs.message}</PanelMessage>
            ) : null}
            {runs.kind === "ready" && runs.data.runs.length === 0 ? (
              <PanelMessage>No eval runs recorded for this version.</PanelMessage>
            ) : null}
            {runs.kind === "ready" && runs.data.runs.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                    <TableHead className="text-right">Promote</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.data.runs.map((run) => (
                    <TableRow key={run.id} data-testid={`model-run-${run.id}`}>
                      <TableCell className="font-mono text-xs">{run.id}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{run.kind}</Badge>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={run.status} />
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {run.attemptCount}/{run.maxAttempts}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {new Date(run.createdAt).toLocaleTimeString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {record.promotedRunId === run.id ? (
                          <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                            promoted
                          </Badge>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingRunId !== null}
                            data-testid={`promote-${run.id}`}
                            onClick={() => void promote(run.id)}
                          >
                            {pendingRunId === run.id ? "Promoting…" : "Promote"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
