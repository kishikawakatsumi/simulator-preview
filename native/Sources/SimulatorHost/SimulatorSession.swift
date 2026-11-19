import AppKit
import CoreImage
import SimulatorBridge

@MainActor final class SimulatorSession {
  let screen = SimulatorScreen(frame: CGRect(x: 0, y: 0, width: 500, height: 800))
  let output = HostOutput()
  let captureQueue = DispatchQueue(label: "studio.capture", qos: .userInitiated)
  let encoder: H264Encoder
  var bitrate = 4_000_000
  var forceKeyframe = true
  var streaming = false
  var lastCapture: TimeInterval = 0
  let testPattern: Bool
  var timer: Timer?
  var observer: NSObjectProtocol?
  var deviceName = "iOS Simulator"
  var udid = ""
  var starting = false
  var connected = false
  var busy = false
  var revision = 0
  var geometry = ""
  var encoding = false
  var lastFrame: UInt = 0
  var lastStatus: TimeInterval = 0
  var errorMessage: String?
  let fps: Double
  let maxEdge: Double

  init(fps: Double, maxEdge: Double, testPattern: Bool = false) {
    self.testPattern = testPattern
    self.encoder = H264Encoder(fps: Int(fps), maxEdge: Int(maxEdge))
    self.fps = fps
    self.maxEdge = maxEdge
    observer = NotificationCenter.default.addObserver(
      forName: Notification.Name("SimulatorInputFailed"), object: screen, queue: .main
    ) { [weak self] note in
      let message = note.userInfo?["message"] as? String ?? "Simulator connection failed."
      DispatchQueue.main.async {
        self?.errorMessage = message
        self?.connected = false
        self?.screen.releaseRemoteTouch()
        self?.status()
      }
    }
  }

  func status() {
    let size = screen.displayedPixelSize
    output.status([
      "type": "status", "device": deviceName, "udid": udid, "switching": starting,
      "connected": connected,
      "preview": starting && screen.streamSnapshot != nil && errorMessage == nil,
      "ready": connected && !starting && (testPattern || screen.inputReady) && !screen.rotating
        && !busy,
      "busy": starting || busy || screen.rotating, "supportsHinge": screen.supportsHinge,
      "revision": revision, "width": Int(size.width), "height": Int(size.height),
      "error": errorMessage ?? "",
    ])
  }

  func start(udid: String, appPath: String?, bundleID: String?) async {
    guard !starting else { return }
    starting = true
    self.udid = udid
    timer?.invalidate()
    timer = nil
    connected = false
    revision += 1
    screen.releaseRemoteTouch()
    screen.disconnect()
    errorMessage = nil
    busy = false
    geometry = ""
    lastFrame = 0
    do {
      status()
      let devices = try await Simctl.devices()
      guard
        let device = devices.first(where: { $0.udid.caseInsensitiveCompare(udid) == .orderedSame })
      else {
        throw CommandError(message: "Device not found. Run npm run devices and set PREVIEW_DEVICE.")
      }
      deviceName = device.name
      let directory = try await Simctl.developerDirectory()
      // Subscribe to the display during boot without initializing input or rotating iOS.
      // IO ports may not exist yet; retry until one can be attached, or boot finishes.
      timer = Timer.scheduledTimer(withTimeInterval: 1 / fps, repeats: true) { [weak self] _ in
        DispatchQueue.main.async { self?.tick() }
      }
      let preview = Task { @MainActor [weak self] in
        while !Task.isCancelled {
          guard let self else { return }
          do {
            try self.screen.connect(toUDID: udid, developerDirectory: directory, enableInput: false)
            return
          } catch {
            do { try await Task.sleep(nanoseconds: 500_000_000) } catch { return }
          }
        }
      }
      do { try await Simctl.boot(udid) } catch {
        preview.cancel()
        await preview.value
        throw error
      }
      preview.cancel()
      await preview.value
      var launchID = bundleID
      if let appPath {
        let url = URL(fileURLWithPath: appPath)
        let data = try Data(contentsOf: url.appendingPathComponent("Info.plist"))
        guard
          let info = try PropertyListSerialization.propertyList(from: data, format: nil)
            as? [String: Any],
          let identifier = info["CFBundleIdentifier"] as? String,
          (info["CFBundleSupportedPlatforms"] as? [String])?.contains("iPhoneSimulator") != false
        else {
          throw CommandError(message: "Provide an iOS Simulator .app build, not a device IPA.")
        }
        _ = try await Simctl.run("/usr/bin/xcrun", ["simctl", "install", udid, url.path])
        launchID = launchID ?? identifier
      }
      if let launchID {
        _ = try await Simctl.run("/usr/bin/xcrun", ["simctl", "launch", udid, launchID])
      }
      // A boot preview must never authorize input against its last decoded frame.
      revision += 1
      geometry = ""
      forceKeyframe = true
      lastFrame = 0
      try screen.connect(toUDID: udid, developerDirectory: directory)
      for _ in 0..<450 {
        if screen.framesReceived > 0 && screen.inputReady && !screen.rotating
          && (!screen.supportsHinge || screen.hingeReady)
        {
          break
        }
        if let errorMessage { throw CommandError(message: errorMessage) }
        try await Task.sleep(nanoseconds: 100_000_000)
      }
      guard screen.framesReceived > 0, screen.inputReady, !screen.rotating,
        !screen.supportsHinge || screen.hingeReady
      else {
        throw CommandError(message: "Display or input did not become ready within 45 seconds.")
      }
      connected = true
      starting = false
      status()
    } catch {
      timer?.invalidate()
      timer = nil
      starting = false
      connected = false
      errorMessage = error.localizedDescription
      screen.disconnect()
      status()
    }
  }

