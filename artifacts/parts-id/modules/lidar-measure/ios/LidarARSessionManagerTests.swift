/**
 * LidarARSessionManagerTests.swift
 *
 * Unit tests for LidarARSessionManager — the singleton that owns the shared
 * ARSession used by both LidarMeasureModule and LidarDepthView.
 *
 * What is tested here:
 *   - Singleton identity (shared always returns the same instance)
 *   - Initial state (isRunning == false before any call)
 *   - pause() always transitions isRunning → false
 *   - start() is a no-op on a simulator / non-LiDAR device (isRunning stays
 *     false when ARWorldTrackingConfiguration.supportsSceneReconstruction
 *     returns false, which is the case in every CI / simulator environment)
 *   - Repeated pause() calls do not crash
 *   - session property is stable across repeated accesses
 *
 * No ARKit hardware or camera is needed; every assertion is against the
 * manager's own state, not the underlying ARSession internals.
 *
 * Wired into the `LidarMeasureTests` test_spec in lidar-measure.podspec.
 * Run via:
 *   xcodebuild test \
 *     -workspace ios/PartsID.xcworkspace \
 *     -scheme lidar-measure-LidarMeasureTests \
 *     -destination 'platform=iOS Simulator,name=iPhone 16'
 */

import ARKit
import XCTest
@testable import LidarMeasure

final class LidarARSessionManagerTests: XCTestCase {

    // Always restore a clean state so tests do not bleed into each other.
    override func setUp() {
        super.setUp()
        LidarARSessionManager.shared.pause()
    }

    override func tearDown() {
        LidarARSessionManager.shared.pause()
        super.tearDown()
    }

    // ── Singleton identity ─────────────────────────────────────────────────────

    func test_shared_returnsSameInstanceOnEveryAccess() {
        let first  = LidarARSessionManager.shared
        let second = LidarARSessionManager.shared
        XCTAssertTrue(first === second, "shared must return the same object every time")
    }

    func test_session_isSameObjectAcrossAccesses() {
        let s1 = LidarARSessionManager.shared.session
        let s2 = LidarARSessionManager.shared.session
        XCTAssertTrue(s1 === s2, "session property must be stable (same ARSession object)")
    }

    // ── Initial state ──────────────────────────────────────────────────────────

    func test_isRunning_isFalseBeforeAnyCall() {
        // setUp() already called pause(), so this exercises the post-pause state.
        XCTAssertFalse(LidarARSessionManager.shared.isRunning)
    }

    // ── pause() behaviour ──────────────────────────────────────────────────────

    func test_pause_setsIsRunningFalse_whenNeverStarted() {
        LidarARSessionManager.shared.pause()
        XCTAssertFalse(LidarARSessionManager.shared.isRunning)
    }

    func test_pause_isIdempotent_multipleCallsDoNotCrash() {
        XCTAssertNoThrow(LidarARSessionManager.shared.pause())
        XCTAssertNoThrow(LidarARSessionManager.shared.pause())
        XCTAssertNoThrow(LidarARSessionManager.shared.pause())
        XCTAssertFalse(LidarARSessionManager.shared.isRunning)
    }

    // ── start() behaviour ──────────────────────────────────────────────────────

    func test_start_doesNotCrashOnSimulatorOrNonLiDARDevice() {
        // On any device where supportsSceneReconstruction(.mesh) == false
        // (all simulators, non-LiDAR iPhones), start() silently returns.
        XCTAssertNoThrow(LidarARSessionManager.shared.start())
    }

    func test_start_isRunningReflectsHardwareSupport() {
        LidarARSessionManager.shared.start()
        let expected = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        XCTAssertEqual(
            LidarARSessionManager.shared.isRunning,
            expected,
            "isRunning should match whether LiDAR scene-reconstruction is supported"
        )
    }

    func test_start_isIdempotent_doubleStartDoesNotCrash() {
        XCTAssertNoThrow(LidarARSessionManager.shared.start())
        XCTAssertNoThrow(LidarARSessionManager.shared.start())
    }

    // ── start → pause round-trip ───────────────────────────────────────────────

    func test_pause_afterStart_setsIsRunningFalse() {
        LidarARSessionManager.shared.start()
        LidarARSessionManager.shared.pause()
        XCTAssertFalse(LidarARSessionManager.shared.isRunning)
    }

    func test_pause_afterDoubleStart_setsIsRunningFalse() {
        LidarARSessionManager.shared.start()
        LidarARSessionManager.shared.start()
        LidarARSessionManager.shared.pause()
        XCTAssertFalse(LidarARSessionManager.shared.isRunning)
    }

    // ── start() guards against double-running ──────────────────────────────────

    func test_start_whenAlreadyRunning_doesNotCallRunTwice() {
        // We cannot inspect ARSession.run call count directly, but we can assert
        // that isRunning stays true after the second start() (guard fires early).
        let supportsLiDAR = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        guard supportsLiDAR else {
            // On simulator both calls are no-ops; isRunning stays false.
            LidarARSessionManager.shared.start()
            LidarARSessionManager.shared.start()
            XCTAssertFalse(LidarARSessionManager.shared.isRunning)
            return
        }
        LidarARSessionManager.shared.start()
        XCTAssertTrue(LidarARSessionManager.shared.isRunning)
        LidarARSessionManager.shared.start()
        XCTAssertTrue(LidarARSessionManager.shared.isRunning, "isRunning must remain true after redundant start()")
    }
}
