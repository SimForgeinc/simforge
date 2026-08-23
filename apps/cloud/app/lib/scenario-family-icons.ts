/**
 * Scenario family icon mapping.
 *
 * Shared between OverviewTab and ScenariosTab to avoid duplication.
 * Separated from scenario-intelligence-ui.ts to keep that module
 * free of React / lucide-react dependencies.
 */

import {
  GitFork,
  PersonStanding,
  SquareParking,
  Bike,
  Route,
  Shield,
  Eye,
  CircleDot,
  Store,
  type LucideIcon,
} from "lucide-react";
import type { ScenarioFamily } from "./scenario-intelligence-ui";

/** Map family `iconName` → Lucide icon component. */
export const FAMILY_ICONS: Record<string, LucideIcon> = {
  GitFork,
  PersonStanding,
  SquareParking,
  Bike,
  Route,
  Shield,
  Eye,
  CircleDot,
  Store,
};

/** Resolve a scenario family's icon name to a Lucide component. */
export function getFamilyIcon(family: ScenarioFamily): LucideIcon {
  return FAMILY_ICONS[family.iconName] ?? CircleDot;
}
