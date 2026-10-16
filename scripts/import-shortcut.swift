// Imports a signed .shortcut without a human click: opens it, then presses "Add Shortcut" on the import window
// whose heading is the shortcut's name. Needs Accessibility permission for the calling app (System Settings ->
// Privacy & Security -> Accessibility). Usage: swift scripts/import-shortcut.swift dist/swiss-due.shortcut
import AppKit
import ApplicationServices

let path = CommandLine.arguments.dropFirst().first ?? ""
guard path.hasSuffix(".shortcut"), FileManager.default.fileExists(atPath: path) else {
  FileHandle.standardError.write("usage: import-shortcut <file.shortcut>\n".data(using: .utf8)!)
  exit(2)
}
guard AXIsProcessTrusted() else {
  FileHandle.standardError.write("this process lacks Accessibility permission\n".data(using: .utf8)!)
  exit(3)
}
// Shortcuts names an import after the file.
let name = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
// A busy Shortcuts app makes each accessibility call block for the 6 s system default; keep calls short.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  AXUIElementCopyAttributeValue(e, a as CFString, &v)
  return v
}
func children(_ e: AXUIElement) -> [AXUIElement] { attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func text(_ e: AXUIElement) -> String {
  [attr(e, kAXTitleAttribute), attr(e, kAXDescriptionAttribute), attr(e, kAXValueAttribute)]
    .compactMap { $0 as? String }.first { !$0.isEmpty } ?? ""
}
// Import windows are shallow; the bound keeps a walk through large editor windows from overflowing the stack.
func find(_ e: AXUIElement, role: String, text want: String, depth: Int = 0) -> AXUIElement? {
  if depth > 12 { return nil }
  if attr(e, kAXRoleAttribute) as? String == role, text(e) == want { return e }
  for c in children(e) { if let hit = find(c, role: role, text: want, depth: depth + 1) { return hit } }
  return nil
}

NSWorkspace.shared.open(URL(fileURLWithPath: path))
let deadline = Date().addingTimeInterval(15)
while Date() < deadline {
  Thread.sleep(forTimeInterval: 0.25)
  guard let shortcuts = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.shortcuts").first
  else { continue }
  let windows = attr(AXUIElementCreateApplication(shortcuts.processIdentifier), kAXWindowsAttribute) as? [AXUIElement] ?? []
  // An editor window titled with the same name has no "Add Shortcut" button, so only an import window matches.
  for window in windows where find(window, role: "AXHeading", text: name) != nil {
    // A shortcut that already exists shows "Replace" instead of "Add Shortcut".
    guard let add = find(window, role: "AXButton", text: "Add Shortcut") ?? find(window, role: "AXButton", text: "Replace")
    else { continue }
    let result = AXUIElementPerformAction(add, kAXPressAction as CFString)
    print(result == .success ? "pressed \(text(add)) for \(name)" : "press failed: \(result.rawValue)")
    exit(result == .success ? 0 : 1)
  }
}
FileHandle.standardError.write("no import window for \(name) appeared\n".data(using: .utf8)!)
exit(1)
