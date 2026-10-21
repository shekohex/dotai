/** Shares one in-flight (or just-finished) result between identical requests, e.g. three panels asking at once. */
export function coalesce<Input, Output>(
  run: (input: Input) => Promise<Output>,
  keyOf: (input: Input) => string,
  ttlMs: number,
): (input: Input) => Promise<Output> {
  const entries = new Map<string, { promise: Promise<Output>; at: number }>();
  return (input) => {
    const key = keyOf(input);
    const now = Date.now();
    const hit = entries.get(key);
    if (hit && now - hit.at < ttlMs) return hit.promise;
    const promise = run(input);
    entries.set(key, { promise, at: now });
    promise.catch(() => entries.delete(key));
    if (entries.size > 64) for (const [k, v] of entries) if (now - v.at > ttlMs) entries.delete(k);
    return promise;
  };
}
