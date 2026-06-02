# 확정 전에 스파이크와 스케치로 검증하는 방법

**목표:** 특정 접근 방식을 페이즈에 확정하기 전에 집중된 실현 가능성 실험(스파이크)과 일회용 HTML 목업을 통한 시각적 방향 탐색(스케치)으로 구현 위험을 줄입니다.

**사전 조건:** 없음. `/gsd-spike`와 `/gsd-sketch`는 자체 저장 디렉터리를 생성하며 초기화된 GSD 프로젝트가 필요하지 않습니다.

---

## 결정: 스파이크, 스케치, 또는 둘 다

| 답하고 싶은 질문… | 사용할 도구 |
|---|---|
| "이 기술적 접근 방식이 실제로 작동할까?" | `/gsd-spike` |
| "이 레이아웃 / 인터랙션 / 시각적 처리가 맞는 느낌인가?" | `/gsd-sketch` |
| "올바른 기술적 접근 방식은 무엇이고, 어떻게 보여야 할까?" | 둘 다, 순서대로: 먼저 스파이크, 그다음 스케치 |

스파이크는 실행 가능한 코드와 VALIDATED / INVALIDATED / PARTIAL 판정으로 이진 실현 가능성 질문에 답합니다. 스케치는 2~3개의 브라우저에서 비교 가능한 HTML 변형으로 시각적 질문에 답합니다. 두 가지는 상호 보완적입니다 — 스파이크는 접근 방식이 구현 가능함을 증명하고, 스케치는 디자인이 구현할 가치가 있음을 증명합니다.

---

## 스파이크 실행

### 대화식 입력(기본값)

```bash
/gsd-spike
```

GSD는 기술적 질문에 대해 물어보고, 이를 **Given / When / Then** 가설로 구성된 2~5개의 독립적인 실험으로 분해하며, 빌드 전에 확인을 요청합니다.

### 아이디어를 직접 제공

```bash
/gsd-spike "can we stream LLM tokens through SSE"
```

### 입력 건너뛰고 즉시 실행

```bash
/gsd-spike --quick "websocket vs SSE latency"
```

`--quick`은 분해 대화를 건너뛰고 인자를 단일 스파이크 질문으로 처리합니다. 질문이 이미 충분히 구체적이어서 세분화 없이 실행할 수 있을 때 사용합니다.

### 각 실험이 생성하는 결과물

`.planning/spikes/NNN-descriptive-name/`의 각 스파이크에는 다음이 포함됩니다:

- 작동하는 코드(의사 코드 아님)
- 코드 작성 전에 작성된 **Given / When / Then** 가설
- 엣지 케이스, 방향 전환, 놀라운 발견을 문서화한 조사 추적
- 증거와 함께 **VALIDATED**, **INVALIDATED**, 또는 **PARTIAL** 판정
- 프론트매터, 실행 방법 지침, 결과가 포함된 `README.md`

모든 스파이크는 `.planning/spikes/MANIFEST.md`에 인덱싱됩니다.

### 결과 패키징

신호가 확보되면 결과를 프로젝트 로컬 스킬로 패키징하여 향후 세션에서 자동으로 로드되도록 합니다:

```bash
/gsd-spike --wrap-up
```

이 명령은 `.claude/skills/spike-findings-[project]/`를 작성합니다. 스킬은 자동으로 발견되어 이후의 `/gsd-sketch`, `/gsd-ui-phase`, `/gsd-plan-phase` 실행에서 로드됩니다 — 명시적으로 참조할 필요가 없습니다.

---

## 스케치 실행

### 분위기 입력(기본값)

```bash
/gsd-sketch
```

GSD는 코드 작성 전에 느낌, 시각적 참조, 핵심 사용자 작업을 탐색하는 짧은 대화를 시작합니다. 한 번에 하나의 질문을 하며 진행 승인을 받을 때만 빌드를 시작합니다.

### 디자인 방향을 직접 제공