  func tick() {
    let now = Date.timeIntervalSinceReferenceDate
    if now - lastStatus > 1 {
      lastStatus = now
      status()
    }
    guard connected || starting, errorMessage == nil, streaming, !encoding else { return }
    if testPattern {
      let hue = CGFloat(now.truncatingRemainder(dividingBy: 5) / 5)
      let image = CIImage(color: CIColor(red: hue, green: 0.4, blue: 1 - hue))
        .cropped(to: CGRect(x: 0, y: 0, width: 390, height: 844))
      capture(image: image, now: now)
      return
    }
    guard let snapshot = screen.streamSnapshot else { return }
    let size = screen.displayedPixelSize
    let signature = "\(snapshot.displayID):\(snapshot.turns):\(size.width):\(size.height)"
    if signature != geometry {
      screen.releaseRemoteTouch()
      geometry = signature
      revision += 1
      lastFrame = 0
      forceKeyframe = true
      status()
    }
    guard forceKeyframe || lastFrame != screen.framesReceived || now - lastCapture >= 1 else {
      return
    }
    lastFrame = screen.framesReceived
    // Snapshot on the main actor before handing the immutable image to capture.
    // IOSurface is retained by CIImage until the render has completed.
    let image = CIImage(ioSurface: snapshot.surface)
      .oriented(forExifOrientation: [1, 6, 3, 8][snapshot.turns])
    capture(image: image, now: now)
  }

  private func capture(image: CIImage, now: TimeInterval) {
    encoding = true
    lastCapture = now
    let version = revision
    let force = forceKeyframe
    forceKeyframe = false
    let bitrate = bitrate
    let encoder = encoder
    captureQueue.async { [weak self] in
      guard let self else { return }
      encoder.encode(image: image, revision: version, bitrate: bitrate, forceKeyframe: force) {
        result in
        DispatchQueue.main.async {
          guard version == self.revision else {
            self.encoding = false
            self.forceKeyframe = true
            return
          }
          switch result {
          case .success(let frame):
            self.output.frame(frame) { [weak self] in self?.encoding = false }
          case .failure(let error):
            self.encoding = false
            self.errorMessage = error.localizedDescription
            self.connected = false
            self.status()
          }
        }
      }
    }
  }

  func startPattern() {
    connected = true
    deviceName = "Encoder verification"
    revision = 1
    status()
    timer = Timer.scheduledTimer(withTimeInterval: 1 / fps, repeats: true) { [weak self] _ in
      DispatchQueue.main.async { self?.tick() }
    }
  }

  func command(_ command: [String: Any]) {
    let type = command["type"] as? String ?? ""
    if type == "stream", let enabled = command["enabled"] as? Bool {
      streaming = enabled
      forceKeyframe = true
      return
    }
    if type == "keyframe" {
      forceKeyframe = true
      return
    }
    if type == "bitrate", let value = command["value"] as? Int {
      bitrate = min(12_000_000, max(300_000, value))
      return
    }
    if type == "release" {
      screen.releaseRemoteTouch()
      return
    }
    if type == "select-device", !starting, !busy, !screen.rotating,
      let target = command["udid"] as? String
    {
      Task { @MainActor in
        await start(udid: target, appPath: argument("--app"), bundleID: argument("--bundle-id"))
      }
      return
    }
    guard connected, !starting, !busy, !screen.rotating, screen.inputReady else { return }
    if type == "pointer" {
      // Recheck the live panel as well as the last transmitted revision. An
      // external rotation/fold can happen between two encoder timer ticks.
      guard let snapshot = screen.streamSnapshot else {
        screen.releaseRemoteTouch()
        return
      }
      let size = screen.displayedPixelSize
      let liveGeometry = "\(snapshot.displayID):\(snapshot.turns):\(size.width):\(size.height)"
      guard liveGeometry == geometry else {
        screen.releaseRemoteTouch()
        return
      }
      guard command["revision"] as? Int == revision else {
        screen.releaseRemoteTouch()
        return
      }
      guard let phase = command["phase"] as? String, let x = command["x"] as? Double,
        let y = command["y"] as? Double
      else { return }
      screen.remotePointer(phase: phase, x: x, y: y)
      return
    }
    guard type == "action", let action = command["action"] as? String else { return }
    screen.releaseRemoteTouch()
    forceKeyframe = true
    busy = true
    errorMessage = nil
    revision += 1  // reject inputs based on an image from before this action
    status()
    let done: (Bool) -> Void = { [weak self] success in
      guard let self else { return }
      self.busy = false
      self.lastFrame = 0
      if !success { self.errorMessage = "The \(action) action failed. Check the Mac host." }
      self.status()
    }
    switch action {
    case "home": screen.pressHome(completion: done)
    case "left": screen.rotateClockwise(false, completion: done)
    case "right": screen.rotateClockwise(true, completion: done)
    case "closed", "partial", "open":
      guard screen.hingeReady else {
        done(false)
        return
      }
      screen.setHinge(
        degrees: ["closed": 0.0, "partial": 90.0, "open": 180.0][action]!, completion: done)
    default: done(false)
    }
  }

  func stop() {
    timer?.invalidate()
    screen.releaseRemoteTouch()
    screen.disconnect()
    NSApplication.shared.terminate(nil)
  }
}
