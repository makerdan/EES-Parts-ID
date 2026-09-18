import ARKit
import ExpoModulesCore
import SceneKit

/// Full-screen ARSCNView that renders the live mesh wireframe overlay plus a
/// bright-green 3D bounding-box outline around all detected mesh anchors.
///
/// The bounding box is computed as a world-space AABB and updated every ARKit
/// delegate tick (~60 fps) so it visibly tightens as new mesh geometry arrives.
///
/// The `unit` prop controls how the W/H/D labels are formatted:
///   "mm" → millimetres (e.g. "W 300.0 mm")
///   "cm" → centimetres (e.g. "W 30.0 cm")   ← default
///   "in" → inches      (e.g. "W 11.81 in")
public class LidarDepthView: ExpoView, ARSCNViewDelegate, ARSessionDelegate {

    // MARK: - Unit preference (set via Expo prop)

    /// The display unit for the W/H/D overlay labels. Matches app default ("mm").
    private var displayUnit: String = "mm"

    /// Called by LidarDepthViewModule when the React `unit` prop changes.
    /// Accepts "mm", "cm", or "in"; any other value falls back to "mm".
    public func setUnit(_ unit: String) {
        let valid = ["mm", "cm", "in"]
        displayUnit = valid.contains(unit) ? unit : "mm"
    }

    /// Convert metres (ARKit native) to the display value and suffix.
    /// `internal` (not `private`) so it can be exercised by LidarDepthViewTests.
    func formatMetres(_ metres: Float) -> String {
        switch displayUnit {
        case "cm":
            return String(format: "%.1f cm", metres * 100)
        case "in":
            return String(format: "%.2f in", metres * 39.3701)
        default:
            return String(format: "%.0f mm", metres * 1000)
        }
    }

    // MARK: - Sub-views

    private let sceneView = ARSCNView()

    // MARK: - Bounding-box node

    /// Container node for the 12 edge cylinders of the AABB.
    private let boundingBoxNode = SCNNode()

    /// Colour used for all bounding-box edges.
    private static let boxColour = UIColor(red: 0.18, green: 0.93, blue: 0.35, alpha: 1.0)

    /// Radius of each edge cylinder in metres.
    private static let edgeRadius: CGFloat = 0.003

    // MARK: - Dimension label nodes

    /// SCNText label showing the width (X extent) of the bounding box in cm.
    private let labelNodeX = SCNNode()
    /// SCNText label showing the height (Y extent) of the bounding box in cm.
    private let labelNodeY = SCNNode()
    /// SCNText label showing the depth (Z extent) of the bounding box in cm.
    private let labelNodeZ = SCNNode()

    /// Font size for dimension labels in metres (≈ 2.5 cm).
    private static let labelFontSize: CGFloat = 0.025

