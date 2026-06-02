# GSD-2에서 마이그레이션하는 방법

**목표:** 이전 GSD-2 프로젝트(`.gsd/` 디렉터리 레이아웃)를 GSD Core(`.planning/` 레이아웃)로 이전하고, 선택적으로 저장소에 있는 기존 ADR, PRD, 또는 스펙 문서를 새 계획 구조에 통합합니다.

**사전 조건:** GSD Core가 설치되어 있어야 합니다. GSD-2 프로젝트 디렉터리가 디스크에 있어야 합니다.

---

## 마이그레이션 대상 이해

GSD-2는 `.gsd/` 디렉터리를 계획 루트로 사용했습니다. GSD Core는 `.planning/`을 사용합니다. 마이그레이션은 이를 역전합니다: `.gsd/` 아티팩트를 읽고 모든 GSD Core 명령이 기대하는 표준 `.planning/` 구조로 작성합니다.

| GSD-2에 존재하는 것 | `/gsd-import --from-gsd2`가 생성하는 것 |
|----------------------|-----------------------------------------|
| `.gsd/PROJECT.md` | `.planning/PROJECT.md` |
| `.gsd/ROADMAP.md` | `.planning/ROADMAP.md` |
| `.gsd/STATE.md` | `.planning/STATE.md` |
| `.gsd/phases/` 디렉터리 | `.planning/phases/` 디렉터리 |
| 페이즈 `PLAN.md` 파일 | GSD Core `{NN}-{MM}-PLAN.md` 파일 (이름 변경 적용) |

충돌 감지는 파일이 작성되기 전에 실행됩니다. 대상 디렉터리에 이미 `PROJECT.md`가 있고 가져오는 콘텐츠와 모순되면 마이그레이션은 BLOCKER 게이트에서 중단하고 해결할 충돌 목록을 표시합니다.

---

## 마이그레이션 실행

### 현재 디렉터리 마이그레이션

```bash
/gsd-import --from-gsd2
```

GSD는 현재 작업 디렉터리의 `.gsd/`를 읽고 마이그레이션된 아티팩트를 `.planning/`에 작성합니다.

### 다른 경로에서 마이그레이션

```bash
/gsd-import --from-gsd2 --path ~/projects/old-project
```

GSD-2 프로젝트가 현재 작업 디렉터리가 아닌 경우 `--path`를 사용합니다.

---

## 충돌 해결

충돌 감지에서 블로커가 발견되면 — 예를 들어, 기존 `.planning/PROJECT.md`와 모순되는 GSD-2 기술 스택 선언 — 충돌 보고서를 출력하고 파일을 작성하지 않고 중단합니다.

보고서를 읽고 모순을 해결한 후(소스 문서 또는 기존 계획 아티팩트 편집), `/gsd-import --from-gsd2`를 다시 실행합니다. 마이그레이션은 완전히 통과될 때까지 안전하게 재실행할 수 있습니다.

---

## 외부 플랜 파일 가져오기

전체 GSD-2 프로젝트가 아닌 독립형 플랜 문서(팀 계획 문서, 마크다운 스펙, 내보낸 작업 목록)가 있는 경우 `--from`을 사용합니다:

```bash
/gsd-import --from /tmp/team-plan.md
```

GSD는 동일한 충돌 감지 패스를 수행하고, 콘텐츠를 GSD Core `PLAN.md` 형식으로 변환하며, 플랜 체커로 결과를 검증합니다. 검증 후 대상 파일명과 다음 단계가 표시됩니다.

---

## 기존 문서 통합

저장소에 이미 ADR(아키텍처 결정 기록), PRD, 또는 사양 문서가 있는 경우 마이그레이션 후 `/gsd-ingest-docs`를 사용하여 `.planning/` 구조에 합성합니다:

### 전체 저장소 스캔(모드 자동 감지)

```bash
/gsd-ingest-docs
```

`.planning/`이 이미 있는 경우(예: 방금 실행한 마이그레이션에서) GSD는 기본적으로 병합 모드를 사용합니다 — 기존 내용을 덮어쓰지 않고 가져온 문서와 함께 합성합니다.

### 특정 디렉터리로 범위 지정

```bash
/gsd-ingest-docs docs/
/gsd-ingest-docs docs/adr/
```

### 명시적 우선순위 매니페스트 사용

문서 유형이 혼합되거나 충돌 시 어떤 문서가 우선순위를 가질지 제어하고 싶을 때:

```bash
/gsd-ingest-docs --manifest ingest.yaml
```

매니페스트는 문서당 `{path, type, precedence?}`를 나열하는 YAML 파일입니다. 예상 형태는 [명령 참조](../COMMANDS.md)의 `--manifest` 플래그 설명을 참조하세요.

### 특정 모드 강제

```bash
/gsd-ingest-docs --mode merge     # 기존 .planning/에 병합
/gsd-ingest-docs --mode new       # 처음부터 부트스트랩 (덮어쓰기)
```

**출력:** `/gsd-ingest-docs`는 항상 세 가지 버킷(자동 해결, 경쟁 변형, 미해결 블로커)이 있는 `INGEST-CONFLICTS.md`를 생성합니다. 모든 인제스트 실행 후 이 파일을 검토하세요. LOCKED vs LOCKED ADR 모순에서만 하드 중단이 발생합니다. 다른 모든 것은 자동으로 버려지지 않고 검토를 위해 표시됩니다.

---

## 마이그레이션된 프로젝트 검증

마이그레이션과 문서 인제스트가 완료되면 프로젝트 상태가 일관성 있는지 확인합니다:

```bash
/gsd-health
/gsd-health --repair
```

`/gsd-health`는 `.planning/` 디렉터리 무결성을 확인하고 드리프트를 보고합니다. `--repair`는 복구 가능한 문제를 자동으로 수정합니다.

그다음 GSD Core가 프로젝트 상태를 읽을 수 있는지 확인합니다:

```bash
/gsd-progress
```

프로젝트가 깔끔하게 이전되었다면 현재 페이즈 상태와 권장 다음 단계가 표시됩니다. 여기서부터 표준 GSD Core 워크플로가 적용됩니다.

---

## 조건부 처리: 마이그레이션 대상과 아닌 것

| 상황 | 할 일 |
|-----------|-----------|
| `.gsd/`가 현재 디렉터리에 있음 | `/gsd-import --from-gsd2` 실행 (`--path` 불필요) |
| `.gsd/`가 다른 디렉터리에 있음 | `--path ~/projects/old-project` 사용 |
| 전체 GSD-2 프로젝트가 아닌 독립형 플랜 문서가 있음 | `/gsd-import --from /path/to/plan.md` 사용 |
| `docs/adr/`에 ADR이 있음 | 마이그레이션 후 `/gsd-ingest-docs docs/adr/` 실행 |
| ADR, PRD, 스펙이 혼합되어 있음 | 저장소 루트에서 `/gsd-ingest-docs` 실행; 자동으로 분류됨 |
| 충돌 감지가 블로커를 보고함 | 나열된 모순을 해결한 후 재실행; 모든 블로커가 해결될 때까지 파일이 작성되지 않음 |
| 마이그레이션 작동 여부 확인이 안 됨 | `/gsd-health`와 `/gsd-progress`를 실행하여 확인 |
| INGEST-CONFLICTS.md에 미해결 블로커가 나열됨 | 영향받는 문서가 계획에 통합되기 전에 수동 해결 필요 |

---

## 관련 문서

- [첫 번째 프로젝트](../tutorials/your-first-project.md)
- [명령 참조](../COMMANDS.md)
- [문서 인덱스](../README.md)
