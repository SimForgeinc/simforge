import type { ScenarioStatus } from "@simforge-oss/studio-shared";
import { Clock, Loader2, CheckCheck, X } from "lucide-react";
import { Badge } from "@/app/components/ui/badge";

type StatusConfig = {
  label: string;
  icon: React.ReactNode;
  className: string;
};

const CONFIG: Record<ScenarioStatus, StatusConfig> = {
  DRAFT: {
    label: "Draft",
    icon: <Clock className="size-3.5" aria-hidden="true" />,
    className:
      "bg-gray-500/15 text-gray-400 border-gray-500/20 hover:bg-gray-500/15",
  },
  FINALIZED: {
    label: "Finalized",
    icon: <CheckCheck className="size-3.5" aria-hidden="true" />,
    className:
      "bg-green-500/15 text-green-400 border-green-500/20 hover:bg-green-500/15",
  },
  // Keep backward compat with old RunStatusType values that may still be in data
  QUEUED: {
    label: "Queued",
    icon: <Clock className="size-3.5" aria-hidden="true" />,
    className:
      "bg-yellow-500/15 text-yellow-400 border-yellow-500/20 hover:bg-yellow-500/15",
  },
  RUNNING: {
    label: "Running",
    icon: <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />,
    className:
      "bg-blue-500/15 text-blue-400 border-blue-500/20 hover:bg-blue-500/15",
  },
  COMPLETED: {
    label: "Succeeded",
    icon: <CheckCheck className="size-3.5" aria-hidden="true" />,
    className:
      "bg-green-500/15 text-green-400 border-green-500/20 hover:bg-green-500/15",
  },
  FAILED: {
    label: "Failed",
    icon: <X className="size-3.5" aria-hidden="true" />,
    className:
      "bg-red-500/15 text-red-400 border-red-500/20 hover:bg-red-500/15",
  },
} as Record<string, StatusConfig>;

interface ScenarioStatusBadgeProps {
  status: string;
}

export function ScenarioStatusBadge({ status }: ScenarioStatusBadgeProps) {
  const config = (CONFIG as Record<string, StatusConfig>)[status] ?? CONFIG.DRAFT;
  const { label, icon, className } = config;
  return (
    <Badge
      title={label}
      aria-label={label}
      className={`h-6 w-6 shrink-0 cursor-default justify-center p-0 ${className}`}
    >
      {icon}
    </Badge>
  );
}

