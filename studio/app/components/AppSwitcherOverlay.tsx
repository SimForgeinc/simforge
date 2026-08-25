"use client";

import Link from "next/link";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { FlaskConical, HardDrive, X } from "lucide-react";
import type { RefObject } from "react";
import { AppSwitcherArt } from "@/app/components/AppSwitcherArt";
import { SkyCloudBackdrop } from "@/app/components/SkyCloudBackdrop";
import { DASHBOARD_APPS } from "@/app/lib/dashboard-nav";
import {
  setExperimentalFeaturesEnabled,
  useExperimentalFeaturesEnabled,
} from "@/app/lib/experimental-features";
import { cn } from "@/app/lib/utils";

export function AppSwitcherOverlay({
  open,
  onOpenChange,
  pathname,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pathname: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const experimentalEnabled = useExperimentalFeaturesEnabled();
  const close = () => onOpenChange(false);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[300] overflow-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none"
          data-testid="app-switcher-backdrop"
        >
          <SkyCloudBackdrop />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          className="app-switcher-center-fade fixed inset-0 z-[310] overflow-y-auto text-white outline-none"
          data-testid="app-switcher-dialog"
          data-visual-surface="flat"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Switch app
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Choose a SimForge app or configure local features.
          </DialogPrimitive.Description>
          <DialogPrimitive.Close
            className="fixed right-5 top-5 z-20 grid size-10 place-items-center rounded-full text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] sm:right-8 sm:top-8"
            aria-label="Close app switcher"
          >
            <X className="size-5" aria-hidden="true" />
          </DialogPrimitive.Close>

          <div className="relative mx-auto flex min-h-full w-full max-w-[1120px] flex-col justify-center gap-8 px-5 py-20 sm:px-8 sm:py-24">
            <div
              aria-hidden="true"
              data-testid="app-switcher-sky-ambience"
              className="pointer-events-none absolute -left-24 top-0 h-56 w-96 rounded-full bg-[#E8E044]/[0.055] blur-[90px]"
            />
            <div
              className="relative grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
              aria-label="SimForge apps"
            >
              {DASHBOARD_APPS.map((app, index) => {
                const active = !app.disabled && app.match(pathname);
                const content = (
                  <>
                    <span className="relative z-10 flex items-center justify-between">
                      <span className="font-meta text-[9px] font-semibold tracking-[0.18em] text-white/30">
                        0{index + 1}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-2.5 py-1 font-meta text-[8px] font-bold uppercase tracking-[0.13em]",
                          app.disabled
                            ? "border-white/[0.07] text-white/25"
                            : active
                              ? "border-[#E8E044]/30 bg-[#E8E044]/10 text-[#E8E044]"
                              : "border-white/10 text-white/40",
                        )}
                      >
                        {app.disabled
                          ? "In development"
                          : active
                            ? "Current"
                            : "Available"}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "pointer-events-none absolute -right-4 top-7 grid size-40 place-items-center transition-[transform,opacity,filter] duration-500 group-hover:-translate-x-1 group-hover:scale-[1.04]",
                        active
                          ? "opacity-100 drop-shadow-[0_16px_34px_rgba(232,224,68,0.14)]"
                          : "opacity-45 grayscale group-hover:opacity-80 group-hover:grayscale-0",
                      )}
                    >
                      <AppSwitcherArt
                        href={app.href}
                        className="size-40 object-contain"
                      />
                    </span>
                    <span className="relative z-10 mt-20 block max-w-[75%] text-left">
                      <span
                        className={cn(
                          "block font-display text-2xl font-semibold tracking-[-0.035em]",
                          active ? "text-[#E8E044]" : "text-white",
                        )}
                      >
                        {app.label}
                      </span>
                      <span className="mt-2 block text-xs leading-5 text-white/45">
                        {app.description}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "relative z-10 mt-6 flex items-center justify-between border-t pt-4 text-left font-meta text-[9px] font-bold uppercase tracking-[0.14em]",
                        active
                          ? "border-[#E8E044]/20 text-[#E8E044]"
                          : "border-white/[0.07] text-white/35 group-hover:text-white/70",
                      )}
                    >
                      <span>
                        {app.disabled
                          ? "Coming soon"
                          : active
                            ? "You are here"
                            : "Open app"}
                      </span>
                      {!app.disabled ? (
                        <span
                          aria-hidden="true"
                          className="text-base leading-none"
                        >
                          ↗
                        </span>
                      ) : null}
                    </span>
                  </>
                );
                const cardClassName = cn(
                  "group relative flex min-h-60 flex-col overflow-hidden rounded-[20px] border p-5 transition-[border-color,background-color,box-shadow,transform] duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] motion-reduce:transition-none sm:min-h-64 sm:p-6",
                  app.disabled
                    ? "cursor-not-allowed border-white/[0.05] bg-black/20 opacity-60"
                    : active
                      ? "border-[#E8E044]/25 bg-[linear-gradient(145deg,rgba(232,224,68,0.09),rgba(255,255,255,0.025))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_50px_rgba(0,0,0,0.18)]"
                      : "border-white/[0.08] bg-white/[0.025] hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.05] hover:shadow-[0_20px_55px_rgba(0,0,0,0.25)]",
                );

                return app.disabled ? (
                  <button
                    aria-label={`${app.label} — Coming soon`}
                    className={cardClassName}
                    data-visual-treatment="disabled"
                    disabled
                    key={app.href}
                    type="button"
                  >
                    {content}
                  </button>
                ) : (
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={cardClassName}
                    data-visual-treatment="open"
                    href={app.href}
                    key={app.href}
                    onClick={close}
                  >
                    {content}
                  </Link>
                );
              })}
            </div>

            <div
              className="grid grid-cols-2 gap-1 self-end rounded-xl border border-white/[0.07] bg-white/[0.025] p-1"
              data-testid="app-switcher-footer"
            >
              <button
                type="button"
                onClick={() =>
                  setExperimentalFeaturesEnabled(!experimentalEnabled)
                }
                aria-label={`${experimentalEnabled ? "Disable" : "Enable"} experimental features`}
                aria-pressed={experimentalEnabled}
                data-testid="experimental-features-toggle"
                className={cn(
                  "flex min-h-12 items-center justify-center gap-2 rounded-lg px-3 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E8E044]",
                  experimentalEnabled
                    ? "bg-[#E8E044]/10 text-[#E8E044]"
                    : "text-white/45 hover:bg-white/[0.05] hover:text-white",
                )}
              >
                <FlaskConical className="size-3.5 shrink-0" aria-hidden="true" />
                <span>Experimental {experimentalEnabled ? "on" : "off"}</span>
              </button>
              <div className="flex min-h-12 items-center justify-center gap-2 rounded-lg px-3 text-[10px] font-medium text-white/45">
                <HardDrive className="size-3.5 shrink-0" aria-hidden="true" />
                <span>Local data</span>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
