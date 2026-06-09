# 檢查點

計劃自主執行。檢查點用於規範化需要人工驗證或決策的互動點。

**核心原則：** Claude 用 CLI/API 自動化一切。檢查點用於驗證和決策，而非手動工作。

**黃金法則：**
1. **如果 Claude 能執行，Claude 就執行** - 絕不讓使用者執行 CLI 命令、啟動伺服器或執行構建
2. **Claude 設定驗證環境** - 啟動開發伺服器、填充資料庫、配置環境變數
3. **使用者只做需要人工判斷的事** - 視覺檢查、UX 評估、"這個感覺對嗎？"
4. **金鑰來自使用者，自動化來自 Claude** - 詢問 API 金鑰，然後 Claude 通過 CLI 使用它們
5. **自動模式繞過驗證/決策檢查點** — 當 config 中 `workflow._auto_chain_active` 或 `workflow.auto_advance` 為 true 時：human-verify 自動批准，decision 自動選擇第一個選項，human-action 仍會停止（認證門控無法自動化）

## 檢查點型別

### checkpoint:human-verify（最常見 - 90%）

**何時使用：** Claude 完成自動化工作，人工確認其正常工作。

**用於：**
- 視覺 UI 檢查（佈局、樣式、響應式）
- 互動流程（點擊向導、測試使用者流程）
- 功能驗證（功能按預期工作）
- 音訊/影片播放品質
- 動畫流暢度
- 無障礙測試

**結構：**
```xml
<task type="checkpoint:human-verify" gate="blocking">
  <what-built>[Claude 自動化並部署/構建的內容]</what-built>
  <how-to-verify>
    [測試的確切步驟 - URL、命令、預期行為]
  </how-to-verify>
  <resume-signal>[如何繼續 - "approved"、"yes" 或描述問題]</resume-signal>
</task>
```

**示例：UI 元件（展示關鍵模式：Claude 在檢查點之前啟動伺服器）**
```xml
<task type="auto">
  <name>構建響應式儀表板佈局</name>
  <files>src/components/Dashboard.tsx, src/app/dashboard/page.tsx</files>
  <action>建立帶側邊欄、標題和內容區域的儀表板。使用 Tailwind 響應式類處理移動端。</action>
  <verify>npm run build 成功，無 TypeScript 錯誤</verify>
  <done>儀表板元件構建無錯誤</done>
</task>

<task type="auto">
  <name>啟動開發伺服器用於驗證</name>
  <action>在後臺執行 `npm run dev`，等待 "ready" 訊息，捕獲埠</action>
  <verify>curl http://localhost:3000 返回 200</verify>
  <done>開發伺服器運行於 http://localhost:3000</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>響應式儀表板佈局 - 開發伺服器運行於 http://localhost:3000</what-built>
  <how-to-verify>
    訪問 http://localhost:3000/dashboard 並驗證：
    1. 桌面端 (>1024px): 左側邊欄，右側內容，頂部標題
    2. 平板端 (768px): 側邊欄摺疊為漢堡選單
    3. 移動端 (375px): 單列布局，出現底部導航
    4. 任何尺寸無佈局偏移或水平滾動
  </how-to-verify>
  <resume-signal>輸入 "approved" 或描述佈局問題</resume-signal>
</task>
```

### checkpoint:decision（9%）

**何時使用：** 人工必須做出影響實現方向的選擇。

**用於：**
- 技術選型（哪個認證提供商、哪個資料庫）
- 架構決策（monorepo 還是獨立倉庫）
- 設計選擇（配色方案、佈局方式）
- 功能優先順序（構建哪個變體）
- 資料模型決策（模式結構）

