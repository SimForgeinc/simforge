import { redirect } from "next/navigation";

export default function HomePage(): never {
  redirect(
    process.env.NEXT_PUBLIC_DRIVE_STANDALONE
      ? "/dashboard/drive"
      : "/dashboard",
  );
}
