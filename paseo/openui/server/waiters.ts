/** Renders held open by `wait`, keyed by program fingerprint. Oldest first when one program is waiting twice. */
export class Waiters {
  private readonly pending = new Map<string, Array<(text: string) => void>>();

  /** Resolves with the user's answer, or null on timeout or abort. */
  wait(key: string, timeoutMs: number, signal: AbortSignal): Promise<string | null> {
    return new Promise((resolve) => {
      const queue = this.pending.get(key) ?? [];
      const settle = (value: string | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const list = this.pending.get(key);
        if (list) {
          const index = list.indexOf(answer);
          if (index >= 0) list.splice(index, 1);
          if (list.length === 0) this.pending.delete(key);
        }
        resolve(value);
      };
      const answer = (text: string) => settle(text);
      const onAbort = () => settle(null);
      const timer = setTimeout(() => settle(null), timeoutMs);
      queue.push(answer);
      this.pending.set(key, queue);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** True when a waiting render took the answer. */
  answer(key: string, text: string): boolean {
    const next = this.pending.get(key)?.[0];
    if (!next) return false;
    next(text);
    return true;
  }
}
