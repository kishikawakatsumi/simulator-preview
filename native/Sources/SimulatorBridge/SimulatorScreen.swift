import AppKit
import IOSurface
import QuartzCore

/// Embedded simulator display. Public operations and view state live on the main thread.
public final class SimulatorScreen: NSView {
  public private(set) var framesReceived: UInt = 0
  public private(set) var pixelSize: CGSize = .zero
  public var displayedPixelSize: CGSize { quarterTurns % 2 == 0 ? pixelSize : CGSize(width: pixelSize.height, height: pixelSize.width) }
  public private(set) var rotating = false
  public private(set) var supportsHinge = false
  public var hingeReady: Bool { hinge?.ready == true && !changingHinge }
  public var inputReady: Bool { input?.ready == true && (!followsActiveDisplay || (selectedDisplay != nil && screenLayer.contents != nil)) }

  private var context: AnyObject?
  private var deviceSet: AnyObject?
  private var device: AnyObject?
  private var io: AnyObject?
  private var displays: [AnyObject] = []
  private var callbackID: UUID?
  private var input: SimulatorInput?
  private var hinge: SimulatorHingeInput?
  private var changingHinge = false
  private var touchActive = false
  private var lastTouch = CGPoint.zero
  private let screenLayer = CALayer()
  private var quarterTurns = 0
  private var followsActiveDisplay = false
  private var selectedDisplayID: String?
  private var selectedDisplay: AnyObject?
  private var screensByID: [String: AnyObject] = [:]
  private let frameQueue = DispatchQueue(label: "MySimulator.frames", qos: .userInteractive)
  private var displayQuery: Process?
  private var motionQuery: Process?
  private var physicalTurns = 0
  private var hasPhysicalOrientation = false
  private var needsInitialOrientation = false
  private var rotationRequest: UUID?
  private var rotationTarget = 0
  private var rotationAcknowledged = false
  private var rotationStarted: CFAbsoluteTime = 0
  private var physicalObservedAt: CFAbsoluteTime = 0
  private var rotationMatchedAt: CFAbsoluteTime = 0
  private var rotationCompletion: ((Bool) -> Void)?

  /// Local-only access to the current surface; never transmitted as a pointer.
  public var streamSnapshot: (surface: IOSurfaceRef, turns: Int, displayID: String)? {
    guard let contents = screenLayer.contents else { return nil }
    return (contents as! IOSurfaceRef, quarterTurns, selectedDisplayID ?? "primary")
  }

  /// Browser points are normalized to the displayed image, with a top-left origin.
  public func remotePointer(phase: String, x: Double, y: Double) {
    if phase == "cancel" { cancelTouch(); return }
    guard x.isFinite, y.isFinite else { cancelTouch(); return }
    let point = SimulatorUnrotatePoint(CGPoint(x: min(1, max(0, x)), y: min(1, max(0, y))), quarterTurns)
    switch phase {
    case "down":
      cancelTouch()
      guard inputReady, framesReceived > 0, !rotating, !changingHinge else { return }
      lastTouch = point
      touchActive = input?.sendPoint(point, eventType: .leftMouseDown) == true
    case "move":
      guard touchActive else { return }
      lastTouch = point
      _ = input?.sendPoint(point, eventType: .leftMouseDragged)
    case "up":
      guard touchActive else { return }
      lastTouch = point
      cancelTouch()
    default: break
    }
  }

  public func releaseRemoteTouch() { cancelTouch() }

  public override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor.black.cgColor
    layer?.addSublayer(screenLayer)
    for name in [NSApplication.willResignActiveNotification, NSApplication.willTerminateNotification] {
      NotificationCenter.default.addObserver(self, selector: #selector(cancelTouchForNotification), name: name, object: nil)
    }
  }

  public required init?(coder: NSCoder) {
    fatalError("Use init(frame:)")
  }

  deinit {
    if displayQuery?.isRunning == true { displayQuery?.terminate() }
    if motionQuery?.isRunning == true { motionQuery?.terminate() }
    NotificationCenter.default.removeObserver(self)
    if touchActive { _ = input?.sendPoint(lastTouch, eventType: .leftMouseUp) }
    if let callbackID { for display in displays { try? PrivateAPI.unsubscribe(display, id: callbackID) } }
  }

