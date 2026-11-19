import AppKit
import XPC

final class SimulatorModernInput: SimulatorInput {
  private static let service = "com.apple.coredevice.feature.remote.hid.digitizer"
  private let connection: xpc_connection_t
  private var inventoryConnection: xpc_connection_t?
  private var started = false
  private var failed = false
  private var pressingHome = false
  private var touchscreens: [String: UInt64] = [:]
  private var displayID: String?
  private var target: UInt64 = 0
  private var requiresTarget = false
  var failureHandler: ((String) -> Void)?
  var ready: Bool { started && (!requiresTarget || touchscreens[displayID ?? ""] != nil) }

  func selectDisplay(_ identity: String?) {
    requiresTarget = true
    displayID = identity?.uppercased()
    target = touchscreens[displayID ?? ""] ?? 0
  }

  init(device: AnyObject) throws {
    connection = try SimulatorXPC.connection(device: device, service: Self.service)
    xpc_connection_set_event_handler(connection) { [weak self] event in
      if xpc_get_type(event) == XPC_TYPE_ERROR {
        self?.fail("Simulator HID connection interrupted. Reconnect the device.")
      }
    }
    xpc_connection_resume(connection)
    let payload = SimulatorXPC.dictionary()
    xpc_dictionary_set_uint64(payload, "usageCode", 0)
    xpc_dictionary_set_uint64(payload, "state", 2)
    let probe = message("IndigoKeyboardButtonEvent", payload)
    xpc_dictionary_set_bool(probe, "isBarrier", true)
    xpc_connection_send_message_with_reply(connection, probe, .main) { [weak self] reply in
      if xpc_get_type(reply) == XPC_TYPE_ERROR {
        self?.fail("Simulator HID service did not answer. Reconnect after boot completes.")
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
        guard let self, !self.failed else { return }
        self.started = true
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
      guard let self, !self.started else { return }
      self.fail("Simulator HID startup timed out. Wait a moment and reconnect.")
    }
    if let inventory = try? SimulatorXPC.connection(device: device, service: "com.apple.coredevice.feature.remote.universalhidservice") {
      inventoryConnection = inventory
      xpc_connection_set_event_handler(inventory) { _ in }
      xpc_connection_resume(inventory)
      let request = SimulatorXPC.dictionary()
      let body = SimulatorXPC.dictionary()
      xpc_dictionary_set_value(body, "connectedServices", SimulatorXPC.dictionary())
      xpc_dictionary_set_value(request, "payload", body)
      xpc_dictionary_set_bool(request, "isBarrier", false)
      xpc_connection_send_message_with_reply(inventory, request, .main) { [weak self] reply in
        guard let self, xpc_get_type(reply) == XPC_TYPE_DICTIONARY,
              let services = xpc_dictionary_get_value(reply, "connectedServices"),
              xpc_get_type(services) == XPC_TYPE_ARRAY else { return }
        var mapping: [String: UInt64] = [:]
        xpc_array_apply(services) { _, service in
          guard xpc_get_type(service) == XPC_TYPE_DICTIONARY,
                xpc_dictionary_get_uint64(service, "PrimaryUsagePage") == 0x0d,
                xpc_dictionary_get_uint64(service, "PrimaryUsage") == 4 else { return true }
          let id = xpc_dictionary_get_uint64(service, "_ServiceID")
          if let uuid = xpc_dictionary_get_string(service, "displayUUID"), id & ~UInt64(0xff) == 0x100, id & 0xff != 0 {
            mapping[String(cString: uuid).uppercased()] = id & 0xff
          }
          return true
        }
        self.touchscreens = mapping
        self.target = mapping[self.displayID ?? ""] ?? 0
        NSLog("Touchscreen routes: %@", mapping)
      }
    }
  }

  deinit {
    if let inventoryConnection { xpc_connection_cancel(inventoryConnection) }
    let connection = connection
    // Let the final touch-up drain before cancelling, without retaining this input.
    xpc_connection_send_barrier(connection) {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { xpc_connection_cancel(connection) }
    }
  }

  private func fail(_ message: String) {
    guard !failed else { return }
    failed = true
    started = false
    failureHandler?(message)
  }

  private func message(_ type: String, _ payload: xpc_object_t) -> xpc_object_t {
    SimulatorXPC.message(type: type, service: Self.service, payload: payload)
  }

  func sendPoint(_ point: CGPoint, eventType: NSEvent.EventType) -> Bool {
    guard ready else { return false }
    let position = SimulatorXPC.dictionary()
    xpc_dictionary_set_double(position, "x", point.x)
    xpc_dictionary_set_double(position, "y", point.y)
    let payload = SimulatorXPC.dictionary()
    xpc_dictionary_set_value(payload, "pointOne", position)
    xpc_dictionary_set_uint64(payload, "eventType", eventType == .leftMouseDown ? 0 : eventType == .leftMouseUp ? 2 : 1)
    xpc_dictionary_set_uint64(payload, "edge", 0)
    xpc_dictionary_set_uint64(payload, "target", target)
    xpc_connection_send_message(connection, message("IndigoDigitizerEvent", payload))
    return true
  }

  private func sendHomeState(_ state: UInt64) -> Bool {
    guard started else { return false }
    let payload = SimulatorXPC.dictionary()
    xpc_dictionary_set_uint64(payload, "usagePage", 0x0c)
    xpc_dictionary_set_uint64(payload, "usageCode", 0x40)
    xpc_dictionary_set_uint64(payload, "state", state)
    xpc_connection_send_message(connection, message("IndigoButtonEvent", payload))
    return true
  }

  func pressHome(completion: @escaping (Bool) -> Void) {
    guard !pressingHome, sendHomeState(1) else { completion(false); return }
    pressingHome = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
      let success = self.sendHomeState(2)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        self.pressingHome = false
        completion(success && self.started)
      }
    }
  }
}
