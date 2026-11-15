import AppKit
import Foundation

private let maxLaunchConfigurationBytes = 64 * 1024
private let maxLaunchItemCount = 128
private let maxLaunchStringBytes = 16 * 1024

struct LaunchOptions: Decodable {
    let arguments: [String]?
    let environment: [String: String]?
    let activates: Bool?
    let newInstance: Bool?

    enum CodingKeys: String, CodingKey {
        case arguments
        case environment
        case activates
        case newInstance
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        if container.contains(.arguments) {
            arguments = try container.decode([String].self, forKey: .arguments)
        } else {
            arguments = nil
        }

        if container.contains(.environment) {
            environment = try container.decode(
                [String: String].self,
                forKey: .environment
            )
        } else {
            environment = nil
        }

        if container.contains(.activates) {
            activates = try container.decode(Bool.self, forKey: .activates)
        } else {
            activates = nil
        }

        if container.contains(.newInstance) {
            newInstance = try container.decode(Bool.self, forKey: .newInstance)
        } else {
            newInstance = nil
        }
    }
}

enum LaunchOptionsError: LocalizedError {
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let message):
            return "Invalid launch configuration: \(message)"
        }
    }
}

func containsNul(_ value: String) -> Bool {
    value.unicodeScalars.contains { $0.value == 0 }
}

func parseLaunchOptions(_ text: String) throws -> LaunchOptions {
    guard let data = text.data(using: .utf8) else {
        throw LaunchOptionsError.invalid("configuration must be UTF-8 JSON")
    }

    guard data.count <= maxLaunchConfigurationBytes else {
        throw LaunchOptionsError.invalid("configuration exceeds 65536 bytes")
    }

    let json: Any
    do {
        json = try JSONSerialization.jsonObject(with: data)
    } catch {
        throw LaunchOptionsError.invalid("configuration must be valid JSON")
    }

    guard let object = json as? [String: Any] else {
        throw LaunchOptionsError.invalid("configuration must be a JSON object")
    }

    let allowedKeys: Set<String> = ["arguments", "environment", "activates", "newInstance"]
    guard object.keys.allSatisfy({ allowedKeys.contains($0) }) else {
        throw LaunchOptionsError.invalid("configuration contains an unknown field")
    }

    let options: LaunchOptions
    do {
        options = try JSONDecoder().decode(LaunchOptions.self, from: data)
    } catch {
        throw LaunchOptionsError.invalid(
            "arguments must be strings, environment values must be strings, and activates/newInstance must be booleans"
        )
    }

    if let arguments = options.arguments {
        guard arguments.count <= maxLaunchItemCount else {
            throw LaunchOptionsError.invalid("arguments exceed 128 entries")
        }

        for argument in arguments {
            guard argument.utf8.count <= maxLaunchStringBytes else {
                throw LaunchOptionsError.invalid("an argument exceeds 16384 bytes")
            }
            guard !containsNul(argument) else {
                throw LaunchOptionsError.invalid("arguments cannot contain NUL")
            }
        }
    }

    if let environment = options.environment {
        guard environment.count <= maxLaunchItemCount else {
            throw LaunchOptionsError.invalid("environment exceeds 128 entries")
        }

        for (key, value) in environment {
            guard !key.isEmpty, !key.contains("="), !containsNul(key) else {
                throw LaunchOptionsError.invalid(
                    "environment keys must be nonempty and cannot contain '=' or NUL"
                )
            }
            guard key.utf8.count <= maxLaunchStringBytes else {
                throw LaunchOptionsError.invalid(
                    "an environment key exceeds 16384 bytes"
                )
            }
            guard value.utf8.count <= maxLaunchStringBytes else {
                throw LaunchOptionsError.invalid(
                    "an environment value exceeds 16384 bytes"
                )
            }
            guard !containsNul(value) else {
                throw LaunchOptionsError.invalid(
                    "environment values cannot contain NUL"
                )
            }
        }
    }

    return options
}

func output(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(
        withJSONObject: value,
        options: [.sortedKeys]
    ),
    let text = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"error\":\"JSON encoding failed\"}")
        return
    }

    print(text)
}

func activationPolicyName(_ policy: NSApplication.ActivationPolicy) -> String {
    switch policy {
    case .regular:
        return "regular"
    case .accessory:
        return "accessory"
    case .prohibited:
        return "prohibited"
    @unknown default:
        return "unknown"
    }
}

func addApplicationMetadata(
    _ app: NSRunningApplication,
    to result: inout [String: Any]
) {
    result["activationPolicy"] = activationPolicyName(app.activationPolicy)
    result["activationPolicyRawValue"] = app.activationPolicy.rawValue

    if let executableURL = app.executableURL {
        result["executableURL"] = executableURL.path
    }

    if let launchDate = app.launchDate {
        result["launchDate"] = ISO8601DateFormatter().string(from: launchDate)
    }
}

