// Worktime menu bar companion.
//
// A thin read-mostly client over the same local API the CLI uses — it renders
// `GET /api/state` and posts start/stop. No state of its own: the running timer
// still lives in SQLite behind the server, so the menu bar, the CLI and the
// dashboard can all be open at once without disagreeing.
//
// Build: scripts/build-menubar.sh

import AppKit
import Foundation

// ------------------------------------------------------------------ config --

/// Mirrors the precedence in bin/wt.js: environment first, then
/// ~/.worktime/config.json wins over it.
struct Config {
    var port = 4321
    var token = ""

    var base: String { "http://127.0.0.1:\(port)" }

    static func load() -> Config {
        var c = Config()
        let env = ProcessInfo.processInfo.environment
        if let p = env["WT_PORT"], let n = Int(p) { c.port = n }
        if let t = env["WT_TOKEN"] { c.token = t }

        let file = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".worktime/config.json")
        if let data = try? Data(contentsOf: file),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            if let p = json["port"] as? Int { c.port = p }
            if let t = json["token"] as? String { c.token = t }
        }
        return c
    }
}

// ------------------------------------------------------------------- model --

struct Running: Decodable {
    let project: String
    let projectName: String?
    let description: String?
    let color: String?
    let startedAt: String
}

struct State: Decodable {
    let running: Running?
    let todaySeconds: Int
    let weekSeconds: Int
}

struct Project: Decodable {
    let slug: String
    let name: String
    let color: String?
    let archived: Bool
}

// ------------------------------------------------------------------ client --

final class Client {
    let config: Config

    init(_ config: Config) { self.config = config }

    private func request(_ path: String, method: String, body: [String: Any]?) -> URLRequest {
        var req = URLRequest(url: URL(string: config.base + path)!)
        req.httpMethod = method
        // Short: a hung request must not stall the next poll behind it.
        req.timeoutInterval = 4
        if !config.token.isEmpty {
            req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    /// Always calls back on the main queue — every caller here touches AppKit.
    func get<T: Decodable>(_ path: String, as _: T.Type, then: @escaping (T?) -> Void) {
        URLSession.shared.dataTask(with: request(path, method: "GET", body: nil)) { data, _, _ in
            let value = data.flatMap { try? JSONDecoder().decode(T.self, from: $0) }
            DispatchQueue.main.async { then(value) }
        }.resume()
    }

    func post(_ path: String, body: [String: Any] = [:], then: @escaping () -> Void) {
        URLSession.shared.dataTask(with: request(path, method: "POST", body: body)) { _, _, _ in
            DispatchQueue.main.async { then() }
        }.resume()
    }
}

// ----------------------------------------------------------------- helpers --

let isoParser: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    // The server writes new Date().toISOString(), which carries milliseconds.
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func parseISO(_ s: String) -> Date? {
    isoParser.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}

/// Ticking form, for the timer that is running right now.
func clock(_ seconds: Int) -> String {
    let s = max(0, seconds)
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60)
    return h > 0
        ? String(format: "%d:%02d:%02d", h, m, sec)
        : String(format: "%d:%02d", m, sec)
}

/// Settled form, for totals that are not moving second to second.
func duration(_ seconds: Int) -> String {
    let s = max(0, seconds)
    let (h, m) = (s / 3600, (s % 3600) / 60)
    if h > 0 { return "\(h)h \(m)m" }
    if m > 0 { return "\(m)m" }
    return "\(s)s"
}

// ------------------------------------------------------------- installed --

/// Finds the dashboard installed as a standalone web app, so "Open dashboard"
/// can prefer it over a browser tab.
enum WebApp {
    /// Match on the recorded start URL, not the bundle name. Chromium names the
    /// bundle from the page title at install time — this dashboard installs as
    /// "worktime.app" even though its manifest says "SpringTime" — but it always
    /// writes the URL to `CrAppModeShortcutURL`. Matching the URL also means a
    /// PWA installed against a *different* port correctly does not match.
    static func installed(servedFrom base: String) -> URL? {
        guard let want = URLComponents(string: base), let host = want.host else { return nil }
        let wantPort = want.port ?? 80
        let fm = FileManager.default

        let roots = [
            fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications"),
            URL(fileURLWithPath: "/Applications"),
        ]

        // Browsers file web apps in a per-browser subfolder ("Chrome Apps
        // .localized", "Brave Browser Apps.localized"), so look one level down
        // before the much larger top level, and stop at the first hit.
        var candidates: [URL] = []
        for root in roots {
            let entries = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
            let (apps, folders) = (entries.filter { $0.pathExtension == "app" },
                                   entries.filter { $0.pathExtension != "app" })
            candidates += folders.flatMap {
                (try? fm.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil)) ?? []
            }
            candidates += apps
        }

        for app in candidates where app.pathExtension == "app" {
            let plist = app.appendingPathComponent("Contents/Info.plist")
            guard let info = NSDictionary(contentsOf: plist),
                  let raw = info["CrAppModeShortcutURL"] as? String,
                  let got = URLComponents(string: raw),
                  got.host == host, (got.port ?? 80) == wantPort else { continue }
            return app
        }
        return nil
    }
}

