---
type: Fixed
pr: 4879
---
**The post-merge gate's Xcode detection works on real project layouts** — the gate resolved the .xcodeproj path but built its commands without -project (any project one directory down failed with exit 66) and hardcoded the iPhone 16 simulator name (a machine property); commands now carry -project, the destination resolves from the machine's available simulators, gates skip loudly when none exists, and the timeout message names the sysdiagnose collector. (#4784)
