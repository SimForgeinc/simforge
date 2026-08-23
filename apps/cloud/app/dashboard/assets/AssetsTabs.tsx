"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard/assets", label: "Gallery" },
  { href: "/dashboard/assets/carla", label: "CARLA compatibility" },
] as const;

export function AssetsTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Asset views" className="border-b border-white/[0.07] bg-[#090b0e] px-5 sm:px-8">
      <div className="mx-auto flex max-w-[1500px] gap-5">
        {TABS.map((tab) => {
          const active = tab.href === "/dashboard/assets"
            ? pathname === tab.href
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`border-b-2 px-0.5 py-3 text-xs font-medium transition-colors ${
                active
                  ? "border-[#E8E044] text-white"
                  : "border-transparent text-white/45 hover:text-white/75"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
