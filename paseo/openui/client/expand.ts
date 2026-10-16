import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { expandRpc } from "../shared/components";
import { usesComponents } from "../shared/template";

export interface Expanded {
  /** The program to draw, or null while a saved component is still being looked up. */
  ui: string | null;
  errors: string[];
}

const cache = new Map<string, Expanded>();

/** Resolves `@Use("name", {props})` calls through the daemon, which owns the saved components. */
export function useExpandedUi(ui: string, complete: boolean, agentId: string): Expanded {
  const rpc = useRpc(expandRpc);
  const expand = useRef(rpc);
  expand.current = rpc;
  const needed = usesComponents(ui);
  const cacheKey = `${agentId}\0${ui}`;
  const [result, setResult] = useState<Expanded | undefined>(() => cache.get(cacheKey));
  useEffect(() => {
    if (!needed || !complete) return;
    const known = cache.get(cacheKey);
    if (known) {
      setResult(known);
      return;
    }
    let cancelled = false;
    expand.current({ agentId, ui }).then(
      (done) => {
        const next: Expanded = done.errors.length > 0 ? { ui: null, errors: done.errors } : done;
        if (next.ui !== null) cache.set(cacheKey, next);
        if (!cancelled) setResult(next);
      },
      (error: unknown) => {
        if (!cancelled) setResult({ ui: null, errors: [error instanceof Error ? error.message : "Could not expand components"] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cacheKey, needed, complete]);
  if (!needed) return { ui, errors: [] };
  return result ?? { ui: null, errors: [] };
}
