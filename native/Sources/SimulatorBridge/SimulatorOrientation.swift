import Foundation
import Darwin

func setLegacyOrientation(device: AnyObject, orientation: UInt32) throws {
  let port = try PrivateAPI.lookup(device, service: "PurpleWorkspacePort")
  defer {
    mach_port_deallocate(mach_task_self_, port)
  }
  // Preserve the checked Xcode 26 wire offsets, rather than assuming Swift struct layout.
  let storage = UnsafeMutableRawPointer.allocate(byteCount: 112, alignment: MemoryLayout<mach_msg_header_t>.alignment)
  defer {
    storage.deallocate()
  }
  memset(storage, 0, 112)
  var header = mach_msg_header_t()
  header.msgh_bits = mach_msg_bits_t(MACH_MSG_TYPE_COPY_SEND)
  header.msgh_size = 108
  header.msgh_remote_port = port
  header.msgh_id = 0x7b
  let headerPointer = storage.bindMemory(to: mach_msg_header_t.self, capacity: 1)
  headerPointer.initialize(to: header)
  storage.storeBytes(of: UInt32(50 | 0x20000), toByteOffset: 0x18, as: UInt32.self)
  storage.storeBytes(of: UInt32(4), toByteOffset: 0x48, as: UInt32.self)
  storage.storeBytes(of: orientation, toByteOffset: 0x4c, as: UInt32.self)
  let result = mach_msg(
    headerPointer,
    MACH_SEND_MSG | MACH_SEND_TIMEOUT,
    108,
    0,
    mach_port_t(MACH_PORT_NULL),
    100,
    mach_port_t(MACH_PORT_NULL)
  )
  guard result == KERN_SUCCESS else {
    throw simulatorError(String(cString: mach_error_string(result)))
  }
}
