import ExpoModulesCore

public class LidarDepthViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("LidarDepthView")

        View(LidarDepthView.self) {}
    }
}
