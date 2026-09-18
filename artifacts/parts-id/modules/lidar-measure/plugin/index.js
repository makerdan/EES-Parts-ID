const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin for lidar-measure.
 *
 * Patches the CocoaPods-generated Podfile so that the lidar-measure pod
 * includes the LidarMeasureTests test_spec.  Without this, `pod install`
 * creates the test target definition in the .xcodeproj but the scheme is
 * not added to the workspace unless explicitly opted-in via :testspecs.
 *
 * The patch turns:
 *   pod 'lidar-measure', :path => '...'
 * into:
 *   pod 'lidar-measure', :path => '...', :testspecs => ['LidarMeasureTests']
 *
 * This runs automatically during `expo prebuild --platform ios`.
 */
const withLidarMeasureTests = (config) => {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');

      if (!fs.existsSync(podfilePath)) {
        return cfg;
      }

      let contents = fs.readFileSync(podfilePath, 'utf8');

      const alreadyPatched = contents.includes(":testspecs => ['LidarMeasureTests']");
      if (alreadyPatched) {
        return cfg;
      }

      contents = contents.replace(
        /(pod\s+['"]lidar-measure['"][^'\n]*)/g,
        "$1, :testspecs => ['LidarMeasureTests']"
      );

      fs.writeFileSync(podfilePath, contents, 'utf8');
      return cfg;
    },
  ]);
};

module.exports = withLidarMeasureTests;
