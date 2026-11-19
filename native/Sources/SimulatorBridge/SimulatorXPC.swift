import Foundation
import XPC
import Darwin

/// Xcode 27 simulator endpoints. The private creator returns a +1 XPC object
/// and consumes the Mach send right returned by lookup. Neither is released twice.
enum SimulatorXPC {
  static func connection(device: AnyObject, service: String) throws -> xpc_connection_t {
    typealias Endpoint = @convention(c) (mach_port_t, UInt64, UInt64) -> Unmanaged<AnyObject>?
    typealias Enable = @convention(c) (xpc_connection_t) -> Void
    let create = try PrivateAPI.symbol("xpc_endpoint_create_mach_port_4sim", as: Endpoint.self)
    let enable = try PrivateAPI.symbol("xpc_connection_enable_sim2host_4sim", as: Enable.self)
    let port = try PrivateAPI.lookup(device, service: service)
    guard let object = create(port, 0, 0)?.takeRetainedValue() else {
      throw simulatorError("Could not create the simulator XPC endpoint.")
    }
    let endpoint = object as! xpc_endpoint_t
    let connection = xpc_connection_create_from_endpoint(endpoint)
    enable(connection)
    xpc_connection_set_target_queue(connection, .main)
    return connection
  }

  static func dictionary() -> xpc_object_t { xpc_dictionary_create(nil, nil, 0) }

  static func message(type: String, service: String, payload: xpc_object_t, barrier: Bool = false) -> xpc_object_t {
    let message = dictionary()
    xpc_dictionary_set_string(message, "messageType", type)
    xpc_dictionary_set_string(message, "featureIdentifier", service)
    xpc_dictionary_set_bool(message, "isBarrier", barrier)
    xpc_dictionary_set_value(message, "payload", payload)
    return message
  }
}