```bash
/gsd-sketch "dashboard layout"
```

### 분위기 입력 건너뛰고 즉시 실행

```bash
/gsd-sketch --quick "sidebar navigation"
```

`--quick`은 입력 대화를 완전히 건너뛰고 인자를 디자인 방향으로 사용합니다.

### 비 Claude 런타임(Codex, Gemini CLI 등)

```bash
/gsd-sketch --text "onboarding flow"
```

`--text`는 대화식 프롬프트를 일반 텍스트 번호 목록으로 대체합니다. 런타임이 `AskUserQuestion`을 지원하지 않을 때 사용합니다.

### 각 스케치가 생성하는 결과물

`.planning/sketches/NNN-descriptive-name/`의 각 스케치에는 다음이 포함됩니다:

- 탭 탐색으로 접근 가능한 2~3개의 변형이 있는 `index.html` — 빌드 단계 없이 브라우저에서 직접 열기
- 기능적인 인터랙티브 요소(호버, 클릭, 전환)
- 이전 스파이크 결과의 필드 이름과 데이터 형태를 사용하는 실제에 가까운 콘텐츠
- `.planning/sketches/themes/default.css`의 공유 CSS 변수
- 디자인 질문, 변형, 살펴볼 사항이 포함된 `README.md`

모든 스케치는 `.planning/sketches/MANIFEST.md`에 인덱싱됩니다.

### 우승 디자인 결정 패키징

변형을 선택한 후 시각적 결정을 프로젝트 로컬 스킬로 캡처합니다:

```bash
/gsd-sketch --wrap-up
```

이 명령은 `.claude/skills/sketch-findings-[project]/`를 작성합니다. 스킬은 `/gsd-ui-phase`에 의해 자동으로 가져옵니다 — 사전 검증된 결정(레이아웃, 색상 팔레트, 타이포그래피, 간격)은 확정된 것으로 처리되어 다시 묻지 않습니다.

---

## 통합 흐름: 스파이크 → 스케치 → 페이즈

기술적 실현 가능성과 시각적 방향 모두 불확실할 때 권장하는 순서:

```bash
/gsd-spike "SSE vs WebSocket for real-time feed"
/gsd-spike --wrap-up

/gsd-sketch "real-time feed UI"
/gsd-sketch --wrap-up

/gsd-discuss-phase N
/gsd-plan-phase N
```

스파이크 결과가 스케치에 정보를 제공합니다(실제 데이터 형태, 실제 인터랙션 상태, 현실적인 제약). 두 wrap-up 모두 플래너와 UI 연구자가 자동으로 로드하는 결정을 유지하므로 `/gsd-discuss-phase`나 `/gsd-ui-phase` 중에 선택 사항을 다시 설명할 필요가 없습니다.

---

## 스파이크 또는 스케치가 페이즈에 반영되는 방식

스파이크와 스케치 아티팩트는 수동으로 참조할 필요가 없습니다. GSD는 두 시점에서 자동으로 읽습니다:

1. **`/gsd-sketch`** — 목업 빌드 전에 `.claude/skills/spike-findings-*/`를 로드하여 변형이 증명된 제약(스트리밍 상태, 실제 필드 이름 등)을 반영하도록 함
2. **`/gsd-ui-phase N`** — UI 디자인 계약을 생성하기 전에 `.claude/skills/sketch-findings-*/`를 로드. 사전 검증된 디자인 결정은 확정된 것으로 처리됨

플래너도 `spike-findings-*` 스킬이 있을 때 스파이크 결과를 읽으므로 검증된 기술 선택(어떤 라이브러리, 어떤 프로토콜, 어떤 데이터 형식)이 반복적인 설명 없이 작업 플랜으로 직접 반영됩니다.

---

## 관련 문서

- [UI 페이즈 디자인](design-a-ui-phase.md)
- [페이즈 계획](plan-a-phase.md)
- [명령 참조](../COMMANDS.md)
- [문서 인덱스](../README.md)
