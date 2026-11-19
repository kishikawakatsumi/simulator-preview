import XCTest
@testable import SimulatorBridge

private final class RuntimeFixture: NSObject {
  var calls = 0
  @objc func sampleObject() -> NSNumber { calls += 1; return 42 }
  @objc(lookup:error:)
  func lookup(_ name: NSString, error: AutoreleasingUnsafeMutablePointer<NSError?>?) -> UInt32 {
    error?.pointee = NSError(domain: "RuntimeFixture", code: 7, userInfo: [NSLocalizedDescriptionKey: "Service not found"])
    return 0
  }
}

final class PrivateAPITests: XCTestCase {
  func testObjectGetterAndMissingSelector() throws {
    let fixture = RuntimeFixture()
    XCTAssertEqual(try PrivateAPI.object(fixture, "sampleObject") as? NSNumber, 42)
    XCTAssertEqual(fixture.calls, 1)
    XCTAssertThrowsError(try PrivateAPI.object(fixture, "missingMethod"))
    XCTAssertEqual(fixture.calls, 1)
  }

  func testIncompatibleABIMustNotInvokeMethod() {
    let fixture = RuntimeFixture()
    typealias WrongReturn = @convention(c) (AnyObject, Selector) -> UInt64
    XCTAssertThrowsError(try PrivateAPI.method(fixture, "sampleObject", returns: "Q", as: WrongReturn.self))
    typealias WrongArguments = @convention(c) (AnyObject, Selector, UInt64) -> Unmanaged<AnyObject>?
    XCTAssertThrowsError(try PrivateAPI.method(fixture, "sampleObject", returns: "@", arguments: ["Q"], as: WrongArguments.self))
    XCTAssertEqual(fixture.calls, 0)
  }

  func testNSErrorFromPrivateLookupIsPreserved() {
    XCTAssertThrowsError(try PrivateAPI.lookup(RuntimeFixture(), service: "unavailable")) { error in
      XCTAssertEqual((error as NSError).domain, "RuntimeFixture")
      XCTAssertEqual((error as NSError).code, 7)
    }
  }
}
