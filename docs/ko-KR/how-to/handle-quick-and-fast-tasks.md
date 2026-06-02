# 빠른 작업과 간단한 작업을 처리하는 방법

모든 작업이 페이즈 안에 맞는 것은 아닙니다. GSD는 전체 discuss → plan → execute → verify 루프가 필요 없는 작업을 위한 두 가지 경량 명령을 제공합니다.

전체 페이즈 파이프라인이 오버헤드를 감당할 가치가 있는 경우에 대한 맥락은 [컨텍스트 엔지니어링](../explanation/context-engineering.md)을 참고하세요.

---

## 어떤 명령을 사용할지 결정

| 상황 | 명령 |
|-----------|---------|
| 버그 수정, 소규모 기능 추가, 또는 단일 사소한 수정으로 요약할 수 없는 작업 | `/gsd-quick` |
| 오타 수정, 설정 값 업데이트, `.gitignore` 항목 추가, 또는 ≤ 3개 파일을 터치하고 1분 이내에 완료되는 변경 | `/gsd-fast` |
| 작업에 미지수가 있거나 리서치가 필요하거나 여러 파일을 터치할 경우 | `--research`와 함께 `/gsd-quick` |

**경험 법칙:** 작업이 사소한지에 대해 잠시라도 망설인다면 `/gsd-quick`을 사용하세요. `/gsd-fast`는 범위가 사소하지 않아 보이면 자동으로 `/gsd-quick`으로 리디렉션합니다.

---

## `/gsd-quick` — GSD 보장이 있는 임시 작업

`/gsd-quick`은 전체 페이즈와 동일한 원자적 커밋 및 STATE.md 추적 보장으로 플래너와 실행자를 실행하지만, 페이즈 오버헤드 없이 진행합니다(ROADMAP 항목 없음, discuss-phase 없음, 여러 계획에 걸친 웨이브 조정 없음).

### 기본 사용

```bash
/gsd-quick
```

GSD가 태스크 설명을 묻고 계획 및 실행합니다. 산출물은 `.planning/quick/`에 저장됩니다.

설명을 직접 전달할 수도 있습니다:

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

### 플래그

작업에 필요한 경우 더 많은 품질 파이프라인을 추가하는 플래그를 사용하세요.

| 플래그 | 추가되는 것 |
|------|-------------|
| `--discuss` | 플래너 실행 전 모호한 영역을 표시하고 결정을 `CONTEXT.md`에 캡처하는 경량 사전 기획 논의 |
| `--research` | 집중된 리서치 에이전트가 기획 전에 접근법, 라이브러리, 함정을 조사함 |
| `--validate` | 플랜 체킹(최대 2회 반복) 및 실행 후 검증 |
| `--full` | 위의 모든 것 — `--discuss --research --validate`와 동일 |

플래그는 자유롭게 조합할 수 있습니다:

```bash
/gsd-quick --research --validate   # 리서치 + 플랜 체킹 + 검증, 논의 없음
/gsd-quick --discuss               # 기획 전 모호한 영역만 표시
/gsd-quick --full                  # 전체 품질 파이프라인
```

### 플래그 추가 시기

- 작업에 어떻게 접근할지 또는 어떤 라이브러리를 사용할지 확실하지 않을 때 `--research` 추가
- 작업이 중요한 코드 경로를 터치하고 검증자 에이전트가 must-haves를 충족했는지 확인하기를 원할 때 `--validate` 추가
- 작업에 플래너 실행 전 확정하고 싶은 설계 선택이 있을 때 `--discuss` 추가(예: 올바른 오류 처리 동작이 명확하지 않을 때)
- 태스크가 실제로 중요하고 페이즈로 기획하겠지만 ROADMAP에 속하지 않을 때 `--full` 사용

### 빠른 작업 목록 및 재개

```bash
/gsd-quick list                    # 상태별 모든 빠른 작업 표시
/gsd-quick status my-task-slug     # 특정 작업 상태 표시
/gsd-quick resume my-task-slug     # 중단된 작업 재개
```

---

## `/gsd-fast` — 인라인 사소한 편집

`/gsd-fast`는 현재 컨텍스트에서 직접 작업을 수행합니다. 서브에이전트, `PLAN.md`, 리서치가 없습니다. 스스로 1분 이내에 할 수 있는 변경에만 적합합니다.

```bash
/gsd-fast "fix typo in README"
/gsd-fast "add .env to .gitignore"
```

설명을 생략하면 GSD가 묻습니다.

`/gsd-fast`는 진행 전에 작업이 실제로 사소한지 확인합니다. 범위가 너무 크다고 판단하면 중단하고 리디렉션합니다:

```text
This looks like it needs planning. Use /gsd-quick instead:
  /gsd-quick "your task description"
```

변경 후 `/gsd-fast`는 원자적으로 커밋하고, `.planning/STATE.md`에 `Quick Tasks Completed` 테이블이 있으면 행을 추가합니다.

---

## `/gsd-quick`이 `/gsd-fast`와 다른 점

| 기능 | `/gsd-fast` | `/gsd-quick` |
|------------|------------|--------------|
| 서브에이전트 플래너 | 없음 | 있음 |
| 서브에이전트 실행자 | 없음 | 있음 |
| 리서치 에이전트 | 없음 | 선택 사항 (`--research`) |
| 플랜 체킹 | 없음 | 선택 사항 (`--validate`) |
| 실행 후 검증 | 없음 | 선택 사항 (`--validate`) |
| 논의 단계 | 없음 | 선택 사항 (`--discuss`) |
| 워크트리 격리 | 없음 | 있음 (기본값) |
| 태스크당 원자적 커밋 | 단일 커밋 | 계획 태스크당 하나 |
| STATE.md 추적 | 테이블이 있으면 행 추가 | 항상 업데이트됨 |
| `.planning/quick/` 산출물 | 없음 | 있음 |

핵심 차이는 서브에이전트 격리입니다. `/gsd-quick`은 별도의 컨텍스트 창에서 새 플래너와 실행자를 실행하므로 작업이 적절히 기획되고 커밋이 태스크당 원자적이며 오케스트레이터가 결과를 검증할 수 있습니다. `/gsd-fast`는 현재 컨텍스트 창만 사용하며 이러한 것이 필요하지 않을 만큼 사소한 변경에 의도적으로 제한됩니다.

---

## 관련 문서

- [페이즈 루프](../explanation/the-phase-loop.md)
- [컨텍스트 엔지니어링](../explanation/context-engineering.md)
- [명령어 참조](../COMMANDS.md)
- [문서 목차](../README.md)
