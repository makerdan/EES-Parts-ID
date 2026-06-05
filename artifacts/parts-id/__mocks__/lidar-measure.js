module.exports = {
  isLiDARSupported: () => false,
  measureObject: () => Promise.reject(new Error("LiDAR not available in test environment")),
  NativeLidarDepthView: null,
};
