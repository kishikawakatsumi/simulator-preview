import XCTest
import SimulatorBridge

final class DisplaySelectionTests: XCTestCase {
  func record(_ id: String, active: Bool? = nil, backlight: String? = nil, integrated: Bool = true) -> [String: Any] {
    var result: [String: Any] = ["uniqueId": id, "type": [integrated ? "integrated" : "external": [:]]]
    if let active { result["active"] = active }
    if let backlight { result["backlightState"] = backlight }
    return result
  }

  func testFollowsActivityInsteadOfSizeOrPrimary() {
    let outer = record("outer", active: true, backlight: "activeOn")
    let inner = record("inner", active: false, backlight: "off")
    XCTAssertEqual(SimulatorActiveDisplayID([inner, outer]), "outer")
    XCTAssertEqual(SimulatorActiveDisplayID([record("outer", active: false), record("inner", active: true)]), "inner")
  }

  func testAmbiguousAndTransitioningReportsDoNotPickAPanel() {
    XCTAssertNil(SimulatorActiveDisplayID([record("a", active: true), record("b", active: true)]))
    XCTAssertNil(SimulatorActiveDisplayID([record("a", active: true), record("b", active: false, backlight: "activeOn")]))
    XCTAssertNil(SimulatorActiveDisplayID([record("a", active: false)]))
    XCTAssertNil(SimulatorActiveDisplayID([record("a", backlight: "off")]))
    XCTAssertNil(SimulatorActiveDisplayID(nil))
  }

  func testLegacyFallbackRequiresSoleIntegratedPanel() {
    XCTAssertEqual(SimulatorActiveDisplayID([record("a"), record("tv", active: true, integrated: false)]), "a")
    XCTAssertNil(SimulatorActiveDisplayID([record("a"), record("b")]))
    XCTAssertEqual(SimulatorActiveDisplayID([record("a", backlight: "activeDimmed"), record("b", backlight: "off")]), "a")
  }
}
