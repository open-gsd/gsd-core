# Planning artifacts 참조

`.planning/` 디렉터리는 프로젝트를 위한 GSD Core의 공유 메모리입니다. 모든 워크플로가 여기서 읽고 쓰며, 감사 가능한 결정 추적 기록을 남깁니다. 이 페이지는 모든 파일, 그 목적, 그리고 어떤 명령이 생성하거나 소비하는지를 매핑합니다. [문서 인덱스](../../README.md)를 참조하세요.

---

## 디렉터리 구조

```
.planning/
├── PROJECT.md                          # 프로젝트 아이덴티티와 핵심 가치
├── ROADMAP.md                          # 마일스톤 + 목표가 있는 페이즈 목록
├── REQUIREMENTS.md                     # 번호가 매겨진 인수 기준
├── STATE.md                            # 살아있는 위치 추적기
├── config.json                         # 워크플로 및 모델 구성
├── MILESTONES.md                       # 마일스톤 아카이브 (선택)
├── BACKLOG.md                          # 미뤄진 및 향후 작업 (선택)
├── LEARNINGS.md                        # 축적된 크로스 페이즈 학습 (선택)
├── DECISIONS-INDEX.md                  # 이전 결정의 롤링 요약 (선택)
├── METHODOLOGY.md                      # 재사용 가능한 해석 프레임워크 (선택)
├── HANDOFF.json                        # 기계가 읽을 수 있는 일시 정지 상태 (임시)
├── codebase/                           # 코드베이스 맵 (선택)
│   ├── architecture.md
│   ├── stack.md
│   └── ...
├── onboarding/                         # 브라운필드 온보딩 요약 (선택)
│   └── SUMMARY.md
├── intel/                              # 쿼리 가능한 심볼 인덱스 (선택, intel.enabled)
│   └── API-SURFACE.md
└── phases/
    └── <NN>-<slug>/                    # 페이즈당 하나의 디렉터리
        ├── <NN>-CONTEXT.md             # 구현 결정 (discuss-phase)
        ├── <NN>-DISCUSSION-LOG.md      # 사람이 읽을 수 있는 토론 감사 (discuss-phase)
        ├── <NN>-RESEARCH.md            # 기술 리서치 결과 (plan-phase)
        ├── <NN>-VALIDATION.md          # Nyquist 테스트 커버리지 전략 (plan-phase)
        ├── <NN>-PATTERNS.md            # 코드베이스 유사 맵 (plan-phase, 선택)
        ├── <NN>-<PP>-PLAN.md           # 실행 가능한 플랜 (plan-phase, 플랜당 하나)
        ├── <NN>-<PP>-SUMMARY.md        # 실행 기록 (execute-phase, 플랜당 하나)
        ├── <NN>-VERIFICATION.md        # 페이즈 목표 검증 보고서 (verify-phase)
        ├── <NN>-UAT.md                 # 지속적인 UAT 세션 상태 (execute-phase)
        └── .continue-here.md           # 일시 정지 후 재개 지침 (pause-work)
```

---

## 루트 수준 아티팩트

### `PROJECT.md`

| | |
|---|---|
| **목적** | 표준 프로젝트 아이덴티티: 무엇인지, 누구를 위한 것인지, 핵심 가치, 요구사항, 제약 사항, 주요 결정. 제품이 발전함에 따라 프로젝트 생명주기 전반에 걸쳐 업데이트됩니다. |
| **생성자** | `/gsd-new-project` (최초 생성, `/gsd-onboard` handoff 포함); 결정이 검증됨에 따라 `/gsd-complete-milestone`에 의해 업데이트됩니다. |
| **소비자** | 모든 플래닝 워크플로; `gsd-phase-researcher`, `gsd-planner` (컨텍스트); `discuss-phase` (이전 결정); `gsd-plan-checker` (프로젝트 제약 사항). |

### `ROADMAP.md`

| | |
|---|---|
| **목적** | 목표, 요구사항 ID, 성공 기준, 페이즈별 표준 참조가 있는 마일스톤 및 페이즈 목록. 프로젝트가 무엇을 빌드하고 어떤 순서로 하는지에 대한 단일 진실의 원천. |
| **생성자** | `/gsd-new-project` (최초 생성, `/gsd-onboard` handoff 포함); `/gsd-phase --insert`와 `/gsd-complete-milestone`에 의해 업데이트됩니다. |
| **소비자** | `/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-execute-phase`; 페이즈 정보가 필요한 모든 오케스트레이션 명령; `gsd-planner`, `gsd-plan-checker`, `gsd-phase-researcher`. |