**結構：**
```xml
<task type="checkpoint:decision" gate="blocking">
  <decision>[正在決策的內容]</decision>
  <context>[為什麼這個決策重要]</context>
  <options>
    <option id="option-a">
      <name>[選項名稱]</name>
      <pros>[好處]</pros>
      <cons>[權衡]</cons>
    </option>
    <option id="option-b">
      <name>[選項名稱]</name>
      <pros>[好處]</pros>
      <cons>[權衡]</cons>
    </option>
  </options>
  <resume-signal>[如何表明選擇]</resume-signal>
</task>
```

**示例：認證提供商選擇**
```xml
<task type="checkpoint:decision" gate="blocking">
  <decision>選擇認證提供商</decision>
  <context>
    應用需要使用者認證。三個可靠選項各有權衡。
  </context>
  <options>
    <option id="supabase">
      <name>Supabase Auth</name>
      <pros>與我們使用的 Supabase DB 內建整合，慷慨的免費額度，行級安全整合</pros>
      <cons>UI 定製性較差，繫結 Supabase 生態</cons>
    </option>
    <option id="clerk">
      <name>Clerk</name>
      <pros>精美的預構建 UI，最佳開發體驗，優秀文件</pros>
      <cons>10k MAU 後付費，供應商鎖定</cons>
    </option>
    <option id="nextauth">
      <name>NextAuth.js</name>
      <pros>免費，自託管，最大控制權，廣泛採用</pros>
      <cons>更多設定工作，需自行管理安全更新，UI 需自己構建</cons>
    </option>
  </options>
  <resume-signal>選擇：supabase、clerk 或 nextauth</resume-signal>
</task>
```

### checkpoint:human-action（1% - 罕見）

**何時使用：** 操作沒有 CLI/API 且需要僅人工互動，或者 Claude 在自動化過程中遇到認證門控。

**僅用於：**
- **認證門控** - Claude 嘗試了 CLI/API 但需要憑證（這不是失敗）
- 郵箱驗證連結（點選郵件）
- 簡訊兩步驗證碼（手機驗證）
- 人工賬戶審批（平臺需要人工稽核）
- 信用卡 3D Secure 流程（基於 Web 的支付授權）
- OAuth 應用審批（基於 Web 的審批）

**不要用於預定的手動工作：**
- 部署（使用 CLI - 如需要則認證門控）
- 建立 webhooks/資料庫（使用 API/CLI - 如需要則認證門控）
- 執行構建/測試（使用 Bash 工具）
- 建立檔案（使用 Write 工具）

**結構：**
```xml
<task type="checkpoint:human-action" gate="blocking">
  <action>[人工必須做什麼 - Claude 已完成所有可自動化的]</action>
  <instructions>
    [Claude 已自動化的內容]
    [需要人工操作的一件事]
  </instructions>
  <verification>[Claude 之後可以檢查的內容]</verification>
  <resume-signal>[如何繼續]</resume-signal>
</task>
```

**示例：認證門控（動態檢查點）**
```xml
<task type="auto">
  <name>部署到 Vercel</name>
  <files>.vercel/, vercel.json</files>
  <action>執行 `vercel --yes` 進行部署</action>
  <verify>vercel ls 顯示部署，curl 返回 200</verify>
</task>

<!-- 如果 vercel 返回 "Error: Not authenticated"，Claude 即時建立檢查點 -->

<task type="checkpoint:human-action" gate="blocking">
  <action>認證 Vercel CLI 以便我繼續部署</action>
  <instructions>
    我嘗試部署但收到認證錯誤。
    執行：vercel login
    這將開啟你的瀏覽器 - 完成認證流程。
  </instructions>
  <verification>vercel whoami 返回你的賬戶郵箱</verification>
  <resume-signal>認證完成後輸入 "done"</resume-signal>
</task>

<!-- 認證後，Claude 重試部署 -->

<task type="auto">
  <name>重試 Vercel 部署</name>
  <action>執行 `vercel --yes`（已認證）</action>
  <verify>vercel ls 顯示部署，curl 返回 200</verify>
</task>
```

