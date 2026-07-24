// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "PiLive",
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", from: "150.0.0"),
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts", from: "3.0.1"),
    ],
    targets: [
        .executableTarget(
            name: "PiLive",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC"),
                .product(name: "KeyboardShortcuts", package: "KeyboardShortcuts"),
            ],
            path: "Sources/PiLive",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("DeviceCheck"),
                .linkedFramework("Security"),
            ]
        ),
        .testTarget(
            name: "PiLiveTests",
            dependencies: ["PiLive"],
            path: "Tests/PiLiveTests"
        ),
    ]
)
