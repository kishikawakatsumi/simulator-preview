import XCTest
import SimulatorBridge

final class CoordinateTests: XCTestCase {
  func testAspectFitMarginsAndTopLeftOrigin() {
    // A 2:4 portrait image in a square view has 50pt side margins.
    let bounds = CGRect(x: 10, y: 20, width: 200, height: 200)
    var result = CGPoint.zero
    XCTAssertFalse(SimulatorNormalizePoint(CGPoint(x: 59, y: 120), bounds, CGSize(width: 200, height: 400), false, &result))
    XCTAssertTrue(SimulatorNormalizePoint(CGPoint(x: 85, y: 170), bounds, CGSize(width: 200, height: 400), false, &result))
    XCTAssertEqual(result.x, 0.25, accuracy: 0.00001)
    XCTAssertEqual(result.y, 0.25, accuracy: 0.00001)
  }

  func testHorizontalImageAndClampedRelease() {
    let bounds = CGRect(x: 0, y: 0, width: 200, height: 200)
    var result = CGPoint.zero
    XCTAssertFalse(SimulatorNormalizePoint(CGPoint(x: 100, y: 49), bounds, CGSize(width: 400, height: 200), false, &result))
    XCTAssertTrue(SimulatorNormalizePoint(CGPoint(x: 300, y: -50), bounds, CGSize(width: 400, height: 200), true, &result))
    XCTAssertEqual(result, CGPoint(x: 1, y: 1))
  }

  func testInverseRotationAtCorners() {
    let corner = CGPoint(x: 0, y: 0)
    XCTAssertEqual(SimulatorUnrotatePoint(corner, 0), CGPoint(x: 0, y: 0))
    XCTAssertEqual(SimulatorUnrotatePoint(corner, 1), CGPoint(x: 0, y: 1))
    XCTAssertEqual(SimulatorUnrotatePoint(corner, 2), CGPoint(x: 1, y: 1))
    XCTAssertEqual(SimulatorUnrotatePoint(corner, 3), CGPoint(x: 1, y: 0))
    XCTAssertEqual(SimulatorUnrotatePoint(CGPoint(x: 0.5, y: 0.5), 1), CGPoint(x: 0.5, y: 0.5))
  }

  func testNoFrameAndInvalidCoordinates() {
    var result = CGPoint.zero
    let bounds = CGRect(x: 0, y: 0, width: 200, height: 200)
    XCTAssertFalse(SimulatorNormalizePoint(.zero, bounds, .zero, false, &result))
    XCTAssertFalse(SimulatorNormalizePoint(.zero, .zero, CGSize(width: 200, height: 400), true, &result))
    XCTAssertFalse(SimulatorNormalizePoint(CGPoint(x: CGFloat.nan, y: 0), bounds, CGSize(width: 200, height: 400), true, &result))
  }
}
