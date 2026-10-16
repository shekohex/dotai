import {
  ACTION_STEPS,
  BuiltinActionType,
  createStore,
  createStreamingParser,
  evaluate,
  evaluateRoot,
  resolveStateField,
  type ActionEvent,
  type ActionPlan,
  type ElementNode,
  type EvalContext,
  type EvaluationContext,
  type OpenUIError,
  type StateField,
  type Store,
} from "../shared/lang-core/index.mjs";
import {
  Component,
  createContext,
  Fragment,
  type ComponentType,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { Text } from "react-native";
import { library } from "../shared/library";
import { COMPONENTS } from "./components";
import { useBidi } from "./bidi";
import { FONT, useUiEnv } from "./tokens";

type LegacyAction = { type?: string; params?: Record<string, unknown> };

interface RuntimeValue {
  renderNode: (value: unknown) => ReactNode;
  triggerAction: (label: string, formName?: string, action?: ActionPlan | LegacyAction) => void;
  getFieldValue: (formName: string | undefined, name: string) => unknown;
  setFieldValue: (
    formName: string | undefined,
    componentType: string | undefined,
    name: string,
    value: unknown,
  ) => void;
  store: Store;
  evaluationContext: EvaluationContext;
}

const RuntimeContext = createContext<RuntimeValue | null>(null);
export const FormNameContext = createContext<string | undefined>(undefined);

function useRuntime(): RuntimeValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("OpenUI runtime missing");
  return value;
}

export function useRenderNode() {
  return useRuntime().renderNode;
}

export function useTriggerAction() {
  return useRuntime().triggerAction;
}

/** A field bound to a `$variable` or to this form's state, with its default stored once. */
export function useField<T>(
  name: string,
  value: unknown,
  componentType: string,
  fallback: T,
): StateField<T> {
  const runtime = useRuntime();
  const formName = useContext(FormNameContext);
  const field = resolveStateField<T>(
    name,
    value,
    runtime.store,
    runtime.evaluationContext,
    (fieldName) => runtime.getFieldValue(formName, fieldName),
    (fieldName, next) => runtime.setFieldValue(formName, componentType, fieldName, next),
  );
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || field.isReactive || value === undefined) return;
    seeded.current = true;
    if (runtime.getFieldValue(formName, name) === undefined) {
      runtime.setFieldValue(formName, componentType, name, value);
    }
  }, [field.isReactive, value, runtime, formName, name, componentType]);
  return { ...field, value: (field.value ?? fallback) as T };
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return (value as { value: unknown }).value;
  }
  return value;
}

interface BoundaryProps {
  name: string;
  children: ReactNode;
}

interface BoundaryState {
  error: string | null;
}

/**
 * Keeps one broken component from taking the whole card down, and says which one broke.
 * Written as a function plus prototype because Hermes on Android leaves `class` declarations
 * undefined when it evals the plugin bundle ("Element type is invalid ... got: undefined").
 */
function Boundary(this: Component<BoundaryProps, BoundaryState>, props: BoundaryProps) {
  (Component as unknown as (this: unknown, props: unknown) => void).call(this, props);
  this.state = { error: null };
}
Boundary.prototype = Object.create(Component.prototype);
Boundary.prototype.constructor = Boundary;
Boundary.getDerivedStateFromError = (error: unknown): BoundaryState => ({
  error: error instanceof Error ? error.message : String(error),
});
Boundary.prototype.componentDidCatch = function (this: Component<BoundaryProps>, error: Error) {
  console.warn(`[openui] ${this.props.name} failed`, error.message);
};
Boundary.prototype.render = function (this: Component<BoundaryProps, BoundaryState>) {
  return this.state.error === null ? (
    this.props.children
  ) : (
    <Text selectable style={{ color: "#d9534f", fontSize: FONT.s }}>
      {`⚠ ${this.props.name}: ${this.state.error}`}
    </Text>
  );
};

export const NodeBoundary = Boundary as unknown as ComponentType<BoundaryProps>;

export interface OpenUiViewProps {
  source: string;
  onAction: (event: ActionEvent) => void;
  onProblems?: (problems: OpenUIError[]) => void;
}

