import Darwin
import Foundation

final class SSHTunnel {
    private var process: Process?

    func open(target: String, remoteHost: String, remotePort: Int) async throws -> URL {
        let localPort = try reserveLocalPort()
        let process = Process()
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
        process.standardError = Pipe()
        try process.run()
        self.process = process
        try await Task.sleep(for: .milliseconds(500))
        guard process.isRunning else {
            let pipe = process.standardError as? Pipe
            let detail = pipe.flatMap { String(data: $0.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) }
            throw PiLiveError.protocolError("SSH tunnel failed\(detail.map { ": \($0)" } ?? "")")
        }
        return URL(string: "ws://127.0.0.1:\(localPort)/live")!
    }

    func close() {
        guard let process else { return }
        if process.isRunning { process.terminate() }
        self.process = nil
    }

    deinit { close() }

    private func reserveLocalPort() throws -> Int {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw PiLiveError.protocolError("Unable to create local socket") }
        defer { Darwin.close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard result == 0 else { throw PiLiveError.protocolError("Unable to reserve local port") }
        var bound = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let status = withUnsafeMutablePointer(to: &bound) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(descriptor, $0, &length)
            }
        }
        guard status == 0 else { throw PiLiveError.protocolError("Unable to read local port") }
        return Int(UInt16(bigEndian: bound.sin_port))
    }
}
