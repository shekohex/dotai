const nonAuthoritativeRuntimeSymbol = Symbol.for("@shekohex/agent/non-authoritative-runtime");

type SessionManagerLikeWithAuthorityFlag = {
  [nonAuthoritativeRuntimeSymbol]?: true;
};

export function markNonAuthoritativeRuntime(sessionManager: object): void {
  const flaggedSessionManager = sessionManager as SessionManagerLikeWithAuthorityFlag;
  flaggedSessionManager[nonAuthoritativeRuntimeSymbol] = true;
}

export function isAuthoritativeRuntime(context: { sessionManager: object }): boolean {
  const flaggedSessionManager = context.sessionManager as SessionManagerLikeWithAuthorityFlag;
  return flaggedSessionManager[nonAuthoritativeRuntimeSymbol] !== true;
}
