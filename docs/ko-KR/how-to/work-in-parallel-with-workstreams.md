# 워크스트림으로 여러 영역을 병렬로 작업하는 방법

**목표:** 백엔드 API, 프론트엔드 대시보드, 인프라 등 서로 다른 마일스톤 영역에서 한 영역의 계획 상태가 다른 영역으로 유입되지 않도록 동시 작업을 수행합니다.

**사전 조건:** 활성화된 GSD Core 프로젝트(`.planning/ROADMAP.md` 존재). 없는 경우 먼저 `/gsd-new-project`를 실행하세요.

---

## 워크스트림이란

워크스트림은 단일 코드베이스 내의 독립된 계획 컨텍스트입니다. 각 워크스트림은 독립적인 `STATE.md`, `ROADMAP.md`, `REQUIREMENTS.md`, `phases/` 디렉터리를 포함하는 `.planning/workstreams/<name>/` 서브트리를 가집니다. 코드베이스 자체(소스 코드, git 히스토리, 브랜치)는 모든 워크스트림이 공유합니다.

```
.planning/
├── PROJECT.md          ← 공유
├── config.json         ← 공유
├── codebase/           ← 공유
└── workstreams/
    ├── backend-api/
    │   ├── STATE.md
    │   ├── ROADMAP.md
    │   ├── REQUIREMENTS.md
    │   └── phases/
    └── frontend-dash/
        ├── STATE.md
        ├── ROADMAP.md
        ├── REQUIREMENTS.md
        └── phases/
```

워크스트림이 활성화되면 모든 GSD 명령인 `/gsd-progress`, `/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-execute-phase`가 해당 워크스트림의 디렉터리에서 읽고 씁니다. 워크스트림을 전환하면 소스 트리를 건드리지 않고 모든 명령이 다른 서브트리로 리디렉션됩니다.

---

## 워크스트림 생성

```bash
/gsd-workstreams create backend-api
```

GSD는 `.planning/workstreams/backend-api/` 아래에 워크스트림 디렉터리를 생성하고 기본 `STATE.md`와 `ROADMAP.md`를 시드합니다. 워크스트림은 자동으로 활성화되지 않으며 명시적으로 전환해야 합니다.

---

## 워크스트림 목록 보기

```bash
/gsd-workstreams list
```

모든 워크스트림과 현재 세션에서 활성화된 워크스트림을 표시합니다.

---

## 워크스트림으로 전환

```bash
/gsd-workstreams switch backend-api
```

이 시점부터 모든 GSD 워크플로 명령은 `backend-api` 컨텍스트에서 동작합니다. 전환은 세션 범위로 적용됩니다. 같은 저장소에서 여러 Claude Code 터미널이 열려 있는 경우, 각 세션은 서로 간섭 없이 서로 다른 활성 워크스트림을 유지할 수 있습니다.

전환 후 일반 페이즈 워크플로를 진행합니다:

```bash
/gsd-discuss-phase 1
/gsd-plan-phase 1
/gsd-execute-phase 1
/gsd-verify-work 1
```

다른 영역에서 작업하려면 두 번째 터미널에서 워크스트림을 전환합니다:

```bash
/gsd-workstreams switch frontend-dash
/gsd-discuss-phase 1
/gsd-plan-phase 1
```

---

## 모든 워크스트림의 진행 상황 확인

```bash
/gsd-workstreams progress
```

워크스트림 간 전환 없이 모든 워크스트림의 페이즈 상태, 현재 위치, 미완료 작업을 포함한 교차 워크스트림 요약을 출력합니다.

단일 워크스트림의 상세 상태 확인:

```bash
/gsd-workstreams status backend-api
```

---

## 워크스트림에서 작업 재개

컨텍스트 초기화나 새 세션 이후 위치를 복원합니다:

```bash
/gsd-workstreams resume backend-api
```

이 명령은 워크스트림을 활성화하고 마지막으로 알려진 위치를 복원합니다. 전환 후 `/gsd-resume-work`를 실행하는 것과 동일합니다.

---

## 완료된 워크스트림 보관

워크스트림의 마일스톤 작업이 완료되면:

```bash
/gsd-workstreams complete backend-api
```

GSD는 워크스트림을 보관 상태로 표시하고 활성 목록에서 제거합니다. 계획 아티팩트는 감사 목적으로 `.planning/workstreams/backend-api/`에 보존됩니다.

---

## 세션 컨텍스트 전환 없이 특정 워크스트림에 명령 실행

세션의 활성 컨텍스트를 변경하지 않고 특정 워크스트림에 대해 하나의 명령을 실행해야 하는 경우 `--ws` 플래그를 사용합니다:

```bash
/gsd-progress --ws frontend-dash
/gsd-plan-phase 2 --ws backend-api
```

`--ws`는 해석 우선순위에서 가장 높은 우선권을 가지며 세션 범위의 포인터를 변경하지 않습니다.

---

## 워크스트림과 워크스페이스 중 선택 기준

워크스트림을 선택할 때:

- 모든 작업이 **동일한 저장소**에 있고 같은 git 히스토리를 공유할 때
- 서로의 `STATE.md`를 덮어쓰지 않고 서로 다른 관심 영역(API, UI, 인프라)을 **동시에** 계획하거나 논의하고자 할 때
- 워크스트림 생성 시 브랜치를 별도로 만들 필요가 없을 때(각 워크스트림의 실행 내에서 일반적으로 브랜칭 가능)
- 전체 git 워크트리 생성 오버헤드가 필요한 격리에 비해 과하다고 느껴질 때

[워크스페이스](isolate-work-with-workspaces.md)를 선택할 때:

- **여러 저장소**(예: `hr-ui`와 `ZeymoAPI`)에서 작업할 때
- 기능별로 **별도의 git 워크트리** 또는 클론이 필요할 때 — 완전히 독립된 브랜치, 잠금 파일, 빌드 아티팩트
- 메인 저장소의 `.planning/` 하위 디렉터리가 아닌 완전히 별도의 `.planning/` 루트로 `/gsd-new-project`를 독립적으로 실행하고자 할 때

---

## 관련 문서

- [워크스페이스로 작업 격리](isolate-work-with-workspaces.md)
- [페이즈 루프](../explanation/the-phase-loop.md)
- [명령 참조](../COMMANDS.md)
- [문서 인덱스](../README.md)