  public override func layout() {
    super.layout()
    updateDisplayLayout()
  }

  private func updateDisplayLayout() {
    let size = displayedPixelSize
    guard size.width > 0, size.height > 0 else { return }
    let scale = min(bounds.width / size.width, bounds.height / size.height)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    screenLayer.bounds = CGRect(x: 0, y: 0, width: pixelSize.width * scale, height: pixelSize.height * scale)
    screenLayer.position = CGPoint(x: bounds.midX, y: bounds.midY)
    screenLayer.setAffineTransform(CGAffineTransform(rotationAngle: -CGFloat(quarterTurns) * .pi / 2))
    CATransaction.commit()
  }

  public func connect(toUDID udid: String, developerDirectory directory: String, enableInput: Bool = true) throws {
    disconnect()
    framesReceived = 0
    pixelSize = .zero
    var kit = directory + "/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
    let modern = !FileManager.default.fileExists(atPath: kit)
    if modern { kit = URL(fileURLWithPath: directory).deletingLastPathComponent().path + "/SharedFrameworks/SimulatorKit.framework/SimulatorKit" }
    for path in ["/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", kit] {
      // Never dlclose frameworks that own classes and asynchronous callbacks.
      guard dlopen(path, RTLD_NOW | RTLD_GLOBAL) != nil else {
        throw simulatorError("Framework load failed: \(String(cString: dlerror()))")
      }
    }
    do {
      let context = try PrivateAPI.context(directory: directory)
      self.context = context
      let set = try PrivateAPI.deviceSet(context)
      deviceSet = set
      let devices = try PrivateAPI.objects(set, "availableDevices")
      guard let device = try devices.first(where: {
        (try PrivateAPI.object($0, "UDID") as? UUID)?.uuidString.caseInsensitiveCompare(udid) == .orderedSame
      }) else { throw simulatorError("Device not found in the default device set.") }
      self.device = device
      let type = try PrivateAPI.object(device, "deviceType")
      let typeID = try type.flatMap { try PrivateAPI.object($0, "identifier") as? String }
      supportsHinge = modern && typeID == "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"
      if enableInput {
        if supportsHinge { hinge = try SimulatorHingeInput(device: device) }
        input = modern ? try SimulatorModernInput(device: device) : try SimulatorTouchInput(device: device)
        input?.failureHandler = { [weak self] message in self?.reportFailure(message) }
      }
      let generation = UUID()
      callbackID = generation
      followsActiveDisplay = modern
      guard let io = try PrivateAPI.object(device, "io") else { throw simulatorError("Device IO is unavailable.") }
      self.io = io
      try PrivateAPI.updatePorts(io)
      let ports = try PrivateAPI.objects(io, "deviceIOPorts")
      if modern {
        var found = false
        for port in ports {
          guard let adapter = try PrivateAPI.object(port, "descriptor"),
                PrivateAPI.supports(adapter, "enumerateScreensWithCompletionQueue:completionHandler:") else { continue }
          found = true
          try PrivateAPI.enumerate(adapter) { [weak self] screens in
            DispatchQueue.main.async {
              guard let self, self.callbackID == generation else { return }
              do { try self.subscribe(screens.map { $0 as AnyObject }) }
              catch { self.reportFailure(error.localizedDescription) }
            }
          }
        }
        guard found else { throw simulatorError("No screen adapter is available.") }
        queryActiveDisplay(udid, directory: directory, generation: generation)
      } else {
        var compatible: [AnyObject] = []
        for port in ports {
          guard try PrivateAPI.object(port, "portIdentifier") as? String == "com.apple.framebuffer.display",
                let display = try PrivateAPI.object(port, "descriptor"),
                PrivateAPI.supports(display, "framebufferSurface") else { continue }
          compatible.append(display)
        }
        guard !compatible.isEmpty else { throw simulatorError("No compatible display port. Boot the device first.") }
        try subscribe(compatible)
      }
      if enableInput && supportsHinge {
        needsInitialOrientation = true
        rotating = true
      } else if enableInput { setQuarterTurns(0) { _ in } }
    } catch {
      disconnect()
      throw error
    }
  }

