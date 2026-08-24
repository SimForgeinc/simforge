import { redirect } from "next/navigation";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";

/** The dashboard root is an entry point, not a separate product surface. */
export default async function DashboardPage() {
  await connection();
  await requireAppContext("/dashboard");
  redirect("/dashboard/map-assets");
}
