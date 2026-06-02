# 복구 및 문제 해결 방법

**목표:** 조건부 레시피 구조를 사용하여 컨텍스트 손실과 손상된 상태부터 설치 실패와 권한 오류까지 일반적인 문제를 식별하고 수정합니다.

**사전 조건:** GSD Core가 설치되어 있어야 합니다. 설치 문제의 경우 [런타임에 설치](install-on-your-runtime.md)를 참조하세요.

---

## 컨텍스트 및 세션 문제

### 현재 위치를 파악하지 못한 경우

```bash
/gsd-progress
```

모든 상태 파일을 읽고 현재 위치와 다음 할 일을 정확히 알려줍니다.

올바른 다음 단계로 자동 진행하려면:

```bash
/gsd-progress --next
```

### 새 세션을 시작하고 컨텍스트를 복원해야 하는 경우

```bash
/gsd-resume-work
```

마지막 핸드오프의 전체 세션 컨텍스트(현재 페이즈, 계획 결정, 작업이 중단된 위치)를 복원합니다.

### 긴 세션 중 품질이 저하되는 경우

주요 명령 사이에 컨텍스트 창을 초기화합니다:

```bash
/clear
```

그다음 상태를 복원합니다:

```bash
/gsd-resume-work
```

GSD는 새로운 컨텍스트를 중심으로 설계되었습니다. 모든 서브에이전트는 이미 깨끗한 200k 창을 받습니다. 메인 세션은 시간이 지남에 따라 저하됩니다 — 초기화하고 재개하는 것이 올바른 해결책이며 계속 밀어붙이는 것이 아닙니다.

### 중단 전에 컨텍스트를 저장하고 싶은 경우

```bash
/gsd-pause-work
```

현재 위치가 있는 `.planning/HANDOFF.json`을 생성합니다. 세션 후 요약도 `.planning/reports/`에 작성하려면 `--report`를 추가합니다:

```bash
/gsd-pause-work --report
```

---

## 계획 무결성 문제

### `.planning/` 무결성이 불확실한 경우

```bash
/gsd-health
```

오류, 경고, 정보 메모에 걸쳐 상태를 보고합니다:

| 상태 | 의미 |
|--------|---------|
| `HEALTHY` | 모든 예상 아티팩트가 존재하고 올바른 형식 |
| `DEGRADED` | 처리해야 하지만 작업을 계속할 수 있는 경고 |
| `BROKEN` | 실행을 차단하는 심각한 오류 |

일반적인 자동 복구 가능한 문제(오류 E004, E005; 경고 W003, W008):

```bash
/gsd-health --repair
```

누락된 `STATE.md`를 재생성하고, 손상된 `config.json`을 기본값으로 재설정하며, 누락된 구성 키를 추가합니다. `PROJECT.md`나 `ROADMAP.md`를 덮어쓰지 않습니다.

### STATE.md가 존재하지 않는 페이즈를 참조하는 경우

이것은 경고 `W002`를 생성합니다. 상태 CLI를 사용하여 진단하고 복구합니다:

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state validate
```

쓰기 없이 동기화가 변경할 내용 미리 보기:

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync --verify
```

동기화 적용:

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync
```

이 명령들은 디스크의 실제 프로젝트 상태에서 `STATE.md`를 재구성합니다. 수동 `STATE.md` 편집을 대체합니다.

### "Project already initialised"가 표시되는 경우

`.planning/PROJECT.md`가 이미 있습니다. `/gsd-new-project`는 안전 확인입니다. 정말로 처음부터 다시 시작하고 싶다면 먼저 `.planning/` 디렉터리를 삭제합니다:

```bash
rm -rf .planning/
```

그다음 `/gsd-new-project`를 다시 실행합니다.

### 컨텍스트 창 사용률이 높은 경우

```bash
/gsd-health --context
```

컨텍스트 창 사용률 가드를 프로브합니다. 60%에서 경고, 70%에서 위험. 경고 임계값을 초과한 경우 다음 주요 명령을 시작하기 전에 `/clear`를 실행한 후 `/gsd-resume-work`를 실행합니다.

---

## 실행 문제

### 실행자가 Bash 명령에서 "Permission denied"를 받는 경우

GSD의 `gsd-executor` 서브에이전트는 쓰기 가능한 Bash 접근이 필요합니다. `~/.claude/settings.json`의 `permissions.allow` 아래에 필요한 패턴을 추가합니다. 최소한:

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git checkout:*)"
```

