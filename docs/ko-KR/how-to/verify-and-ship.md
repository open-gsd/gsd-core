# 페이즈를 검증하고 배포하는 방법

**목표:** 실행된 작업에 대해 사용자 인수 테스트를 진행하고, 실패를 진단하여 수정하고, 자동 생성된 본문으로 풀 리퀘스트를 엽니다.

**전제 조건:** 페이즈가 실행되고 `SUMMARY.md` 파일이 존재해야 합니다. 실행이 아직 완료되지 않았다면 [페이즈 실행](execute-a-phase.md)을 참고하세요.

---

## 사용자 인수 테스트 실행

```bash
/gsd-verify-work 1
```

GSD는 페이즈의 `SUMMARY.md` 파일을 읽고, 사용자가 관찰 가능한 결과물을 추출하여 하나씩 안내합니다. 각 체크포인트에서 *예상되는 것*을 제시하고 실제와 일치하는지 묻습니다.

- `yes` / `y` / 빈 값 → 통과, 다음 테스트로 이동
- 그 외 → 문제로 기록됨, 설명에서 심각도 추론

심각도를 직접 분류할 필요가 없습니다. GSD가 표현에서 추론합니다("충돌" → 차단, "작동 안 함" → 주요, "이상해 보임" → 외관상).

진행 상황은 `.planning/phases/01-<name>/01-UAT.md`에 기록되며 `/clear`에서도 유지됩니다. 세션이 중단된 경우 `/gsd-verify-work 1`을 다시 실행하면 GSD가 마지막 체크포인트에서 재개할 것을 제안합니다.

---

## 실패 발견 시: 자동 진단 및 수정 기획

테스트에서 문제가 발견되면 GSD는 자동으로 진행합니다:

1. **근본 원인 진단** — 문제당 하나씩 병렬 디버그 에이전트를 실행하고 근본 원인으로 `UAT.md`를 업데이트합니다.
2. **갭 해소 기획** — 갭 해소 모드에서 `gsd-planner`를 실행하며, 진단이 포함된 `UAT.md`를 읽고 새 `PLAN.md` 파일을 작성합니다.
3. **수정 계획 검증** — `gsd-plan-checker`를 실행하여 계획이 실행 가능한지 확인합니다. 문제가 발견되면 플래너와 체커가 최대 3회 반복합니다.
4. **다음 단계 제시** — 계획이 체커를 통과하면:

```
Plans verified and ready for execution.

`/clear` then `/gsd-execute-phase 1 --gaps-only`
```

제안된 명령을 실행하여 수정을 적용한 후, `/gsd-verify-work 1`을 다시 실행하여 모든 것이 통과하는지 확인하세요.

---

## 모든 테스트 통과 시: 페이즈 배포

모든 UAT 테스트가 통과하면(또는 첫 번째 실행에서 문제가 발견되지 않으면) 페이즈는 `ROADMAP.md`와 `STATE.md`에서 자동으로 완료로 표시됩니다.

```bash
/gsd-ship 1
```

GSD는 사전 점검(검증 상태, 깨끗한 작업 트리, 브랜치, 원격 저장소, `gh` CLI 인증)을 실행하고 브랜치를 푸시한 후 PR을 생성합니다:

```bash
/gsd-ship 1          # 검토 준비된 PR
/gsd-ship 1 --draft  # 초안 PR — 더 많은 페이즈가 뒤따를 때 유용
```

PR 본문은 기획 산출물에서 자동으로 조합됩니다:

- `ROADMAP.md`의 페이즈 목표
- `SUMMARY.md` 파일 및 핵심 파일의 계획별 요약
- 처리된 요구 사항 (REQ-ID)
- `VERIFICATION.md`의 검증 상태
- `STATE.md`의 핵심 결정 사항

본문을 수동으로 작성할 필요가 없습니다.

---

## 선택 사항: 배포 전후 코드 리뷰

`/gsd-ship`은 자동으로 코드 리뷰를 실행하지 않지만, 언제든지 추가할 수 있습니다:

**검증 전** (UAT 전에 문제 발견):

```bash
/gsd-code-review 1          # 표준 리뷰
/gsd-code-review 1 --fix    # 리뷰 후 Critical + Warning 발견 사항 자동 수정
```

**PR 오픈 후** (병합 전 품질 게이팅):

```bash
/gsd-code-review 1 --depth=deep  # 임포트 그래프를 포함한 파일 간 분석
```

주기 초반의 계획 리뷰를 위해 Gemini, Codex 또는 다른 리뷰어를 설정하려면 [크로스 AI 리뷰 설정](set-up-cross-ai-review.md)을 참고하세요.

---

## 선택 사항: 깔끔한 PR 브랜치 생성

브랜치에 리뷰어에게 보여주고 싶지 않은 `.planning/` 커밋이 포함된 경우:

```bash
/gsd-pr-branch          # main에 대해 필터링
/gsd-pr-branch develop  # develop에 대해 필터링
```

`/gsd-pr-branch`는 코드 변경 사항만 포함된 새 브랜치를 생성합니다. 기획 산출물 커밋은 제외됩니다. 팀의 리뷰 정책에서 기획 노이즈를 제외하는 경우 `/gsd-ship` 전에 실행하세요.

---

## 마일스톤 종료

이것이 마일스톤의 마지막 페이즈였다면 마일스톤 감사를 실행하고 보관하세요:

```bash
/gsd-audit-milestone      # 모든 요구 사항이 배포되었는지 확인
/gsd-complete-milestone   # 보관, git 태그 생성
```

`/gsd-complete-milestone`은 PR이 병합된 후의 자연스러운 다음 단계입니다. 검증과 배포가 전체 프로젝트 생애주기에 어떻게 적합한지는 [페이즈 루프](../explanation/the-phase-loop.md)를 참고하세요.

---

## 관련 문서

- [페이즈 실행](execute-a-phase.md)
- [크로스 AI 리뷰 설정](set-up-cross-ai-review.md)
- [페이즈 루프](../explanation/the-phase-loop.md)
- [명령어 참조](../COMMANDS.md)
