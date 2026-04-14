export type ExecutorEndpointCandidate = {
  label: string;
  mcpUrl: string;
};

export type ExecutorSettings = {
  autoStart: boolean;
  probeTimeoutMs: number;
  candidates: readonly ExecutorEndpointCandidate[];
};

let executorSettingsOverride: ExecutorSettings | undefined;

const DEFAULT_SETTINGS = {
  autoStart: true,
  probeTimeoutMs: 1_000,
  candidates: [
    { label: "lan", mcpUrl: "http://192.168.1.116:4788/mcp" },
    { label: "tail", mcpUrl: "http://100.100.1.116:4788/mcp" },
  ],
} satisfies ExecutorSettings;

export function getExecutorSettings(): ExecutorSettings {
  return executorSettingsOverride ?? DEFAULT_SETTINGS;
}

export function getExecutorWebUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function formatExecutorSettings(settings: ExecutorSettings): string[] {
  return [
    `autoStart: ${settings.autoStart}`,
    `probeTimeoutMs: ${settings.probeTimeoutMs}`,
    ...settings.candidates.map((candidate) => `candidate.${candidate.label}: ${candidate.mcpUrl}`),
  ];
}

export function setExecutorSettingsForTests(settings: ExecutorSettings | undefined): void {
  executorSettingsOverride = settings;
}