@main
struct AppManager {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())

        guard let command = args.first else {
            output(["ok": false, "error": "Missing command"])
            return
        }

        switch command {
        case "launch":
            guard args.count >= 2 else {
                output(["ok": false, "error": "Missing bundle identifier"])
                return
            }

            guard args.count <= 3 else {
                output([
                    "ok": false,
                    "error": "Usage: launch BUNDLE_ID [CONFIGURATION_JSON]"
                ])
                return
            }

            let options: LaunchOptions?
            if args.count == 3 {
                do {
                    options = try parseLaunchOptions(args[2])
                } catch {
                    output([
                        "ok": false,
                        "error": error.localizedDescription
                    ])
                    return
                }
            } else {
                options = nil
            }

            let bundleID = args[1]
            let existingProcessIDs = Set(
                NSRunningApplication.runningApplications(
                    withBundleIdentifier: bundleID
                ).map { $0.processIdentifier }
            )

            guard let appURL = NSWorkspace.shared
                .urlForApplication(withBundleIdentifier: bundleID) else {
                output(["ok": false, "error": "Application not found"])
                return
            }

            do {
                let config = NSWorkspace.OpenConfiguration()
                if let arguments = options?.arguments {
                    config.arguments = arguments
                }
                if let environment = options?.environment {
                    config.environment = environment
                }
                if let activates = options?.activates {
                    config.activates = activates
                }
                if let newInstance = options?.newInstance {
                    config.createsNewApplicationInstance = newInstance
                }

                let app = try await NSWorkspace.shared.openApplication(
                    at: appURL,
                    configuration: config
                )

                var result: [String: Any] = [
                    "ok": true,
                    "name": app.localizedName ?? "Unknown",
                    "bundleIdentifier": app.bundleIdentifier ?? bundleID,
                    "pid": Int(app.processIdentifier),
                    "bundleURL": appURL.path,
                    "processExistedBeforeLaunch": !existingProcessIDs.isEmpty,
                    "processReused": existingProcessIDs.contains(
                        app.processIdentifier
                    )
                ]
                addApplicationMetadata(app, to: &result)
                output(result)
            } catch {
                output([
                    "ok": false,
                    "error": error.localizedDescription
                ])
            }

        case "frontmost":
            guard args.count == 1 else {
                output(["ok": false, "error": "Usage: frontmost"])
                return
            }

            guard let app = NSWorkspace.shared.frontmostApplication else {
                output([
                    "ok": true,
                    "available": false,
                    "message": "Frontmost application unavailable"
                ])
                return
            }

            var result: [String: Any] = [
                "ok": true,
                "available": true,
                "pid": Int(app.processIdentifier),
                "name": app.localizedName ?? "Unknown",
                "bundleIdentifier": app.bundleIdentifier ?? "Unknown"
            ]
            addApplicationMetadata(app, to: &result)
            output(result)

        case "inspect", "terminate":
            guard args.count == 3,
                  let pid = Int32(args[1]),
                  pid > 0 else {
                output([
                    "ok": false,
                    "error": "Usage: \(command) PID EXPECTED_BUNDLE_ID"
                ])
                return
            }

            let expectedBundleID = args[2]

            guard let app = NSRunningApplication(
                processIdentifier: pid
            ) else {
                output([
                    "ok": true,
                    "pid": Int(pid),
                    "running": false,
                    "message": "Application process not found"
                ])
                return
            }

            guard app.bundleIdentifier == expectedBundleID else {
                output([
                    "ok": false,
                    "pid": Int(pid),
                    "error": "PID does not match expected application",
                    "actualBundleIdentifier": app.bundleIdentifier ?? "Unknown"
                ])
                return
            }

            if command == "inspect" {
                var result: [String: Any] = [
                    "ok": true,
                    "pid": Int(pid),
                    "name": app.localizedName ?? "Unknown",
                    "bundleIdentifier": expectedBundleID,
                    "running": !app.isTerminated,
                    "hidden": app.isHidden
                ]
                addApplicationMetadata(app, to: &result)
                output(result)
                return
            }

            if app.isTerminated {
                output([
                    "ok": true,
                    "pid": Int(pid),
                    "running": false
                ])
                return
            }

            let accepted = app.terminate()

            for _ in 0..<30 {
                if app.isTerminated {
                    break
                }
                try? await Task.sleep(for: .milliseconds(100))
            }

            output([
                "ok": true,
                "pid": Int(pid),
                "terminationRequested": accepted,
                "running": !app.isTerminated
            ])

        default:
            output([
                "ok": false,
                "error": "Unknown command"
            ])
        }
    }
}
