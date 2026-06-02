# GSD를 사용한 이슈 주도 오케스트레이션

**상태:** 안정적인 워크플로우 가이드
**대상:** GitHub Issues, Linear, Jira 또는 유사한 이슈 트래커에서 작업을 관리하며
GSD의 기존 기본 도구들을 통해 AI 보조 구현을 이끌고자 하는 개발자.

## 이 가이드란 무엇인가

GSD가 이미 제공하는 명령어들을 이슈 트래커 → 워크스페이스 → 계획/실행 → 검증/리뷰 → PR 루프로 조합하는 레시피이다. 문서화만을 위한 것이다. 새로운 명령어도, 데몬도, 트래커 통합도 없다 — 아래 참조된 모든 명령어들은 GSD에 이미 존재한다.

형태는 OpenAI의 오픈 소스 [Symphony 오케스트레이션 레퍼런스](https://openai.com/index/open-source-codex-orchestration-symphony/)([저장소](https://github.com/openai/symphony))에서 영감을 받았다. GSD는 Symphony를 벤더링하거나 래핑하지 않는다. 오케스트레이션 *개념들*이 GSD가 이미 노출하는 기본 도구들에 깔끔하게 매핑된다; 이 가이드는 글루 코드를 작성하거나 GSD의 안전 게이트를 우회하지 않고도 패턴을 채택할 수 있도록 매핑을 명확하게 설명한다.

## 존재 이유

GSD에는 이슈 주도 AI 개발을 위한 구성 요소들이 있다 —
`/gsd-workspace --new`, `/gsd-manager`, `/gsd-autonomous`, `/gsd-verify-work`,
`/gsd-review`, `/gsd-ship`, 그리고 `STATE.md`와 단계 결과물 스위트
— 하지만 사용자 정의 오케스트레이션 스크립트를 작성하지 않고 단일 트래커 이슈에서 이것들을 구동하는 방법을 안내하는 가이드가 없다. 그 가이드 없이는 실패 모드들이 발생한다:

- 과소 사용: 개발자들이 discuss/plan/execute를 수동으로 실행하면서 작업 패턴이 적합할 때도 `/gsd-manager`나 `/gsd-autonomous`에 손을 뻗지 않는다.
- 임시방편 스크립트: 개발자들이 트래커와 `claude` 호출 사이에 임시 쉘 루프를 연결하여 `STATE.md`, 단계 매니페스트, 검증 게이트를 우회한다.

이 가이드는 정규 루프를 발견 가능하게 만든다.

## 개념 매핑

각 행은 Symphony 스타일 오케스트레이션 개념을 GSD가 이미 제공하는 기본 도구에 매핑한다. Symphony 문서, 블로그 게시물, 또는 타사 오케스트레이션 설명을 읽을 때 이 표를 번역 키로 사용하라.

| Symphony 개념 | GSD 기본 도구 |
|---|---|
| `WORKFLOW.md` (최상위 의도) | `ROADMAP.md` (프로젝트 의도), `STATE.md` (라이브 상태), 단계 `CONTEXT.md` (단계별 범위), 단계 `PLAN.md` (실행 가능한 단계) |
| 작업당 격리된 에이전트 워크스페이스 | `/gsd-workspace --new --strategy worktree` |
| 에이전트 디스패치 및 동시성 | `/gsd-manager` (대화형 대시보드), `/gsd-autonomous` (무인) |
| 단계별 계획 및 논의 단계 | `/gsd-discuss-phase` → `/gsd-plan-phase` → `/gsd-execute-phase` |
| 작업 증명 / 테스트 증거 | `/gsd-verify-work` (`/clear` 전반에 걸쳐 지속되는 UAT.md) |
| 적대적 리뷰 | `/gsd-review` (계획의 교차 AI 동료 리뷰) |
| 사람 병합 게이트 | `/gsd-ship` (PR 생성, 선택적 코드 리뷰, 병합 준비) |
| 후속 캡처 | `/gsd-capture`, `/gsd-capture --seed`, `/gsd-new-milestone`, 또는 수동으로 열린 트래커 이슈 |
| 동시성 제어 | Manager / background-agent 의미 (항상 켜진 폴러 없음) |

매핑은 단방향이다: GSD가 안전 게이트(검증, 사람 리뷰, 후속 생성에 대한 명시적 확인)를 소유한다. Symphony의 "지속적 오케스트레이션" 프레이밍은 의도적으로 채택하지 않는다 — [비목표](#비목표) 참조.

## 엔드투엔드 흐름

단일 트래커 이슈에서 엔드투엔드로 실행될 수 있도록 작성된 정규 이슈 → PR 루프. 실행 전에 대괄호 플레이스홀더를 교체하라.

1. **트래커 이슈 선택.** 트래커(GitHub, Linear 등)에서 자율 구현에 충분히 범위가 지정된 이슈 하나를 선택한다 — 범위가 한정되고, 관찰 가능한 수락 기준이 있으며, 실행을 막는 업스트림 의존성이 없는 것.
2. **GSD 단계에 매핑.** 이슈가 `ROADMAP.md`의 기존 단계에 매핑된다면 선택한다. 그렇지 않으면 `/gsd-new-milestone`(관련 이슈들의 새 마일스톤을 위한)을 실행하거나 `/gsd-phase` / `/gsd-phase --insert`를 통해 단계를 열어라. 압축 후에도 추적 가능성이 유지되도록 단계의 `CONTEXT.md`에 트래커 이슈 URL을 캡처하라.
3. **격리된 워크스페이스 생성.** `/gsd-workspace --new --strategy worktree <slug>`를 실행하여 독립적인 `.planning/` 디렉터리를 가진 git worktree를 생성한다. worktree가 안전 경계이다: 모든 탐색, 부분 커밋, 중단된 계획이 `main` 밖에 머문다.
4. **GSD를 통해 discuss → plan → execute 실행.** 워크스페이스 내에서 `/gsd-discuss-phase`로 모호함을 명확히 하고, `/gsd-plan-phase`로 `PLAN.md`를 생성하고, `/gsd-manager`(대화형 대시보드) 또는 `/gsd-execute-phase` / `/gsd-autonomous`(무인)로 구현한다. GSD 외부에서 raw `claude` 호출을 구동하는 것을 피하라 — 그것은 `STATE.md` 업데이트와 단계 매니페스트를 우회한다.
5. **작업 증명 요구.** `/gsd-verify-work`를 실행하여 사용자가 단계의 수락 기준에 대해 UAT를 진행하도록 안내한다. 테스트, 스크린샷, 로그 캡처, 설정 차이가 모두 `UAT.md`에 기록되며, 이것은 `/clear` 전반에 걸쳐 지속되고 검증이 놓친 범위를 표면화할 때 `/gsd-plan-phase --gaps`에 공급된다.
6. **리뷰 및 출시 게이트 통과.** `/gsd-review`를 실행하여 독립적인 AI CLI들로부터 계획의 적대적 동료 리뷰를 받고(모델별 맹점 포착), 그런 다음 `/gsd-ship`을 실행하여 계획 결과물로 구성된 풍부한 본문으로 PR을 열어라. 두 게이트 모두 원격에 도달하기 전에 사람의 결정을 요구한다.
7. **후속 작업 명시적으로 캡처.** 인라인 메모에는 `/gsd-capture`를, 미래 단계가 될 아이디어에는 `/gsd-capture --seed`를, 일관된 후속 작업 그룹에는 `/gsd-new-milestone`을 사용하라. 발견된 후속 작업에서 트래커 이슈를 생성하는 것은 명시적인 사용자 확인이 필요하다 — GSD는 원격 트래커에 자동으로 게시하지 않는다.

PR이 병합되면 루프가 닫힌다. PR 본문의 자동 닫기 키워드들(`Closes #NNN` / `Fixes #NNN`)이 병합 시점에 트래커 이슈를 닫는다.

## 안전 경계

루프는 네 가지 불변성이 구성상 유지되기 때문에 안전하다:

- **격리된 worktree.** 모든 이슈는 `/gsd-workspace --new` worktree에서 실행되므로 부분 작업, 중단된 계획, 탐색적 커밋이 `main`에 절대 닿지 않는다. `gsd-local-patches/`가 worktree의 수동 편집이 업데이트 후에 다시 돌아와야 할 경우의 복구 표면이다.
- **명시적 사람 리뷰.** `/gsd-review`와 `/gsd-ship` 모두 사람 승인을 위해 중지된다. 자동 병합도 실행에서 자동 PR 경로도 없다. 특정 저장소에 대해 사람 게이트를 제거하고 싶다면, 그것은 사용자의 브랜치 보호 / 병합 큐 정책 결정이지 GSD가 사용자 대신 선택하는 것이 아니다.
- **자동 공개 게시 없음.** GSD는 명시적으로 사용자가 시작한 명령어 없이는 트래커 이슈를 열거나, 댓글을 달거나, 닫지 않는다. 후속 캡처는 기본적으로 로컬 결과물(메모, 시드, 마일스톤)에 저장된다; 트래커에 다시 푸시하는 것은 별도의 수동 단계이다.
- **출시 전 검증.** `/gsd-verify-work`의 UAT.md는 `/gsd-ship`이 실행되기 전에 증거를 기록해야 한다. 권장 원칙은 구현이 올바르게 보일 때도 `verification_failed`를 차단제로 취급하는 것이다 — 실패는 일반적으로 불안정한 테스트가 아닌 놓친 수락 기준을 표면화한다.

이 불변성 중 하나라도 우회되면(예: worktree에 직접 `claude`를 실행하거나, `/gsd-verify-work`를 건너뛰거나, 사용자 확인 없이 트래커 API를 통해 이슈 생성을 스크립팅하는 경우), 이 가이드의 보장이 적용되지 않는다.

## 비목표

이 가이드는 의도적으로 다음 중 어느 것도 제안하지 않는다. 코드 리뷰에서 재논의되지 않도록 여기에 나열한다:

- **Symphony 코드 벤더링이나 복사 없음.** GSD는 자체 기본 도구를 재사용한다. 위의 매핑은 개념적이다; 이 저장소에 Symphony 파생 소스가 없다.
- **장시간 실행 데몬 없음.** GSD는 GitHub이나 Linear를 폴링하지 않는다. manager와 autonomous 워크플로우는 데몬이 아닌 background-agent 의미를 통해 동시성을 처리한다.
- **필수 트래커 의존성 없음.** 루프는 트래커 통합 없이도 작동한다. "트래커 이슈" 단계는 *사람 입력*이다 — URL이 `CONTEXT.md`에 들어간다. GSD는 어떤 트래커를 사용하는지, 또는 트래커를 사용하는지에 대해 의견이 없다.
- **검증, 리뷰, 사람 결정 게이트 우회 없음.** `/gsd-autonomous`를 실행할 때도 검증 및 리뷰 게이트가 여전히 실행된다. "autonomous" 레이블은 단계 간 진행을 가리키며, 사람 승인 건너뛰기를 가리키지 않는다.
- **기본 스킬 / 명령어 표면 확장 없음.** 이 가이드에 참조된 모든 명령어들은 이미 존재한다. 이 가이드는 문서 표면이지, 기능 표면이 아니다.

## 가능한 미래 후속 작업

이 루프에 대한 유지관리자 경험이 정당화된다면, 별도의 승인된 개선 사항이 나중에 *최소한의* 트래커 브리지를 추가할 수 있다:

- 하나의 GitHub 또는 Linear 이슈를 GSD 워크스페이스 / 단계로 가져오기.
- `UAT.md` 증거를 소스 이슈의 댓글로 내보내기.
- `/gsd-capture --seed` 출력에서 후속 트래커 이슈 생성.

그 각각은 통합 표면과 지속적인 유지 관리 부담을 추가하기 때문에 자체 개선 제안이 될 것이다. 이 가이드의 범위에서 벗어난다.

## Related

- [단계 루프](explanation/the-phase-loop.md) — 논의 → 계획 → 실행 → 검증 → 출시가 반복되는 사이클로 어떻게 맞물리는지.
- [워크스페이스 how-to](how-to/work-in-parallel-with-workstreams.md) — 병렬 worktree를 생성하고 관리하는 단계별 가이드.
- [문서 인덱스](README.md) — GSD Core 문서의 전체 목차.
- [docs/USER-GUIDE.md](./USER-GUIDE.md) — 위에 참조된 개별 명령어들의 작업 지향 안내서.
- [docs/COMMANDS.md](COMMANDS.md) — `/gsd-*` 명령어의 전체 레퍼런스.
- [docs/FEATURES.md](FEATURES.md) — 기능 수준 역량 매트릭스 (워크스페이스, manager, autonomous, verify, review, ship).
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 단계 결과물 수명 주기와 `STATE.md` 메카닉.
