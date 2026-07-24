import AppKit
import Foundation

@MainActor
final class LiveViewModel: ObservableObject {
    @Published var pairingURL = ""
    @Published var coderToken = ""
    @Published var sshTarget = UserDefaults.standard.string(forKey: "sshTarget") ?? ""
    @Published var preferredTransport = PreferredTransport(
        rawValue: UserDefaults.standard.string(forKey: "preferredTransport") ?? "automatic"
    ) ?? .automatic
    @Published var phase: LivePhase = .idle
    @Published var transcript = ""
    @Published var errorMessage = ""
    @Published var connected = false
    @Published var muted = false

    private let credentials = CredentialStore()
    private let client = LivePairingClient()

    init() {
        coderToken = credentials.readCoderToken()
        client.onPhase = { [weak self] phase in
            self?.phase = phase
            self?.connected = ![.idle, .pairing, .connecting, .error].contains(phase)
            self?.muted = phase == .muted
        }
        client.onTranscript = { [weak self] text in self?.transcript = text }
        client.onError = { [weak self] error in self?.errorMessage = error.localizedDescription }
        client.onStopped = { [weak self] in self?.reset() }
    }

    func pastePairingURL() {
        pairingURL = NSPasteboard.general.string(forType: .string) ?? pairingURL
    }

    func connect() {
        errorMessage = ""
        UserDefaults.standard.set(sshTarget, forKey: "sshTarget")
        UserDefaults.standard.set(preferredTransport.rawValue, forKey: "preferredTransport")
        do { try credentials.saveCoderToken(coderToken) }
        catch { errorMessage = error.localizedDescription; return }
        Task {
            do {
                try await client.connect(
                    pairingURL: pairingURL,
                    preferredTransport: preferredTransport,
                    coderToken: coderToken,
                    sshTarget: sshTarget
                )
            } catch {
                phase = .error
                errorMessage = error.localizedDescription
            }
        }
    }

    func toggleMute() {
        Task { await client.toggleMute() }
    }

    func disconnect() {
        client.close()
        reset()
    }

    private func reset() {
        connected = false
        muted = false
        phase = .idle
        transcript = ""
    }
}