### `REQUIREMENTS.md`

| | |
|---|---|
| **목적** | 프로젝트의 번호가 매겨진 체크 가능한 인수 기준. 각 요구사항은 로드맵 페이즈에 매핑되는 ID(예: `AUTH-01`)를 가집니다. 페이즈가 실행됨에 따라 요구사항을 완료로 표시합니다. |
| **생성자** | `/gsd-new-project` (최초 생성, `/gsd-onboard` handoff 포함); `execute-phase`에 의해 요구사항이 완료로 표시됩니다. |
| **소비자** | `gsd-planner` (플랜은 모든 페이즈 요구사항 ID를 처리해야 함); `gsd-plan-checker` Dimension 1 (요구사항 커버리지); `discuss-phase` (이전 요구사항). |

### `STATE.md`

| | |
|---|---|
| **목적** | 살아있는 위치 추적기 — 현재 페이즈와 플랜, 진행 지표, 누적된 결정, 세션 연속성 노트. 모든 워크플로 실행 시작 시 읽힙니다. 중요한 작업 이후 업데이트됩니다. |
| **생성자** | `/gsd-new-project` (최초 생성, `/gsd-onboard` handoff 포함); 모든 페이즈 워크플로, `/gsd-pause-work`, `/gsd-resume-work`에 의해 지속적으로 업데이트됩니다. |
| **소비자** | 모든 오케스트레이션 워크플로; `/gsd-progress`; `/gsd-quick`을 통한 임시 태스크 실행; `gsd-planner` 및 `gsd-phase-researcher` (프로젝트 결정). |

전체 필드 참조는 [STATE.md 스키마](state-md.md)를 참조하세요.

### `config.json`

| | |
|---|---|
| **목적** | 워크플로 구성: 모델 프로파일, 리서치 및 플랜 체커 토글, git 브랜칭 전략, Nyquist 검증, 병렬화 설정, 에이전트별 모델 오버라이드. |
| **생성자** | `/gsd-new-project` (최초 생성); `/gsd-settings` (대화형 편집). |
| **소비자** | 모든 워크플로 및 서브에이전트 — `gsd-tools query config-get`을 통해 초기화 시점에 읽습니다. |

전체 스키마는 [CONFIGURATION](../../CONFIGURATION.md)을 참조하세요.

### `onboarding/SUMMARY.md` (선택)

| | |
|---|---|
| **목적** | 브라운필드 온보딩 인덱스. 아티팩트 상태, 코드베이스 매핑 완료 여부, 초기 설정 후 권장되는 다음 GSD 명령을 기록합니다. |
| **생성자** | `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`가 모두 존재한 뒤 `/gsd-onboard`. |
| **소비자** | 초기 설정을 검토하는 사람; 기존 온보딩 상태를 확인하는 향후 `/gsd-onboard` 실행. |

### `MILESTONES.md` (선택)

| | |
|---|---|
| **목적** | 완료된 마일스톤의 역사적 기록. 각 마일스톤이 종료될 때 채워지며, 무엇이 언제 출시되었는지의 아카이브 스냅샷을 제공합니다. |
| **생성자** | `/gsd-complete-milestone`. |
| **소비자** | `/gsd-audit-milestone`; 인간 검토. |

### `DECISIONS-INDEX.md` (선택)

| | |
|---|---|
| **목적** | 이전 페이즈 CONTEXT.md 파일에서 캡처된 결정의 경계가 있는 롤링 요약. 있는 경우, `discuss-phase`는 최대 세 개의 이전 CONTEXT.md 파일을 개별적으로 읽는 대신 이 단일 파일을 읽어 컨텍스트 예산을 절약합니다. |
| **생성자** | 이전 페이즈 수가 롤링 읽기 임계값을 초과할 때 생성됩니다. |
| **소비자** | `discuss-phase` (`load_prior_context` 단계). |

### `HANDOFF.json` (임시)

| | |
|---|---|
| **목적** | 작업이 중단될 때 기록되는 기계가 읽을 수 있는 일시 정지 상태. 재개 지점, 진행 중인 컨텍스트, 연속 지침을 포함합니다. 정확히 한 번 소비됩니다 — 재개 시. |
| **생성자** | `/gsd-pause-work`. |
| **소비자** | `/gsd-resume-work`. |

