import AppKit
import CoreGraphics
import Foundation

func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
}

func click(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    post(CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseDown,
        mouseCursorPosition: point,
        mouseButton: .left
    ))
    post(CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseUp,
        mouseCursorPosition: point,
        mouseButton: .left
    ))
}

func setUnicode(_ event: CGEvent?, _ text: String) {
    let characters = Array(text.utf16)
    characters.withUnsafeBufferPointer { buffer in
        event?.keyboardSetUnicodeString(
            stringLength: buffer.count,
            unicodeString: buffer.baseAddress
        )
    }
}

func typeText(_ text: String) async {
    let source = CGEventSource(stateID: .hidSystemState)
    let selectAllDown = CGEvent(
        keyboardEventSource: source,
        virtualKey: 0,
        keyDown: true
    )
    selectAllDown?.flags = .maskCommand
    post(selectAllDown)
    let selectAllUp = CGEvent(
        keyboardEventSource: source,
        virtualKey: 0,
        keyDown: false
    )
    selectAllUp?.flags = .maskCommand
    post(selectAllUp)
    try? await Task.sleep(for: .milliseconds(150))

    for scalar in text.unicodeScalars {
        let value = String(scalar)
        let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
        setUnicode(down, value)
        post(down)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        setUnicode(up, value)
        post(up)
        try? await Task.sleep(for: .milliseconds(2))
    }
}

@main
struct GUIInput {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count >= 3,
              let pid = pid_t(args[1]),
              let app = NSRunningApplication(processIdentifier: pid) else {
            fputs("Usage: gui-input click PID X Y | type PID TEXT\n", stderr)
            exit(2)
        }

        guard app.activate() else {
            fputs("Could not activate PID \(pid)\n", stderr)
            exit(1)
        }
        try? await Task.sleep(for: .milliseconds(750))

        switch args[0] {
        case "click":
            guard args.count == 4, let x = Double(args[2]), let y = Double(args[3]) else {
                fputs("Usage: gui-input click PID X Y\n", stderr)
                exit(2)
            }
            click(x: x, y: y)
        case "type":
            let text = args.dropFirst(2).joined(separator: " ")
            await typeText(text)
        default:
            fputs("Unknown command\n", stderr)
            exit(2)
        }
    }
}
