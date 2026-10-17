// The Zenith Mac app: its own window, not a browser tab. alon-release.sh
// compiles this with swiftc into Zenith.app/Contents/MacOS/Zenith.
//
// It starts Zenith with launcher.sh (in the app's Resources), shows it in a
// WebKit view, and stops it when the app quits. Links to other websites open
// in the normal browser. Updates are looked for in the background; when one
// is ready, the app offers Restart now.
import AppKit
import WebKit

let zenithURL = URL(string: "http://localhost:4173/")!
let resources = Bundle.main.resourceURL!

/// Runs launcher.sh with one action and returns what it printed.
@discardableResult
func launcher(_ action: String) -> (ok: Bool, said: String) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/zsh")
  process.arguments = [resources.appendingPathComponent("launcher.sh").path, action]
  var environment = ProcessInfo.processInfo.environment
  environment["ZENITH_NO_BROWSER"] = "1"
  process.environment = environment
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = FileHandle.nullDevice
  do { try process.run() } catch { return (false, "Zenith could not start its helper.") }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  let said = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  return (process.terminationStatus == 0, said)
}

/// The page view: a click on the window when it is not in front still reaches
/// the button under it, as in a browser (a plain WebKit view only brings the
/// window forward on that first click).
final class ZenithWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  let waiting = NSTextField(labelWithString: "Starting Zenith…")
  /// A short note along the top of the window (never a box that can get stuck in front).
  let banner = NSTextField(labelWithString: "")
  var pageReady = false
  var pendingNote = ""
  var checking: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    let configuration = WKWebViewConfiguration()
    configuration.preferences.isElementFullscreenEnabled = true
    configuration.websiteDataStore = .default()
    webView = ZenithWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    // Dark until Zenith draws, not white.
    webView.setValue(false, forKey: "drawsBackground")
    webView.isHidden = true

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.title = "Zenith"
    window.titlebarAppearsTransparent = true
    window.backgroundColor = NSColor(red: 0.01, green: 0.03, blue: 0.05, alpha: 1)
    window.minSize = NSSize(width: 900, height: 600)
    window.collectionBehavior = .fullScreenPrimary
    window.center()
    window.setFrameAutosaveName("ZenithWindow")
    // A remembered size smaller than the smallest allowed one is not kept.
    if window.frame.width < window.minSize.width || window.frame.height < window.minSize.height {
      window.setContentSize(NSSize(width: 1440, height: 900))
      window.center()
    }
    let content = NSView()
    window.contentView = content
    banner.isHidden = true
    banner.alignment = .center
    banner.textColor = NSColor(red: 0.01, green: 0.06, blue: 0.09, alpha: 1)
    banner.backgroundColor = NSColor(red: 0.45, green: 0.9, blue: 1, alpha: 0.95)
    banner.drawsBackground = true
    banner.font = .systemFont(ofSize: 13, weight: .semibold)
    banner.lineBreakMode = .byWordWrapping
    banner.maximumNumberOfLines = 2
    for view in [webView!, waiting, banner] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      content.addSubview(view)
    }
    waiting.textColor = NSColor(red: 0.6, green: 0.9, blue: 1, alpha: 1)
    waiting.font = .monospacedSystemFont(ofSize: 15, weight: .medium)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      webView.topAnchor.constraint(equalTo: content.topAnchor),
      webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      waiting.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      waiting.centerYAnchor.constraint(equalTo: content.centerYAnchor),
      banner.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      banner.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      banner.bottomAnchor.constraint(equalTo: content.bottomAnchor),
    ])
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    start()
  }

  func start() {
    waiting.stringValue = "Starting Zenith…"
    waiting.isHidden = false
    webView.isHidden = true
    DispatchQueue.global().async {
      let result = launcher("start")
      DispatchQueue.main.async {
        guard result.ok else {
          self.tell("Zenith did not start", result.said)
          NSApp.terminate(nil)
          return
        }
        self.webView.load(URLRequest(url: zenithURL))
        self.lookForUpdates()
        self.checking?.invalidate()
        self.checking = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in self.lookForUpdates() }
      }
    }
  }

  /// Looks for an update in the background, then says what there is to say.
  func lookForUpdates() {
    DispatchQueue.global().async {
      launcher("check-bg")
      let note = launcher("note").said
      DispatchQueue.main.async { self.showNote(note) }
    }
  }

  func showNote(_ note: String) {
    // Nothing is shown over the window until Zenith's page is up.
    guard pageReady else {
      pendingNote += (pendingNote.isEmpty ? "" : "\n") + note
      return
    }
    for line in note.split(separator: "\n").map(String.init) where !line.isEmpty {
      if line.hasPrefix("READY ") {
        let alert = NSAlert()
        alert.messageText = "A new version of Zenith is ready"
        alert.informativeText = String(line.dropFirst("READY ".count))
        alert.addButton(withTitle: "Restart now")
        alert.addButton(withTitle: "Later")
        alert.beginSheetModal(for: window) { answer in
          guard answer == .alertFirstButtonReturn else { return }
          self.waiting.stringValue = "Updating Zenith…"
          self.waiting.isHidden = false
          self.webView.isHidden = true
          DispatchQueue.global().async {
            launcher("stop")
            DispatchQueue.main.async { self.start() }
          }
        }
      } else {
        say(line)
      }
    }
  }

  /// A short note along the bottom of the window, gone after twelve seconds.
  func say(_ text: String) {
    banner.stringValue = "  \(text)  "
    banner.isHidden = false
    DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
      if self?.banner.stringValue == "  \(text)  " { self?.banner.isHidden = true }
    }
  }

  func tell(_ title: String, _ text: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = text
    if window.isVisible { alert.beginSheetModal(for: window) } else { alert.runModal() }
  }

  // Closing the window quits Zenith, and quitting stops it.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationWillTerminate(_ notification: Notification) { launcher("stop") }

  // MARK: the page

  // Shown as soon as the page starts to draw: Zenith has its own loading screen,
  // and the first start loads many files.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    waiting.isHidden = true
    webView.isHidden = false
    window.makeFirstResponder(webView)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard !pageReady else { return }
    pageReady = true
    let waitingNote = pendingNote
    pendingNote = ""
    if !waitingNote.isEmpty { showNote(waitingNote) }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    // The server can need a moment more after it first answers.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { webView.load(URLRequest(url: zenithURL)) }
  }

  private func isZenith(_ url: URL?) -> Bool {
    guard let url else { return false }
    if ["blob", "data", "about"].contains(url.scheme ?? "") { return true }
    return ["localhost", "127.0.0.1"].contains(url.host ?? "") && url.port == 4173
  }

  // Zenith's own pages stay here; a link to another website opens in the browser.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { decisionHandler(.download); return }
    if action.targetFrame?.isMainFrame != false, !isZenith(action.request.url), let url = action.request.url {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .download)
  }

  // A link that asks for a new window opens in the browser.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  // Saving a file (such as the settings file) goes to Downloads.
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    let name = (suggestedFilename as NSString).lastPathComponent
    var target = folder.appendingPathComponent(name.isEmpty ? "zenith-download" : name)
    var number = 1
    while FileManager.default.fileExists(atPath: target.path) {
      let base = (name as NSString).deletingPathExtension
      let ext = (name as NSString).pathExtension
      target = folder.appendingPathComponent(ext.isEmpty ? "\(base) (\(number))" : "\(base) (\(number)).\(ext)")
      number += 1
    }
    completionHandler(target)
  }
  func downloadDidFinish(_ download: WKDownload) {
    say("Saved in your Downloads folder.")
  }

  // Choosing a file (such as loading a settings file).
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = false
    panel.beginSheetModal(for: window) { answer in completionHandler(answer == .OK ? panel.urls : nil) }
  }

  // The page's own messages and questions.
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }
  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { answer in completionHandler(answer == .alertFirstButtonReturn) }
  }

  // The microphone, for voice control: only Zenith's own page may ask, and macOS asks the person first.
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
               initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
               decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(["localhost", "127.0.0.1"].contains(origin.host) && origin.port == 4173 && type == .microphone ? .grant : .deny)
  }

  // MARK: menus

  @objc func reloadPage() { webView.reload() }

  func buildMenu() {
    let main = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) {
      let holder = NSMenuItem()
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      holder.submenu = menu
      main.addItem(holder)
    }
    func item(_ title: String, _ action: Selector?, _ key: String, _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let made = NSMenuItem(title: title, action: action, keyEquivalent: key)
      made.keyEquivalentModifierMask = modifiers
      return made
    }
    add("Zenith", [
      item("About Zenith", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      .separator(),
      item("Hide Zenith", #selector(NSApplication.hide(_:)), "h"),
      .separator(),
      item("Quit Zenith", #selector(NSApplication.terminate(_:)), "q"),
    ])
    add("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    let reload = item("Reload", #selector(reloadPage), "r")
    reload.target = self
    add("View", [reload, item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])])
    add("Window", [item("Minimise", #selector(NSWindow.miniaturize(_:)), "m"), item("Close", #selector(NSWindow.performClose(_:)), "w")])
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