---

## 페이즈별 아티팩트

모든 페이즈별 파일은 `.planning/phases/<NN>-<slug>/` 아래에 있으며, 여기서 `NN`은 제로 패딩된 페이즈 번호이고 `slug`는 하이픈으로 연결된 페이즈 이름입니다.

### `<NN>-CONTEXT.md`

| | |
|---|---|
| **목적** | 플래닝 시작 전에 캡처된 구현 결정. 페이즈 경계(`<domain>`), `D-NN` 식별자가 있는 잠긴 결정(`<decisions>`), 표준 문서 참조(`<canonical_refs>`), 기존 코드 인사이트(`<code_context>`), 특정 영감(`<specifics>`), 미뤄진 아이디어(`<deferred>`)를 포함합니다. |
| **생성자** | `/gsd-discuss-phase` (대화형 토론 또는 PRD/ADR 익스프레스 경로). |
| **소비자** | `gsd-phase-researcher` (무엇을 조사할지); `gsd-planner` (잠긴 결정); `gsd-plan-checker` Dimension 7 (컨텍스트 준수). |

전체 필드 참조는 [CONTEXT.md 스키마](context-md.md)를 참조하세요.

### `<NN>-DISCUSSION-LOG.md`

| | |
|---|---|
| **목적** | discuss-phase 세션의 사람이 읽을 수 있는 감사 추적: 논의된 영역, 제시된 옵션, 선택된 항목, 미뤄진 아이디어, Claude의 재량에 맡겨진 항목. 자동화된 워크플로에서 소비되지 않습니다. |
| **생성자** | `/gsd-discuss-phase` (`git_commit` 단계). |
| **소비자** | 인간 검토; 회고. |

### `<NN>-RESEARCH.md`

| | |
|---|---|
| **목적** | 플래닝 전에 생성된 기술 리서치 결과. "이 페이즈를 잘 계획하기 위해 무엇을 알아야 하는가?"에 답합니다 — 도메인 분석, 패턴, 위험, 아키텍처 책임 맵, 검증 아키텍처 섹션(Nyquist 게이트에서 사용)을 포함합니다. |
| **생성자** | `/gsd-plan-phase` (via `gsd-phase-researcher` 에이전트). |
| **소비자** | `gsd-planner` (플래닝 입력); `gsd-plan-checker` Dimension 7c (계층 준수), Dimension 8 (Nyquist), Dimension 11 (리서치 해결); `gsd-pattern-mapper` (파일 목록 소스). |

### `<NN>-VALIDATION.md`

| | |
|---|---|
| **목적** | RESEARCH.md의 `## Validation Architecture` 섹션에서 도출된 Nyquist 영감 검증 전략. 플랜이 지켜야 하는 자동화된 테스트 커버리지 요구사항을 지정합니다. |
| **생성자** | `/gsd-plan-phase` (Step 5.5, `workflow.nyquist_validation`이 활성화되고 RESEARCH.md에 Validation Architecture 섹션이 있는 경우). |
| **소비자** | `gsd-plan-checker` Dimension 8 (Check 8e 게이트 — Nyquist 확인이 진행되기 전에 반드시 존재해야 함); `gsd-verifier`. |

### `<NN>-PATTERNS.md`

| | |
|---|---|
| **목적** | `gsd-pattern-mapper`가 생성한 코드베이스 유사 맵. 이 페이즈에서 생성하거나 수정할 각 파일에 대해, 가장 가까운 기존 유사 파일을 식별하고, 파일의 역할과 데이터 흐름을 분류하며, 구체적인 코드 발췌를 추출합니다. 플래너가 일관된 패턴을 사용하도록 안내합니다. |
| **생성자** | `/gsd-plan-phase` (via `gsd-pattern-mapper` 에이전트, 선택; `workflow.pattern_mapper: false`이면 건너뜀). |
| **소비자** | `gsd-planner` (패턴 안내); `gsd-plan-checker` Dimension 12 (패턴 준수). |

### `<NN>-<PP>-PLAN.md`

