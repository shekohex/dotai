export interface ModeRoute {
  phasePattern: string;
  mode: string;
  useRegex?: boolean;
}

export interface ModeRoutingConfig {
  defaultMode?: string;
  routes: ModeRoute[];
}

export function resolveModeForPhase(
  phase: string | undefined,
  config: ModeRoutingConfig,
): string | undefined {
  if (phase === undefined || phase === "" || config.routes.length === 0) {
    return config.defaultMode;
  }

  for (const route of config.routes) {
    if (route.useRegex === true) {
      try {
        const regex = new RegExp(route.phasePattern, "i");
        if (regex.test(phase)) return route.mode;
      } catch {}
    } else if (phase.toLowerCase().includes(route.phasePattern.toLowerCase())) {
      return route.mode;
    }
  }

  return config.defaultMode;
}

export function parseModeRoutingFromMeta(
  phases?: Array<{ title: string; mode?: string }>,
): ModeRoutingConfig {
  const routes: ModeRoute[] = [];
  for (const phase of phases ?? []) {
    if (phase.mode !== undefined && phase.mode !== "") {
      routes.push({ phasePattern: phase.title, mode: phase.mode });
    }
  }
  return { routes };
}
