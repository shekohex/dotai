import Foundation
@preconcurrency import Network

@MainActor
final class SSHTunnel {
    private let networkQueue = DispatchQueue(label: "dev.herdr.pilive.ssh-port")
    private var process: Process?

    func open(target: String, remoteHost: String, remotePort: Int) async throws -> URL {
        let localPort = try await allocateLocalPort()
        let process = Process()
        let errorPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = [
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=15",
            "-N",
            "-L", "\(localPort):\(remoteHost):\(remotePort)",
            target,
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errorPipe
        try process.run()
        self.process = process

        let url = URL(string: "ws://127.0.0.1:\(localPort)/live")!
        do {
            try await waitUntilReady(url: url, process: process)
            return url
        } catch {
            if process.isRunning { process.terminate() }
            self.process = nil
            let detail = String(
                data: errorPipe.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            )?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let detail, !detail.isEmpty {
                throw PiLiveError.protocolError("SSH tunnel failed: \(detail)")
            }
            throw error
        }
    }

    func close() {
        guard let process else { return }
        if process.isRunning { process.terminate() }
        self.process = nil
    }

    deinit {
        if process?.isRunning == true { process?.terminate() }
    }

    private func allocateLocalPort() async throws -> Int {
        let listener = try NWListener(using: .tcp, on: .any)
        listener.start(queue: networkQueue)
        defer { listener.cancel() }

        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(2))
        while clock.now < deadline {
            if let port = listener.port { return Int(port.rawValue) }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw PiLiveError.protocolError("Unable to allocate a local SSH port")
    }

    private func waitUntilReady(url: URL, process: Process) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(8))
        while clock.now < deadline {
            guard process.isRunning else {
                throw PiLiveError.protocolError("SSH exited before the tunnel became ready")
            }
            if await probeWebSocket(url) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw PiLiveError.protocolError("SSH tunnel did not become ready in time")
    }

    private func probeWebSocket(_ url: URL) async -> Bool {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 0.5
        let session = URLSession(configuration: configuration)
        let socket = session.webSocketTask(with: url)
        socket.resume()
        defer {
            socket.cancel(with: .normalClosure, reason: nil)
            session.invalidateAndCancel()
        }
        return await withCheckedContinuation { continuation in
            socket.sendPing { error in
                continuation.resume(returning: error == nil)
            }
        }
    }
}