  private func reportFailure(_ message: String) {
    input?.failureHandler = nil
    cancelTouch()
    input = nil
    NotificationCenter.default.post(name: Notification.Name("SimulatorInputFailed"), object: self, userInfo: ["message": message])
  }

  private func subscribe(_ newDisplays: [AnyObject]) throws {
    guard let generation = callbackID else { return }
    for display in newDisplays {
      if followsActiveDisplay, let properties = try PrivateAPI.object(display, "screenProperties"),
         let id = try PrivateAPI.object(properties, "uniqueId") {
        screensByID[String(describing: id).uppercased()] = display
      }
      try PrivateAPI.subscribe(display, id: generation, queue: frameQueue) { [weak self] in
        DispatchQueue.main.async {
          guard let self, self.callbackID == generation else { return }
          self.presentFrame()
        }
      }
      displays.append(display)
    }
    presentFrame()
  }

  // Keep CLI discovery inspectable. No overlapping queries; disconnect terminates them.
  private func queryActiveDisplay(_ udid: String, directory: String, generation: UUID) {
    guard callbackID == generation else { return }
    var environment = ProcessInfo.processInfo.environment
    environment["DEVELOPER_DIR"] = directory
    func launch(_ args: [String]) -> (Process, Pipe, Bool) {
      let task = Process()
      let pipe = Pipe()
      task.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
      task.arguments = ["devicectl", "device"] + args + ["--device", udid, "--timeout", "5", "--json-output", "-"]
      task.environment = environment
      task.standardOutput = pipe
      task.standardError = FileHandle.nullDevice
      do { try task.run(); return (task, pipe, true) }
      catch { return (task, pipe, false) }
    }
    let display = launch(["info", "displays"])
    displayQuery = display.0
    let motion = supportsHinge && hinge?.ready == true ? launch(["orientation", "get"]) : nil
    motionQuery = motion?.0
    DispatchQueue.global(qos: .utility).async { [weak self] in
      func read(_ query: (Process, Pipe, Bool)?) -> [String: Any] {
        guard let (task, pipe, launched) = query, launched else { return [:] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      }
      let report = read(display)
      let orientation = read(motion)
      DispatchQueue.main.async {
        guard let self, self.callbackID == generation else { return }
        self.displayQuery = nil
        self.motionQuery = nil
        if self.supportsHinge,
           let result = orientation["result"] as? [String: Any],
           let name = result["deviceOrientationNonFlat"] as? String,
           let physical = ["portrait": 0, "landscapeRight": 1, "portraitUpsideDown": 2, "landscapeLeft": 3][name] {
          // A transient missing report must not erase the last known physical pose.
          self.hasPhysicalOrientation = true
          self.physicalTurns = physical
          self.physicalObservedAt = CFAbsoluteTimeGetCurrent()
        }
        let records = (report["result"] as? [String: Any])?["displays"] as? [[String: Any]]
        let identity = SimulatorActiveDisplayID(records)?.uppercased()
        if self.selectedDisplayID != identity {
          self.cancelTouch() // release to the old digitizer before changing target
          self.selectedDisplayID = identity
          self.selectedDisplay = nil
          (self.input as? SimulatorModernInput)?.selectDisplay(identity)
          NSLog("Active display: %@", identity ?? "unavailable")
        }
        if self.supportsHinge, self.hasPhysicalOrientation, let identity,
           let record = records?.first(where: { ($0["uniqueId"] as? String)?.uppercased() == identity }) {
          // Duo's inner panel is mounted at 270°: physical portrait => +1 display turn.
          let turns = (self.physicalTurns + ((record["primary"] as? Bool == true) ? 0 : 1)) % 4
          if self.quarterTurns != turns {
            self.cancelTouch()
            self.quarterTurns = turns
            self.updateDisplayLayout()
          }
        }
        self.presentFrame()
        if self.needsInitialOrientation, self.hinge?.ready == true, self.input?.ready == true, self.hasPhysicalOrientation {
          self.needsInitialOrientation = false
          self.setQuarterTurns(0) { _ in }
        } else if self.rotationRequest != nil && self.rotationAcknowledged {
          let matches = self.hasPhysicalOrientation && self.physicalTurns == self.rotationTarget && self.inputReady && self.physicalObservedAt >= self.rotationStarted
          if !matches { self.rotationMatchedAt = 0 }
          else if self.rotationMatchedAt == 0 { self.rotationMatchedAt = self.physicalObservedAt }
          else if self.physicalObservedAt - self.rotationMatchedAt >= 0.6 { self.finishVendorRotation(true) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
          self?.queryActiveDisplay(udid, directory: directory, generation: generation)
        }
      }
    }
  }

  private func presentFrame() {
    do {
      var surface: IOSurfaceRef?
      if followsActiveDisplay {
        selectedDisplay = screensByID[selectedDisplayID ?? ""]
        if let selectedDisplay, let object = try PrivateAPI.object(selectedDisplay, "framebufferSurface") {
          surface = (object as! IOSurfaceRef)
        }
        guard surface != nil else { screenLayer.contents = nil; return }
      } else {
        var area = 0
        for display in displays {
          guard let object = try PrivateAPI.object(display, "framebufferSurface") else { continue }
          let candidate = object as! IOSurfaceRef
          let candidateArea = IOSurfaceGetWidth(candidate) * IOSurfaceGetHeight(candidate)
          if candidateArea > area { area = candidateArea; surface = candidate }
        }
      }
      guard let surface else { return }
      let size = CGSize(width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface))
      if size != pixelSize { cancelTouch() }
      pixelSize = size
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      screenLayer.contents = nil // the same IOSurface may now contain new pixels
      screenLayer.contents = surface
      updateDisplayLayout()
      CATransaction.commit()
      framesReceived += 1
    } catch { reportFailure(error.localizedDescription) }
  }

  public override var acceptsFirstResponder: Bool { true }
  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  private func normalized(_ event: NSEvent, clamp: Bool) -> CGPoint? {
    var point = CGPoint.zero
    guard SimulatorNormalizePoint(convert(event.locationInWindow, from: nil), bounds, displayedPixelSize, clamp, &point) else { return nil }
    return SimulatorUnrotatePoint(point, quarterTurns)
  }

  public override func mouseDown(with event: NSEvent) {
    cancelTouch()
    guard inputReady, framesReceived > 0, !rotating, !changingHinge,
          let point = normalized(event, clamp: false) else { return }
    window?.makeFirstResponder(self)
    lastTouch = point
    touchActive = input?.sendPoint(point, eventType: .leftMouseDown) == true
  }

  public override func mouseDragged(with event: NSEvent) {
    guard touchActive else { return }
    guard let point = normalized(event, clamp: true) else { cancelTouch(); return }
    lastTouch = point
    _ = input?.sendPoint(point, eventType: .leftMouseDragged)
  }

  public override func mouseUp(with event: NSEvent) {
    guard touchActive else { return }
    if let point = normalized(event, clamp: true) { lastTouch = point }
    cancelTouch()
  }

  @objc private func cancelTouchForNotification(_ notification: Notification) { cancelTouch() }

  private func cancelTouch() {
    guard touchActive else { return }
    touchActive = false
    _ = input?.sendPoint(lastTouch, eventType: .leftMouseUp)
  }

  public override func resignFirstResponder() -> Bool { cancelTouch(); return true }

  public override func viewWillMove(toWindow newWindow: NSWindow?) {
    cancelTouch()
    for name in [NSWindow.didResignKeyNotification, NSWindow.willCloseNotification] {
      if let window { NotificationCenter.default.removeObserver(self, name: name, object: window) }
      if let newWindow { NotificationCenter.default.addObserver(self, selector: #selector(cancelTouchForNotification), name: name, object: newWindow) }
    }
    super.viewWillMove(toWindow: newWindow)
  }

  public override func setFrameSize(_ size: NSSize) {
    if size != frame.size { cancelTouch() }
    super.setFrameSize(size)
  }

  public func rotateClockwise(_ clockwise: Bool, completion: @escaping (Bool) -> Void) {
    guard !rotating, !changingHinge, device != nil, framesReceived > 0,
          !supportsHinge || hasPhysicalOrientation else { completion(false); return }
    setQuarterTurns(((supportsHinge ? physicalTurns : quarterTurns) + (clockwise ? 1 : 3)) % 4, completion: completion)
  }

  private func setQuarterTurns(_ turns: Int, completion: @escaping (Bool) -> Void) {
    cancelTouch()
    rotating = true
    let generation = callbackID
    if supportsHinge {
      rotationCompletion = completion
      let request = UUID()
      rotationRequest = request
      rotationTarget = turns
      rotationAcknowledged = false
      rotationMatchedAt = 0
      rotationStarted = CFAbsoluteTimeGetCurrent()
      hinge?.setOrientationTurns(turns) { [weak self] success in
        guard let self, self.rotationRequest == request else { return }
        if success { self.rotationAcknowledged = true }
        else { self.finishVendorRotation(false, message: "Could not send the rotation event. Reconnect the device.") }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
        guard let self, self.rotationRequest == request else { return }
        self.finishVendorRotation(false, message: "Could not confirm the device orientation change.")
      }
      return
    }
    guard let device else { rotating = false; completion(false); return }
    let orientation: UInt32 = [1, 4, 2, 3][turns]
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let result = Result { try setLegacyOrientation(device: device, orientation: orientation) }
      DispatchQueue.main.async {
        guard let self, self.callbackID == generation else { completion(false); return }
        var message = ""
        let success: Bool
        switch result {
        case .success:
          success = true
          self.quarterTurns = turns
          self.updateDisplayLayout()
        case .failure(let error): success = false; message = error.localizedDescription
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
          guard self.callbackID == generation else { completion(false); return }
          self.rotating = false
          self.notifyRotation(success, message: message)
          completion(success)
        }
      }
    }
  }

  private func notifyRotation(_ success: Bool, message: String) {
    NotificationCenter.default.post(name: Notification.Name("SimulatorRotationChanged"), object: self, userInfo: ["success": success, "message": message])
  }

  private func finishVendorRotation(_ success: Bool, message: String = "") {
    let callback = rotationCompletion
    rotationCompletion = nil
    rotationRequest = nil
    rotating = false
    notifyRotation(success, message: message)
    callback?(success)
  }

  public func setHinge(degrees: Double, completion: @escaping (Bool) -> Void) {
    guard hingeReady, !rotating else { completion(false); return }
    cancelTouch()
    changingHinge = true
    let generation = callbackID
    hinge?.setDegrees(degrees) { [weak self] success in
      DispatchQueue.main.asyncAfter(deadline: .now() + (success ? 2 : 0)) {
        guard let self, self.callbackID == generation else { completion(false); return }
        self.changingHinge = false
        completion(success)
      }
    }
  }

  public func pressHome(completion: @escaping (Bool) -> Void) {
    cancelTouch()
    guard let input, framesReceived > 0 else { completion(false); return }
    input.pressHome(completion: completion)
  }

  public func disconnect() {
    cancelTouch()
    if displayQuery?.isRunning == true { displayQuery?.terminate() }
    if motionQuery?.isRunning == true { motionQuery?.terminate() }
    displayQuery = nil
    motionQuery = nil
    needsInitialOrientation = false
    hasPhysicalOrientation = false
    if rotationCompletion != nil { finishVendorRotation(false, message: "The device was disconnected.") }
    selectedDisplayID = nil
    selectedDisplay = nil
    screensByID = [:]
    hinge?.invalidate()
    hinge = nil
    supportsHinge = false
    changingHinge = false
    input?.failureHandler = nil
    input = nil
    let generation = callbackID
    callbackID = nil // queued callbacks from this connection must not update a new one
    if let generation {
      for display in displays { try? PrivateAPI.unsubscribe(display, id: generation) }
    }
    displays = []
    io = nil
    device = nil
    deviceSet = nil
    context = nil
    screenLayer.contents = nil
    rotating = false
  }
}
