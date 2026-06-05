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

  s.dependency 'ExpoModulesCore'

  s.source_files   = 'ios/**/*.swift'

  s.frameworks     = 'ARKit', 'SceneKit'
end