    // MARK: - Init

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        setupScene()
    }

    // MARK: - Layout

    public override func layoutSubviews() {
        super.layoutSubviews()
        sceneView.frame = bounds
    }

    // MARK: - Lifecycle

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            LidarARSessionManager.shared.start()
            sceneView.session = LidarARSessionManager.shared.session
            sceneView.session.delegate = self
        } else {
            LidarARSessionManager.shared.pause()
        }
    }

    // MARK: - Setup

    private func setupScene() {
        sceneView.delegate = self
        sceneView.automaticallyUpdatesLighting = true

        addSubview(sceneView)
        sceneView.scene.rootNode.addChildNode(boundingBoxNode)

        buildEdgeGeometries()
    }

    // MARK: - ARSCNViewDelegate – mesh wireframe

    public func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard anchor is ARMeshAnchor else { return nil }
        return SCNNode()
    }

    public func renderer(
        _ renderer: SCNSceneRenderer,
        didUpdate node: SCNNode,
        for anchor: ARAnchor
    ) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        node.childNodes.forEach { $0.removeFromParentNode() }
        let wireframe = wireframeNode(for: meshAnchor)
        node.addChildNode(wireframe)
    }

    public func renderer(
        _ renderer: SCNSceneRenderer,
        didAdd node: SCNNode,
        for anchor: ARAnchor
    ) {
        guard let meshAnchor = anchor as? ARMeshAnchor else { return }
        let wireframe = wireframeNode(for: meshAnchor)
        node.addChildNode(wireframe)
    }

    // MARK: - ARSessionDelegate – bounding-box update

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let meshAnchors = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        guard !meshAnchors.isEmpty else {
            DispatchQueue.main.async { self.boundingBoxNode.isHidden = true }
            return
        }

        let aabb = AABB(anchors: meshAnchors)
        guard aabb.isValid else {
            DispatchQueue.main.async { self.boundingBoxNode.isHidden = true }
            return
        }

        DispatchQueue.main.async {
            self.updateBoundingBox(aabb: aabb)
            self.boundingBoxNode.isHidden = false
        }
    }

    // MARK: - Wireframe helper

    private func wireframeNode(for anchor: ARMeshAnchor) -> SCNNode {
        let geometry = anchor.geometry
        let vertices = geometry.vertices
        let faces = geometry.faces

        var positions: [SCNVector3] = []
        for i in 0 ..< vertices.count {
            let v = vertices.vertex(at: UInt32(i))
            positions.append(SCNVector3(v.0, v.1, v.2))
        }

        let vertexSource = SCNGeometrySource(vertices: positions)

        var indices: [Int32] = []
        for i in 0 ..< faces.count {
            let face = faces.indices(at: UInt32(i))
            indices.append(contentsOf: [
                Int32(face.0), Int32(face.1),
                Int32(face.1), Int32(face.2),
                Int32(face.2), Int32(face.0)
            ])
        }

        let indexData = Data(bytes: &indices, count: indices.count * MemoryLayout<Int32>.size)
        let element = SCNGeometryElement(
            data: indexData,
            primitiveType: .line,
            primitiveCount: indices.count / 2,
            bytesPerIndex: MemoryLayout<Int32>.size
        )

        let mesh = SCNGeometry(sources: [vertexSource], elements: [element])
        let mat = SCNMaterial()
        mat.diffuse.contents = UIColor(white: 1, alpha: 0.35)
        mat.isDoubleSided = true
        mesh.materials = [mat]

        return SCNNode(geometry: mesh)
    }

    // MARK: - Bounding-box geometry

    /// Build 12 placeholder edge nodes once; updateBoundingBox() repositions them.
    /// Also creates the three dimension label nodes with billboard constraints.
    private func buildEdgeGeometries() {
        for _ in 0 ..< 12 {
            let cylinder = SCNCylinder(radius: Self.edgeRadius, height: 1)
            let mat = SCNMaterial()
            mat.diffuse.contents = Self.boxColour
            mat.emission.contents = Self.boxColour
            cylinder.materials = [mat]

            let node = SCNNode(geometry: cylinder)
            boundingBoxNode.addChildNode(node)
        }

        // Build the three dimension label nodes and attach them to the bounding-box container.
        for labelNode in [labelNodeX, labelNodeY, labelNodeZ] {
            let text = SCNText(string: "", extrusionDepth: 0)
            text.font = UIFont.monospacedDigitSystemFont(ofSize: Self.labelFontSize, weight: .semibold)
            text.flatness = 0.4  // reduce polygon count

            let mat = SCNMaterial()
            mat.diffuse.contents = UIColor.white
            mat.emission.contents = UIColor.white
            mat.isDoubleSided = true
            text.materials = [mat]

            labelNode.geometry = text

            // Scale the SCNText geometry so its unit matches metres in scene space.
            // SCNText renders at points; 1 pt ≈ 1/72 inch, so we need a uniform scale
            // to bring the text down to the scene's metre scale.
            labelNode.scale = SCNVector3(0.001, 0.001, 0.001)

            // Always face the camera regardless of viewing angle.
            let billboard = SCNBillboardConstraint()
            billboard.freeAxes = .all
            labelNode.constraints = [billboard]

            boundingBoxNode.addChildNode(labelNode)
        }

        boundingBoxNode.isHidden = true
    }

    /// Reposition the 12 edge nodes so they form the AABB outline,
    /// and update the three dimension labels with live cm measurements.
    private func updateBoundingBox(aabb: AABB) {
        let x0 = aabb.minX, x1 = aabb.maxX
        let y0 = aabb.minY, y1 = aabb.maxY
        let z0 = aabb.minZ, z1 = aabb.maxZ

        // 12 edges: 4 along X, 4 along Y, 4 along Z
        let edgeSpecs: [(start: simd_float3, end: simd_float3)] = [
            // Bottom face — 4 edges along X
            (simd_float3(x0, y0, z0), simd_float3(x1, y0, z0)),
            (simd_float3(x0, y0, z1), simd_float3(x1, y0, z1)),
            // Top face — 4 edges along X
            (simd_float3(x0, y1, z0), simd_float3(x1, y1, z0)),
            (simd_float3(x0, y1, z1), simd_float3(x1, y1, z1)),
            // Bottom face — 4 edges along Z
            (simd_float3(x0, y0, z0), simd_float3(x0, y0, z1)),
            (simd_float3(x1, y0, z0), simd_float3(x1, y0, z1)),
            // Top face — 4 edges along Z
            (simd_float3(x0, y1, z0), simd_float3(x0, y1, z1)),
            (simd_float3(x1, y1, z0), simd_float3(x1, y1, z1)),
            // Vertical edges along Y
            (simd_float3(x0, y0, z0), simd_float3(x0, y1, z0)),
            (simd_float3(x1, y0, z0), simd_float3(x1, y1, z0)),
            (simd_float3(x0, y0, z1), simd_float3(x0, y1, z1)),
            (simd_float3(x1, y0, z1), simd_float3(x1, y1, z1)),
        ]

        let edgeNodes = boundingBoxNode.childNodes
        for (i, spec) in edgeSpecs.enumerated() {
            guard i < edgeNodes.count else { break }
            let node = edgeNodes[i]
            positionEdge(node: node, from: spec.start, to: spec.end)
        }

        // Update dimension label text and positions.
        // Each label sits slightly outside the midpoint of a representative edge
        // so it doesn't overlap the box geometry.
        let widthM  = x1 - x0
        let heightM = y1 - y0
        let depthM  = z1 - z0

        let offsetOut: Float = 0.04  // 4 cm clearance from the box face

        // Width label (X axis) — along the bottom-front edge, offset toward -Z
        if let text = labelNodeX.geometry as? SCNText {
            text.string = "W \(formatMetres(widthM))"
        }
        labelNodeX.position = SCNVector3(
            (x0 + x1) * 0.5,
            y0,
            z1 + offsetOut
        )

        // Height label (Y axis) — along the right-front edge, offset toward +X
        if let text = labelNodeY.geometry as? SCNText {
            text.string = "H \(formatMetres(heightM))"
        }
        labelNodeY.position = SCNVector3(
            x1 + offsetOut,
            (y0 + y1) * 0.5,
            z1
        )

        // Depth label (Z axis) — along the bottom-right edge, offset toward -Y
        if let text = labelNodeZ.geometry as? SCNText {
            text.string = "D \(formatMetres(depthM))"
        }
        labelNodeZ.position = SCNVector3(
            x1,
            y0 - offsetOut,
            (z0 + z1) * 0.5
        )
    }

    /// Orient and size a cylinder node to span from `start` to `end` in world space.
    private func positionEdge(node: SCNNode, from start: simd_float3, to end: simd_float3) {
        let diff = end - start
        let length = simd_length(diff)
        guard length > 0.0001 else {
            node.isHidden = true
            return
        }
        node.isHidden = false

        let mid = (start + end) * 0.5
        node.position = SCNVector3(mid.x, mid.y, mid.z)

        if let cylinder = node.geometry as? SCNCylinder {
            cylinder.height = CGFloat(length)
        }

        let dir = simd_normalize(diff)
        let yAxis = simd_float3(0, 1, 0)
        if abs(simd_dot(dir, yAxis)) > 0.9999 {
            node.orientation = SCNQuaternion(0, 0, 0, 1)
            if dir.y < 0 {
                node.orientation = SCNQuaternion(0, 0, 1, 0)
            }
        } else {
            let axis = simd_normalize(simd_cross(yAxis, dir))
            let angle = acos(simd_dot(yAxis, dir))
            let sinHalf = sin(angle / 2)
            node.orientation = SCNQuaternion(
                axis.x * sinHalf,
                axis.y * sinHalf,
                axis.z * sinHalf,
                cos(angle / 2)
            )
        }
    }
}

// MARK: - ARGeometrySource accessor

private extension ARGeometrySource {
    func vertex(at index: UInt32) -> (Float, Float, Float) {
        assert(componentsPerVector == 3)
        let ptr = buffer.contents().advanced(by: Int(offset) + Int(index) * Int(stride))
        return ptr.assumingMemoryBound(to: (Float, Float, Float).self).pointee
    }
}

private extension ARGeometryElement {
    func indices(at index: UInt32) -> (UInt32, UInt32, UInt32) {
        let ptr = buffer.contents().advanced(by: Int(index) * Int(bytesPerIndex) * Int(indexCountPerPrimitive))
        if bytesPerIndex == 2 {
            let p = ptr.assumingMemoryBound(to: UInt16.self)
            return (UInt32(p[0]), UInt32(p[1]), UInt32(p[2]))
        } else {
            let p = ptr.assumingMemoryBound(to: UInt32.self)
            return (p[0], p[1], p[2])
        }
    }
}
