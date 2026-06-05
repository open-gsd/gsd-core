---
type: Fixed
pr: 5
---
**`check.decision-coverage-plan` gate now recognises D-NN citations inside `<objective>`, `<tasks>`, `<task>`, and `<action>` XML tag bodies** — `extractPlanSections()` previously searched only front-matter (`must_haves`, `truths`, `objective`) and body lines under designated markdown headings. The `gsd-planner` spec directs agents to cite decision IDs inside `<action>` bodies; those citations were invisible to the gate, causing plans that correctly followed the spec to report `passed: false` with all decisions uncovered. `extractXmlTagBodies()` now extracts inner text from the four canonical planner XML tags via a narrow regex (no parser library), and that text is appended to the `designated` search string. Self-closing tags and non-canonical tags are safely ignored. (#5)
