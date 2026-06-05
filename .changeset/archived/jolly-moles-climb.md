---
type: Fixed
pr: 383
---
Phase dependency level assignment (gsd-tools phase-plan-index) now dequeues its Kahns-algorithm BFS via a head index instead of Array.shift(), fixing O(V^2) behavior that slowed superlinearly on wide fan-in plan graphs (Array.shift() is O(n) per call in V8). Now O(V+E); behavior is unchanged (same topological levels, same cycle detection). Fixes #307.
