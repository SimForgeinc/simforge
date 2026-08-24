"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { CarlaCompatibilityPill } from "@/app/components/CarlaCompatibilityPill";
import { Input } from "@/app/components/ui/input";
import { SelectMenu } from "@/app/components/ui/select-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import type { CarlaCompatibility } from "@/app/lib/scenario/carla-compatibility";

export interface CarlaCompatibilityRow {
  catalogId: string;
  label: string;
  source: string;
  objectClass: string;
  dimensions: string | null;
  compatibility: CarlaCompatibility;
}

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "native", label: "CARLA ready" },
  { value: "generated-pack", label: "CARLA pack required" },
  { value: "browser-only", label: "Browser only" },
];

export function CarlaCompatibilityTable({ rows }: { rows: CarlaCompatibilityRow[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | CarlaCompatibility["status"]>("all");

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((row) => {
      if (status !== "all" && row.compatibility.status !== status) return false;
      if (!needle) return true;
      const detail = row.compatibility.status === "native"
        ? row.compatibility.blueprintId
        : row.compatibility.reason;
      return [row.catalogId, row.label, row.source, row.objectClass, detail]
        .some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [query, rows, status]);

  return (
    <section aria-label="CARLA compatibility catalog" className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/30" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search objects, classes, or blueprints"
            aria-label="Search CARLA compatibility"
            className="border-white/10 bg-white/[0.035] pl-9"
          />
        </div>
        <SelectMenu
          value={status}
          onChange={(value) => setStatus(value as typeof status)}
          options={STATUS_OPTIONS}
          label="Filter by compatibility status"
          className="sm:w-56"
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
        <Table className="min-w-[1050px] text-xs">
          <TableHeader className="bg-white/[0.035] [&_tr]:border-white/[0.08]">
            <TableRow className="border-white/[0.08] hover:bg-transparent">
              <TableHead className="h-10 text-white/40">Object</TableHead>
              <TableHead className="h-10 text-white/40">Source</TableHead>
              <TableHead className="h-10 text-white/40">Class</TableHead>
              <TableHead className="h-10 text-white/40">Dimensions</TableHead>
              <TableHead className="h-10 text-white/40">Status</TableHead>
              <TableHead className="h-10 text-white/40">CARLA blueprint</TableHead>
              <TableHead className="h-10 text-white/40">Agreement</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.map((row) => {
              const native = row.compatibility.status === "native" ? row.compatibility : null;
              return (
                <TableRow key={row.catalogId} className="border-white/[0.06] hover:bg-white/[0.025]">
                  <TableCell className="py-2.5">
                    <p className="font-medium text-white/85">{row.label}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-white/35">{row.catalogId}</p>
                  </TableCell>
                  <TableCell className="py-2.5 text-white/55">{row.source}</TableCell>
                  <TableCell className="py-2.5 capitalize text-white/55">{row.objectClass.replaceAll("_", " ")}</TableCell>
                  <TableCell className="py-2.5 tabular-nums text-white/55">{row.dimensions ?? "—"}</TableCell>
                  <TableCell className="py-2.5"><CarlaCompatibilityPill compatibility={row.compatibility} size="sm" /></TableCell>
                  <TableCell className="max-w-sm py-2.5">
                    {row.compatibility.status === "native"
                      ? <span className="font-mono text-[11px] text-white/65">{row.compatibility.blueprintId}</span>
                      : <span className="text-white/45">{row.compatibility.reason}</span>}
                  </TableCell>
                  <TableCell className="py-2.5 capitalize text-white/55">{native?.dimensionalAgreement ?? "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {filteredRows.length === 0 ? (
          <div className="border-t border-white/[0.06] px-4 py-12 text-center text-sm text-white/40">
            No catalog objects match these filters.
          </div>
        ) : null}
      </div>
      <p className="text-xs tabular-nums text-white/35">Showing {filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()} objects</p>
    </section>
  );
}
