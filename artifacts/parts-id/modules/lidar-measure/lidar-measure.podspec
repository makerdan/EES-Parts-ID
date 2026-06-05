require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'lidar-measure'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = { type: 'MIT' }
  s.author         = 'Parts ID'
  s.homepage       = 'https://github.com'
  s.platform       = :ios, '14.0'
  s.swift_version  = '5.4'
  s.source         = { git: '' }
  s.static_framework = true
  s.module_name    = 'LidarMeasure'

  s.dependency 'ExpoModulesCore'

  s.source_files   = 'ios/**/*.swift'
  s.exclude_files  = 'ios/**/*Tests.swift'

  s.frameworks     = 'ARKit', 'SceneKit'

  s.test_spec 'LidarMeasureTests' do |test|
    test.source_files = 'ios/LidarMeasureModuleTests.swift'
  end
end
