import type {
  CliproxyAccountsByProvider,
  OpenUsageRuntimeState,
  SupportedProviderId,
} from "./types.js";

type OpenUsageViewData = {
  state: OpenUsageRuntimeState;
  accountsByProvider: CliproxyAccountsByProvider;
  providerIds: SupportedProviderId[];
  initialProviderId: SupportedProviderId;
  activeProviderId?: SupportedProviderId;
  activeModelLabel?: string;
  refreshProvider: (
    providerId: SupportedProviderId,
    options?: { force?: boolean },
  ) => Promise<void>;
  persistState: () => void;
};

export type { OpenUsageViewData };