**關鍵區別：** 認證門控是 Claude 遇到認證錯誤時動態建立的。不是預定的 — Claude 先自動化，只有在被阻止時才請求憑證。

## 執行協議

當 Claude 遇到 `type="checkpoint:*"` 時：

1. **立即停止** - 不繼續下一個任務
2. **清晰顯示檢查點** 使用下面的格式
3. **等待使用者響應** - 不幻想完成
4. **如可能則驗證** - 檢查檔案、執行測試、任何指定的內容
5. **恢復執行** - 僅在確認後繼續下一個任務

**對於 checkpoint:human-verify:**
```
╔═══════════════════════════════════════════════════════╗
║  CHECKPOINT: 需要驗證                                  ║
╚═══════════════════════════════════════════════════════╝

進度: 5/8 任務完成
任務: 響應式儀表板佈局

已構建: /dashboard 的響應式儀表板

如何驗證:
  1. 訪問: http://localhost:3000/dashboard
  2. 桌面端 (>1024px): 側邊欄可見，內容填充剩餘空間
  3. 平板端 (768px): 側邊欄摺疊為圖示
  4. 移動端 (375px): 側邊欄隱藏，出現漢堡選單

────────────────────────────────────────────────────────
→ 你的操作: 輸入 "approved" 或描述問題
────────────────────────────────────────────────────────
```

**對於 checkpoint:decision:**
```
╔═══════════════════════════════════════════════════════╗
║  CHECKPOINT: 需要決策                                  ║
╚═══════════════════════════════════════════════════════╝

進度: 2/6 任務完成
任務: 選擇認證提供商

決策: 我們應該使用哪個認證提供商？

上下文: 需要使用者認證。三個選項各有權衡。

選項:
  1. supabase - 與我們的資料庫內建整合，免費額度
     優點: 行級安全整合，慷慨的免費額度
     缺點: UI 定製性較差，生態鎖定

  2. clerk - 最佳 DX，10k 使用者後付費
     優點: 精美的預構建 UI，優秀文件
     缺點: 供應商鎖定，規模化時價格問題

  3. nextauth - 自託管，最大控制權
     優點: 免費，無供應商鎖定，廣泛採用
     缺點: 更多設定工作，自行 DIY 安全更新

────────────────────────────────────────────────────────
→ 你的操作: 選擇 supabase、clerk 或 nextauth
────────────────────────────────────────────────────────
```

## 認證門控

**認證門控 = Claude 嘗試了 CLI/API，收到認證錯誤。** 不是失敗 — 是需要人工輸入來解除阻止的門控。

**模式：** Claude 嘗試自動化 → 認證錯誤 → 建立 checkpoint:human-action → 使用者認證 → Claude 重試 → 繼續

**門控協議：**
1. 認識到這不是失敗 - 缺少認證是正常的
2. 停止當前任務 - 不要反覆重試
3. 動態建立 checkpoint:human-action
4. 提供確切的認證步驟
5. 驗證認證有效
6. 重試原始任務
7. 正常繼續

**關鍵區別：**
- 預定的檢查點："我需要你做 X"（錯誤 - Claude 應該自動化）
- 認證門控："我嘗試自動化 X 但需要憑證"（正確 - 解除自動化阻止）

## 自動化參考

**規則：** 如果有 CLI/API，Claude 就做。絕不讓人工執行可自動化的工作。

### 服務 CLI 參考

