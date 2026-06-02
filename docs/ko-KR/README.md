# GSD Core 문서

문서는 네 가지 유형으로 구성됩니다. **튜토리얼**은 직접 해보며 배우고, **how-to 가이드**는 특정 작업을 해결하며, **레퍼런스**는 권위 있는 사실을 제시하고, **설명**은 개념과 설계 결정을 탐구합니다.

언어 버전: [English](../README.md) · [Português (pt-BR)](../pt-BR/README.md) · [日本語](../ja-JP/README.md) · [简体中文](../zh-CN/README.md) · **한국어**

---

## 튜토리얼

- [첫 번째 프로젝트](tutorials/your-first-project.md) — 설치부터 첫 단계 출시까지, 확실한 한 가지 경로
- [기존 코드베이스 온보딩](tutorials/onboarding-an-existing-codebase.md) — 기존 저장소에 GSD Core 적용하기

---

## How-to guides

- [런타임에 설치하기](how-to/install-on-your-runtime.md) — 지원하는 15개 런타임 각각의 설치 단계
- [단계 논의하기](how-to/discuss-a-phase.md) — 기획 시작 전 구현 결정 사항 정리
- [단계 기획하기](how-to/plan-a-phase.md) — 리서치 실행, 작업 분해, 플랜 품질 검증
- [단계 실행하기](how-to/execute-a-phase.md) — 새 컨텍스트 서브에이전트로 병렬 웨이브 실행
- [검증 및 출시](how-to/verify-and-ship.md) — 완료된 작업 검토, 오류 진단, PR 생성
- [단계 자율 실행하기](how-to/run-phases-autonomously.md) — 무인 단계 실행을 위한 자율 모드 사용
- [빠른 임시 작업 처리](how-to/handle-quick-and-fast-tasks.md) — 단계 루프 외 임시 작업에 `/gsd-quick`과 `/gsd-fast` 활용
- [모델 프로필 설정](how-to/configure-model-profiles.md) — 고품질, 균형, 예산 모델 티어 전환
- [크로스 AI 리뷰 설정](how-to/set-up-cross-ai-review.md) — 주 에이전트가 생성한 코드를 두 번째 AI가 검토하도록 설정
- [워크스트림으로 병렬 작업](how-to/work-in-parallel-with-workstreams.md) — 워크스트림을 사용해 독립적인 작업 라인 동시 실행
- [워크스페이스로 작업 격리](how-to/isolate-work-with-workspaces.md) — 워크스페이스로 실험적이거나 위험한 변경 사항 샌드박스 처리
- [실패한 실행 디버깅](how-to/debug-a-failed-execution.md) — 깨지거나 불완전한 단계 실행 진단 및 복구
- [스파이크와 스케치](how-to/spike-and-sketch.md) — 플랜 확정 전 탐색 작업에 `/gsd-spike`와 `/gsd-sketch` 활용
- [UI 단계 설계](how-to/design-a-ui-phase.md) — 프론트엔드 및 시각적 작업에 UI 단계 루프 활용
- [트래커 이슈로 GSD 구동](how-to/drive-gsd-from-a-tracker-issue.md) — GitHub, Linear, Jira 이슈에서 단계 시작
- [GSD 2에서 마이그레이션](how-to/migrate-from-gsd-2.md) — 기존 GSD 2 프로젝트를 GSD Core로 업그레이드
- [GSD 업데이트](how-to/update-gsd.md) — 설치 프로그램을 재실행해 최신 릴리스 적용
- [복구 및 문제 해결](how-to/recover-and-troubleshoot.md) — 일반적인 문제 해결, 컨텍스트 재구축, 제거

---

## 레퍼런스

- [명령어](COMMANDS.md) — 플래그와 예제가 포함된 모든 명령어
- [설정](CONFIGURATION.md) — 전체 설정 스키마, 모델 프로필, git 브랜칭 전략
- [CLI 도구](CLI-TOOLS.md) — 워크플로우와 에이전트를 위한 `gsd-tools.cjs` 프로그래밍 API
- [기능](FEATURES.md) — 전체 기능 색인
- [인벤토리](INVENTORY.md) — 설치된 스킬과 서피스 맵
- [STATE.md 스키마](reference/state-md.md) — `.planning/STATE.md` 필드별 레퍼런스
- [CONTEXT.md 스키마](reference/context-md.md) — `.planning/phases/<N>/CONTEXT.md` 필드별 레퍼런스
- [PLAN.md 스키마](reference/plan-md.md) — `.planning/phases/<N>/PLAN.md` 필드별 레퍼런스
- [기획 아티팩트](reference/planning-artifacts.md) — 모든 `.planning/` 파일과 역할

---

## 설명

- [컨텍스트 엔지니어링](explanation/context-engineering.md) — 컨텍스트 rot가 형성되는 방식과 GSD Core의 방지 방법
- [단계 루프](explanation/the-phase-loop.md) — 논의 → 기획 → 실행 → 검증 → 출시 사이클의 설계 근거
- [멀티 에이전트 오케스트레이션](explanation/multi-agent-orchestration.md) — 서브에이전트의 생성, 범위 지정, 조율 방식
- [보안 모델](explanation/security-model.md) — 신뢰 경계, 권한, 안전한 자동화
- [아키텍처](ARCHITECTURE.md) — 시스템 아키텍처, 에이전트 모델, 데이터 흐름
- [논의 모드](workflow-discuss-mode.md) — `/gsd-discuss-phase`의 가정 모드와 인터뷰 모드
- [컨텍스트 모니터링](context-monitor.md) — 컨텍스트 창 모니터링 훅 아키텍처
- [이슈 기반 오케스트레이션](issue-driven-orchestration.md) — 기존 프리미티브를 사용해 트래커 이슈로 GSD를 구동하는 레시피

---

## Related

- [루트 README](../README.md) — 랜딩 페이지, 빠른 시작, 문서 개요
- [변경 로그](../../CHANGELOG.md) — 릴리스 이력
