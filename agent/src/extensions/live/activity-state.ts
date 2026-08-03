export type LiveActivityState =
  | "thinking"
  | "working"
  | "checkingSubagents"
  | "waiting"
  | "success"
  | "failure";

export interface LiveActivitySnapshot {
  revision: number;
  state: LiveActivityState;
  updatedAt: number;
}

const TRANSIENT_ACTIVITY_MS = 1_200;

export class LiveActivityTracker {
  readonly #onChange: (snapshot: LiveActivitySnapshot) => void;
  #agentState: Exclude<LiveActivityState, "checkingSubagents"> = "waiting";
  #checkingSubagents = false;
  #snapshot: LiveActivitySnapshot = { revision: 0, state: "waiting", updatedAt: Date.now() };
  #transientTimer: NodeJS.Timeout | undefined;

  constructor(onChange: (snapshot: LiveActivitySnapshot) => void) {
    this.#onChange = onChange;
  }

  get snapshot(): LiveActivitySnapshot {
    return { ...this.#snapshot };
  }

  setAgentState(state: Exclude<LiveActivityState, "checkingSubagents">): void {
    if (this.#transientTimer !== undefined) clearTimeout(this.#transientTimer);
    this.#transientTimer = undefined;
    this.#agentState = state;
    this.#commit();
    if (state === "success" || state === "failure") {
      this.#transientTimer = setTimeout(() => {
        this.#transientTimer = undefined;
        if (this.#agentState !== state) return;
        this.#agentState = "waiting";
        this.#commit();
      }, TRANSIENT_ACTIVITY_MS);
      this.#transientTimer.unref?.();
    }
  }

  setCheckingSubagents(checkingSubagents: boolean): void {
    this.#checkingSubagents = checkingSubagents;
    this.#commit();
  }

  dispose(): void {
    if (this.#transientTimer !== undefined) clearTimeout(this.#transientTimer);
    this.#transientTimer = undefined;
  }

  #commit(): void {
    const state: LiveActivityState = this.#checkingSubagents
      ? "checkingSubagents"
      : this.#agentState;
    if (state === this.#snapshot.state) return;
    this.#snapshot = {
      revision: this.#snapshot.revision + 1,
      state,
      updatedAt: Date.now(),
    };
    this.#onChange(this.snapshot);
  }
}
