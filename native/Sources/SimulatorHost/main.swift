import AppKit

func argument(_ name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name),
    index + 1 < CommandLine.arguments.count
  else { return nil }
  return CommandLine.arguments[index + 1]
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
DispatchQueue.main.async {
  let host = SimulatorSession(
    fps: Double(argument("--fps") ?? "30") ?? 30,
    maxEdge: Double(argument("--max-edge") ?? "1280") ?? 1280,
    testPattern: CommandLine.arguments.contains("--test-pattern"))
  DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
      guard line.utf8.count < 65_536, let data = line.data(using: .utf8),
        let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { continue }
      DispatchQueue.main.async { host.command(command) }
    }
    DispatchQueue.main.async { host.stop() }
  }
  if host.testPattern {
    host.startPattern()
  } else if let device = argument("--device") {
    Task { @MainActor in
      await host.start(udid: device, appPath: argument("--app"), bundleID: argument("--bundle-id"))
    }
  } else {
    host.status()
  }
}
app.run()
