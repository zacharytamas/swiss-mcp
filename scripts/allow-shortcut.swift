// Answers Shortcuts' first-run privacy prompt ("Allow “<name>” to access “<app>”?") with Allow, for one named
// shortcut only. Reads nothing but the Shortcuts prompt service. Needs Accessibility permission.
// Usage: swift scripts/allow-shortcut.swift swiss-due [seconds-to-wait]
import AppKit
import ApplicationServices

let args = Array(CommandLine.arguments.dropFirst())
guard let name = args.first else {
  FileHandle.standardError.write("usage: allow-shortcut <shortcut-name> [seconds]\n".data(using: .utf8)!)
  exit(2)
}
let deadline = Date().addingTimeInterval(Double(args.dropFirst().first ?? "20") ?? 20)
guard AXIsProcessTrusted() else {
  FileHandle.standardError.write("this process lacks Accessibility permission\n".data(using: .utf8)!)
  exit(3)
}
// Keep each accessibility call short so the deadline holds even when the prompt service is busy.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  AXUIElementCopyAttributeValue(e, a as CFString, &v)
  return v
}
func label(_ e: AXUIElement) -> String {
  [attr(e, kAXTitleAttribute), attr(e, kAXValueAttribute), attr(e, kAXDescriptionAttribute)]
    .compactMap { $0 as? String }.first { !$0.isEmpty } ?? ""
}
func all(_ e: AXUIElement, depth: Int = 0) -> [AXUIElement] {
  depth > 8 ? [] : [e] + (attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? []).flatMap { all($0, depth: depth + 1) }
}

var allowed = 0
while Date() < deadline {
  for service in NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.WorkflowKit.ShortcutsViewService") {
    let windows = attr(AXUIElementCreateApplication(service.processIdentifier), kAXWindowsAttribute) as? [AXUIElement] ?? []
    for window in windows {
      let elements = all(window)
      let asksAboutThis = elements.contains {
        attr($0, kAXRoleAttribute) as? String == "AXStaticText" && label($0).hasPrefix("Allow “\(name)”")
      }
      guard asksAboutThis else { continue }
      let button = elements.first { attr($0, kAXRoleAttribute) as? String == "AXButton" && label($0) == "Always Allow" }
        ?? elements.first { attr($0, kAXRoleAttribute) as? String == "AXButton" && label($0) == "Allow" }
      guard let button else { continue }
      if AXUIElementPerformAction(button, kAXPressAction as CFString) == .success {
        allowed += 1
        print("pressed \(label(button)) for \(name)")
      }
    }
  }
  Thread.sleep(forTimeInterval: 0.3)
}
exit(allowed > 0 ? 0 : 1)
