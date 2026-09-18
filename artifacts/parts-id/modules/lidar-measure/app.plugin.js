const { withInfoPlist } = require('@expo/config-plugins');

/**
 * Expo config plugin for lidar-measure — iOS privacy descriptions.
 *
 * Injects the two Info.plist keys that iOS requires before the app may request
 * camera or ARKit/motion access.  Without them the OS terminates the process
 * immediately when LiDAR measurement is triggered.
 *
 * Runs automatically during `expo prebuild --platform ios`.
 */
const withLidarPrivacyDescriptions = (config) => {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults['NSCameraUsageDescription'] =
      cfg.modResults['NSCameraUsageDescription'] ||
      'Parts ID uses the camera to measure part dimensions with LiDAR.';

    cfg.modResults['NSMotionUsageDescription'] =
      cfg.modResults['NSMotionUsageDescription'] ||
      'Parts ID uses motion data to track surfaces during LiDAR measurement.';

    return cfg;
  });
};

module.exports = withLidarPrivacyDescriptions;
