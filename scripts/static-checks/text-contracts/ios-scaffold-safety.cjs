'use strict';

// iOS scaffold safety (#2023): the guidance never offers Package.swift + .executableTarget as the build system
// of an iOS app (that produces a macOS CLI), requires XcodeGen (project.yml + xcodegen generate), documents
// SwiftUI API availability against the deployment target, and the executor and the universal anti-patterns
// point at it. Was tests/ios-scaffold-safety.test.cjs. The original accepted any of several words (`never`,
// `iOS 16`, `ios-scaffold`, `xcodegen`, `Package.swift` or `SPM` plus `iOS`); each assertion below names the
// phrase the real file carries, so an unrelated mention elsewhere in the file cannot satisfy it.

module.exports = {
  id: 'ios-scaffold-safety',
  issue: '#2023',
  check(ctx) {
    ctx.exists('gsd-core/references/ios-scaffold.md', 'the iOS scaffold reference should exist at gsd-core/references/ios-scaffold.md');

    ctx.doc('gsd-core/references/ios-scaffold.md')
      .has('Package.swift', 'ios-scaffold.md must name Package.swift')
      .has(/NEVER use `Package\.swift`/, 'ios-scaffold.md must explicitly prohibit Package.swift as the primary build system for iOS apps')
      .has('executableTarget', 'ios-scaffold.md must name .executableTarget')
      .has(/NEVER[^\n]{0,200}`\.executableTarget`/, 'ios-scaffold.md must explicitly prohibit .executableTarget for iOS app targets')
      .has('project.yml', 'ios-scaffold.md must require project.yml as the XcodeGen spec file')
      .has('xcodegen generate', 'ios-scaffold.md must require the xcodegen generate command to create .xcodeproj')
      .has('SwiftUI API availability', 'ios-scaffold.md must document SwiftUI API availability')
      .has('IPHONEOS_DEPLOYMENT_TARGET', 'ios-scaffold.md must document iOS deployment target compatibility');

    ctx.doc('agents/gsd-executor.md')
      .has('ios-scaffold.md', 'gsd-executor.md must reference ios-scaffold.md for iOS app scaffold guidance');

    ctx.doc('gsd-core/references/universal-anti-patterns.md')
      .has('`Package.swift` + `.executableTarget`', 'universal-anti-patterns.md must document the Package.swift misuse anti-pattern')
      .has('primary build system for iOS apps', 'universal-anti-patterns.md must say the misuse is for iOS apps');
  },
};