스택별 패턴(Rails, Python, Node, Rust)은 `docs/USER-GUIDE.md`의 "Executor Subagent Gets Permission denied" 섹션의 전체 표를 참조하세요.

프로젝트별 대안: 프로젝트 루트의 `.claude/settings.local.json`에 동일한 블록을 추가합니다.

### 실행이 실패하거나 스텁을 생성하는 경우

플랜이 너무 야심찬지 확인합니다. 플랜에는 최대 두세 개의 작업이 있어야 합니다. 작업이 너무 크면 단일 컨텍스트 창이 안정적으로 생성할 수 있는 것을 초과합니다. 더 작은 범위로 페이즈를 다시 계획합니다:

```bash
/gsd-plan-phase 1
```

무엇이 잘못되었는지에 대한 체계적인 진단은 [실패한 실행 디버그](debug-a-failed-execution.md)를 참조하세요.

### 병렬 실행이 빌드 잠금 오류 또는 사전 커밋 훅 실패를 일으키는 경우

이것은 여러 에이전트가 동시에 빌드 도구를 트리거하여 발생합니다. GSD는 v1.26 이후 이를 자동으로 처리합니다. 오래된 버전이거나 여전히 경합이 보이면 병렬 실행을 비활성화합니다:

```bash
/gsd-settings
```

`parallelization.enabled`를 `false`로 설정합니다.

### 서브에이전트가 실패한 것처럼 보이지만 커밋이 만들어진 경우

무언가가 고장났다고 결론 내리기 전에 git 로그를 확인합니다:

```bash
git log --oneline -10
```

알려진 Claude Code 분류 버그로 인해 작업이 성공했는데도 실패를 보고할 수 있습니다. GSD의 오케스트레이터는 실제 출력을 점검하지만 불일치가 보이면 커밋이 실제 근거입니다.

---

## 플랜 및 페이즈 문제

### 플랜이 의도와 맞지 않거나 잘못 정렬된 경우

계획 전에 `/gsd-discuss-phase N`을 실행합니다. 대부분의 플랜 품질 문제는 `CONTEXT.md`가 방지했을 가정에서 발생합니다:

```bash
/gsd-discuss-phase 1
```

전체 세션을 시작하지 않고 GSD가 현재 어떤 가정을 하는지 보려면:

```bash
/gsd-discuss-phase 3 --assumptions
```

### 실행 후 무언가를 변경해야 하는 경우

`/gsd-execute-phase`를 다시 실행하지 마세요. 대상이 되는 수정에는 `/gsd-quick`을 사용합니다:

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

또는 `/gsd-verify-work N`을 사용하여 UAT를 통해 체계적으로 문제를 식별하고 수정합니다.

### 명령이 "Spawning…"에서 멈춘 것처럼 보이는 경우

기다리세요. GSD 서브에이전트는 별도의 컨텍스트 창에서 실행됩니다. 진행 중일 때는 상위 세션에서 보이지 않습니다. 스폰 라인의 활성 상태 메모가 이것이 예상된 동작임을 확인합니다. 연구 및 계획 에이전트는 일상적으로 1~5분이 걸립니다. 검증 에이전트는 대규모 페이즈에서 더 오래 걸릴 수 있습니다.

세션을 중단하지 마세요. 종료하면 진행 중인 서브에이전트 작업이 버려집니다.

10분 이상 지난 경우 Claude Code 사이드바에서 에이전트 작업이 여전히 활성으로 표시되는지 확인합니다.

---

## 워크플로 상태 문제

### 워크플로가 손상되거나 상태가 일관성이 없어 보이는 경우

```bash
/gsd-forensics
```

또는 설명과 함께:

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

`/gsd-forensics`는 사후 분석 조사를 실행합니다: git 히스토리 이상 감지, 아티팩트 무결성, STATE.md 일관성, 커밋되지 않은 작업, 고아 워크트리. `.planning/forensics/`에 보고서를 작성하고 권장 복구 단계를 제시합니다. 읽기 전용이며 프로젝트 파일을 절대 수정하지 않습니다.

