"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type RenderingBenchmarkTarget = {
  manifestUrl: string;
  label: string;
};

type RenderingBenchmarkTargetContextValue = {
  target: RenderingBenchmarkTarget | null;
  register: (target: RenderingBenchmarkTarget | null) => void;
};

const RenderingBenchmarkTargetContext =
  createContext<RenderingBenchmarkTargetContextValue | null>(null);

export function RenderingBenchmarkTargetProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [target, setTarget] = useState<RenderingBenchmarkTarget | null>(null);
  const value = useMemo(
    () => ({ target, register: setTarget }),
    [target],
  );
  return (
    <RenderingBenchmarkTargetContext.Provider value={value}>
      {children}
    </RenderingBenchmarkTargetContext.Provider>
  );
}

export function useRenderingBenchmarkTarget() {
  return useContext(RenderingBenchmarkTargetContext)?.target ?? null;
}

export function useRegisterRenderingBenchmarkTarget(
  target: RenderingBenchmarkTarget | null,
) {
  const register = useContext(RenderingBenchmarkTargetContext)?.register;
  useEffect(() => {
    if (!register) return;
    register(target);
    return () => register(null);
  }, [register, target]);
}
