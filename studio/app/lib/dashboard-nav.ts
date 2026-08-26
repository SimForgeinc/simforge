import {
  Boxes,
  CarFront,
  Database,
  FlaskConical,
  Map,
  PackageCheck,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
  disabled?: boolean;
};

export const DASHBOARD_APPS: NavItem[] = [
  {
    href: "/dashboard/map-assets",
    label: "Maps",
    description: "CARLA map library and bridges",
    icon: Map,
    match: (p) => p.startsWith("/dashboard/map-assets"),
  },
  {
    href: "/dashboard/assets",
    label: "Assets",
    description: "3D models and maps for scenarios",
    icon: Boxes,
    match: (p) => p.startsWith("/dashboard/assets"),
  },
  {
    href: "/dashboard/scenario",
    label: "Datasets",
    description: "Scenario datasets and authoring",
    icon: Database,
    match: (p) => p.startsWith("/dashboard/scenario"),
  },
  {
    href: "/dashboard/evaluation",
    label: "Evaluation",
    description: "Eval campaigns, playback, and promotion",
    icon: FlaskConical,
    match: (p) => p.startsWith("/dashboard/evaluation"),
  },
  {
    href: "/dashboard/dataset-export",
    label: "Exports",
    description: "Package datasets for download",
    icon: PackageCheck,
    match: (p) => p.startsWith("/dashboard/dataset-export"),
    disabled: true,
  },
  {
    href: "/dashboard/drive",
    label: "Drive",
    description: "Continuous worlds and live driving",
    icon: CarFront,
    match: (p) => p.startsWith("/dashboard/drive"),
  },
];

export const DASHBOARD_NAV: NavItem[] = [
  ...DASHBOARD_APPS,
  {
    href: "/dashboard/workspace/settings",
    label: "Settings",
    description: "Workspace settings and configuration",
    icon: Settings,
    match: (p) => p.startsWith("/dashboard/workspace/settings"),
  },
];

export function activeNavItem(pathname: string): NavItem | null {
  return DASHBOARD_NAV.find((item) => item.match(pathname)) ?? null;
}
