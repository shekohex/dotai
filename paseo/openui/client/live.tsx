import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import {
  ACTION_STEPS,
  type ActionStep,
  createQueryManager,
  evaluate,
  type EvaluationContext,
  type ParseResult,
  type QueryManager,
  type QueryNode,
  type QuerySnapshot,
} from "../shared/lang-core/index.mjs";
import { sourceCallRpc, sourceReadRpc, sourceStopRpc } from "../shared/sources";
import { useBidi } from "./bidi";
import { createSourceProvider, type SourceProvider } from "./sources";
import { FONT, GAP, useUiEnv } from "./tokens";

/** Queries may not refresh faster than this, whatever the program asks. */
const MIN_REFRESH_SECONDS = 0.5;
const CLOCK_EVERY_MS = 1_000;

export interface Live {
  manager: QueryManager;
  provider: SourceProvider;
  snapshot: QuerySnapshot;
  updatedAt: number | null;
  /** Source names the program reads with Query and fires with Mutation. */
  names: { queries: Set<string>; mutations: Set<string> };
  /** Which source each Query statement reads, so a stream's news reaches the right ones. */
  toolOf: Map<string, string>;
}

type Engine = Omit<Live, "snapshot" | "updatedAt">;

/** The query manager and source provider for one rendered UI, living as long as the UI is on screen. */
export function useLive(agentId: string): Live {
  const call = useRpc(sourceCallRpc);
  const read = useRpc(sourceReadRpc);
  const stop = useRpc(sourceStopRpc);
  const rpc = useRef({ call, read, stop });
  rpc.current = { call, read, stop };
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const clock = useRef(0);

  const engine = useMemo<Engine>(() => {
    const names: Engine["names"] = { queries: new Set(), mutations: new Set() };
    const toolOf = new Map<string, string>();
    const holder: { manager: QueryManager | undefined } = { manager: undefined };
    const provider = createSourceProvider({
      agentId,
      call: (input) => rpc.current.call(input),
      read: (input) => rpc.current.read(input),
      stop: (input) => rpc.current.stop(input),
      intent: (name) => (names.mutations.has(name) && !names.queries.has(name) ? "mutation" : "query"),
      onChange: (name) => {
        const ids = [...toolOf].filter(([, tool]) => tool === name).map(([id]) => id);
        if (ids.length > 0) holder.manager?.invalidate(ids);
      },
      onResult: () => {
        const now = Date.now();
        if (now - clock.current < CLOCK_EVERY_MS) return;
        clock.current = now;
        setUpdatedAt(now);
      },
    });
    const manager = createQueryManager(provider);
    holder.manager = manager;
    return { manager, provider, names, toolOf };
  }, [agentId]);

  useEffect(() => {
    engine.manager.activate();
    const subscription = AppState.addEventListener("change", (state) => engine.provider.setActive(state === "active"));
    return () => {
      subscription.remove();
      engine.provider.shutdown();
      engine.manager.dispose();
    };
  }, [engine]);

  const snapshot = useSyncExternalStore(engine.manager.subscribe, engine.manager.getSnapshot, engine.manager.getSnapshot);
  return { ...engine, snapshot, updatedAt };
}

function plain(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Keeps the manager's queries and mutations in step with the program and the variables it reads. */
export function useQuerySync(live: Live, result: ParseResult, context: EvaluationContext, state: unknown): void {
  useEffect(() => {
    const tools = live.toolOf;
    tools.clear();
    live.names.queries.clear();
    live.names.mutations.clear();
    const nodes: QueryNode[] = [];
    for (const query of result.queryStatements) {
      try {
        const name = query.toolAST ? evaluate(query.toolAST, context) : undefined;
        if (typeof name !== "string") continue;
        const args = plain(query.argsAST ? evaluate(query.argsAST, context) : {});
        const seconds = query.refreshAST ? Number(evaluate(query.refreshAST, context)) : 0;
        tools.set(query.statementId, name);
        live.names.queries.add(name);
        nodes.push({
          statementId: query.statementId,
          toolName: name,
          args,
          defaults: query.defaultsAST ? evaluate(query.defaultsAST, context) : null,
          deps: (query.deps ?? []).map((dep) => context.getState(dep)),
          refreshInterval: seconds > 0 ? Math.max(MIN_REFRESH_SECONDS, seconds) : 0,
          complete: query.complete,
        });
      } catch (error) {
        console.warn(`[openui] query ${query.statementId} could not be read`, error);
      }
    }
    const mutations = result.mutationStatements.flatMap((mutation) => {
      const name = mutation.toolAST ? evaluate(mutation.toolAST, context) : undefined;
      if (typeof name !== "string") return [];
      live.names.mutations.add(name);
      return [{ statementId: mutation.statementId, toolName: name }];
    });
    live.manager.registerMutations(mutations);
    live.manager.evaluateQueries(nodes);
    // live is rebuilt every render; its manager is the stable part
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.manager, result, context, state]);
}

/** Runs the `@Run(query)` and `@Run(mutation)` steps of a button's action. */
export function runSteps(live: Live, result: ParseResult, context: EvaluationContext, steps: ActionStep[]): void {
  const runs = steps.flatMap((step) => (step.type === ACTION_STEPS.Run ? [step] : []));
  if (runs.length === 0) return;
  const queries = runs.filter((step) => step.refType === "query").map((step) => step.statementId);
  const mutations = runs.filter((step) => step.refType === "mutation");
  void live.provider.retry();
  if (mutations.length === 0) {
    live.manager.invalidate(queries);
    return;
  }
  for (const step of mutations) {
    const node = result.mutationStatements.find((mutation) => mutation.statementId === step.statementId);
    if (!node) continue;
    const args = plain(node.argsAST ? evaluate(node.argsAST, context) : {});
    void live.manager.fireMutation(step.statementId, args, queries);
  }
}

function clockText(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Under a live UI: what went wrong with its data, when it last updated, and a refresh. */
export function LiveBar({ live }: { live: Live }) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  const messages = [...new Set(live.snapshot.__openui_errors.map((error) => error.message))];
  const busy = live.snapshot.__openui_loading.length > 0;
  const refresh = () => {
    void live.provider.retry();
    live.manager.invalidate();
  };
  return (
    <View style={{ gap: GAP.xs }}>
      {messages.map((message) => (
        <View key={message} style={{ flexDirection: "row", gap: GAP.s, alignItems: "flex-start" }}>
          <Icon name="TriangleAlert" size={14} color={colors.statusWarning} />
          <Text selectable style={{ flex: 1, color: colors.statusWarning, fontSize: FONT.s, ...bidi.text(message) }}>
            {message}
          </Text>
        </View>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: GAP.s }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: messages.length > 0 ? colors.statusWarning : colors.statusSuccess }} />
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT.s }}>
          {messages.length > 0 ? "Showing the last data" : "Live"}
          {live.updatedAt ? ` · updated ${clockText(live.updatedAt)}` : ""}
          {busy ? " · refreshing…" : ""}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh live data" onPress={refresh} hitSlop={8}>
          <Icon name="RefreshCw" size={14} color={colors.foregroundMuted} />
        </Pressable>
      </View>
    </View>
  );
}
