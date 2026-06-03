# 트래커 이슈에서 GSD Core를 구동하는 방법

**목표:** 사용자 정의 스크립트나 트래커 통합 없이 GSD Core에 이미 존재하는 명령만으로 단일의 명확히 범위가 정해진 GitHub, Linear, 또는 Jira 이슈를 격리된 워크스페이스에서 병합된 PR까지 전체 GSD 파이프라인을 통해 진행합니다.

**사전 조건:** GSD Core가 설치되어 있어야 합니다. 이슈는 범위가 한정되고, 관찰 가능한 수락 기준이 있으며, 상위 블로커가 없어야 합니다.

이 패턴의 개념과 설계 근거는 [이슈 기반 오케스트레이션 설명](../issue-driven-orchestration.md)을 참조하세요.

---

## 1단계: 이슈를 페이즈에 매핑

트래커 이슈를 열고 `ROADMAP.md`에 어떻게 매핑되는지 결정합니다:

- **이슈가 기존 페이즈와 일치** → 페이즈 번호를 메모하고 2단계로 이동합니다.
- **이슈가 독립적인 새 작업** → 페이즈를 추가합니다:

```bash
/gsd-phase "Description matching the issue title"
```

- **이슈가 긴급하고 기존 페이즈 사이에 삽입해야 함** → 소수점 페이즈 삽입:

```bash
/gsd-phase --insert 3 "Fix: description from issue"
```

트래커 이슈 URL을 복사하세요. 3단계에서 `CONTEXT.md`에 붙여넣어 컨텍스트 압축 후에도 추적 가능성이 유지되도록 합니다.

---

## 2단계: 격리된 워크스페이스 생성

모든 이슈는 자체 워크스페이스를 가집니다 — 독립적인 `.planning/` 디렉터리가 있는 git 워크트리. 부분 작업, 중단된 플랜, 탐색적 커밋은 `main` 밖에 유지됩니다.

```bash
/gsd-workspace --new --name my-issue-slug --repos . --strategy worktree
```

계속하기 전에 워크스페이스 디렉터리로 이동합니다:

```bash
cd ~/gsd-workspaces/my-issue-slug
```

---

## 3단계: 페이즈 논의

계획이 이루어지기 전에 구현 결정을 확정하기 위해 discuss-phase를 실행합니다. 세션이 열리면 트래커 이슈 URL을 토론에 붙여넣어 `CONTEXT.md`에 캡처되도록 합니다.

```bash
/gsd-discuss-phase N
```

GSD는 이슈 범위의 모호성 — 오류 처리, 엣지 케이스, 인터페이스 계약, 기술 선택 — 에 대해 물어봅니다. 귀하의 답변이 다음에 나올 플랜을 형성합니다.

이미 모든 답을 알고 빠르게 진행하고 싶다면:

```bash
/gsd-discuss-phase N --auto
```

---

## 4단계: 페이즈 계획

```bash
/gsd-plan-phase N
```

GSD는 연구 에이전트를 스폰하고, `CONTEXT.md` 결정(이슈 URL 포함)을 읽으며, 원자적인 `PLAN.md` 파일을 생성합니다. 플랜 체커가 저장 전에 각 플랜을 검증합니다.

실행 전에 외부 AI CLI의 동료 검토를 원한다면(중요한 변경에 권장):

```bash
/gsd-review --phase N
/gsd-plan-phase N --reviews
```

또는 HIGH 우려 사항이 없을 때까지 전체 플랜-검토-수렴 루프를 실행합니다:

```bash
/gsd-plan-review-convergence N
```

---

## 5단계: 페이즈 실행

대화식, 페이즈 단위 실행:

```bash
/gsd-execute-phase N
```

모든 나머지 페이즈를 자동으로 실행:

```bash
/gsd-autonomous
```

진행 상황을 보고 페이즈 전반에 걸쳐 작업을 디스패치할 수 있는 대화식 대시보드:

```bash
/gsd-manager
```

세 가지 접근 방식 모두 `STATE.md`를 업데이트하고, 각 작업을 원자적으로 커밋하며, 페이즈 후 검증기를 실행합니다.

---

## 6단계: 작업 검증

```bash
/gsd-verify-work N
```

GSD는 페이즈 목표(트래커 이슈를 반영)의 수락 기준을 하나씩 안내합니다. 무언가 실패하면 GSD가 근본 원인을 진단하고 수정 플랜을 만듭니다. 모든 검사가 통과될 때까지 실행과 검증을 반복합니다.

코드가 올바르게 보여도 `verification_failed`를 블로커로 취급하세요 — 실패는 보통 원래 이슈에서 놓친 수락 기준을 드러냅니다.

---

## 7단계: 검토 및 출시

PR을 열기 전에 코드 검토를 실행합니다:

```bash
/gsd-code-review N
/gsd-code-review N --fix
```

그다음 PR을 생성합니다:

```bash
/gsd-ship N
```

GSD는 계획 아티팩트에서 PR 본문을 조립합니다: 페이즈 목표, 변경 사항 요약, 충족된 요구 사항, 검증 상태, 주요 결정. PR이 병합될 때 트래커 이슈가 자동으로 닫히도록 PR 본문에 `Closes #NNN` 또는 `Fixes #NNN`을 포함하세요(또는 `/gsd-config`를 통해 설정).

---

## 8단계: 후속 작업 캡처

이슈 작업 중 관련 작업을 자주 발견하게 됩니다. 컨텍스트를 잃지 않고 캡처합니다:

```bash
/gsd-capture "Follow-up: description of discovered work"      # 할 일로 추가
/gsd-capture --seed "Idea worth a future phase"               # 다음 마일스톤을 위해 보존
/gsd-capture --backlog "Not urgent but worth tracking"        # 백로그에 저장
```

GSD는 트래커에 자동으로 게시하지 않습니다. 캡처된 후속 작업에서 트래커 이슈를 생성하는 것은 별도의 수동 단계입니다 — 이는 검토 루프에 사람이 참여하도록 유지합니다.

---

## 조건부 처리

| 상황 | 할 일 |
|-----------|-----------|
| 이슈가 매우 작음(오타, 설정 변경) | 워크스페이스 + 논의 + 계획 건너뜀; 대신 `/gsd-quick` 사용 |
| 이슈에 여러 독립적인 하위 작업이 있음 | `/gsd-manager`를 사용하여 플랜 전반에 걸쳐 실행 병렬화 |
| 이슈가 다른 이슈에 의해 차단됨 | 상위 블로커가 해결될 때까지 시작하지 않음; GSD에는 자동 의존성 폴러가 없음 |
| 실행 중간에 이슈 범위가 예상보다 큰 것으로 드러남 | 중단하고, `/gsd-phase --insert N`을 실행하여 하위 페이즈 추가 후 계속 |
| 대화식 논의를 건너뛰고 싶음 | `/gsd-discuss-phase`와 함께 `--auto` 플래그 사용, 또는 프로젝트 전체 자동화를 위해 `workflow.skip_discuss: true` 설정 |
| 여러 이슈가 일관된 릴리즈를 형성 | `/gsd-new-milestone`으로 그룹화하고 `/gsd-autonomous`로 순서대로 실행 |

---

## 관련 문서

- [이슈 기반 오케스트레이션 설명](../issue-driven-orchestration.md)
- [워크스페이스로 작업 격리](isolate-work-with-workspaces.md)
- [검증 및 출시](verify-and-ship.md)
- [문서 인덱스](../README.md)
