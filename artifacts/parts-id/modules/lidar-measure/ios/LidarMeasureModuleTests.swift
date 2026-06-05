/**
 * LidarMeasureModuleTests.swift
 *
 * Pure-Swift unit tests for the `worldAxisBoundingBox()` geometry helper.
 * These tests run entirely in the Swift test process — no ARKit hardware,
 * no device, no simulator required.
 *
 * This file is wired into the `LidarMeasureTests` test_spec in lidar-measure.podspec.
 * After running `expo prebuild` (which also runs `pod install`), open
 * ios/PartsID.xcworkspace in Xcode, select the
 * `lidar-measure-LidarMeasureTests` scheme, and press Cmd-U.
 *
 * Command-line equivalent:
 *   xcodebuild test \
 *     -workspace ios/PartsID.xcworkspace \
 *     -scheme lidar-measure-LidarMeasureTests \
 *     -destination 'platform=iOS Simulator,name=iPhone 16'
 */

import XCTest
import simd
@testable import LidarMeasure   // gives access to `internal` symbols

// MARK: - worldAxisBoundingBox tests

final class WorldAxisBoundingBoxTests: XCTestCase {

    // ── Empty / degenerate inputs ──────────────────────────────────────────────

    func test_emptyVertexArray_returnsNil() {
        XCTAssertNil(worldAxisBoundingBox(vertices: []))
    }

    func test_singleVertex_returnsNil() {
        let v = SIMD3<Float>(1, 2, 3)
        XCTAssertNil(worldAxisBoundingBox(vertices: [v]))
    }

    func test_allCoincidentVertices_returnsNil() {
        let v = SIMD3<Float>(0.5, 0.5, 0.5)
        XCTAssertNil(worldAxisBoundingBox(vertices: [v, v, v, v]))
    }

    func test_flatPlaneZeroHeight_returnsNilBecauseLargestExtentIsZero() {
        // All vertices have the same Y — one axis extent is zero.
        // The largest extent is > 0, so a bounding box IS returned;
        // height is expected to be 0.
        let vertices: [SIMD3<Float>] = [
            SIMD3(0, 0, 0),
            SIMD3(0.2, 0, 0),
            SIMD3(0.2, 0, 0.1),
            SIMD3(0, 0, 0.1),
        ]
        // Extents: X = 200 mm, Z = 100 mm, Y = 0 mm  →  sorted [200, 100, 0]
        let box = worldAxisBoundingBox(vertices: vertices)
        XCTAssertNotNil(box)
        XCTAssertEqual(box?.height ?? -1, 0, accuracy: 0.001)
    }

    // ── Axis sorting ───────────────────────────────────────────────────────────

    func test_sortedDimensions_lengthGreaterThanOrEqualToWidthGreaterThanOrEqualToHeight() {
        // A box in metres: X = 0.3 m, Y = 0.1 m, Z = 0.2 m
        // Expected in mm, sorted: 300 ≥ 200 ≥ 100
        let vertices: [SIMD3<Float>] = [
            SIMD3(0,    0,    0   ),
            SIMD3(0.3,  0,    0   ),
            SIMD3(0.3,  0.1,  0   ),
            SIMD3(0,    0.1,  0   ),
            SIMD3(0,    0,    0.2 ),
            SIMD3(0.3,  0,    0.2 ),
            SIMD3(0.3,  0.1,  0.2 ),
            SIMD3(0,    0.1,  0.2 ),
        ]
        guard let box = worldAxisBoundingBox(vertices: vertices) else {
            return XCTFail("Expected non-nil bounding box")
        }
        XCTAssertGreaterThanOrEqual(box.length, box.width)
        XCTAssertGreaterThanOrEqual(box.width,  box.height)
    }

    // ── Unit conversion (metres → millimetres) ────────────────────────────────

    func test_unitConversion_metresAreConvertedToMillimetres() {
        // A 1 m × 1 m × 1 m cube → 1000 mm on every axis.
        let vertices: [SIMD3<Float>] = [
            SIMD3(0, 0, 0), SIMD3(1, 0, 0),
            SIMD3(1, 1, 0), SIMD3(0, 1, 0),
            SIMD3(0, 0, 1), SIMD3(1, 0, 1),
            SIMD3(1, 1, 1), SIMD3(0, 1, 1),
        ]
        guard let box = worldAxisBoundingBox(vertices: vertices) else {
            return XCTFail("Expected non-nil bounding box")
        }
        XCTAssertEqual(box.length, 1_000, accuracy: 0.1)
        XCTAssertEqual(box.width,  1_000, accuracy: 0.1)
        XCTAssertEqual(box.height, 1_000, accuracy: 0.1)
    }

