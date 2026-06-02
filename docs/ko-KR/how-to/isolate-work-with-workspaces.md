# 워크스페이스로 작업을 격리하는 방법

**목표:** 피처 브랜치나 멀티 저장소 작업을 위해 별도의 git 워크트리, 독립적인 `.planning/` 루트, 그리고 선택적으로 여러 저장소를 포함하는 완전히 격리된 GSD 환경을 만듭니다.

**사전 조건:** `git`이 설치되어 있고 저장소가 워크트리를 지원해야 합니다. 멀티 저장소 워크스페이스의 경우 대상 저장소가 로컬 머신에 존재하거나 경로로 접근 가능해야 합니다.

---

## 워크스페이스란

워크스페이스는 하나 이상의 git 워크트리(또는 클론)와 자체 `.planning/` 루트 디렉터리를 결합한 자급자족 환경입니다. 각 워크스페이스에는 다음이 포함됩니다:

- 소스 저장소의 `.planning/`으로부터 **완전히 독립적인** 자체 `.planning/` 디렉터리 — 그 하위 디렉터리가 아님
- 멤버 저장소를 추적하는 자체 `WORKSPACE.md` 매니페스트
- 지정된 저장소의 git 워크트리(기본값) 또는 전체 클론이며 전용 브랜치(기본값: `workspace/<name>`)로 체크아웃됨

워크스페이스는 기본적으로 `~/gsd-workspaces/<name>/` 아래에 위치합니다.

```
~/gsd-workspaces/
└── feature-b/
    ├── WORKSPACE.md        ← 매니페스트
    ├── .planning/          ← 완전히 독립된 GSD 상태
    │   ├── PROJECT.md
    │   ├── ROADMAP.md
    │   └── ...
    ├── hr-ui/              ← hr-ui 저장소의 워크트리 또는 클론
    └── ZeymoAPI/           ← ZeymoAPI 저장소의 워크트리 또는 클론
```

워크스페이스의 `.planning/`이 소스 저장소와 분리되어 있으므로 소스 저장소에 존재하는 계획 상태와 충돌이나 겹침이 없습니다.

---

## 여러 저장소에 대한 워크스페이스 생성

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
```

GSD는 `~/gsd-workspaces/feature-b/` 내에 `hr-ui`와 `ZeymoAPI`의 워크트리를 생성하고, 각각에서 `workspace/feature-b` 브랜치를 체크아웃하며, `WORKSPACE.md`를 작성하고 `/gsd-new-project`를 위한 빈 `.planning/` 디렉터리를 생성합니다.

위치를 사용자 정의하려면:

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI --path /projects/feature-b
```

---

## 현재 저장소에 대한 워크스페이스 생성

단일 저장소에서 피처 브랜치 격리가 필요할 때 — 독립적인 브랜치, 독립적인 `.planning/`, 메인에서의 상태 유입 없음:

```bash
/gsd-workspace --new --name payments-rework --repos .
```

`.`은 GSD에게 현재 저장소의 워크트리를 생성하도록 지시합니다. 워크트리는 `workspace/payments-rework`로 체크아웃됩니다.

워크트리 대신 전체 클론을 강제하려면:

```bash
/gsd-workspace --new --name payments-rework --repos . --strategy clone
```

---

## 브랜치 명시적 지정

```bash
/gsd-workspace --new --name payments-rework --repos . --branch feature/payments-v2
```

`--branch` 플래그는 워크스페이스의 모든 저장소에 대한 브랜치 이름을 설정합니다. 기본값은 `workspace/<name>`입니다.

---

## 대화형 질문 건너뛰기

```bash
/gsd-workspace --new --name payments-rework --repos . --auto
```

GSD는 프롬프트 없이 모든 기본값을 수락합니다.

---

## 워크스페이스 내에서 GSD 초기화

워크스페이스를 생성한 후 그 안으로 이동하고 GSD 프로젝트를 초기화합니다:

```bash
cd ~/gsd-workspaces/feature-b
/gsd-new-project
```

워크스페이스 내의 `.planning/` 디렉터리가 해당 디렉터리에서 실행되는 모든 후속 GSD 명령의 루트입니다. 이것은 소스 저장소에 존재하는 어떠한 `.planning/`과도 완전히 분리되어 있습니다.

---

## 워크스페이스 목록 보기

```bash
/gsd-workspace --list
```

모든 활성 GSD 워크스페이스와 상태를 출력합니다.

---

## 워크스페이스 제거

```bash
/gsd-workspace --remove feature-b
```

GSD는 git 워크트리를 제거하고 워크스페이스 디렉터리를 정리합니다. 이 작업은 원격 저장소에서 브랜치를 삭제하지 않으며 로컬 워크트리와 워크스페이스 디렉터리만 제거합니다.

---

## 워크스트림 대신 워크스페이스를 선택할 때

워크스페이스를 선택할 때:

- **여러 저장소**(예: API 저장소와 함께 출시되는 UI 저장소)를 하나의 GSD 프로젝트 아래서 조율해야 할 때
- 피처별로 자체 브랜치, 잠금 파일, 빌드 아티팩트를 가진 **별도의 git 워크트리**가 필요할 때 — 한 환경에서의 빌드와 의존성 설치가 다른 환경에 영향을 주지 않도록
- 메인 저장소의 `.planning/` 하위 디렉터리가 아닌 **완전히 독립적인 `.planning/` 루트**를 원할 때
- 각 트래커 이슈가 워크스페이스에 매핑되는 이슈 기반 워크플로를 따를 때([트래커 이슈에서 GSD 구동](drive-gsd-from-a-tracker-issue.md) 참조)

[워크스트림](work-in-parallel-with-workstreams.md)을 선택할 때:

- 모든 작업이 **하나의 저장소**에 있고 같은 git 히스토리를 공유할 때
- 서로의 `STATE.md` 파일 간의 컨텍스트 유입 없이 서로 다른 관심 영역(API, UI, 인프라)에 대해 동시에 `/gsd-plan-phase` 또는 `/gsd-discuss-phase`를 실행하고 싶을 때
- 관심사별로 별도의 워크트리가 필요하지 않고 계획 컨텍스트 전환으로 충분할 때

---

## 관련 문서

- [워크스트림으로 병렬 작업](work-in-parallel-with-workstreams.md)
- [트래커 이슈에서 GSD 구동](drive-gsd-from-a-tracker-issue.md)
- [명령 참조](../COMMANDS.md)
- [문서 인덱스](../README.md)