| 服務 | CLI/API | 關鍵命令 | 認證門控 |
|------|---------|----------|----------|
| Vercel | `vercel` | `--yes`, `env add`, `--prod`, `ls` | `vercel login` |
| Railway | `railway` | `init`, `up`, `variables set` | `railway login` |
| Fly | `fly` | `launch`, `deploy`, `secrets set` | `fly auth login` |
| Stripe | `stripe` + API | `listen`, `trigger`, API 呼叫 | .env 中的 API key |
| Supabase | `supabase` | `init`, `link`, `db push`, `gen types` | `supabase login` |
| Upstash | `upstash` | `redis create`, `redis get` | `upstash auth login` |
| PlanetScale | `pscale` | `database create`, `branch create` | `pscale auth login` |
| GitHub | `gh` | `repo create`, `pr create`, `secret set` | `gh auth login` |
| Node | `npm`/`pnpm` | `install`, `run build`, `test`, `run dev` | N/A |
| Xcode | `xcodebuild` | `-project`, `-scheme`, `build`, `test` | N/A |
| Convex | `npx convex` | `dev`, `deploy`, `env set`, `env get` | `npx convex login` |

### 環境變數自動化

**Env 檔案：** 使用 Write/Edit 工具。絕不讓使用者手動建立 .env。

**通過 CLI 的儀表板環境變數：**

| 平臺 | CLI 命令 | 示例 |
|------|----------|------|
| Convex | `npx convex env set` | `npx convex env set OPENAI_API_KEY sk-...` |
| Vercel | `vercel env add` | `vercel env add STRIPE_KEY production` |
| Railway | `railway variables set` | `railway variables set API_KEY=value` |
| Fly | `fly secrets set` | `fly secrets set DATABASE_URL=...` |
| Supabase | `supabase secrets set` | `supabase secrets set MY_SECRET=value` |

### 開發伺服器自動化

| 框架 | 啟動命令 | 就緒訊號 | 預設 URL |
|------|----------|----------|----------|
| Next.js | `npm run dev` | "Ready in" 或 "started server" | http://localhost:3000 |
| Vite | `npm run dev` | "ready in" | http://localhost:5173 |
| Convex | `npx convex dev` | "Convex functions ready" | N/A（僅後端）|
| Express | `npm start` | "listening on port" | http://localhost:3000 |
| Django | `python manage.py runserver` | "Starting development server" | http://localhost:8000 |

**伺服器生命週期：**
```bash
# 後臺執行，捕獲 PID
npm run dev &
DEV_SERVER_PID=$!

# 等待就緒（最多 30s）
timeout 30 bash -c 'until curl -s localhost:3000 > /dev/null 2>&1; do sleep 1; done'
```

**埠衝突：** 終止陳舊程序（`lsof -ti:3000 | xargs kill`）或使用備用埠（`--port 3001`）。

**伺服器保持執行** 直到檢查點結束。僅在計劃完成、切換到生產環境或埠需要用於不同服務時終止。

### CLI 安裝處理

| CLI | 自動安裝？ | 命令 |
|-----|------------|------|
| npm/pnpm/yarn | 否 - 詢問使用者 | 使用者選擇包管理器 |
| vercel | 是 | `npm i -g vercel` |
| gh (GitHub) | 是 | `brew install gh` (macOS) 或 `apt install gh` (Linux) |
| stripe | 是 | `npm i -g stripe` |
| supabase | 是 | `npm i -g supabase` |
| convex | 否 - 使用 npx | `npx convex`（無需安裝）|
| fly | 是 | `brew install flyctl` 或 curl 安裝器 |
| railway | 是 | `npm i -g @railway/cli` |

**協議：** 嘗試命令 → "command not found" → 可自動安裝？→ 是：靜默安裝，重試 → 否：檢查點請求使用者安裝。

## 檢查點前自動化失敗處理

| 失敗 | 響應 |
|------|------|
| 伺服器無法啟動 | 檢查錯誤，修復問題，重試（不進入檢查點）|
| 埠被佔用 | 終止陳舊程序或使用備用埠 |
| 缺少依賴 | 執行 `npm install`，重試 |
| 構建錯誤 | 先修復錯誤（是 bug，不是檢查點問題）|
| 認證錯誤 | 建立認證門控檢查點 |
| 網路超時 | 帶退避重試，如果持續則檢查點 |

