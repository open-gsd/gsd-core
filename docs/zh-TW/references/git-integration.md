<overview>
GSD 框架的 Git 整合。
</overview>

<core_principle>

**提交結果，而非過程。**

git 日誌應該讀起來像是釋出內容的變更日誌，而不是規劃活動的日記。
</core_principle>

<commit_points>

| 事件 | 提交? | 原因 |
| ----------------------- | ------- | ------------------------------------------------ |
| BRIEF + ROADMAP 建立 | 是 | 專案初始化 |
| PLAN.md 建立 | 否 | 中間產物 - 與計劃完成一起提交 |
| RESEARCH.md 建立 | 否 | 中間產物 |
| DISCOVERY.md 建立 | 否 | 中間產物 |
| **任務完成** | 是 | 原子工作單元（每個任務 1 個提交） |
| **計劃完成** | 是 | 後設資料提交（SUMMARY + STATE + ROADMAP） |
| 交接建立 | 是 | WIP 狀態保留 |

</commit_points>

<git_check>

```bash
[ -d .git ] && echo "GIT_EXISTS" || echo "NO_GIT"
```

如果 NO_GIT：靜默執行 `git init`。GSD 專案總是有自己的倉庫。
</git_check>

<commit_formats>

<format name="initialization">
## 專案初始化（brief + roadmap 一起）

```
docs: initialize [project-name] ([N] phases)

[PROJECT.md 中的一句話描述]

Phases:
1. [phase-name]: [goal]
2. [phase-name]: [goal]
3. [phase-name]: [goal]
```

提交內容：

```bash
gsd-tools.cjs query commit "docs: initialize [project-name] ([N] phases)" --files .planning/
```

</format>

<format name="task-completion">
## 任務完成（計劃執行期間）

每個任務在完成後立即獲得自己的提交。

```
{type}({phase}-{plan}): {task-name}

- [關鍵變更 1]
- [關鍵變更 2]
- [關鍵變更 3]
```

**提交型別：**
- `feat` - 新功能/功能
- `fix` - Bug 修復
- `test` - 僅測試（TDD RED 階段）
- `refactor` - 程式碼清理（TDD REFACTOR 階段）
- `perf` - 效能改進
- `chore` - 依賴、配置、工具

**示例：**

```bash
# 標準任務
git add src/api/auth.ts src/types/user.ts
git commit -m "feat(08-02): create user registration endpoint

- POST /auth/register validates email and password
- Checks for duplicate users
- Returns JWT token on success
"

# TDD 任務 - RED 階段
git add src/__tests__/jwt.test.ts
git commit -m "test(07-02): add failing test for JWT generation

- Tests token contains user ID claim
- Tests token expires in 1 hour
- Tests signature verification
"

# TDD 任務 - GREEN 階段
git add src/utils/jwt.ts
git commit -m "feat(07-02): implement JWT generation

- Uses jose library for signing
- Includes user ID and expiry claims
- Signs with HS256 algorithm
"
```

</format>

<format name="plan-completion">
## 計劃完成（所有任務完成後）

所有任務提交後，最後一個後設資料提交捕獲計劃完成。

```
docs({phase}-{plan}): complete [plan-name] plan

Tasks completed: [N]/[N]
- [Task 1 name]
- [Task 2 name]
- [Task 3 name]

SUMMARY: .planning/phases/XX-name/{phase}-{plan}-SUMMARY.md
```

提交內容：

```bash
gsd-tools.cjs query commit "docs({phase}-{plan}): complete [plan-name] plan" --files .planning/phases/XX-name/{phase}-{plan}-PLAN.md .planning/phases/XX-name/{phase}-{plan}-SUMMARY.md .planning/STATE.md .planning/ROADMAP.md
```

**注意：** 程式碼檔案不包含 - 已按任務提交。

</format>

<format name="handoff">
## 交接（WIP）

```
wip: [phase-name] paused at task [X]/[Y]

Current: [task name]
[如果阻塞:] Blocked: [reason]
```

提交內容：

```bash
gsd-tools.cjs query commit "wip: [phase-name] paused at task [X]/[Y]" --files .planning/
```

</format>
</commit_formats>

<example_log>

**舊方法（每個計劃提交）：**
```
a7f2d1 feat(checkout): Stripe payments with webhook verification
3e9c4b feat(products): catalog with search, filters, and pagination
8a1b2c feat(auth): JWT with refresh rotation using jose
5c3d7e feat(foundation): Next.js 15 + Prisma + Tailwind scaffold
2f4a8d docs: initialize ecommerce-app (5 phases)
```

**新方法（每個任務提交）：**
```
# Phase 04 - Checkout
1a2b3c docs(04-01): complete checkout flow plan
4d5e6f feat(04-01): add webhook signature verification
7g8h9i feat(04-01): implement payment session creation
0j1k2l feat(04-01): create checkout page component

# Phase 03 - Products
3m4n5o docs(03-02): complete product listing plan
6p7q8r feat(03-02): add pagination controls
9s0t1u feat(03-02): implement search and filters
2v3w4x feat(03-01): create product catalog schema

# Phase 02 - Auth
5y6z7a docs(02-02): complete token refresh plan
8b9c0d feat(02-02): implement refresh token rotation
1e2f3g test(02-02): add failing test for token refresh
4h5i6j docs(02-01): complete JWT setup plan
7k8l9m feat(02-01): add JWT generation and validation
0n1o2p chore(02-01): install jose library

# Phase 01 - Foundation
3q4r5s docs(01-01): complete scaffold plan
6t7u8v feat(01-01): configure Tailwind and globals
9w0x1y feat(01-01): set up Prisma with database
2z3a4b feat(01-01): create Next.js 15 project

# Initialization
5c6d7e docs: initialize ecommerce-app (5 phases)
```

每個計劃產生 2-4 個提交（任務 + 後設資料）。清晰、細粒度、可 bisect。

</example_log>

<anti_patterns>

**仍不要提交（中間產物）：**
- PLAN.md 建立（與計劃完成一起提交）
- RESEARCH.md（中間產物）
- DISCOVERY.md（中間產物）
- 小的規劃調整
- "Fixed typo in roadmap"

**要提交（結果）：**
- 每個任務完成（feat/fix/test/refactor）
- 計劃完成後設資料（docs）
- 專案初始化（docs）

**關鍵原則：** 提交可工作的程式碼和已釋出的結果，而非規劃過程。

</anti_patterns>

<commit_strategy_rationale>

## 為什麼使用每任務提交？

**AI 上下文工程：**
- Git 歷史成為未來 Claude 會話的主要上下文源
- `git log --grep="{phase}-{plan}"` 顯示計劃的所有工作
- `git diff <hash>^..<hash>` 顯示每個任務的確切變更
- 減少對解析 SUMMARY.md 的依賴 = 更多上下文用於實際工作

**失敗恢復：**
- 任務 1 已提交 ✅，任務 2 失敗 ❌
- 下次會話中的 Claude：看到任務 1 完成，可以重試任務 2
- 可以 `git reset --hard` 到最後一個成功的任務

**除錯：**
- `git bisect` 找到確切的失敗任務，而不僅僅是失敗計劃
- `git blame` 將行追溯到特定任務上下文
- 每個提交獨立可回滾

**可觀察性：**
- 獨立開發者 + Claude 工作流受益於細粒度歸因
- 原子提交是 git 最佳實踐
- 當消費者是 Claude 而非人類時，"提交噪音"無關緊要

</commit_strategy_rationale>