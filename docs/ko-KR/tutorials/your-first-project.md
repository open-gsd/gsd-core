# 첫 번째 프로젝트

이 튜토리얼에서는 GSD Core를 설치하고, 간단한 커맨드라인 할 일(to-do) 앱을 처음부터 만들어봅니다 — 하나의 단계(phase), 하나의 PR, 그리고 전체 루프를 경험합니다. 튜토리얼이 끝나면 핵심 단계 루프의 모든 명령어를 최소 한 번씩 실행해보고, 각 명령어가 생성하는 계획 산출물도 확인하게 됩니다.

---

## 만들 것

로컬 JSON 파일에 저장된 할 일 항목을 추가하고, 목록을 보고, 완료 처리할 수 있는 Node.js CLI입니다. 한 세션 안에 완성할 만큼 작고, Node.js 표준 라이브러리만 사용하므로 별도로 설치할 것이 없습니다.

---

## 사전 준비

- **Node.js 18 이상** — `node --version`이 `v18.x.x` 이상을 출력해야 합니다.
- **Claude Code** — 사용하려는 프로젝트 디렉터리에서 열어둡니다.
- 초기 설치를 위한 인터넷 연결.

그 외 도구는 필요하지 않습니다. GSD Core는 다음 단계에서 설치합니다.

---

## Step 1 — GSD Core 설치

프로젝트 디렉터리에서 터미널을 열고 실행합니다:

```bash
npx @opengsd/gsd-core@latest
```

설치 프로그램이 사용 중인 AI 코딩 런타임과 전역 설치 또는 현재 프로젝트 설치 여부를 묻습니다. 지금은 **Claude Code**와 **local**(이 프로젝트에만)을 선택합니다.

다음과 같은 출력이 표시됩니다:

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

프로젝트 안에 `.claude/` 디렉터리가 생성된 것을 확인할 수 있습니다. GSD Core의 명령어와 에이전트가 이곳에 저장됩니다.

> 로컬 vs 전역 설치 이유? 로컬 설치는 이 프로젝트에 스킬 버전을 고정합니다. 전역 설치가 필요하다면 [런타임에 설치하기](../how-to/install-on-your-runtime.md)를 참고하세요.

---

## Step 2 — 권한 플래그로 Claude Code 시작

GSD Core는 파일을 읽고 쓰는 서브 에이전트를 생성합니다. 모든 파일 작업마다 확인을 요청하지 않도록 권한 플래그를 사용해 Claude Code를 시작합니다:

```bash
claude --dangerously-skip-permissions
```

프로젝트 디렉터리에서 Claude Code 프롬프트로 이동됩니다.

---

## Step 3 — 프로젝트 생성

Claude Code 프롬프트에 다음 슬래시 명령어를 입력합니다:

```text
/gsd-new-project
```

GSD Core가 대화를 시작합니다. 먼저 질문을 하나 합니다:

```text
What do you want to build?
```

다음과 같이 입력합니다:

```text
A Node.js CLI tool for managing to-do items. Users run `todo add "buy milk"`,
`todo list`, and `todo done 1`. Items are saved to a local todos.json file.
No external dependencies — Node built-ins only.
```

GSD Core는 몇 가지 후속 질문을 합니다. 자연스럽게 답변하면 됩니다. 계획을 하나도 작성하기 전에 먼저 여러분이 중요하게 생각하는 것을 파악합니다.

질문이 끝나면 도메인 리서치 실행 여부를 묻습니다. 이 정도 규모의 프로젝트는 리서치를 건너뛰어도 됩니다 — 프롬프트가 표시될 때 **Skip research**를 선택합니다.

그런 다음 GSD Core가 워크플로 설정(모드, 세분화 수준, 리서치 에이전트)을 선택하도록 안내합니다. 각 항목마다 권장 기본값을 선택합니다. 이 설정들은 `.planning/config.json`에 저장됩니다.

마지막으로 로드맵 작성 서브 에이전트가 실행됩니다("Spawning roadmapper…" 메시지가 표시되는 것은 정상이며, 약 1분 정도 소요됩니다). 완료되면 GSD Core가 제안 로드맵을 제시합니다. 단일 단계 프로젝트라면 다음과 같이 표시됩니다:

```text
Proposed Roadmap

1 phase | 4 requirements mapped | All v1 requirements covered ✓

| # | Phase              | Goal                                    | Requirements      |
|---|--------------------|-----------------------------------------|-------------------|
| 1 | Core CLI           | add / list / done commands, todos.json  | CLI-01 … CLI-04   |
```

**Approve**를 입력해 로드맵을 승인합니다.

**`.planning/`에 생성되는 파일:**

```text
.planning/
  PROJECT.md          ← 프로젝트 설명과 요구사항
  REQUIREMENTS.md     ← 모든 v1 기능의 REQ-ID
  ROADMAP.md          ← Phase 1, 상태: pending
  STATE.md            ← 세션 메모리, 현재 위치
  config.json         ← 워크플로 설정
```

지금 `.planning/ROADMAP.md`를 열어 살펴봅니다. Phase 1에는 목표(Goal), 충족해야 할 요구사항 목록, 그리고 성공 기준(Success Criteria) — 실행이 반드시 달성해야 하는 관찰 가능한 동작 — 이 포함되어 있습니다.

---

## Step 4 — 컨텍스트 초기화 후 Phase 1 논의

GSD Core는 새로운 컨텍스트를 기반으로 동작하도록 설계되었습니다. 각 단계를 시작하기 전에 메인 세션 창을 초기화합니다:

```text
/clear
```

그런 다음 Phase 1 논의를 시작합니다:

```text
/gsd-discuss-phase 1
```

GSD Core가 단계 목표를 읽고 구현 방식에 대해 질문합니다. 이는 *무엇을* 만들지가 아닌 *어떻게* 만들지를 결정하는 과정입니다. 예시 대화:

```text
> How should done items be stored — mark them in place or move them?
  Mark them in place with a "done" flag.

> Should `todo list` show completed items by default?
  No, hide them unless --all is passed.

> Error format when todos.json doesn't exist yet?
  Create it silently on first add.
```

논의가 끝나면 GSD Core가 다음 파일을 생성합니다:

```text
.planning/phases/01-core-cli/CONTEXT.md
```

해당 파일을 열어봅니다. `## Implementation Decisions` 섹션에 여러분이 말한 내용이 정확히 기록되어 있습니다. 플래너가 이 파일을 읽으므로, 여기서 결정한 내용이 모든 태스크 계획에 반영됩니다.

---

## Step 5 — Phase 1 계획

```text
/gsd-plan-phase 1
```

4개의 리서치 서브 에이전트가 병렬로 실행됩니다("Spawning 4 researchers…" 메시지가 표시됩니다). 1–5분 정도 소요됩니다. 중단하지 마세요.

완료되면 플래너가 CONTEXT.md와 리서치 결과를 바탕으로 원자적 태스크 계획을 생성합니다. 플랜 검사기가 각 계획이 단계 목표를 달성하는지 확인한 후 저장합니다.

**생성되는 파일:**

```text
.planning/phases/01-core-cli/
  RESEARCH.md         ← 도메인 리서치 결과
  01-01-PLAN.md       ← 태스크: todos.json 읽기/쓰기 헬퍼 생성
  01-02-PLAN.md       ← 태스크: add / list / done 명령어 구현
```

`01-01-PLAN.md`를 열어봅니다. 이름, 관련 파일, 실행 단계, 검증 명령어, 완료 조건이 담긴 `<task>` 블록을 확인할 수 있습니다. `<verify>` 태그에 주목하세요 — GSD Core의 실행기가 코드 작성 후 해당 명령어를 실행합니다.

---

## Step 6 — Phase 1 실행

```text
/gsd-execute-phase 1
```

GSD Core가 계획을 웨이브(독립적인 계획은 병렬로 실행)로 묶고, 계획별로 새로운 200k 컨텍스트 실행기를 생성하며, 각 태스크를 원자적으로 커밋합니다.

다음과 같은 출력이 표시됩니다:

```text
Wave 1 (parallel):
  [Executor A] → 01-01-PLAN.md (read/write helpers)   ✓ committed
  [Executor B] → 01-02-PLAN.md (CLI commands)          ✓ committed

[Verifier] Checking codebase against phase goals...
  CLI-01 todo add   ✓
  CLI-02 todo list  ✓
  CLI-03 todo done  ✓
  CLI-04 --all flag ✓
  Status: PASS
```

**생성되는 파일:**

```text
.planning/phases/01-core-cli/
  01-01-SUMMARY.md    ← Executor A가 빌드하고 커밋한 내용
  01-02-SUMMARY.md    ← Executor B가 빌드하고 커밋한 내용
  VERIFICATION.md     ← REQ 커버리지: PASS
```

이제 CLI를 실행해봅니다:

```bash
node todo.js add "buy milk"
node todo.js add "write tests"
node todo.js list
node todo.js done 1
node todo.js list
```

항목이 나타나고, 완료 처리한 항목 1번이 기본 목록에서 사라지는 것을 확인할 수 있습니다. 이것이 GSD Core가 전달하는 첫 번째 가시적인 결과입니다.

---

## Step 7 — 작업 검증

```text
/gsd-verify-work 1
```

GSD Core가 단계의 성공 기준을 추출하고 하나씩 확인합니다:

```text
[1/3] Can you run `node todo.js add "buy milk"` without errors?
> yes

[2/3] Does `node todo.js list` show only incomplete items by default?
> yes

[3/3] Does `node todo.js done 1` mark item 1 complete and hide it from the default list?
> yes

All 3 checks passed. Phase 1 verified.
```

검사가 실패하면 GSD Core가 근본 원인을 진단하고 수정 계획을 생성합니다. `/gsd-execute-phase 1`을 다시 실행해 수정을 적용한 후, `/gsd-verify-work 1`을 다시 실행합니다.

**생성되는 파일:**

```text
.planning/phases/01-core-cli/UAT.md   ← 모든 검사 항목과 결과
```

---

## Step 8 — 배포

```text
/gsd-ship 1
```

GSD Core가 자동 생성된 본문으로 풀 리퀘스트를 생성합니다. PR 본문에는 항상 요약(Summary), 변경 사항(Changes), 요구사항 반영(Requirements Addressed), 검증(Verification), 핵심 결정사항(Key Decisions)이 포함됩니다.

다음과 같이 표시됩니다:

```text
Pull request created: https://github.com/your-org/your-repo/pull/1

Title: feat(phase-1): core CLI — add / list / done commands
```

이것이 하나의 단계(phase)에 대한 아이디어부터 PR 머지까지의 전체 루프입니다.

---

## 배운 내용

- `npx @opengsd/gsd-core@latest`로 GSD Core를 설치하는 방법.
- `/gsd-new-project`가 대화를 통해 `.planning/` 산출물로 뒷받침되는 로드맵으로 전환하는 방법.
- `/gsd-discuss-phase`가 계획 수립 전에 구현 결정사항을 기록하는 방법.
- `/gsd-plan-phase`가 병렬 리서처를 생성하고 원자적 태스크 계획을 만드는 방법.
- `/gsd-execute-phase`가 해당 계획을 병렬 웨이브로 실행하고 각 태스크를 커밋하는 방법.
- `/gsd-verify-work`가 성공 기준을 하나씩 확인하고 필요 시 수정 계획을 생성하는 방법.
- `/gsd-ship`이 검증된 단계를 풀 리퀘스트로 전환하는 방법.

멀티 단계 프로젝트의 경우 각 단계마다 Step 4–8을 반복한 다음, `/gsd-progress --next`를 실행해 GSD Core가 다음 단계를 자동으로 감지하도록 합니다.

---

## Related

- [The phase loop](../explanation/the-phase-loop.md) — 루프가 이런 구조를 가지는 이유
- [How-to guides](../README.md#how-to-guides) — 특정 상황에 대한 태스크 중심 레시피
- [Onboarding an existing codebase](onboarding-an-existing-codebase.md) — 브라운필드 레포에 GSD Core 도입하기
