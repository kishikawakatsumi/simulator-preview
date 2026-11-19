import Foundation

/// stdout is a framed binary pipe. Diagnostics must go to stderr.
/// Every message starts with a big-endian UInt32 length followed by a kind byte.
final class HostOutput {
  private let queue = DispatchQueue(label: "studio.output")

  func status(_ object: [String: Any]) {
    guard let json = try? JSONSerialization.data(withJSONObject: object) else { return }
    send(kind: 1, payload: json)
  }

  func frame(_ frame: EncodedFrame, completion: @escaping () -> Void) {
    var payload = Data()
    payload.appendInteger(UInt32(frame.revision))
    payload.appendInteger(frame.timestampMicroseconds)
    payload.append(frame.isKeyframe ? 1 : 0)
    payload.appendInteger(UInt16(frame.width))
    payload.appendInteger(UInt16(frame.height))
    payload.append(frame.data)
    send(kind: 2, payload: payload, completion: completion)
  }

  private func send(kind: UInt8, payload: Data, completion: (() -> Void)? = nil) {
    var message = Data()
    message.appendInteger(UInt32(payload.count + 1))
    message.append(kind)
    message.append(payload)
    queue.async {
      do { try FileHandle.standardOutput.write(contentsOf: message) } catch { exit(1) }
      if let completion { DispatchQueue.main.async(execute: completion) }
    }
  }
}

extension Data {
  mutating func appendInteger<T: FixedWidthInteger>(_ value: T) {
    var encoded = value.bigEndian
    Swift.withUnsafeBytes(of: &encoded) { append(contentsOf: $0) }
  }
}
