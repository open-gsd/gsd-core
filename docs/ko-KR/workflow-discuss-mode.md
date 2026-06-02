# 논의 모드: 가정 vs 인터뷰

GSD Core의 discuss-phase는 계획 전에 구현 컨텍스트를 수집하기 위한 두 가지 모드를 제공한다. 각 모드를 언제 사용해야 하는지 이해하면 더 적은 주고받음으로 확인된 `CONTEXT.md`에 도달할 수 있다.

두 모드 중 하나를 실행하는 단계별 지침은 [단계 논의하기 how-to](how-to/discuss-a-phase.md)를 참조하라.

## 모드

### `discuss` (기본값)

원래의 인터뷰 스타일 흐름. Claude가 단계의 회색 영역을 식별하고 선택을 위해 표시한 다음 영역당 약 네 가지 질문을 한다. 다음 경우에 적합하다:

- 코드베이스가 새로운 초반 단계
- 사용자가 사전에 표현하고 싶은 강한 의견이 있는 단계
- 가이드된 대화식 컨텍스트 수집을 선호하는 사용자

### `assumptions`

코드베이스 우선 흐름. Claude가 서브에이전트를 통해 코드베이스를 깊이 분석하고(관련 파일 5-15개 읽기), 증거를 바탕으로 가정을 형성하며, 확인 또는 수정을 위해 표시한다. 다음 경우에 적합하다:

- 명확한 패턴을 가진 기존 코드베이스
- 인터뷰 질문들이 당연하게 느껴지는 사용자
- 더 빠른 컨텍스트 수집 (~2-4회 상호작용 vs ~15-20회)

## 설정

```bash
# assumptions 모드 활성화
node gsd-tools.cjs config-set workflow.discuss_mode assumptions

# 인터뷰 모드로 전환
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

설정은 프로젝트별이다(`.planning/config.json`에 저장). 두 모드 모두가 생성하는 파일의 전체 구조는 [CONTEXT.md 스키마](reference/context-md.md)를 참조하라.

## Assumptions 모드 작동 방식

1. **초기화** — discuss 모드와 동일 (이전 컨텍스트 로드, 코드베이스 스카우트, 할 일 확인)
2. **깊이 분석** — 탐색 서브에이전트가 단계와 관련된 코드베이스 파일 5-15개를 읽음
3. **가정 표시** — 각 가정에 포함:
   - Claude가 무엇을 하고 왜 하는지 (파일 경로 인용)
   - 가정이 잘못된 경우 무엇이 잘못될 수 있는지
   - 신뢰도 수준 (Confident / Likely / Unclear)
4. **확인 또는 수정** — 사용자가 가정을 검토하고 변경이 필요한 것을 선택
5. **CONTEXT.md 작성** — discuss 모드와 동일한 출력 형식

## 플래그 호환성

| 플래그 | `discuss` 모드 | `assumptions` 모드 |
|------|----------------|-------------------|
| `--auto` | 추천 답변 자동 선택 | 확인 게이트 건너뜀, 불분명 항목 자동 해결 |
| `--batch` | 질문을 배치로 그룹화 | 해당 없음 (수정 사항이 이미 배치 처리됨) |
| `--text` | 텍스트 형식 질문 (원격 세션) | 텍스트 형식 질문 (원격 세션) |
| `--analyze` | 질문당 트레이드오프 테이블 표시 | 해당 없음 (가정에 증거 포함) |

## 출력

두 모드 모두 동일한 여섯 섹션을 가진 동일한 `CONTEXT.md`를 생성한다:

- `<domain>` — 단계 경계
- `<decisions>` — 확정된 구현 결정 사항
- `<canonical_refs>` — 하위 에이전트들이 읽어야 하는 사양/문서
- `<code_context>` — 재사용 가능한 자산, 패턴, 통합 포인트
- `<specifics>` — 사용자 참조 사항과 선호도
- `<deferred>` — 미래 단계를 위해 메모된 아이디어

하위 에이전트들(리서처, 플래너, 검사기)은 어느 모드가 생성했든 관계없이 이 파일을 동일하게 소비한다. 전체 필드 레퍼런스는 [CONTEXT.md 스키마](reference/context-md.md)를 참조하라.

## Related

- [단계 논의하기](how-to/discuss-a-phase.md) — 두 모드 중 하나로 `/gsd-discuss-phase`를 실행하는 단계별 how-to.
- [CONTEXT.md 스키마](reference/context-md.md) — 두 모드 모두가 생성하는 파일의 전체 필드 레퍼런스.
- [단계 루프](explanation/the-phase-loop.md) — 논의가 더 넓은 논의 → 계획 → 실행 → 검증 → 출시 사이클에서 어떻게 맞는지.
- [문서 인덱스](README.md) — GSD Core 문서의 전체 목차.
