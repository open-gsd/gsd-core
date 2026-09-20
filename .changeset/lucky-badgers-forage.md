---
type: Fixed
pr: 4807
---
**The UI plan gate now recognizes native UI projects** — a SwiftUI, Jetpack Compose, Flutter, or .NET MAUI project never tripped the static frontend-evidence check, so the gate that requires a UI-SPEC before planning a UI phase silently never fired for them. A `.xaml` file, or a `.swift`/`.kt`/`.dart` file importing its ecosystem's UI framework, now counts as evidence; non-UI native packages (a Swift CLI, a plain Kotlin server) stay silent. (#4658)