    // ── Known bounding-box dimensions ─────────────────────────────────────────

    func test_knownBox_200x100x50mm() {
        // Vertices for a 0.2 m × 0.1 m × 0.05 m box.
        let L: Float = 0.2, W: Float = 0.1, H: Float = 0.05
        let vertices: [SIMD3<Float>] = [
            SIMD3(0, 0, 0), SIMD3(L, 0, 0),
            SIMD3(L, W, 0), SIMD3(0, W, 0),
            SIMD3(0, 0, H), SIMD3(L, 0, H),
            SIMD3(L, W, H), SIMD3(0, W, H),
        ]
        guard let box = worldAxisBoundingBox(vertices: vertices) else {
            return XCTFail("Expected non-nil bounding box")
        }
        XCTAssertEqual(box.length, 200, accuracy: 0.1)
        XCTAssertEqual(box.width,  100, accuracy: 0.1)
        XCTAssertEqual(box.height,  50, accuracy: 0.1)
    }

    func test_knownBox_asymmetricVertexLayout() {
        // Vertices are NOT at box corners — scattered noise inside the same volume.
        // The bounding box should still match the min/max extents.
        let vertices: [SIMD3<Float>] = [
            SIMD3(0.05, 0.02, 0.01),
            SIMD3(0.15, 0.07, 0.03),
            SIMD3(0.20, 0.10, 0.05),  // max corner
            SIMD3(0.00, 0.00, 0.00),  // min corner
            SIMD3(0.10, 0.05, 0.025),
        ]
        guard let box = worldAxisBoundingBox(vertices: vertices) else {
            return XCTFail("Expected non-nil bounding box")
        }
        XCTAssertEqual(box.length, 200, accuracy: 0.1)
        XCTAssertEqual(box.width,  100, accuracy: 0.1)
        XCTAssertEqual(box.height,  50, accuracy: 0.1)
    }

    func test_knownBox_negativeCoordinates() {
        // Mesh anchors can have vertices at negative world coordinates.
        // A box centred on the origin: ±0.1 m × ±0.05 m × ±0.025 m
        let vertices: [SIMD3<Float>] = [
            SIMD3(-0.1, -0.05, -0.025),
            SIMD3( 0.1,  0.05,  0.025),
        ]
        guard let box = worldAxisBoundingBox(vertices: vertices) else {
            return XCTFail("Expected non-nil bounding box")
        }
        XCTAssertEqual(box.length, 200, accuracy: 0.1)
        XCTAssertEqual(box.width,  100, accuracy: 0.1)
        XCTAssertEqual(box.height,  50, accuracy: 0.1)
    }

    func test_thinRod_twoNearlyZeroAxes() {
        // A long thin rod: 0.5 m long, ~0 in other axes.
        let vertices: [SIMD3<Float>] = [
            SIMD3(0,   0, 0),
            SIMD3(0.5, 0, 0),
        ]
        guard let box = worldAxisBoundingBox(vertices: vertices) else {
            return XCTFail("Expected non-nil bounding box")
        }
        XCTAssertEqual(box.length, 500, accuracy: 0.1)
        XCTAssertEqual(box.width,    0, accuracy: 0.001)
        XCTAssertEqual(box.height,   0, accuracy: 0.001)
    }

    // ── Large vertex sets ──────────────────────────────────────────────────────

    func test_largeVertexCloud_correctBoundingBox() {
        // Generate 10 000 random vertices inside [0, 0.3] × [0, 0.2] × [0, 0.1].
        var rng = SystemRandomNumberGenerator()
        var vertices = [SIMD3<Float>]()
        vertices.reserveCapacity(10_000)
        for _ in 0 ..< 10_000 {
            vertices.append(SIMD3(
                Float.random(in: 0 ..< 0.3, using: &rng),
                Float.random(in: 0 ..< 0.2, using: &rng),
                Float.random(in: 0 ..< 0.1, using: &rng)
            ))
        }
        // Force the extremes so the test is deterministic.
        vertices[0] = SIMD3(0, 0, 0)
        vertices[1] = SIMD3(0.3, 0.2, 0.1)

        guard let box = worldAxisBoundingBox(vertices: vertices) else {
            return XCTFail("Expected non-nil bounding box")
        }
        XCTAssertEqual(box.length, 300, accuracy: 0.5)
        XCTAssertEqual(box.width,  200, accuracy: 0.5)
        XCTAssertEqual(box.height, 100, accuracy: 0.5)
    }
}
