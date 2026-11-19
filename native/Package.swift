// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SimulatorPreview",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "SimulatorHost", targets: ["SimulatorHost"])],
    targets: [
        .target(name: "SimulatorBridge", linkerSettings: [
            .linkedFramework("AppKit"), .linkedFramework("IOSurface"),
            .linkedFramework("IOKit"), .linkedFramework("QuartzCore")
        ]),
        .executableTarget(name: "SimulatorHost", dependencies: ["SimulatorBridge"], linkerSettings: [
            .linkedFramework("CoreImage"), .linkedFramework("VideoToolbox")
        ]),
        .testTarget(name: "SimulatorBridgeTests", dependencies: ["SimulatorBridge"]),
        .testTarget(name: "SimulatorHostTests", dependencies: ["SimulatorHost"])
    ]
)
