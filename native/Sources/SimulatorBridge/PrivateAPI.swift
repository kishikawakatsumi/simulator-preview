import AppKit
import ObjectiveC
import Darwin

func simulatorError(_ message: String) -> NSError {
  NSError(domain: "MySimulator", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// The only Objective-C runtime boundary. No private headers or protocol casts.
/// Each call checks its method encoding before casting the IMP to a C function.
/// Returned objects are +0 except alloc/init; ownership is explicit at those sites.
enum PrivateAPI {
  typealias ErrorPointer = AutoreleasingUnsafeMutablePointer<NSError?>?
  typealias FrameBlock = @convention(block) () -> Void
  typealias SurfacesBlock = @convention(block) (AnyObject?, AnyObject?) -> Void
  typealias PropertiesBlock = @convention(block) (AnyObject?) -> Void
  typealias ScreensBlock = @convention(block) (NSArray) -> Void
  typealias CompletionBlock = @convention(block) (NSError?) -> Void

  static func supports(_ object: AnyObject, _ name: String) -> Bool {
    let selector = NSSelectorFromString(name)
    if class_getInstanceMethod(object_getClass(object), selector) != nil {
      return true
    }
    // CoreSimulator IO ports can be ROCK remote proxies: their methods are forwarded.
    typealias F = @convention(c) (AnyObject, Selector, Selector) -> Bool
    let responds = NSSelectorFromString("respondsToSelector:")
    guard let method = class_getInstanceMethod(object_getClass(object), responds) else {
      return false
    }
    return unsafeBitCast(method_getImplementation(method), to: F.self)(object, responds, selector)
  }

  private static func normalized(_ string: String) -> String {
    let value = string.drop { "rnNoORV".contains($0) }
    if value.hasPrefix("^{"), let end = value.firstIndex(of: "=") {
      return String(value[..<end]) + "}"
    }
    if value.hasPrefix("@?") {
      return "@?"
    }
    if value.hasPrefix("@") {
      return "@"
    }
    return String(value)
  }

  private static func encoding(_ pointer: UnsafeMutablePointer<CChar>?) -> String {
    guard let pointer else { return "" }
    defer { free(pointer) }
    return normalized(String(cString: pointer))
  }

  static func method<F>(
    _ object: AnyObject,
    _ name: String,
    returns: String,
    arguments: [String] = [],
    as type: F.Type
  ) throws -> (F, Selector) {
    let selector = NSSelectorFromString(name)
    let result: String
    let actualArguments: [String]
    let implementation: F
    if let method = class_getInstanceMethod(object_getClass(object), selector) {
      result = encoding(method_copyReturnType(method))
      actualArguments = (0..<method_getNumberOfArguments(method)).map { encoding(method_copyArgumentType(method, $0)) }
      implementation = unsafeBitCast(method_getImplementation(method), to: type)
    } else {
      // NSMethodSignature is unavailable as a Swift type. Read its public ObjC
      // methods through typed IMPs, then invoke the proxy using objc_msgSend.
      // Calling an IMP alone would bypass Objective-C message forwarding.
      typealias Signature = @convention(c) (AnyObject, Selector, Selector) -> Unmanaged<AnyObject>?
      let signatureSelector = NSSelectorFromString("methodSignatureForSelector:")
      guard supports(object, name),
            let m = class_getInstanceMethod(object_getClass(object), signatureSelector),
            let signature = unsafeBitCast(method_getImplementation(m), to: Signature.self)(object, signatureSelector, selector)?.takeUnretainedValue() else {
        throw simulatorError("Unavailable private method: \(name)")
      }
      func imp<T>(_ name: String, _ type: T.Type) throws -> (T, Selector) {
        let sel = NSSelectorFromString(name)
        guard let method = class_getInstanceMethod(object_getClass(signature), sel) else {
          throw simulatorError("Missing method signature metadata: \(name)")
        }
        return (unsafeBitCast(method_getImplementation(method), to: type), sel)
      }
      typealias Count = @convention(c) (AnyObject, Selector) -> UInt
      typealias ReturnType = @convention(c) (AnyObject, Selector) -> UnsafePointer<CChar>
      typealias ArgumentType = @convention(c) (AnyObject, Selector, UInt) -> UnsafePointer<CChar>
      let (count, countSel) = try imp("numberOfArguments", Count.self)
      let (ret, retSel) = try imp("methodReturnType", ReturnType.self)
      let (arg, argSel) = try imp("getArgumentTypeAtIndex:", ArgumentType.self)
      result = normalized(String(cString: ret(signature, retSel)))
      actualArguments = (0..<count(signature, countSel)).map { normalized(String(cString: arg(signature, argSel, $0))) }
      implementation = try symbol("objc_msgSend", as: type)
    }
    let expectedArguments = ["@", ":"] + arguments
    guard result == returns, actualArguments.count == expectedArguments.count else {
      throw simulatorError("Private method ABI mismatch: \(name), return \(result), arguments \(actualArguments)")
    }
    for (actual, expected) in zip(actualArguments, expectedArguments) {
      guard actual == expected || (expected == "B" && actual == "c") else {
        throw simulatorError("Private method ABI mismatch: \(name), expected \(expected), found \(actual)")
      }
    }
    return (implementation, selector)
  }

  static func symbol<F>(_ name: String, as type: F.Type) throws -> F {
    guard let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else {
      throw simulatorError("Private symbol is unavailable: \(name)")
    }
    return unsafeBitCast(pointer, to: type)
  }

  static func object(_ receiver: AnyObject, _ name: String) throws -> AnyObject? {
    typealias F = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
    let (call, selector) = try method(receiver, name, returns: "@", as: F.self)
    return call(receiver, selector)?.takeUnretainedValue()
  }

  static func objects(_ receiver: AnyObject, _ name: String) throws -> [AnyObject] {
    guard let result = try object(receiver, name) as? [AnyObject] else {
      throw simulatorError("Private method did not return an array: \(name)")
    }
    return result
  }

  static func context(directory: String) throws -> AnyObject {
    guard let cls = NSClassFromString("SimServiceContext") else {
      throw simulatorError("SimServiceContext is unavailable.")
    }
    typealias F = @convention(c) (AnyObject, Selector, NSString, ErrorPointer) -> Unmanaged<AnyObject>?
    let receiver = cls as AnyObject
    let (call, selector) = try method(receiver, "sharedServiceContextForDeveloperDir:error:", returns: "@", arguments: ["@", "^@"], as: F.self)
    var error: NSError?
    guard let result = call(receiver, selector, directory as NSString, &error)?.takeUnretainedValue() else {
      throw error ?? simulatorError("Could not obtain the simulator context.")
    }
    return result
  }

  static func deviceSet(_ context: AnyObject) throws -> AnyObject {
    typealias F = @convention(c) (AnyObject, Selector, ErrorPointer) -> Unmanaged<AnyObject>?
    let (call, selector) = try method(context, "defaultDeviceSetWithError:", returns: "@", arguments: ["^@"], as: F.self)
    var error: NSError?
    guard let result = call(context, selector, &error)?.takeUnretainedValue() else {
      throw error ?? simulatorError("Could not obtain the default device set.")
    }
    return result
  }

  static func updatePorts(_ io: AnyObject) throws {
    typealias F = @convention(c) (AnyObject, Selector) -> Void
    let (call, selector) = try method(io, "updateIOPorts", returns: "v", as: F.self)
    call(io, selector)
  }

  static func enumerate(_ adapter: AnyObject, completion: @escaping (NSArray) -> Void) throws {
    typealias F = @convention(c) (AnyObject, Selector, DispatchQueue, @escaping ScreensBlock) -> Void
    let (call, selector) = try method(adapter, "enumerateScreensWithCompletionQueue:completionHandler:", returns: "v", arguments: ["@", "@?"], as: F.self)
    call(adapter, selector, .main, completion)
  }

  static func subscribe(
    _ display: AnyObject,
    id: UUID,
    queue: DispatchQueue,
    refresh: @escaping () -> Void
  ) throws {
    typealias F = @convention(c) (AnyObject, Selector, NSUUID, DispatchQueue, @escaping FrameBlock, @escaping SurfacesBlock, @escaping PropertiesBlock) -> Void
    let (call, selector) = try method(display, "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:", returns: "v", arguments: ["@", "@", "@?", "@?", "@?"], as: F.self)
    call(display, selector, id as NSUUID, queue, refresh, { _, _ in refresh() }, { _ in refresh() })
  }

  static func unsubscribe(_ display: AnyObject, id: UUID) throws {
    typealias F = @convention(c) (AnyObject, Selector, NSUUID) -> Void
    let (call, selector) = try method(display, "unregisterScreenCallbacksWithUUID:", returns: "v", arguments: ["@"], as: F.self)
    call(display, selector, id as NSUUID)
  }

  static func lookup(_ device: AnyObject, service: String) throws -> mach_port_t {
    typealias F = @convention(c) (AnyObject, Selector, NSString, ErrorPointer) -> mach_port_t
    let (call, selector) = try method(device, "lookup:error:", returns: "I", arguments: ["@", "^@"], as: F.self)
    var error: NSError?
    let port = call(device, selector, service as NSString, &error)
    guard port != MACH_PORT_NULL && port != mach_port_t.max else {
      throw error ?? simulatorError("Could not find simulator service: \(service)")
    }
    return port
  }

  static func legacyClient(device: AnyObject) throws -> AnyObject {
    guard let cls = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
      throw simulatorError("The Xcode 26 legacy HID client is unavailable.")
    }
    typealias Alloc = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
    typealias Initialize = @convention(c) (UnsafeMutableRawPointer, Selector, AnyObject, ErrorPointer) -> Unmanaged<AnyObject>?
    let (allocate, allocSelector) = try method(cls as AnyObject, "alloc", returns: "@", as: Alloc.self)
    guard let allocation = allocate(cls as AnyObject, allocSelector) else {
      throw simulatorError("Could not allocate the legacy HID client.")
    }
    let initializer: (Initialize, Selector)
    do {
      initializer = try method(allocation.takeUnretainedValue(), "initWithDevice:error:", returns: "@", arguments: ["@", "^@"], as: Initialize.self)
    } catch {
      allocation.release()
      throw error
    }
    // init consumes the allocation's +1 reference, including when it returns nil.
    var error: NSError?
    guard let initialized = initializer.0(allocation.toOpaque(), initializer.1, device, &error) else {
      throw error ?? simulatorError("Could not initialize the legacy HID client.")
    }
    return initialized.takeRetainedValue()
  }

  static func sendLegacy(
    _ client: AnyObject,
    message: UnsafeMutableRawPointer,
    completion: @escaping (NSError?) -> Void
  ) throws {
    typealias F = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, DispatchQueue, @escaping CompletionBlock) -> Void
    let (call, selector) = try method(client, "sendWithMessage:freeWhenDone:completionQueue:completion:", returns: "v", arguments: ["^{IndigoHIDMessageStruct}", "B", "@", "@?"], as: F.self)
    call(client, selector, message, true, .main, completion)
  }
}
