// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PiLive",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", from: "150.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "PiLive",
            dependencies: [.product(name: "WebRTC", package: "WebRTC")],
            path: "Sources/PiLive",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
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
