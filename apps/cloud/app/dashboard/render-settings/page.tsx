import { requireAppContext } from "@/app/lib/db/app-context";
import { RenderSettingsPageClient } from "./RenderSettingsPageClient";

export default async function RenderSettingsPage() {
  await requireAppContext("/dashboard/render-settings");
  return <RenderSettingsPageClient />;
}
