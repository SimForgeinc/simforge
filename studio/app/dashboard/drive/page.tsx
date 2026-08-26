import { connection } from "next/server";

import { requireAppContext } from "@/app/lib/db/app-context";
import { DriveClient } from "./DriveClient";

export default async function DrivePage() {
  await connection();
  await requireAppContext("/dashboard/drive");
  return <DriveClient />;
}
