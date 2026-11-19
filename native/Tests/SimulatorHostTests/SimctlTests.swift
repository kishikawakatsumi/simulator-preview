import XCTest

@testable import SimulatorHost

final class SimctlTests: XCTestCase {
  func testSuccessfulOutputIsReturnedIntact() async throws {
    let data = try await Simctl.run("/bin/sh", ["-c", "printf 'boot completed'"], timeout: 5)
    XCTAssertEqual(String(decoding: data, as: UTF8.self), "boot completed")
  }

  func testProgressWithinDeadlineIsNotAnError() async throws {
    let data = try await Simctl.run(
      "/bin/sh", ["-c", "printf 'Waiting on Data Migration\\n'; sleep 0.2; printf 'Ready\\n'"],
      timeout: 5)
    XCTAssertTrue(String(decoding: data, as: UTF8.self).hasSuffix("Ready\n"))
  }

  func testTimeoutIdentifiesDeadlineInsteadOfTreatingProgressAsFailure() async throws {
    do {
      _ = try await Simctl.run(
        "/bin/sh", ["-c", "printf 'Waiting on Data Migration\\n'; exec /bin/sleep 5"],
        timeout: 0.1)
      XCTFail("Expected timeout")
    } catch {
      XCTAssertTrue(error.localizedDescription.contains("timed out after 0.1 seconds"))
      XCTAssertTrue(error.localizedDescription.contains("Waiting on Data Migration"))
    }
  }

  func testFailureKeepsOnlyTheTailAndIncludesTheExitStatus() async throws {
    do {
      _ = try await Simctl.run(
        "/bin/sh",
        [
          "-c",
          "printf 'old progress\\n'; i=0; while [ $i -lt 1000 ]; do printf 'migration progress\\n'; i=$((i + 1)); done; printf 'Latest failure\\n'; exit 7",
        ],
        timeout: 5)
      XCTFail("Expected command failure")
    } catch {
      let message = error.localizedDescription
      XCTAssertTrue(message.contains("exit 7"))
      XCTAssertTrue(message.contains("Recent command output"))
      XCTAssertTrue(message.hasSuffix("Latest failure"))
      XCTAssertLessThan(message.utf8.count, 1000)
    }
  }

  func testFailureWithoutOutputStillHasADiagnostic() async throws {
    do {
      _ = try await Simctl.run("/bin/sh", ["-c", "exit 9"], timeout: 5)
      XCTFail("Expected command failure")
    } catch {
      XCTAssertTrue(error.localizedDescription.contains("exit 9"))
    }
  }
}
