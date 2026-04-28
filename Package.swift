// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "T3CodeHost",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "T3CodeHost",
            targets: ["T3CodeHost"]
        )
    ],
    dependencies: [
        .package(path: "../t3code-sidecar/t3code-communication")
    ],
    targets: [
        .target(
            name: "T3CodeHost",
            dependencies: [
                .product(name: "T3CodeCommunication", package: "t3code-communication")
            ]
        ),
        .testTarget(
            name: "T3CodeHostTests",
            dependencies: ["T3CodeHost"]
        )
    ]
)
