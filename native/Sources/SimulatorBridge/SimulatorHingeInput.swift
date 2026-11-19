import Foundation
import XPC
import IOKit

final class SimulatorHingeInput {
  private static let service = "com.apple.coredevice.feature.remote.hid.vendordefined"
  private let connection: xpc_connection_t
  private(set) var ready = false
  private var invalidated = false
  private var requestID: UUID?
  private var completion: ((Bool) -> Void)?

  init(device: AnyObject) throws {
    connection = try SimulatorXPC.connection(device: device, service: Self.service)
    xpc_connection_set_event_handler(connection) { [weak self] event in
      if xpc_get_type(event) == XPC_TYPE_ERROR { self?.invalidate() }
    }
    xpc_connection_resume(connection)
    // A barrier is a startup probe, not an event that changes the device.
    xpc_connection_send_message_with_reply(connection, message(SimulatorXPC.dictionary(), barrier: true), .main) { [weak self] reply in
      if xpc_get_type(reply) == XPC_TYPE_ERROR { self?.invalidate(); return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
        guard let self, !self.invalidated else { return }
        self.ready = true
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
      guard let self, !self.ready else { return }
      self.invalidate()
    }
  }

  deinit {
    xpc_connection_cancel(connection)
  }

  private func message(_ payload: xpc_object_t, barrier: Bool) -> xpc_object_t {
    SimulatorXPC.message(type: "IndigoVendorDefinedEvent", service: Self.service, payload: payload, barrier: barrier)
  }

  func setDegrees(_ degrees: Double, completion: @escaping (Bool) -> Void) {
    guard degrees.isFinite, (0...180).contains(degrees) else { completion(false); return }
    sendControl(["provider": "com.apple.Virtualization.VirtualMachines", "source": "hinge-slider-control",
                 "type": "range", "value": degrees], completion: completion)
  }

  func setOrientationTurns(_ turns: Int, completion: @escaping (Bool) -> Void) {
    guard (0...3).contains(turns) else { completion(false); return }
    sendControl(["provider": "com.apple.Virtualization.VirtualMachines", "source": "orientation-picker-control",
                 "type": "enum", "value": ["portrait", "landscape-right", "pud", "landscape-left"][turns]], completion: completion)
  }

  private func sendControl(_ control: [String: Any], completion: @escaping (Bool) -> Void) {
    guard ready, self.completion == nil, let serialized = IOCFSerialize(control as CFDictionary, 1) else {
      completion(false); return
    }
    let data = serialized as Data
    guard !data.isEmpty else { completion(false); return }
    let payload = SimulatorXPC.dictionary()
    xpc_dictionary_set_uint64(payload, "usagePage", 0xff61)
    xpc_dictionary_set_uint64(payload, "usage", 0x5b)
    xpc_dictionary_set_uint64(payload, "version", 0)
    data.withUnsafeBytes { bytes in xpc_dictionary_set_data(payload, "data", bytes.baseAddress!, bytes.count) }
    self.completion = completion
    let request = UUID()
    requestID = request
    // Actual event first; sending only isBarrier=true acknowledges without applying it.
    xpc_connection_send_message(connection, message(payload, barrier: false))
    xpc_connection_send_message_with_reply(connection, message(payload, barrier: true), .main) { [weak self] reply in
      guard let self, self.requestID == request else { return }
      self.finish(xpc_get_type(reply) != XPC_TYPE_ERROR)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
      guard let self, self.requestID == request else { return }
      self.invalidate()
    }
  }

  private func finish(_ success: Bool) {
    let callback = completion
    completion = nil
    requestID = nil
    callback?(success)
  }

  func invalidate() {
    guard !invalidated else { return }
    invalidated = true
    ready = false
    finish(false)
    xpc_connection_cancel(connection)
  }
}
