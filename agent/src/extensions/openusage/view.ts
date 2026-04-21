import { DynamicBorder, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Key, Text, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";
import { setResetTimeFormat, setSelectedAccount } from "./state.js";
import type { ResetTimeFormat, SupportedProviderId, UsageSnapshot } from "./types.js";
import { buildOpenUsageLines, type OpenUsageAccountOption } from "./view-layout.js";
import type { OpenUsageViewData } from "./view-types.js";

class OpenUsageView implements Component {
  private tui: TUI;
  private theme: Theme;
  private onDone: () => void;
  private data: OpenUsageViewData;
  private container: Container;
  private body: Text;
  private cachedWidth?: number;
  private selectedProviderId: SupportedProviderId;
  private displayMode: "left" | "used" = "left";
  private busyMessage?: string;
  private errorMessage?: string;

  constructor(tui: TUI, theme: Theme, data: OpenUsageViewData, onDone: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.data = data;
    this.onDone = onDone;
    this.selectedProviderId = data.initialProviderId;

    this.container = new Container();
    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    this.container.addChild(
      new Text(
        theme.fg("accent", theme.bold("OpenUsage")) + theme.fg("dim", "  (Esc/q/Enter to close)"),
        1,
        0,
      ),
    );
    this.container.addChild(new Text("", 1, 0));

    this.body = new Text("", 1, 0);
    this.container.addChild(this.body);

    this.container.addChild(new Text("", 1, 0));
    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    void this.ensureSelectedSnapshot();
  }

  private getSelectedSnapshot(): UsageSnapshot | undefined {
    return this.data.state.snapshots.get(this.selectedProviderId);
  }

  private getAccountOptions(providerId = this.selectedProviderId): OpenUsageAccountOption[] {
    const cliproxyAccounts = this.data.accountsByProvider[providerId] ?? [];
    return [
      { label: `Host auth (${providerId})`, source: "host" },
      ...cliproxyAccounts.map((account) => ({
        label: `CLIProxyAPI: ${account.label}`,
        value: account.value,
        source: "cliproxy" as const,
      })),
    ];
  }

  private getCurrentAccountSelection(providerId = this.selectedProviderId): {
    options: OpenUsageAccountOption[];
    option: OpenUsageAccountOption;
    index: number;
  } {
    const options = this.getAccountOptions(providerId);
    const selectedValue = this.data.state.persisted.selectedAccounts[providerId]?.trim();
    const index =
      selectedValue !== undefined && selectedValue.length > 0
        ? Math.max(
            0,
            options.findIndex((option) => option.value === selectedValue),
          )
        : 0;
    const option = options[index] ??
      options[0] ?? { label: `Host auth (${providerId})`, source: "host" };
    return { options, option, index };
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private async ensureSelectedSnapshot(): Promise<void> {
    if (this.getSelectedSnapshot()) {
      return;
    }
    await this.refreshSelectedProvider(false);
  }

  private cycleProvider(direction: number): void {
    const index = this.data.providerIds.indexOf(this.selectedProviderId);
    this.selectedProviderId =
      this.data.providerIds[
        (index + this.data.providerIds.length + direction) % this.data.providerIds.length
      ] ?? this.selectedProviderId;
    this.errorMessage = undefined;
    this.invalidateAndRender();
    void this.ensureSelectedSnapshot();
  }

  private toggleDisplayMode(direction: number): void {
    const modes: Array<"left" | "used"> = ["left", "used"];
    const index = modes.indexOf(this.displayMode);
    this.displayMode = modes[(index + modes.length + direction) % modes.length] ?? "left";
    this.invalidateAndRender();
  }

  private toggleResetTimeFormat(): void {
    const next: ResetTimeFormat =
      this.data.state.persisted.resetTimeFormat === "relative" ? "absolute" : "relative";
    setResetTimeFormat(this.data.state, next);
    this.data.persistState();
    this.invalidateAndRender();
  }

  private async refreshSelectedProvider(force: boolean): Promise<void> {
    if (this.busyMessage !== undefined && this.busyMessage.length > 0) {
      return;
    }

    const providerId = this.selectedProviderId;
    this.busyMessage = `${force ? "Refreshing" : "Loading"} ${providerId}…`;
    this.errorMessage = undefined;
    this.invalidateAndRender();

    try {
      await this.data.refreshProvider(providerId, { force });
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.busyMessage = undefined;
      this.invalidateAndRender();
    }
  }

  private async cycleAccount(direction: number): Promise<void> {
    if (this.busyMessage !== undefined && this.busyMessage.length > 0) {
      return;
    }

    const providerId = this.selectedProviderId;
    const current = this.getCurrentAccountSelection(providerId);
    if (current.options.length <= 1) {
      this.errorMessage = `No alternate accounts for ${providerId}`;
      this.invalidateAndRender();
      return;
    }

    const nextIndex = (current.index + current.options.length + direction) % current.options.length;
    const next = current.options[nextIndex] ?? current.option;
    const previousValue = this.data.state.persisted.selectedAccounts[providerId];

    this.busyMessage = `Switching ${providerId} account…`;
    this.errorMessage = undefined;
    setSelectedAccount(this.data.state, providerId, next.value);
    this.data.persistState();
    this.invalidateAndRender();

    try {
      await this.data.refreshProvider(providerId, { force: true });
    } catch (error) {
      setSelectedAccount(this.data.state, providerId, previousValue);
      this.data.persistState();
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.busyMessage = undefined;
      this.invalidateAndRender();
    }
  }

  private rebuild(width: number): void {
    const lines = buildOpenUsageLines({
      theme: this.theme,
      providerIds: this.data.providerIds,
      selectedProviderId: this.selectedProviderId,
      displayMode: this.displayMode,
      resetTimeFormat: this.data.state.persisted.resetTimeFormat,
      activeProviderId: this.data.activeProviderId,
      activeModelLabel: this.data.activeModelLabel,
      account: this.getCurrentAccountSelection(),
      snapshot: this.getSelectedSnapshot(),
      busyMessage: this.busyMessage,
      errorMessage: this.errorMessage,
      width,
    });
    this.body.setText(lines.join("\n"));
    this.cachedWidth = width;
  }

  private handleCloseInput(data: string): boolean {
    if (
      !matchesKey(data, Key.escape) &&
      !matchesKey(data, Key.ctrl("c")) &&
      data.toLowerCase() !== "q" &&
      data !== "\r"
    ) {
      return false;
    }
    this.onDone();
    return true;
  }

  private handleNavigationInput(data: string): boolean {
    if (matchesKey(data, Key.left) || data.toLowerCase() === "h") {
      this.cycleProvider(-1);
      return true;
    }
    if (matchesKey(data, Key.right) || data.toLowerCase() === "l") {
      this.cycleProvider(1);
      return true;
    }
    if (matchesKey(data, Key.tab) || data.toLowerCase() === "t") {
      this.toggleDisplayMode(1);
      return true;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.toggleDisplayMode(-1);
      return true;
    }
    return false;
  }

  private handleActionInput(data: string): boolean {
    if (data === "r") {
      this.toggleResetTimeFormat();
      return true;
    }
    if (data === "f") {
      void this.refreshSelectedProvider(true);
      return true;
    }
    if (data === "a") {
      void this.cycleAccount(1);
      return true;
    }
    if (data === "A") {
      void this.cycleAccount(-1);
      return true;
    }
    return false;
  }

  private handleProviderShortcutInput(data: string): void {
    if (data === "1") {
      this.selectedProviderId = this.data.providerIds[0] ?? this.selectedProviderId;
      this.invalidateAndRender();
      void this.ensureSelectedSnapshot();
      return;
    }
    if (data === "2") {
      this.selectedProviderId = this.data.providerIds[1] ?? this.selectedProviderId;
      this.invalidateAndRender();
      void this.ensureSelectedSnapshot();
    }
  }

  handleInput(data: string): void {
    if (this.handleCloseInput(data)) {
      return;
    }
    if (this.handleNavigationInput(data)) {
      return;
    }
    if (this.handleActionInput(data)) {
      return;
    }
    this.handleProviderShortcutInput(data);
  }

  invalidate(): void {
    this.container.invalidate();
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) {
      this.rebuild(width);
    }
    return this.container.render(width);
  }
}

export { OpenUsageView, type OpenUsageAccountOption, type OpenUsageViewData };