func swatch(_ hex: String?) -> NSImage? {
    guard var hex, hex.hasPrefix("#") else { return nil }
    hex.removeFirst()
    guard hex.count == 6, let v = Int(hex, radix: 16) else { return nil }
    let color = NSColor(
        red: CGFloat((v >> 16) & 0xff) / 255,
        green: CGFloat((v >> 8) & 0xff) / 255,
        blue: CGFloat(v & 0xff) / 255,
        alpha: 1
    )
    let size = NSSize(width: 10, height: 10)
    let image = NSImage(size: size)
    image.lockFocus()
    color.setFill()
    NSBezierPath(ovalIn: NSRect(origin: .zero, size: size)).fill()
    image.unlockFocus()
    return image
}

// -------------------------------------------------------------------- app ----

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let client = Client(Config.load())

    private var state: State?
    private var startedAt: Date?
    private var projects: [Project] = []
    private var reachable = true

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        render()

        // Two cadences: the poll is the source of truth (it catches a timer the
        // CLI started), the tick just advances the digits in between so the
        // display counts smoothly without hammering the server every second.
        schedule(every: 5, immediately: true) { [weak self] in self?.poll() }
        schedule(every: 1, immediately: false) { [weak self] in self?.render() }
    }

    private func schedule(every seconds: TimeInterval, immediately: Bool, _ body: @escaping () -> Void) {
        let timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { _ in body() }
        // .common keeps both timers alive while the menu is open, otherwise the
        // title freezes exactly when the user is looking at it.
        RunLoop.main.add(timer, forMode: .common)
        if immediately { body() }
    }

    // ----------------------------------------------------------- polling ----

    private func poll() {
        client.get("/api/state", as: State.self) { [weak self] state in
            guard let self else { return }
            self.reachable = state != nil
            if let state {
                self.state = state
                self.startedAt = state.running.flatMap { parseISO($0.startedAt) }
            }
            self.render()
        }
    }

    private var elapsed: Int {
        guard let startedAt else { return 0 }
        return Int(Date().timeIntervalSince(startedAt))
    }

    // --------------------------------------------------------- rendering ----

    private func render() {
        guard let button = statusItem.button else { return }

        let text: String
        if !reachable {
            text = "⏱ —"
        } else if let running = state?.running {
            let label = running.projectName ?? running.project
            text = "▶ \(clock(elapsed)) · \(label)"
        } else if let today = state?.todaySeconds, today > 0 {
            text = "⏱ \(duration(today))"
        } else {
            text = "⏱ —"
        }

        // Monospaced digits, or the whole title shifts left and right as the
        // seconds roll over.
        button.attributedTitle = NSAttributedString(
            string: text,
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)]
        )
    }

    // -------------------------------------------------------------- menu ----

    /// Rebuilt on every open: the project list and totals are cheap, and this
    /// way a project created elsewhere shows up without restarting the app.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        guard reachable else {
            menu.addItem(disabled("worktime server not reachable"))
            menu.addItem(.separator())
            menu.addItem(action("Start server", #selector(startServer)))
            menu.addItem(.separator())
            menu.addItem(action("Quit", #selector(quit), key: "q"))
            return
        }

        if let running = state?.running {
            let label = running.projectName ?? running.project
            menu.addItem(disabled("\(label) — \(clock(elapsed))"))
            if let note = running.description, !note.isEmpty {
                menu.addItem(disabled(note))
            }
            menu.addItem(action("Stop", #selector(stopTimer), key: "s"))
        } else {
            menu.addItem(disabled("No timer running"))
        }

        menu.addItem(.separator())
        menu.addItem(disabled("Today  \(duration(state?.todaySeconds ?? 0))"))
        menu.addItem(disabled("Week   \(duration(state?.weekSeconds ?? 0))"))

        let startable = projects.filter { !$0.archived && $0.slug != state?.running?.project }
        if !startable.isEmpty {
            menu.addItem(.separator())
            menu.addItem(disabled("Start"))
            for project in startable.prefix(12) {
                let item = action("  \(project.name)", #selector(startTimer(_:)))
                item.representedObject = project.slug
                item.image = swatch(project.color)
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        menu.addItem(action("Open dashboard", #selector(openDashboard), key: "o"))
        menu.addItem(action("Quit", #selector(quit), key: "q"))

        // Refresh underneath the open menu so the next open is already correct.
        client.get("/api/projects", as: [Project].self) { [weak self] in self?.projects = $0 ?? [] }
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func action(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }

    // ----------------------------------------------------------- actions ----

    @objc private func stopTimer() {
        client.post("/api/stop") { [weak self] in self?.poll() }
    }

    @objc private func startTimer(_ sender: NSMenuItem) {
        guard let slug = sender.representedObject as? String else { return }
        client.post("/api/projects/\(slug)/start") { [weak self] in self?.poll() }
    }

    /// Prefer the installed web app — it is what the user chose to install, and
    /// it reuses its existing window instead of piling up browser tabs. Fall
    /// back to the browser when it isn't installed.
    @objc private func openDashboard() {
        if let app = WebApp.installed(servedFrom: client.config.base) {
            NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(URL(string: client.config.base)!)
        }
    }

    /// Launched from Finder the app inherits almost no PATH, so `wt` is only
    /// findable through a login shell.
    @objc private func startServer() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/zsh")
        task.arguments = ["-lc", "wt up"]
        try? task.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.poll() }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

// Diagnostic, for answering "why did it open a browser tab?":
//   Worktime.app/Contents/MacOS/Worktime --which-app
if CommandLine.arguments.contains("--which-app") {
    let base = Config.load().base
    print(WebApp.installed(servedFrom: base).map { "app: \($0.path)" } ?? "browser: \(base)")
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
