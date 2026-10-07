export interface SnapshotThinkingOption {
  id: string;
  label: string;
}

export interface SnapshotModel {
  id: string;
  label: string;
  isDefault?: boolean;
  isSelectable?: boolean;
  thinkingOptions?: readonly SnapshotThinkingOption[];
  defaultThinkingOptionId?: string;
}

export interface SnapshotEntry {
  provider: string;
  label?: string;
  enabled: boolean;
  status: "ready" | "loading" | "error" | "unavailable";
  models?: readonly SnapshotModel[];
}

export interface SelectableProvider {
  id: string;
  label: string;
  models: SnapshotModel[];
}

export interface ConductorSelection {
  provider: string;
  model: string;
  thinkingOptionId: string;
}

export interface SelectOption {
  label: string;
  value: string;
}

/** Same rule as Paseo's settings selectors, narrowed to providers that can start an agent now. */
export function selectableProviders(
  entries: readonly SnapshotEntry[],
): SelectableProvider[] {
  return entries
    .filter((entry) => entry.enabled && entry.status === "ready")
    .map((entry) => ({
      id: entry.provider,
      label: entry.label ?? entry.provider,
      models: (entry.models ?? []).filter(
        (model) => model.isSelectable !== false,
      ),
    }));
}

function defaultModel(provider: SelectableProvider): SnapshotModel | undefined {
  return provider.models.find((model) => model.isDefault) ?? provider.models[0];
}

/** Keeps saved choices that are still valid and falls back to provider/model defaults. */
export function resolveSelection(
  providers: readonly SelectableProvider[],
  saved: ConductorSelection,
): ConductorSelection | null {
  const provider =
    providers.find((entry) => entry.id === saved.provider) ?? providers[0];
  if (!provider) return null;
  const model =
    provider.models.find((entry) => entry.id === saved.model) ??
    defaultModel(provider);
  const thinkingOptions = model?.thinkingOptions ?? [];
  const thinking =
    thinkingOptions.find((option) => option.id === saved.thinkingOptionId)
      ?.id ??
    model?.defaultThinkingOptionId ??
    thinkingOptions[0]?.id ??
    "";
  return {
    provider: provider.id,
    model: model?.id ?? "",
    thinkingOptionId: thinking,
  };
}

export function providerOptions(
  providers: readonly SelectableProvider[],
): SelectOption[] {
  return providers.map((provider) => ({
    label: provider.label,
    value: provider.id,
  }));
}

export function modelOptions(
  provider: SelectableProvider | undefined,
): SelectOption[] {
  if (!provider?.models.length)
    return [{ label: "Provider default", value: "" }];
  return provider.models.map((model) => ({
    label: model.label,
    value: model.id,
  }));
}

export function thinkingOptions(
  provider: SelectableProvider | undefined,
  modelId: string,
): SelectOption[] {
  const model = provider?.models.find((entry) => entry.id === modelId);
  return (model?.thinkingOptions ?? []).map((option) => ({
    label: option.label,
    value: option.id,
  }));
}