**絕不呈現驗證環境損壞的檢查點。** 如果 `curl localhost:3000` 失敗，不要讓使用者"訪問 localhost:3000"。

## 可自動化快速參考

| 操作 | 可自動化？| Claude 做？|
|------|------------|------------|
| 部署到 Vercel | 是 (`vercel`) | 是 |
| 建立 Stripe webhook | 是 (API) | 是 |
| 寫入 .env 檔案 | 是 (Write 工具) | 是 |
| 建立 Upstash DB | 是 (`upstash`) | 是 |
| 執行測試 | 是 (`npm test`) | 是 |
| 啟動開發伺服器 | 是 (`npm run dev`) | 是 |
| 新增環境變數到 Convex | 是 (`npx convex env set`) | 是 |
| 新增環境變數到 Vercel | 是 (`vercel env add`) | 是 |
| 填充資料庫 | 是 (CLI/API) | 是 |
| 點選郵件驗證連結 | 否 | 否 |
| 輸入帶 3DS 的信用卡 | 否 | 否 |
| 在瀏覽器中完成 OAuth | 否 | 否 |
| 視覺驗證 UI 是否正確 | 否 | 否 |
| 測試互動式使用者流程 | 否 | 否 |

## 反模式

### ❌ 錯誤：讓使用者啟動開發伺服器
```xml
<task type="checkpoint:human-verify" gate="blocking">
  <what-built>儀表板元件</what-built>
  <how-to-verify>
    1. 執行: npm run dev
    2. 訪問: http://localhost:3000/dashboard
    3. 檢查佈局是否正確
  </how-to-verify>
</task>
```
**為什麼錯誤：** Claude 可以執行 `npm run dev`。使用者應該只訪問 URL，不執行命令。

### ✅ 正確：Claude 啟動伺服器，使用者訪問
```xml
<task type="auto">
  <name>啟動開發伺服器</name>
  <action>在後臺執行 `npm run dev`</action>
  <verify>curl localhost:3000 返回 200</verify>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>http://localhost:3000/dashboard 的儀表板（伺服器執行中）</what-built>
  <how-to-verify>
    訪問 http://localhost:3000/dashboard 並驗證：
    1. 佈局匹配設計
    2. 無控制台錯誤
  </how-to-verify>
</task>
```

### ❌ 錯誤：讓使用者部署 / ✅ 正確：Claude 自動化
```xml
<!-- 錯誤：讓使用者通過儀表板部署 -->
<task type="checkpoint:human-action" gate="blocking">
  <action>部署到 Vercel</action>
  <instructions>訪問 vercel.com/new → 匯入倉庫 → 點選部署 → 複製 URL</instructions>
</task>

<!-- 正確：Claude 部署，使用者驗證 -->
<task type="auto">
  <name>部署到 Vercel</name>
  <action>執行 `vercel --yes`。捕獲 URL。</action>
  <verify>vercel ls 顯示部署，curl 返回 200</verify>
</task>

<task type="checkpoint:human-verify">
  <what-built>已部署到 {url}</what-built>
  <how-to-verify>訪問 {url}，檢查首頁載入</how-to-verify>
  <resume-signal>輸入 "approved"</resume-signal>
</task>
```

## 摘要

檢查點規範化人工介入點用於驗證和決策，而非手動工作。

**黃金法則：** 如果 Claude 能自動化它，Claude 就必須自動化它。

**檢查點優先順序：**
1. **checkpoint:human-verify**（90%）- Claude 自動化一切，人工確認視覺/功能正確性
2. **checkpoint:decision**（9%）- 人工做出架構/技術選擇
3. **checkpoint:human-action**（1%）- 真正無法避免的、沒有 API/CLI 的手動步驟

**何時不用檢查點：**
- Claude 可以程式設計驗證的事情（測試、構建）
- 檔案操作（Claude 可以讀取檔案）
- 程式碼正確性（測試和靜態分析）
- 任何可通過 CLI/API 自動化的內容