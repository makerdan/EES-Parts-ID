import ARKit
import Foundation

/// Singleton that owns the single ARSession shared between LidarMeasureModule
/// and LidarDepthView. Only one ARKit session runs at a time.
final class LidarARSessionManager: NSObject {

    static let shared = LidarARSessionManager()

    let session: ARSession = ARSession()

    private(set) var isRunning = false

    private override init() {
        super.init()
    }

    func start() {
        guard !isRunning else { return }
        guard ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) else { return }
        let config = ARWorldTrackingConfiguration()
        config.sceneReconstruction = .mesh
        config.frameSemantics = .sceneDepth
        session.run(config, options: [.resetTracking, .removeExistingAnchors])
        isRunning = true
    }

    func pause() {
        session.pause()
        isRunning = false
    }
}
