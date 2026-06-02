# 크로스 AI 리뷰를 설정하는 방법

**목표:** 계획 리뷰에 참여할 AI 리뷰어를 설정하고, 기획된 페이즈 리뷰를 실행하고, 피드백을 활용하여 HIGH 심각도 우려 사항이 없는 계획으로 수렴합니다.

**전제 조건:** 페이즈가 기획되어 있어야 합니다(`{phase}-PLAN.md` 파일이 `.planning/phases/`에 존재). 최소 하나의 외부 AI CLI가 설치되어 인증되어 있어야 합니다.

---

## 어떤 리뷰어를 사용할지 결정

GSD Core는 Gemini CLI, Claude(별도 세션), Codex CLI, CodeRabbit, OpenCode, Qwen Code, Cursor, Antigravity CLI, Ollama, LM Studio, llama.cpp의 조합으로 리뷰 요청을 라우팅할 수 있습니다.

각 리뷰어는 `PLAN.md` 파일에 대해 동일한 구조화된 프롬프트를 독립적으로 실행합니다. 서로 다른 모델은 서로 다른 맹점을 가지고 있으므로 멀티 리뷰어 합의가 단일 리뷰어보다 더 많은 문제를 발견합니다.

**외부 CLI가 아직 설치되지 않은 경우**, 최소 하나를 설치하세요:

```bash
# Gemini CLI (Google 자격 증명으로 무료)
npm install -g @google/gemini-cli

# Antigravity CLI (Google 자격 증명으로 무료)
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Codex CLI
npm install -g @openai/codex
```

---

## 기본 리뷰어 설정 (선택 사항)

기본적으로 `/gsd-review`는 감지된 모든 CLI를 실행합니다. 프로젝트 기본값으로 하위 집합을 고정하려면:

```bash
/gsd-config --integrations
```

통합 마법사는 API 키, 코드 리뷰 CLI 라우팅, `review.default_reviewers` 목록을 다룹니다. 목록을 플래그 없는 기본값으로 사용하려는 리뷰어로 설정하세요. 예: `["gemini","codex"]`.

또는 `gsd-tools`로 직접 설정하세요:

```bash
gsd config-set review.default_reviewers '["gemini","codex"]'
```

전체 통합 설정 스키마(API 키, 리뷰어별 모델 재정의, 로컬 서버 호스트 주소)에 대해서는 [설정](../CONFIGURATION.md)을 참고하세요.

---

## 리뷰 실행

### 표준 리뷰 (설정된 기본값 또는 감지된 모든 CLI 사용)

```bash
/gsd-review --phase 3
```

GSD는 각 리뷰어를 순서대로 호출하고 구조화된 피드백(요약, 강점, HIGH/MEDIUM/LOW 우려 사항, 제안, 위험 평가)을 수집하여 `.planning/phases/03-.../03-REVIEWS.md`에 결합된 출력을 작성합니다.

### 일회성 실행을 위한 단일 리뷰어 선택

```bash
/gsd-review --phase 3 --gemini
/gsd-review --phase 3 --codex
/gsd-review --phase 3 --cursor
```

명시적 플래그는 해당 실행에 대해 `--all` 기본값과 `review.default_reviewers` 모두를 재정의합니다.

### 모든 사용 가능한 리뷰어를 병렬로 실행

```bash
/gsd-review --phase 3 --all
```

`--all`은 항상 설정을 재정의하고 Ollama, LM Studio, llama.cpp를 포함하여 설정된 모든 로컬 모델 서버를 포함한 전체 감지 집합을 실행합니다.

### 로컬 모델 서버 리뷰어

Ollama 또는 LM Studio를 로컬에서 실행하는 경우 서버에 접근할 수 있을 때 `--all`에 자동으로 포함됩니다. 명시적으로 지정할 수도 있습니다:

```bash
/gsd-review --phase 3 --ollama
/gsd-review --phase 3 --lm-studio
```

기본값(`localhost:11434` / `localhost:1234`)이 적용되지 않는 경우 `/gsd-config --integrations`를 통해 `review.*` 키 아래의 호스트 주소와 모델 선택을 설정하세요.

---

## 리뷰 출력 읽기

`{padded_phase}-REVIEWS.md` 파일에는 다음이 포함됩니다:

- 심각도 분류 우려 사항이 있는 각 리뷰어의 개별 리뷰
- 두 명 이상의 리뷰어가 제기한 우려 사항을 종합한 **합의 요약** 섹션 — 최우선 신호를 보려면 여기서 시작하세요
- 리뷰어들이 의견이 달랐던 영역에 대한 **상이한 견해** 섹션

---

## 피드백을 계획에 반영

출력을 검토한 후 피드백을 반영하여 재기획하세요:

```bash
/gsd-plan-phase 3 --reviews
```

플래너는 `REVIEWS.md`를 읽고 우려 사항을 해소하도록 저장 전에 계획을 조정합니다.

---

## plan–review–replan 루프 자동화

모든 HIGH 심각도 우려 사항이 해결될 때까지 반복하려는 페이즈에는 수렴 루프를 사용하세요:

```bash
/gsd-plan-review-convergence 3
```

`plan-phase → review → replan → re-review` 사이클을 기본 최대 3회 실행합니다. HIGH 우려 사항 수가 0에 도달하면 루프를 종료합니다.

### 특정 리뷰어로 수렴

```bash
/gsd-plan-review-convergence 3 --codex
/gsd-plan-review-convergence 3 --gemini
```

### 모든 리뷰어로 더 높은 사이클 상한으로 수렴

```bash
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

**정체 감지:** HIGH 우려 사항 수가 사이클 전반에 걸쳐 감소하지 않으면 GSD가 경고합니다. 사이클 상한에 도달했지만 HIGH 우려 사항이 남아 있는 경우, 진행하거나 수동으로 검토할지를 묻는 에스컬레이션 게이트가 표시됩니다.

---

## 조건부: 어떤 리뷰어를 선택할지

| 상황 | 권장 방법 |
|-----------|---------------------|
| Gemini CLI가 이미 설치되어 있는 경우 | `--gemini`는 항상 좋은 시작 리뷰어 |
| 무료 멀티 리뷰어 커버리지를 원하는 경우 | `--gemini` + `--agy` (둘 다 Google 자격 증명 사용) |
| OpenAI 중심 프로젝트인 경우 | OpenAI 모델 관점을 위해 `--codex` 추가 |
| GitHub Copilot 모델을 원하는 경우 | `--opencode` 추가 |
| API 비용을 완전히 피하려는 경우 | 로컬 모델로 Ollama를 설정하고 `--ollama` 사용 |
| 릴리스 전 최대 커버리지가 필요한 경우 | `/gsd-plan-review-convergence N --all` |
| 빠르게 반복하며 빠른 피드백을 원하는 경우 | CLI 하나 선택: `/gsd-review --phase N --gemini` |

---

## 관련 문서

- [검증 및 배포](verify-and-ship.md)
- [설정](../CONFIGURATION.md)
- [명령어 참조](../COMMANDS.md)
- [문서 목차](../README.md)
