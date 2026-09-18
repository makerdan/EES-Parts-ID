/**
 * LidarDepthViewTests.swift
 *
 * Unit tests for the pure-Swift logic in LidarDepthView:
 *   - setUnit(_:)  — validates the accepted unit strings and falls back to "mm"
 *   - formatMetres(_:) — converts a Float in metres to a localised display string
 *
 * These tests exercise only the formatting/validation logic; no ARKit hardware,
 * no running ARSession, and no simulator camera are required.
 *
 * LidarDepthView is instantiated with `appContext: nil` so ExpoView's
 * UIKit hierarchy is initialised without a host Expo application context —
 * this is safe for unit-test builds that link ExpoModulesCore as a test dep.
 *
 * Wired into the `LidarMeasureTests` test_spec in lidar-measure.podspec.
 * Run via:
 *   xcodebuild test \
 *     -workspace ios/PartsID.xcworkspace \
 *     -scheme lidar-measure-LidarMeasureTests \
 *     -destination 'platform=iOS Simulator,name=iPhone 16'
 */

import XCTest
@testable import LidarMeasure

// MARK: - setUnit tests

final class LidarDepthViewSetUnitTests: XCTestCase {

    private var view: LidarDepthView!

    override func setUp() {
        super.setUp()
        view = LidarDepthView(appContext: nil)
    }

    override func tearDown() {
        view = nil
        super.tearDown()
    }

    // ── Accepted units ─────────────────────────────────────────────────────────

    func test_setUnit_mm_isAccepted() {
        view.setUnit("mm")
        let result = view.formatMetres(1.0)
        XCTAssertTrue(result.hasSuffix("mm"), "Expected mm suffix, got: \(result)")
    }

    func test_setUnit_cm_isAccepted() {
        view.setUnit("cm")
        let result = view.formatMetres(1.0)
        XCTAssertTrue(result.hasSuffix("cm"), "Expected cm suffix, got: \(result)")
    }

    func test_setUnit_in_isAccepted() {
        view.setUnit("in")
        let result = view.formatMetres(1.0)
        XCTAssertTrue(result.hasSuffix("in"), "Expected in suffix, got: \(result)")
    }

    // ── Invalid / unknown units fall back to "mm" ──────────────────────────────

    func test_setUnit_emptyString_fallsBackToMm() {
        view.setUnit("")
        let result = view.formatMetres(1.0)
        XCTAssertTrue(result.hasSuffix("mm"), "Empty string should fall back to mm, got: \(result)")
    }

    func test_setUnit_unknownString_fallsBackToMm() {
        view.setUnit("ft")
        let result = view.formatMetres(1.0)
        XCTAssertTrue(result.hasSuffix("mm"), "Unknown unit should fall back to mm, got: \(result)")
    }

    func test_setUnit_uppercase_fallsBackToMm() {
        view.setUnit("MM")
        let result = view.formatMetres(1.0)
        XCTAssertTrue(result.hasSuffix("mm"), "Uppercase unit should fall back to mm, got: \(result)")
    }

    // ── Switching units is reflected immediately ───────────────────────────────

    func test_setUnit_canSwitchFromMmToCm() {
        view.setUnit("mm")
        view.setUnit("cm")
        let result = view.formatMetres(0.5)
        XCTAssertTrue(result.hasSuffix("cm"), "Should reflect latest unit: \(result)")
    }

    func test_setUnit_canSwitchFromCmBackToMm() {
        view.setUnit("cm")
        view.setUnit("mm")
        let result = view.formatMetres(0.5)
        XCTAssertTrue(result.hasSuffix("mm"), "Should reflect latest unit: \(result)")
    }
}

// MARK: - formatMetres tests

final class LidarDepthViewFormatMetresTests: XCTestCase {

    private var view: LidarDepthView!

    override func setUp() {
        super.setUp()
        view = LidarDepthView(appContext: nil)
    }

    override func tearDown() {
        view = nil
        super.tearDown()
    }

    // ── Millimetre conversion (default / "mm") ─────────────────────────────────

    func test_formatMetres_mm_oneMetreIs1000mm() {
        view.setUnit("mm")
        XCTAssertEqual(view.formatMetres(1.0), "1000 mm")
    }

    func test_formatMetres_mm_halfMetreIs500mm() {
        view.setUnit("mm")
        XCTAssertEqual(view.formatMetres(0.5), "500 mm")
    }

    func test_formatMetres_mm_zeroIsZero() {
        view.setUnit("mm")
        XCTAssertEqual(view.formatMetres(0.0), "0 mm")
    }

    func test_formatMetres_mm_smallFractionRoundsToNearest() {
        view.setUnit("mm")
        // 0.001 m = 1 mm  (%.0f rounds)
        XCTAssertEqual(view.formatMetres(0.001), "1 mm")
    }

    func test_formatMetres_mm_roundsHalfUp() {
        view.setUnit("mm")
        // 0.0015 m = 1.5 mm → "2 mm" with %.0f
        XCTAssertEqual(view.formatMetres(0.0015), "2 mm")
    }

    // ── Centimetre conversion ("cm") ───────────────────────────────────────────

    func test_formatMetres_cm_oneMetreIs100cm() {
        view.setUnit("cm")
        XCTAssertEqual(view.formatMetres(1.0), "100.0 cm")
    }

    func test_formatMetres_cm_quarterMetreIs25cm() {
        view.setUnit("cm")
        XCTAssertEqual(view.formatMetres(0.25), "25.0 cm")
    }

    func test_formatMetres_cm_zeroIsZero() {
        view.setUnit("cm")
        XCTAssertEqual(view.formatMetres(0.0), "0.0 cm")
    }

    func test_formatMetres_cm_oneDecimalPlace() {
        view.setUnit("cm")
        // 0.123 m = 12.3 cm
        XCTAssertEqual(view.formatMetres(0.123), "12.3 cm")
    }

    // ── Inch conversion ("in") ─────────────────────────────────────────────────

    func test_formatMetres_in_oneMetreIsApprox39in() {
        view.setUnit("in")
        let result = view.formatMetres(1.0)
        // 1 m * 39.3701 = 39.3701 → "39.37 in"
        XCTAssertEqual(result, "39.37 in")
    }

    func test_formatMetres_in_zeroIsZero() {
        view.setUnit("in")
        XCTAssertEqual(view.formatMetres(0.0), "0.00 in")
    }

    func test_formatMetres_in_twoDecimalPlaces() {
        view.setUnit("in")
        // 0.0254 m = 1 inch exactly
        let result = view.formatMetres(0.0254)
        XCTAssertEqual(result, "1.00 in")
    }

    func test_formatMetres_in_knownConversion() {
        view.setUnit("in")
        // 0.3048 m = 1 foot = 12 inches
        let result = view.formatMetres(0.3048)
        XCTAssertEqual(result, "12.00 in")
    }

    // ── Default unit (before any setUnit call) ─────────────────────────────────

    func test_formatMetres_defaultUnitIsMm() {
        // No setUnit call — default should be "mm"
        let freshView = LidarDepthView(appContext: nil)
        let result = freshView.formatMetres(0.3)
        XCTAssertTrue(result.hasSuffix("mm"), "Default unit should be mm, got: \(result)")
    }
}
