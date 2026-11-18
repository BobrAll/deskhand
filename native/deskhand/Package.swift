// swift-tools-version: 6.0
import PackageDescription

// The desktop agent that Deskhand drives. It is built as a sidecar binary
// (`deskhand-agent --serve`) and speaks newline-delimited JSON with the Electron
// main process; the app owns the UI, the policy and the settings, and this
// package owns everything that touches the machine.
let package = Package(
    name: "Deskhand",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "deskhand-agent", targets: ["DeskhandAgent"]),
        .library(name: "DeskhandCore", targets: ["DeskhandCore"]),
        .library(name: "DeskhandLLM", targets: ["DeskhandLLM"]),
        .library(name: "DeskhandAgentKit", targets: ["DeskhandAgentKit"]),
    ],
    targets: [
        .target(
            name: "DeskhandCore",
            path: "Sources/DeskhandCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "DeskhandLLM",
            dependencies: ["DeskhandCore"],
            path: "Sources/DeskhandLLM",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "DeskhandAgentKit",
            dependencies: ["DeskhandCore", "DeskhandLLM"],
            path: "Sources/DeskhandAgentKit",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "DeskhandAgent",
            dependencies: ["DeskhandCore", "DeskhandLLM", "DeskhandAgentKit"],
            path: "Sources/DeskhandAgent",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "DeskhandCoreTests",
            dependencies: ["DeskhandCore"],
            path: "Tests/DeskhandCoreTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "DeskhandLLMTests",
            dependencies: ["DeskhandLLM", "DeskhandCore"],
            path: "Tests/DeskhandLLMTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "DeskhandAgentTests",
            dependencies: ["DeskhandAgentKit", "DeskhandCore", "DeskhandLLM"],
            path: "Tests/DeskhandAgentTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
