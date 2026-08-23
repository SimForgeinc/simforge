import { Badge } from "@/app/components/ui/badge";
import { cn } from "@/app/lib/utils";
import {
  CARLA_COMPATIBILITY_HINT,
  CARLA_COMPATIBILITY_LABEL,
  type CarlaCompatibility,
} from "@/app/lib/uniscenario/carla-compatibility";

interface CarlaCompatibilityPillProps {
  compatibility: CarlaCompatibility;
  size?: "sm" | "md";
}

const STATUS_CLASS: Record<CarlaCompatibility["status"], string> = {
  native: "border-sky-400/25 bg-sky-400/15 text-sky-200 hover:bg-sky-400/15",
  "generated-pack": "border-transparent bg-muted text-muted-foreground hover:bg-muted",
  "browser-only": "border-border bg-transparent text-muted-foreground",
};

export function CarlaCompatibilityPill({
  compatibility,
  size = "sm",
}: CarlaCompatibilityPillProps) {
  const detail = compatibility.status === "native"
    ? `Blueprint: ${compatibility.blueprintId}`
    : compatibility.reason;

  return (
    <Badge
      variant={compatibility.status === "browser-only" ? "outline" : "secondary"}
      data-carla-compatibility={compatibility.status}
      title={`${CARLA_COMPATIBILITY_HINT[compatibility.status]} ${detail}`}
      className={cn(
        "shrink-0 cursor-default gap-1 whitespace-nowrap font-medium",
        size === "sm" ? "h-5 px-1.5 py-0 text-[10px]" : "h-6 px-2 py-0.5 text-xs",
        STATUS_CLASS[compatibility.status],
      )}
    >
      <span>{CARLA_COMPATIBILITY_LABEL[compatibility.status]}</span>
    </Badge>
  );
}
