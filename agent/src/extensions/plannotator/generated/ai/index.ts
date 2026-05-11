export class ProviderRegistry {
  readonly size = 0;
  register(_provider: unknown): void {}
  disposeAll(): void {}
}

export class SessionManager {
  disposeAll(): void {}
}

export async function createProvider(_options: unknown): Promise<Record<string, unknown>> {
  throw new Error("Plannotator AI providers are unavailable in this build.");
}

export function createAIEndpoints(
  _options: unknown,
): Record<string, (req: Request) => Promise<Response>> {
  return {};
}
