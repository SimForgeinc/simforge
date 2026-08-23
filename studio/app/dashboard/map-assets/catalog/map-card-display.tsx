import type { ComponentType } from "react";
import { Route, GitFork, OctagonAlert, Bike, Bus, Footprints, PersonStanding, Box, CirclePlay } from "lucide-react";
import { TrafficLightIcon } from "@/app/components/icons/TrafficLightIcon";
import { cn } from "@/app/lib/utils";
import type { CardStat, CardStatIconKey, MapCapabilities } from "./map-card-data";

type IconProps = { className?: string };

const STAT_ICONS: Record<CardStatIconKey, ComponentType<IconProps>> = {
  route: Route,
  junction: GitFork,
  signal: TrafficLightIcon,
  stop: OctagonAlert,
  bike: Bike,
  sidewalk: PersonStanding,
  crosswalk: Footprints,
  bus: Bus,
};

type Size = "md" | "sm";

/** Wrapping row of quick stats. `sm` is tuned for the narrow map-view rail. */
export function CardStatsRow({ stats, size = "md" }: { stats: CardStat[]; size?: Size }) {
  if (stats.length === 0) return null;
  const iconCls = size === "sm" ? "size-2.5" : "size-3";
  const textCls = size === "sm" ? "text-[10px]" : "text-xs";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground", textCls)}>
      {stats.map((stat) => {
        const Icon = STAT_ICONS[stat.icon];
        return (
          <span key={stat.key} className="flex items-center gap-1" title={stat.tooltip}>
            <Icon className={iconCls} />
            <span className="font-mono">{stat.value}</span>
          </span>
        );
      })}
    </div>
  );
}

function HintChip({
  active,
  icon: Icon,
  label,
  activeTip,
  inactiveTip,
  size,
}: {
  active: boolean;
  icon: ComponentType<IconProps>;
  label: string;
  activeTip: string;
  inactiveTip: string;
  size: Size;
}) {
  const iconCls = size === "sm" ? "size-3" : "size-3.5";
  const textCls = size === "sm" ? "text-[10px]" : "text-[11px]";
  return (
    <span
      title={active ? activeTip : inactiveTip}
      aria-label={active ? activeTip : inactiveTip}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium transition-colors",
        textCls,
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border/50 text-muted-foreground/40",
      )}
    >
      <Icon className={iconCls} />
      {label}
    </span>
  );
}

/** Always-visible capability hints (3D model + simulation readiness). */
export function CapabilityHints({ caps, size = "md" }: { caps: MapCapabilities; size?: Size }) {
  return (
    <div className="flex items-center gap-1.5">
      <HintChip
        active={caps.has3d}
        icon={Box}
        label="3D"
        activeTip="3D model available"
        inactiveTip="No 3D model"
        size={size}
      />
      <HintChip
        active={caps.simReady}
        icon={CirclePlay}
        label="Sim"
        activeTip="Simulation-ready (runtime bundle + CARLA map)"
        inactiveTip="Not simulation-ready (needs runtime bundle + CARLA map)"
        size={size}
      />
    </div>
  );
}
