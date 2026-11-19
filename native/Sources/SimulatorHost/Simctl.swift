import Foundation

struct Device: Decodable, Identifiable {
  let udid: String
  let name: String
  let state: String
  var id: String { udid }
}

struct CommandError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// The deadline queue and command worker synchronize timeout classification here.
private final class CommandDeadline: @unchecked Sendable {
  private let lock = NSLock()
  private var completed = false
  private var expired = false

  func expire(_ process: Process) {
    lock.lock()
    defer { lock.unlock() }
    guard !completed, process.isRunning else { return }
    expired = true
    process.terminate()
  }

  func finish() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    completed = true
    return expired
  }
}

enum Simctl {
  // Fresh private devices can spend several minutes migrating their initial data.
  static let bootTimeout: TimeInterval = 600

  // Process work happens away from the UI thread. Drain the pipe before waiting.
  static func run(_ executable: String, _ arguments: [String], timeout: TimeInterval = 120)
    async throws -> Data
  {
    try await Task.detached {
      let process = Process()
      let pipe = Pipe()
      process.executableURL = URL(fileURLWithPath: executable)
      process.arguments = arguments
      process.standardOutput = pipe
      process.standardError = pipe
      try process.run()
      let state = CommandDeadline()
      let deadline = DispatchWorkItem { state.expire(process) }
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: deadline)
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      let timedOut = state.finish()
      deadline.cancel()
      guard !timedOut && process.terminationStatus == 0 else {
        let command = ([URL(fileURLWithPath: executable).lastPathComponent] + arguments).joined(
          separator: " ")
        let reason =
          timedOut
          ? "Command timed out after \(String(format: "%g", timeout)) seconds: \(command)"
          : process.terminationReason == .uncaughtSignal
            ? "Command terminated by signal \(process.terminationStatus): \(command)"
            : "Command failed (exit \(process.terminationStatus)): \(command)"
        let output = String(decoding: data.suffix(4096), as: UTF8.self)
          .split(separator: "\n", omittingEmptySubsequences: false).suffix(12).joined(
            separator: "\n"
          )
          .trimmingCharacters(in: .whitespacesAndNewlines)
        throw CommandError(
          message: output.isEmpty ? reason : "\(reason)\nRecent command output:\n\(output)")
      }
      return data
    }.value
  }

  static func devices() async throws -> [Device] {
    struct List: Decodable { let devices: [String: [Device]] }
    let data = try await run(
      "/usr/bin/xcrun", ["simctl", "list", "devices", "available", "--json"])
    let list = try JSONDecoder().decode(List.self, from: data)
    return list.devices.keys.filter { $0.contains(".iOS-") }.sorted().reversed()
      .flatMap { list.devices[$0] ?? [] }
  }

  static func boot(_ udid: String) async throws {
    // bootstatus -b boots only when needed and waits until startup completes.
    _ = try await run("/usr/bin/xcrun", ["simctl", "bootstatus", udid, "-b"], timeout: bootTimeout)
  }

  static func developerDirectory() async throws -> String {
    if let directory = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] { return directory }
    let data = try await run("/usr/bin/xcode-select", ["-p"])
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
