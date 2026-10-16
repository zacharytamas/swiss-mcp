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

// Importing over an existing shortcut shows a Replace / Keep Both / Cancel sheet inside the same import window, under
// the same heading (measured on macOS 27.0). So every press stays within the window headed with this name: Replace
// when the sheet is up, otherwise Add Shortcut. Other import windows are never touched.
NSWorkspace.shared.open(URL(fileURLWithPath: path))
let deadline = Date().addingTimeInterval(20)
var pressed: [String] = []
while Date() < deadline {
  Thread.sleep(forTimeInterval: 0.25)
  guard let shortcuts = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.shortcuts").first
  else { continue }
  let windows = attr(AXUIElementCreateApplication(shortcuts.processIdentifier), kAXWindowsAttribute) as? [AXUIElement] ?? []
  // An editor window titled with the same name has neither button, so only this import window can match.
  let ours = windows.first { find($0, role: "AXHeading", text: name) != nil
    && (find($0, role: "AXButton", text: "Replace") ?? find($0, role: "AXButton", text: "Add Shortcut")) != nil }
  guard let window = ours else {
    if !pressed.isEmpty {
      print("imported \(name) (pressed \(pressed.joined(separator: ", ")))")
      exit(0)
    }
    continue
  }
  guard let button = find(window, role: "AXButton", text: "Replace") ?? find(window, role: "AXButton", text: "Add Shortcut")
  else { continue }
  let label = text(button)
  guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { continue }
  pressed.append(label)
}
FileHandle.standardError.write(
  (pressed.isEmpty ? "no import window for \(name) appeared\n" : "import window for \(name) did not close\n").data(using: .utf8)!)
exit(1)
