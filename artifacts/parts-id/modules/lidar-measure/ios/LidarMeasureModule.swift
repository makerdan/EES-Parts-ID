import ARKit
import ExpoModulesCore
import Foundation

public class LidarMeasureModule: Module {

    private var measureSession: MeasureSession?

    public func definition() -> ModuleDefinition {
        Name("LidarMeasure")

        Function("isLiDARSupported") { () -> Bool in
            return ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        }

        AsyncFunction("measureObject") { (timeoutSeconds: Double, promise: Promise) in
            guard ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) else {
                promise.reject("ERR_LIDAR_NOT_SUPPORTED", "This device does not support LiDAR scene reconstruction.")
                return
            }

            let session = MeasureSession(timeout: timeoutSeconds, promise: promise)
            self.measureSession = session
            session.start()
        }
    }
}

// MARK: - MeasureSession

private class MeasureSession: NSObject, ARSessionDelegate {

    private let arSession = LidarARSessionManager.shared.session
    private let timeout: Double
    private let promise: Promise
    private var timer: Timer?
    private var settled = false

    init(timeout: Double, promise: Promise) {
        self.timeout = timeout
        self.promise = promise
    }

    func start() {
        arSession.delegate = self
        LidarARSessionManager.shared.start()

        timer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] _ in
            self?.finish()
        }
    }

    private func finish() {
        guard !settled else { return }
        settled = true
        timer?.invalidate()

        guard let frame = arSession.currentFrame else {
            promise.reject("ERR_NO_FRAME", "AR session produced no frame.")
            return
        }

        let meshAnchors = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        guard !meshAnchors.isEmpty else {
            promise.reject("ERR_NO_MESH", "No mesh anchors detected.")
            return
        }

        let aabb = AABB(anchors: meshAnchors)
        guard aabb.isValid else {
            promise.reject("ERR_ZERO_DIMS", "Mesh geometry was degenerate (too small or too far).")
            return
        }

        let dims = aabb.sortedDimensions()
        promise.resolve([
            "length": dims.0,
            "width": dims.1,
            "height": dims.2
        ])
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {}
}

// MARK: - AABB helper

struct AABB {
    var minX: Float = .infinity
    var minY: Float = .infinity
    var minZ: Float = .infinity
    var maxX: Float = -.infinity
    var maxY: Float = -.infinity
    var maxZ: Float = -.infinity

    init(anchors: [ARMeshAnchor]) {
        for anchor in anchors {
            let transform = anchor.transform
            let geometry = anchor.geometry
            let vertices = geometry.vertices
            for i in 0 ..< vertices.count {
                let local = vertices.vertex(at: UInt32(i))
                let world = transform * simd_float4(local.0, local.1, local.2, 1)
                expand(x: world.x, y: world.y, z: world.z)
            }
        }
    }

    mutating func expand(x: Float, y: Float, z: Float) {
        minX = Swift.min(minX, x); maxX = Swift.max(maxX, x)
        minY = Swift.min(minY, y); maxY = Swift.max(maxY, y)
        minZ = Swift.min(minZ, z); maxZ = Swift.max(maxZ, z)
    }

    var isValid: Bool {
        let dx = maxX - minX
        let dy = maxY - minY
        let dz = maxZ - minZ
        return dx > 0.001 && dy > 0.001 && dz > 0.001
    }

    /// Returns (length, width, height) in millimetres, sorted largest first.
    func sortedDimensions() -> (Double, Double, Double) {
        var dims = [
            Double((maxX - minX) * 1000),
            Double((maxY - minY) * 1000),
            Double((maxZ - minZ) * 1000)
        ].sorted(by: >)
        return (dims[0], dims[1], dims[2])
    }
}

// MARK: - ARGeometrySource vertex accessor

private extension ARGeometrySource {
    func vertex(at index: UInt32) -> (Float, Float, Float) {
        assert(componentsPerVector == 3)
        let pointer = buffer.contents().advanced(by: Int(offset) + Int(index) * Int(stride))
        let v = pointer.assumingMemoryBound(to: (Float, Float, Float).self).pointee
        return v
    }
}
