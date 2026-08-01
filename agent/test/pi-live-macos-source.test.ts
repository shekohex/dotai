import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Pi Live macOS UX source contracts", () => {
  it("keeps permissions first-class and refresh-only on appearance", () => {
    const settings = source("macos/PiLive/Sources/PiLive/LiveSettingsView.swift");

    expect(settings).toContain("case permissions");
    expect(settings).toContain('case .permissions: "Permissions"');
    expect(settings).toContain("Request Access");
    expect(settings).toContain("Open System Settings");
    expect(settings).toContain("NSApplication.didBecomeActiveNotification");
    expect(settings).toContain(".onAppear { model.refresh() }");
    expect(settings).not.toMatch(
      /\.onAppear\s*\{[^}]*request(?:Microphone|ScreenRecording)Permission/su,
    );
  });

  it("removes semantic traffic-light colors from orb status presentation", () => {
    const orb = source("macos/PiLive/Sources/PiLive/VoiceOrb.swift");
    const compact = source("macos/PiLive/Sources/PiLive/CompactLiveSurface.swift");

    expect(orb).not.toContain("localSpeaking ? .green");
    expect(compact).not.toContain("Color.red.opacity");
    expect(compact).not.toContain(".orange.gradient");
  });

  it("keeps only orb window chrome hidden while avoiding focus stealing", () => {
    const coordinator = source("macos/PiLive/Sources/PiLive/LiveWindowCoordinator.swift");

    expect(coordinator).toContain(".canJoinAllSpaces");
    expect(coordinator).toContain(".fullScreenAuxiliary");
    expect(coordinator).toContain("window.orderFrontRegardless()");
    expect(coordinator).toContain("standardWindowButton(.closeButton)?.isHidden = true");
    expect(coordinator).not.toContain("NSApp.activate(ignoringOtherApps: true)");
    expect(coordinator).not.toContain("makeKeyAndOrderFront");
  });
});
