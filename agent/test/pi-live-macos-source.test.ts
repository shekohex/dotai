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
    const orb = source("macos/PiLive/Sources/PiLive/OrbRenderer.swift");
    const compact = source("macos/PiLive/Sources/PiLive/CompactLiveSurface.swift");

    expect(orb).not.toContain("Circle()");
    expect(orb).not.toContain("Canvas");
    expect(compact).toContain("OrbRenderer(");
    expect(compact).toContain("OrbClickSurface(");
    expect(compact).toContain("onSingleClick: model.toggleMute");
    expect(compact).toContain("onDoubleClick: model.disconnect");
    expect(compact).toContain('.matchedGeometryEffect(id: "live-orb"');
    expect(compact).not.toContain("VoiceOrb");
    expect(compact).not.toContain("AppleIntelligenceGlow");
    expect(compact).not.toContain("Color.red.opacity");
    expect(compact).not.toContain(".orange.gradient");
  });

  it("keeps autonomous desktop roaming local and independent from visual state", () => {
    const motion = source("macos/PiLive/Sources/PiLive/DesktopPetMotionController.swift");
    const compact = source("macos/PiLive/Sources/PiLive/CompactLiveSurface.swift");
    const coordinator = source("macos/PiLive/Sources/PiLive/LiveWindowCoordinator.swift");
    const rpc = source("macos/PiLive/Sources/PiLive/LiveRPC.swift");

    expect(motion).toContain("case .resting");
    expect(motion).toContain("case .outbound");
    expect(motion).toContain("case .returning");
    expect(motion).toContain("restUntil = now + Self.restDuration");
    expect(motion).toContain("return origin");
    expect(motion).toContain("reduceMotion");
    expect(compact).toContain("@Bindable var desktopPetMotion");
    expect(compact).toContain("state: desktopPetMotion.presentation.visualState");
    expect(compact).toContain(
      "mirroredHorizontally: desktopPetMotion.presentation.mirroredHorizontally",
    );
    expect(coordinator).toContain("NSWorkspace.activeSpaceDidChangeNotification");
    expect(coordinator).toContain("moveToPointerDisplayIfNeeded(window)");
    expect(coordinator).toContain("rebaseMotion(window: window, display: target)");
    expect(coordinator).not.toContain("guard !self.desktopPetMotion.ownsWindowPosition else");
    expect(rpc).not.toMatch(/DesktopPet|roam|mirroredHorizontally/u);
  });

  it("keeps orb identity local and separate from voice wire settings", () => {
    const viewModel = source("macos/PiLive/Sources/PiLive/LiveViewModel.swift");
    const preferences = source("macos/PiLive/Sources/PiLive/LivePreferences.swift");
    const rpc = source("macos/PiLive/Sources/PiLive/LiveRPC.swift");

    expect(viewModel).toContain("func selectOrb(_ orb: OrbPackManifest)");
    expect(viewModel).toContain("preferences.saveOrbID(orb.id)");
    expect(viewModel.match(/client\.setPreferredVoice/g)).toHaveLength(1);
    expect(preferences).toContain('static let orb = "selectedOrbID"');
    expect(rpc).not.toContain("selectedOrbID");
  });

  it("keeps orb chrome structurally absent across repeated window reconfiguration", () => {
    const app = source("macos/PiLive/Sources/PiLive/PiLiveApp.swift");
    const coordinator = source("macos/PiLive/Sources/PiLive/LiveWindowCoordinator.swift");

    expect(app).not.toContain(".windowStyle(.hiddenTitleBar)");
    expect(coordinator).toContain("enum LiveWindowPresentation");
    expect(coordinator).toContain("static let styleMask: NSWindow.StyleMask = [.resizable]");
    expect(coordinator).toContain("LiveWindowPresentation.apply(to: window)");
    expect(coordinator).toContain("maintainWindowPresentation(window)");
    expect(coordinator).toContain(".canJoinAllSpaces");
    expect(coordinator).toContain(".fullScreenAuxiliary");
    expect(coordinator).toContain("window.orderFrontRegardless()");
    expect(coordinator).not.toContain(".titled");
    expect(coordinator).not.toContain("standardWindowButton");
    expect(coordinator).not.toContain("NSApp.activate(ignoringOtherApps: true)");
    expect(coordinator).not.toContain("makeKeyAndOrderFront");
  });
});
