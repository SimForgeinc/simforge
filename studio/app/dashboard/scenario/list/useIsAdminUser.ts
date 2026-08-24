"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/app/lib/auth/client";

// Gates VISIBILITY of experimental UI only. Any server action these surfaces trigger enforces its
// own authorization — see `isPlatformAdmin` in `lib/scenario/dataset-store.ts`, which is the real
// gate and reads `session.role` server-side.
const ADMIN_ROLES = new Set(["admin", "superadmin"]);

export function useIsAdminUser(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authClient
      .getSession()
      .then((res) => {
        if (cancelled) return;
        // `role` is a better-auth additionalField, absent from the client type.
        const user = res.data?.user as { role?: string } | undefined;
        if (!user) return;
        setIsAdmin(ADMIN_ROLES.has(user.role ?? ""));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return isAdmin;
}