| | |
|---|---|
| **목적** | 페이즈 내 단일 작업 단위에 대한 실행 가능한 플랜. YAML 프론트매터(웨이브, 의존성, 파일, 요구사항, `must_haves`), 목표, 컨텍스트 참조, `<read_first>`, `<action>`, `<verify>`, `<acceptance_criteria>` 필드가 있는 XML 구조의 태스크, 검증 기준을 포함합니다. |
| **생성자** | `/gsd-plan-phase` (via `gsd-planner` 에이전트). 플랜당 하나의 파일 — 예: `03-02-PLAN.md`는 Phase 3, Plan 2. |
| **소비자** | `/gsd-execute-phase` (실행기 에이전트가 플랜을 읽고 태스크를 실행); `gsd-plan-checker` (실행 전 품질 검토); `gsd-verifier` (실행 후 검증을 위해 `must_haves`를 읽음). |

전체 필드 참조는 [PLAN.md 스키마](plan-md.md)를 참조하세요.

### `<NN>-<PP>-SUMMARY.md`

| | |
|---|---|
| **목적** | 플랜이 완료된 후 기록된 실행 기록. 빌드된 내용, 플랜과의 편차, 인수 기준에 대한 자가 점검, 페이즈의 의존성 그래프를 문서화합니다. |
| **생성자** | `execute-phase` 실행기 에이전트 (각 플랜 실행 종료 시 기록). |
| **소비자** | `/gsd-progress` (페이즈 상태); `gsd-planner` (후속 플랜이 이전 플랜 출력에 대한 실질적인 의존성이 있는 경우); `milestone-summary`. |

### `<NN>-VERIFICATION.md`

| | |
|---|---|
| **목적** | 페이즈 목표 검증 보고서. 실행 후 모든 플랜의 `must_haves.truths`, `must_haves.artifacts`, `must_haves.key_links`를 실제 코드베이스에 대해 확인합니다. `status: passed | gaps_found | human_needed`를 기록합니다. |
| **생성자** | `/gsd-verify-work` (또는 `/gsd-execute-phase` 내의 verify 단계). |
| **소비자** | `plan-phase` 종료된 페이즈 게이트(`status: passed`인 VERIFICATION.md는 페이즈를 `Complete`로 표시하고 `--force` 없이 재플래닝을 차단함); `/gsd-progress`; 인간 검토. |

### `<NN>-UAT.md`

| | |
|---|---|
| **목적** | 지속적인 UAT 세션 추적. 라이브 UAT 세션 전반에 걸쳐 각 테스트 케이스, 예상 관찰 가능한 동작, 결과, 개발자 응답을 기록합니다. YAML 프론트매터(`status`, `phase`, `source`, 타임스탬프)를 가집니다. |
| **생성자** | `/gsd-audit-uat` (대화형 UAT 세션). |
| **소비자** | `/gsd-audit-uat` (이전 UAT 세션 재개). |

### `.continue-here.md`

| | |
|---|---|
| **목적** | 페이즈 작업이 일시 정지될 때 기록되는 사람이 읽을 수 있는 재개 지침. 재개 에이전트를 위한 컨텍스트를 포함합니다: 중요한 안티패턴, 차단 이슈, 필수 읽기, 재개를 위한 정확한 명령. |
| **생성자** | `/gsd-pause-work`. |
| **소비자** | 페이즈에서 시작하는 모든 워크플로 — `discuss-phase`와 `plan-phase` 모두 진입 시 이 파일을 확인하고, 진행하기 전에 에이전트가 `blocking` 안티패턴을 이해했음을 입증하도록 요구합니다. |

---

## 명명 규칙

| 세그먼트 | 형식 | 예시 |
|---|---|---|
| 페이즈 디렉터리 | `<NN>-<slug>` | `03-post-feed` |
| 페이즈 수준 파일 | `<NN>-<ARTIFACT>.md` | `03-CONTEXT.md` |
| 플랜 수준 파일 | `<NN>-<PP>-<ARTIFACT>.md` | `03-02-PLAN.md` |
| `NN` | 제로 패딩된 페이즈 번호 | Phase 3의 경우 `03` |
| `PP` | 페이즈 내 제로 패딩된 플랜 번호 | Plan 2의 경우 `02` |

`config.json`에 `project_code`가 설정된 경우, 페이즈 디렉터리는 프로젝트 코드를 접두사로 사용합니다: 프로젝트 코드 `CK`, Phase 3의 경우 `CK-03-post-feed`.

---

## Related

- [STATE.md 스키마](state-md.md)
- [CONTEXT.md 스키마](context-md.md)
- [PLAN.md 스키마](plan-md.md)
- [docs index](../../README.md)