/** Parses an OpenUI Lang program and draws it with Paseo's native components. */
export function OpenUiView({ source, onAction, onProblems }: OpenUiViewProps) {
  const { colors } = useUiEnv();
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const problemsRef = useRef(onProblems);
  problemsRef.current = onProblems;

  const { result, store, schema } = useMemo(() => {
    const schema = library.toJSONSchema();
    const result = createStreamingParser(schema, library.root).set(source, true);
    const store = createStore();
    store.initialize(result.stateDeclarations ?? {}, {});
    return { result, store, schema };
  }, [source]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const evaluationContext = useMemo<EvaluationContext>(
    () => ({
      getState: (name) => unwrap(store.get(name)),
      resolveRef: () => undefined,
      functions: {},
      actions: schema.actions,
    }),
    [store, schema.actions],
  );

  const root = useMemo(() => {
    if (!result.root && !result.rootExpression) return null;
    const errors: OpenUIError[] = [];
    const context: EvalContext = { ctx: evaluationContext, library, store, errors };
    try {
      return evaluateRoot(result, context);
    } catch (error) {
      console.warn("[openui] evaluation failed", error);
      return result.root;
    }
    // The snapshot changes whenever bound state does, which is what re-evaluates props.
  }, [result, evaluationContext, store, snapshot]);

  useEffect(() => {
    problemsRef.current?.(result.meta.errors.filter((error) => error.severity !== "warning") as never);
  }, [result]);

  const getFieldValue = useCallback(
    (formName: string | undefined, name: string) => {
      if (!formName) return unwrap(store.get(name));
      const form = store.get(formName);
      if (!form || typeof form !== "object" || Array.isArray(form)) return undefined;
      return unwrap((form as Record<string, unknown>)[name]);
    },
    [store],
  );

  const setFieldValue = useCallback(
    (formName: string | undefined, componentType: string | undefined, name: string, value: unknown) => {
      const wrapped = { value, componentType };
      if (!formName) {
        store.set(name, wrapped);
        return;
      }
      const current = store.get(formName);
      const form =
        current && typeof current === "object" && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      store.set(formName, { ...form, [name]: wrapped });
    },
    [store],
  );

  const formPayload = useCallback(
    (formName?: string): Record<string, unknown> => {
      const form = formName ? store.get(formName) : undefined;
      if (formName && form && typeof form === "object" && !Array.isArray(form)) {
        return { [formName]: form };
      }
      return store.getSnapshot();
    },
    [store],
  );

  const triggerAction = useCallback(
    (label: string, formName?: string, action?: ActionPlan | LegacyAction) => {
      const emit = (event: Omit<ActionEvent, "formState" | "formName">) =>
        actionRef.current({ ...event, formState: formPayload(formName), formName });
      if (action && "steps" in action) {
        for (const step of action.steps) {
          switch (step.type) {
            case ACTION_STEPS.ToAssistant:
              emit({
                type: BuiltinActionType.ContinueConversation,
                params: step.context !== undefined ? { context: step.context } : {},
                humanFriendlyMessage: step.message,
              });
              break;
            case ACTION_STEPS.OpenUrl:
              emit({ type: BuiltinActionType.OpenUrl, params: { url: step.url }, humanFriendlyMessage: "" });
              break;
            case ACTION_STEPS.Set:
              if (step.valueAST) store.set(step.target, evaluate(step.valueAST, evaluationContext));
              break;
            case ACTION_STEPS.Reset:
              for (const target of step.targets) {
                store.set(target, result.stateDeclarations?.[target] ?? null, { pristine: true });
              }
              break;
            default:
              break;
          }
        }
        return;
      }
      emit({
        type: BuiltinActionType.ContinueConversation,
        params: {},
        humanFriendlyMessage: label,
      });
    },
    [formPayload, store, evaluationContext, result],
  );

  const renderNodeRef = useRef<(value: unknown) => ReactNode>(() => null);
  const renderNode = useCallback((value: unknown): ReactNode => renderValue(value, renderNodeRef), []);
  renderNodeRef.current = renderNode;

  const runtime = useMemo<RuntimeValue>(
    () => ({
      renderNode,
      triggerAction,
      getFieldValue,
      setFieldValue,
      store,
      evaluationContext,
    }),
    [renderNode, triggerAction, getFieldValue, setFieldValue, store, evaluationContext],
  );

  if (!root) return <Text style={{ color: colors.foregroundMuted, fontSize: FONT.m }}>Nothing to show yet.</Text>;
  return <RuntimeContext.Provider value={runtime}>{renderNode(root)}</RuntimeContext.Provider>;
}

function isElement(value: unknown): value is ElementNode {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "element";
}

function renderValue(value: unknown, self: { current: (value: unknown) => ReactNode }): ReactNode {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" || typeof value === "number") return <PlainText text={String(value)} />;
  if (Array.isArray(value)) {
    return value.map((item, index) => <Fragment key={index}>{self.current(item)}</Fragment>);
  }
  if (isElement(value)) {
    const Render = COMPONENTS[value.typeName];
    if (!Render) return null;
    return (
      <NodeBoundary name={value.typeName}>
        <Render props={value.props} renderNode={self.current} />
      </NodeBoundary>
    );
  }
  return null;
}

function PlainText({ text }: { text: string }) {
  const { colors } = useUiEnv();
  const bidi = useBidi();
  return <Text style={{ color: colors.foreground, fontSize: FONT.m, ...bidi.text(text) }}>{text}</Text>;
}

export { isElement };