### 페이즈 또는 플랜을 롤백해야 하는 경우

```bash
/gsd-undo --phase 03          # 페이즈 3의 모든 커밋 롤백
/gsd-undo --plan 03-02        # 페이즈 3의 플랜 02 커밋 롤백
/gsd-undo --last 5            # 가장 최근 GSD 커밋 5개에서 대화식으로 선택
```

`/gsd-undo`는 되돌리기 전에 종속 페이즈를 확인하고 항상 확인 게이트를 표시합니다.

---

## 설치 및 업데이트 문제

### 설치 후 GSD가 인식되지 않는 경우

런타임을 재시작합니다. GSD는 런타임의 명령 디렉터리(예: `~/.claude/commands/gsd/`)에 슬래시 명령을 설치합니다. 대부분의 런타임은 시작 시에만 새 명령을 발견합니다.

문제가 지속되면 설치를 확인합니다:

```bash
npx @opengsd/gsd-core@latest --claude --local
```

런타임별 설치 경로와 문제 해결은 [런타임에 설치](install-on-your-runtime.md)를 참조하세요.

### 업데이트가 로컬 변경 사항을 덮어쓴 경우

v1.17 이후 인스톨러는 로컬에서 수정된 파일을 `gsd-local-patches/`에 백업합니다. 변경 사항을 재적용합니다:

```bash
/gsd-update --reapply
```

### npm을 통한 업데이트가 불가능한 경우

npm 중단이나 네트워크 제한으로 `npx @opengsd/gsd-core`가 실패하는 경우 npm 접근 없이도 작동하는 단계별 수동 업데이트 절차는 `docs/manual-update.md`를 참조하세요.

일상적인 업데이트는 [GSD 업데이트](update-gsd.md)를 참조하세요.

---

## 비용 문제

### 모델 비용이 너무 높은 경우

예산 프로필로 전환합니다:

```bash
/gsd-config --profile budget
```

도메인이 익숙한 경우 설정에서 연구 및 플랜 체크 에이전트를 비활성화합니다:

```bash
/gsd-settings
```

활성화된 MCP 서버도 감사합니다. 활성화된 모든 MCP 서버는 모든 턴에 도구 스키마를 주입합니다. 브라우저 및 플랫폼별 도구는 각각 20k+ 토큰이 소요될 수 있습니다. 현재 페이즈에 필요하지 않은 것은 `.claude/settings.json`에서 비활성화합니다:

```json
{
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

---

## 복구 빠른 참조

| 문제 | 해결책 |
|---------|---------|
| 컨텍스트 손실 또는 새 세션 | `/gsd-resume-work` 또는 `/gsd-progress` |
| 다음 단계를 모름 | `/gsd-progress --next` |
| 페이즈가 잘못됨 | `/gsd-undo --phase NN`, 그다음 다시 계획 |
| 무언가 고장남 | `/gsd-debug "description"` (수정 없이 분석만 하려면 `--diagnose` 추가) |
| STATE.md 동기화 오류 | `state validate` 후 `state sync` |
| `.planning/` 무결성 불확실 | `/gsd-health`, 그다음 `/gsd-health --repair` |
| 워크플로 상태 손상 | `/gsd-forensics` |
| 빠른 대상 수정 | `/gsd-quick` |
| 플랜이 비전과 맞지 않음 | `/gsd-discuss-phase N` 후 다시 계획 |
| 비용이 높아짐 | `/gsd-config --profile budget` 및 `/gsd-settings`에서 에이전트 끄기 |
| 업데이트가 로컬 변경 사항 손상 | `/gsd-update --reapply` |
| 세션 요약 원함 | `/gsd-pause-work --report` |
| 병렬 실행 빌드 오류 | GSD 업데이트 또는 `parallelization.enabled: false` 설정 |

---

## 관련 문서

- [실패한 실행 디버그](debug-a-failed-execution.md)
- [런타임에 설치](install-on-your-runtime.md)
- [명령 참조](../COMMANDS.md)
- [문서 인덱스](../README.md)
