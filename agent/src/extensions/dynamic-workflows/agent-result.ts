import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const WORKFLOW_AGENT_SESSION_REF = Symbol.for("pi.workflow.agentSessionRef");

const WorkflowAgentSessionRefSchema = Type.Object(
  {
    sessionId: Type.String(),
    sessionPath: Type.String(),
    journalIndex: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export type WorkflowAgentSessionRef = Static<typeof WorkflowAgentSessionRefSchema>;

/** String-compatible workflow agent result that carries hidden resume metadata. */
export class WorkflowAgentTextResult extends String {
  readonly [WORKFLOW_AGENT_SESSION_REF]: WorkflowAgentSessionRef;

  /**
   * Create a string result with hidden workflow resume metadata.
   *
   * @param {string} value Primitive string value returned by the agent.
   * @param {WorkflowAgentSessionRef} sessionRef Session reference used by later `agent(..., {
   *   resume })` calls.
   */
  constructor(value: string, sessionRef: WorkflowAgentSessionRef) {
    super(value);
    this[WORKFLOW_AGENT_SESSION_REF] = sessionRef;
  }
}

/**
 * Attach a resumable session reference to an agent result without changing JSON output.
 *
 * @param {unknown} result Agent result returned from the workflow runner.
 * @param {WorkflowAgentSessionRef | undefined} sessionRef Session reference captured from the child
 *   session.
 * @returns {unknown} Result with hidden session metadata when a session reference is available.
 */
export function attachWorkflowAgentSessionRef(
  result: unknown,
  sessionRef: WorkflowAgentSessionRef | undefined,
): unknown {
  if (sessionRef === undefined) return result;
  if (typeof result === "string") return new WorkflowAgentTextResult(result, sessionRef);
  if (result !== null && typeof result === "object") {
    Object.defineProperty(result, WORKFLOW_AGENT_SESSION_REF, {
      value: sessionRef,
      enumerable: false,
      configurable: true,
    });
  }
  return result;
}

/**
 * Read hidden resumable session metadata from a prior workflow agent result.
 *
 * @param {unknown} value Potential prior agent result.
 * @returns {WorkflowAgentSessionRef | undefined} Session reference when the value carries valid
 *   hidden metadata.
 */
export function getWorkflowAgentSessionRef(value: unknown): WorkflowAgentSessionRef | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, WORKFLOW_AGENT_SESSION_REF);
  const ref: unknown = descriptor?.value;
  return parseWorkflowAgentSessionRef(ref);
}

/**
 * Convert a single string wrapper back to a primitive value for persisted outputs.
 *
 * @param {unknown} value Potential workflow result wrapper.
 * @returns {unknown} Primitive string for string wrappers, otherwise the original value.
 */
export function unwrapWorkflowAgentResult(value: unknown): unknown {
  const stringValue = stringObjectValue(value);
  if (stringValue !== undefined) return stringValue;
  return value;
}

/**
 * Convert workflow return values back to plain JSON-compatible values.
 *
 * @param {unknown} value Workflow return value that may contain hidden result wrappers.
 * @returns {unknown} Plain value suitable for workflow result persistence and display.
 */
export function unwrapWorkflowAgentResults(value: unknown): unknown {
  const stringValue = stringObjectValue(value);
  if (stringValue !== undefined) return stringValue;
  if (Array.isArray(value)) return value.map((item) => unwrapWorkflowAgentResults(item));
  if (value !== null && typeof value === "object") {
    const plain: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      plain[key] = unwrapWorkflowAgentResults(item);
    }
    return plain;
  }
  return value;
}

/**
 * Normalize resume inputs so deterministic call hashing does not serialize whole results.
 *
 * @param {unknown} value Agent resume option supplied by workflow JavaScript.
 * @returns {unknown} Stable hash input for hidden or explicit session refs.
 */
export function normalizeWorkflowAgentResumeForHash(value: unknown): unknown {
  const ref = getWorkflowAgentSessionRef(value);
  if (ref !== undefined) {
    return {
      sessionId: ref.sessionId,
      sessionPath: ref.sessionPath,
      journalIndex: ref.journalIndex ?? null,
    };
  }
  const explicitRef = parseWorkflowAgentSessionRef(value);
  if (explicitRef !== undefined) {
    return {
      sessionId: explicitRef.sessionId,
      sessionPath: explicitRef.sessionPath,
      journalIndex: explicitRef.journalIndex ?? null,
    };
  }
  return value === undefined ? null : "invalid";
}

/**
 * Validate explicit workflow session refs that cross the JavaScript workflow boundary.
 *
 * @param {unknown} value Potential explicit session reference.
 * @returns {WorkflowAgentSessionRef | undefined} Parsed session reference when the value matches
 *   the TypeBox schema.
 */
export function parseWorkflowAgentSessionRef(value: unknown): WorkflowAgentSessionRef | undefined {
  if (!Value.Check(WorkflowAgentSessionRefSchema, value)) return undefined;
  return Value.Parse(WorkflowAgentSessionRefSchema, value);
}

function stringObjectValue(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.toString.call(value) === "[object String]"
  ) {
    return stringObjectPrimitive(value);
  }
  return undefined;
}

function stringObjectPrimitive(value: object): string {
  const primitive = (value as { valueOf(): unknown }).valueOf();
  return typeof primitive === "string" ? primitive : "";
}
