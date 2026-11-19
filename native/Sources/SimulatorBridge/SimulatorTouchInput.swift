import AppKit

protocol SimulatorInput: AnyObject {
  var ready: Bool { get }
  var failureHandler: ((String) -> Void)? { get set }
  func sendPoint(_ point: CGPoint, eventType: NSEvent.EventType) -> Bool
  func pressHome(completion: @escaping (Bool) -> Void)
}

final class SimulatorTouchInput: SimulatorInput {
  // ABI checked against Xcode 26.3 SimulatorKit; the last argument is an edge flag.
  typealias MouseMessage = @convention(c) (UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<CGPoint>?, UInt32, UInt, CGSize, UInt) -> UnsafeMutableRawPointer?
  typealias ButtonMessage = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
  private let client: AnyObject
  private let makeMessage: MouseMessage
  private let makeButton: ButtonMessage
  private var homePressInFlight = false
  var ready: Bool { true }
  var failureHandler: ((String) -> Void)?

  init(device: AnyObject) throws {
    makeMessage = try PrivateAPI.symbol("IndigoHIDMessageForMouseNSEvent", as: MouseMessage.self)
    makeButton = try PrivateAPI.symbol("IndigoHIDMessageForButton", as: ButtonMessage.self)
    client = try PrivateAPI.legacyClient(device: device)
  }

  private func send(_ message: UnsafeMutableRawPointer, completion: @escaping (NSError?) -> Void) {
    do { try PrivateAPI.sendLegacy(client, message: message, completion: completion) }
    catch {
      free(message) // ownership transfers to SimulatorKit only on a successful call
      completion(error as NSError)
    }
  }

  func pressHome(completion: @escaping (Bool) -> Void) {
    guard !homePressInFlight else { completion(false); return }
    let down = makeButton(0, 1, 0x33)
    let up = makeButton(0, 2, 0x33)
    guard let down, let up else {
      free(down); free(up)
      failureHandler?("Could not construct the Home button events.")
      completion(false)
      return
    }
    homePressInFlight = true
    // Keep this client alive until release, including across view disconnection.
    send(down) { downError in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        self.send(up) { upError in
          self.homePressInFlight = false
          let error = downError ?? upError
          if let error { self.failureHandler?(error.localizedDescription) }
          completion(error == nil)
        }
      }
    }
  }

  func sendPoint(_ point: CGPoint, eventType: NSEvent.EventType) -> Bool {
    var point = point
    guard let message = makeMessage(&point, nil, 0x32, eventType.rawValue, CGSize(width: 1, height: 1), 0) else {
      if eventType == .leftMouseDragged { return true } // SimulatorKit rate limits moves
      failureHandler?("Could not construct the touch event.")
      return false
    }
    send(message) { [weak self] error in
      if let error { self?.failureHandler?(error.localizedDescription) }
    }
    return true
  }
}
