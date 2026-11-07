---
type: Fixed
pr: 5930
---
**GitHub Release pages list the release's CHANGELOG entries** — a hotfix's release page had an empty What's Changed because GitHub built it from merged PRs, which a hotfix's cherry-picks are not; every stable release page now shows that release's CHANGELOG section instead of GitHub's PR list. (#5922)
