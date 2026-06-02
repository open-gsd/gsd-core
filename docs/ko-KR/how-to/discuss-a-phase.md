# 페이즈를 논의하는 방법

**목표:** 기획이 시작되기 전에 페이즈에 필요한 구현 결정을 수집합니다. 이를 통해 리서처와 플래너가 다시 질문하지 않고도 작업할 수 있습니다.

**전제 조건:** `.planning/ROADMAP.md`가 존재해야 합니다. 없다면 먼저 `/gsd-new-project`를 실행하세요.

---

## 논의 모드 선택

GSD Core는 두 가지 모드를 제공합니다. 코드베이스에 대한 이해도에 따라 선택하세요.

**구현 방향을 직접 표현하고 싶은 경우** (인터뷰 모드, 기본값):

```bash
/gsd-discuss-phase 2
```

Claude는 페이즈 범위의 모호한 영역을 파악하고, 논의할 항목을 선택하도록 안내한 후 각 영역당 약 4개의 질문을 순서대로 처리합니다.

**코드베이스에 명확한 패턴이 있고 대부분의 질문이 자명한 경우** (가정 모드):

```bash
node gsd-tools.cjs config-set workflow.discuss_mode assumptions
/gsd-discuss-phase 2
```

Claude는 서브에이전트를 통해 관련 코드베이스 파일 5~15개를 읽고, 근거와 신뢰도와 함께 가정을 형성하여 확인 또는 수정을 위해 제시합니다. 일반적으로 15~20번의 상호작용 대신 2~4번의 상호작용으로 처리됩니다.

돌아가려면:

```bash
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

각 모드의 전체 비교 및 시간을 절약할 수 있는 경우에 대해서는 [논의 모드 설명](../workflow-discuss-mode.md)을 참고하세요.

---

## 선택 단계 없이 모든 모호한 영역 논의

기본적으로 Claude는 모호한 영역을 제시하고 다룰 항목을 묻습니다. 선택 프롬프트 없이 모든 항목을 처리하려면:

```bash
/gsd-discuss-phase 2 --all
```

---

## 간단한 페이즈 빠르게 처리

**페이즈가 충분히 이해된 상태이고 Claude가 질문 없이 권장 기본값을 선택하길 원하는 경우:**

```bash
/gsd-discuss-phase 3 --auto
```

Claude는 모든 질문에 권장 답변을 선택하고 선택 사항을 기록합니다. 결정이 낮은 위험을 가지거나 이전 페이즈에 이미 암시된 페이즈에 사용하세요.

**원격 세션 제약이 있는 경우 (TUI 메뉴 없음):**

```bash
/gsd-discuss-phase 2 --text
```

모든 프롬프트가 대화형 선택기 대신 일반 텍스트 번호 목록으로 렌더링됩니다.

---

## 그룹으로 질문 처리

한 번에 하나씩이 아닌 여러 질문을 동시에 답변하고 싶다면:

```bash
/gsd-discuss-phase 2 --batch
```

Claude는 한 번에 2~5개의 질문을 묶어서 처리합니다.

---

## 각 질문에 트레이드오프 분석 추가

결정하기 전에 옵션 비교표를 원한다면:

```bash
/gsd-discuss-phase 2 --analyze
```

---

## 준비된 파일로 일괄 답변

답변 파일을 미리 준비한 경우 한 번에 모든 결정을 적용하려면:

```bash
/gsd-discuss-phase 1 --power
```

---

## 논의 전에 Claude의 가정 확인

**논의 세션에 앞서 Claude가 무엇을 가정하고 어떻게 행동할지 미리 확인하고 싶은 경우** — 논의 시간을 투자하기 전에 정렬 상태를 검증하는 데 유용합니다:

```bash
/gsd-discuss-phase 3 --assumptions
```

Claude는 가정 사항(코드베이스 근거 및 신뢰도 포함)을 출력하고 종료합니다. CONTEXT.md는 작성되지 않습니다. 출력을 검토한 후 수정이 필요한 경우 일반 논의 또는 가정 모드 세션을 실행하세요.

---

## CONTEXT.md의 내용

논의 모드와 가정 모드 모두 페이즈 디렉터리에 동일한 `{phase}-CONTEXT.md`를 생성합니다. 다운스트림 에이전트(리서처, 플래너, 플랜 체커)는 어떤 모드에서 생성했든 이 파일을 동일하게 읽습니다. 파일은 여섯 개의 섹션으로 구성됩니다:

| 섹션 | 목적 |
|---|---|
| `<domain>` | 페이즈 경계 — 이 페이즈가 무엇을 제공하는지 |
| `<decisions>` | 세션에서 확정된 구현 결정 사항 |
| `<canonical_refs>` | 다운스트림 에이전트가 반드시 읽어야 할 명세, ADR, 문서 |
| `<code_context>` | 재사용 가능한 자산, 패턴, 통합 지점 |
| `<specifics>` | 사용자 참조 및 선호 사항 |
| `<deferred>` | 향후 페이즈를 위해 기록된 아이디어 |

`<canonical_refs>` 섹션은 필수입니다. 논의 중 문서, 명세, ADR을 참조하면 Claude가 즉시 추가하고 이후 질문에 반영하기 위해 읽습니다.

전체 필드 참조는 [CONTEXT.md 스키마](../reference/context-md.md)를 참고하세요.

---

## 결정 사항이 기획에 반영되는 방식

다음에 `/gsd-plan-phase`를 실행할 때 플래너는 CONTEXT.md를 읽어 어떤 결정이 확정되었는지 파악합니다. 이미 답변된 질문은 다시 묻지 않습니다. 리서처는 무엇을 조사해야 할지 알기 위해 먼저 읽습니다.

**`/gsd-plan-phase` 실행 시 CONTEXT.md가 없는 경우**, 컨텍스트 없이 계속하거나(계획은 리서치와 요구 사항만 사용, 설계 선호도 없음) 먼저 `/gsd-discuss-phase`를 실행하는 선택지가 제공됩니다.

---

## PRD 또는 인수 기준 문서가 있는 경우

discuss-phase를 완전히 건너뛰고 바로 기획으로 이동합니다:

```bash
/gsd-plan-phase 1 --prd path/to/prd.md
```

플래너는 PRD에서 CONTEXT.md를 합성하고 모든 요구 사항을 확정된 결정으로 처리합니다.

---

## 관련 문서

- [페이즈 기획](plan-a-phase.md)
- [논의 모드](../workflow-discuss-mode.md)
- [CONTEXT.md 스키마](../reference/context-md.md)
- [문서 목차](../README.md)
