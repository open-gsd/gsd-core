# 驗證模式

如何驗證不同型別的工件是真實實現，而非存根或佔位符。

<core_principle>
**存在 ≠ 實現**

檔案存在並不意味著功能有效。驗證必須檢查：
1. **存在** - 檔案在預期路徑
2. **實質性** - 內容是真實實現，非佔位符
3. **已連線** - 已連線到系統的其他部分
4. **功能性** - 呼叫時實際工作

級別 1-3 可以程式設計檢查。級別 4 通常需要人工驗證。
</core_principle>

<stub_detection>

## 通用存根模式

這些模式表明佔位符程式碼，無論檔案型別：

**基於註釋的存根：**
```bash
# 存根註釋的 Grep 模式
grep -E "(TODO|FIXME|XXX|HACK|PLACEHOLDER)" "$file"
grep -E "implement|add later|coming soon|will be" "$file" -i
grep -E "// \.\.\.|/\* \.\.\. \*/|# \.\.\." "$file"
```

**輸出中的佔位符文本：**
```bash
# UI 佔位符模式
grep -E "placeholder|lorem ipsum|coming soon|under construction" "$file" -i
grep -E "sample|example|test data|dummy" "$file" -i
grep -E "\[.*\]|<.*>|\{.*\}" "$file"  # 模板括號未移除
```

**空或瑣碎實現：**
```bash
# 什麼都不做的函式
grep -E "return null|return undefined|return \{\}|return \[\]" "$file"
grep -E "pass$|\.\.\.|\bnothing\b" "$file"
grep -E "console\.(log|warn|error).*only" "$file"  # 僅日誌函式
```

**預期動態但硬編碼的值：**
```bash
# 硬編碼 ID、計數或內容
grep -E "id.*=.*['\"].*['\"]" "$file"  # 硬編碼字串 ID
grep -E "count.*=.*\d+|length.*=.*\d+" "$file"  # 硬編碼計數
grep -E "\\\$\d+\.\d{2}|\d+ items" "$file"  # 硬編碼顯示值
```

</stub_detection>

<react_components>

## React/Next.js 元件

**存在檢查：**
```bash
# 檔案存在且匯出元件
[ -f "$component_path" ] && grep -E "export (default |)function|export const.*=.*\(" "$component_path"
```

**實質性檢查：**
```bash
# 返回實際 JSX，非佔位符
grep -E "return.*<" "$component_path" | grep -v "return.*null" | grep -v "placeholder" -i

# 有有意義的內容（不僅僅是包裝 div）
grep -E "<[A-Z][a-zA-Z]+|className=|onClick=|onChange=" "$component_path"

# 使用 props 或 state（非靜態）
grep -E "props\.|useState|useEffect|useContext|\{.*\}" "$component_path"
```

**React 特有的存根模式：**
```javascript
// 危險訊號 - 這些是存根：
return <div>Component</div>
return <div>Placeholder</div>
return <div>{/* TODO */}</div>
return <p>Coming soon</p>
return null
return <></>

// 也是存根 - 空處理器：
onClick={() => {}}
onChange={() => console.log('clicked')}
onSubmit={(e) => e.preventDefault()}  // 僅阻止預設，什麼都不做
```

**連線檢查：**
```bash
# 元件匯入它需要的東西
grep -E "^import.*from" "$component_path"

# Props 實際被使用（不僅僅是接收）
# 查詢解構或 props.X 用法
grep -E "\{ .* \}.*props|\bprops\.[a-zA-Z]+" "$component_path"

# API 呼叫存在（對於資料獲取元件）
grep -E "fetch\(|axios\.|useSWR|useQuery|getServerSideProps|getStaticProps" "$component_path"
```

**功能驗證（需要人工）：**
- 元件是否渲染可見內容？
- 互動元素是否響應點選？
- 資料是否載入並顯示？
- 錯誤狀態是否適當顯示？

</react_components>

<api_routes>

## API 路由（Next.js App Router / Express 等）

**存在檢查：**
```bash
# 路由檔案存在
[ -f "$route_path" ]

# 匯出 HTTP 方法處理器（Next.js App Router）
grep -E "export (async )?(function|const) (GET|POST|PUT|PATCH|DELETE)" "$route_path"

# 或 Express 風格處理器
grep -E "\.(get|post|put|patch|delete)\(" "$route_path"
```

**實質性檢查：**
```bash
# 有實際邏輯，不僅僅是 return 語句
wc -l "$route_path"  # 超過 10-15 行表明真實實現

# 與資料來源互動
grep -E "prisma\.|db\.|mongoose\.|sql|query|find|create|update|delete" "$route_path" -i

# 有錯誤處理
grep -E "try|catch|throw|error|Error" "$route_path"

# 返回有意義的響應
grep -E "Response\.json|res\.json|res\.send|return.*\{" "$route_path" | grep -v "message.*not implemented" -i
```

**API 路由特有的存根模式：**
```typescript
// 危險訊號 - 這些是存根：
export async function POST() {
  return Response.json({ message: "Not implemented" })
}

export async function GET() {
  return Response.json([])  // 空 array 無資料庫查詢
}

export async function PUT() {
  return new Response()  // 空響應
}

// 僅控制台日誌：
export async function POST(req) {
  console.log(await req.json())
  return Response.json({ ok: true })
}
```

**連線檢查：**
```bash
# 匯入資料庫/服務客戶端
grep -E "^import.*prisma|^import.*db|^import.*client" "$route_path"

# 實際使用請求體（對於 POST/PUT）
grep -E "req\.json\(\)|req\.body|request\.json\(\)" "$route_path"

# 驗證輸入（不僅僅信任請求）
grep -E "schema\.parse|validate|zod|yup|joi" "$route_path"
```

**功能驗證（人工或自動化）：**
- GET 是否從資料庫返回真實資料？
- POST 是否實際建立記錄？
- 錯誤響應是否有正確的狀態碼？
- 認證檢查是否實際執行？

</api_routes>

<database_schema>

## 資料庫模式（Prisma / Drizzle / SQL）

**存在檢查：**
```bash
# 模式檔案存在
[ -f "prisma/schema.prisma" ] || [ -f "drizzle/schema.ts" ] || [ -f "src/db/schema.sql" ]

# 模型/表已定義
grep -E "^model $model_name|CREATE TABLE $table_name|export const $table_name" "$schema_path"
```

**實質性檢查：**
```bash
# 有預期欄位（不僅僅是 id）
grep -A 20 "model $model_name" "$schema_path" | grep -E "^\s+\w+\s+\w+"

# 有預期關係
grep -E "@relation|REFERENCES|FOREIGN KEY" "$schema_path"

# 有適當的欄位型別（不全是 String）
grep -A 20 "model $model_name" "$schema_path" | grep -E "Int|DateTime|Boolean|Float|Decimal|Json"
```

**模式特有的存根模式：**
```prisma
// 危險訊號 - 這些是存根：
model User {
  id String @id
  // TODO: add fields
}

model Message {
  id        String @id
  content   String  // 只有一個真實欄位
}

// 缺少關鍵欄位：
model Order {
  id     String @id
  // 缺少: userId, items, total, status, createdAt
}
```

**連線檢查：**
```bash
# 遷移存在且已應用
ls prisma/migrations/ 2>/dev/null | wc -l  # 應該 > 0
npx prisma migrate status 2>/dev/null | grep -v "pending"

# 客戶端已生成
[ -d "node_modules/.prisma/client" ]
```

**功能驗證：**
```bash
# 可以查詢表（自動化）
npx prisma db execute --stdin <<< "SELECT COUNT(*) FROM $table_name"
```

</database_schema>

<hooks_utilities>

## 自定義 Hooks 和工具

**存在檢查：**
```bash
# 檔案存在且匯出函式
[ -f "$hook_path" ] && grep -E "export (default )?(function|const)" "$hook_path"
```

**實質性檢查：**
```bash
# Hook 使用 React hooks（對於自定義 hooks）
grep -E "useState|useEffect|useCallback|useMemo|useRef|useContext" "$hook_path"

# 有有意義的返回值
grep -E "return \{|return \[" "$hook_path"

# 超過瑣碎長度
[ $(wc -l < "$hook_path") -gt 10 ]
```

**Hooks 特有的存根模式：**
```typescript
// 危險訊號 - 這些是存根：
export function useAuth() {
  return { user: null, login: () => {}, logout: () => {} }
}

export function useCart() {
  const [items, setItems] = useState([])
  return { items, addItem: () => console.log('add'), removeItem: () => {} }
}

// 硬編碼返回：
export function useUser() {
  return { name: "Test User", email: "test@example.com" }
}
```

**連線檢查：**
```bash
# Hook 實際在某處被匯入
grep -r "import.*$hook_name" src/ --include="*.tsx" --include="*.ts" | grep -v "$hook_path"

# Hook 實際被呼叫
grep -r "$hook_name()" src/ --include="*.tsx" --include="*.ts" | grep -v "$hook_path"
```

</hooks_utilities>

<environment_config>

## 環境變數和配置

**存在檢查：**
```bash
# .env 檔案存在
[ -f ".env" ] || [ -f ".env.local" ]

# 必需變數已定義
grep -E "^$VAR_NAME=" .env .env.local 2>/dev/null
```

**實質性檢查：**
```bash
# 變數有實際值（非佔位符）
grep -E "^$VAR_NAME=.+" .env .env.local 2>/dev/null | grep -v "your-.*-here|xxx|placeholder|TODO" -i

# 值對型別看起來有效：
# - URL 應以 http 開頭
# - 金鑰應足夠長
# - 布林值應為 true/false
```

**環境變數特有的存根模式：**
```bash
# 危險訊號 - 這些是存根：
DATABASE_URL=your-database-url-here
STRIPE_SECRET_KEY=sk_test_xxx
API_KEY=placeholder
NEXT_PUBLIC_API_URL=http://localhost:3000  # 生產環境仍指向 localhost
```

**連線檢查：**
```bash
# 變數實際在程式碼中使用
grep -r "process\.env\.$VAR_NAME|env\.$VAR_NAME" src/ --include="*.ts" --include="*.tsx"

# 變數在驗證模式中（如果使用 zod 等驗證 env）
grep -E "$VAR_NAME" src/env.ts src/env.mjs 2>/dev/null
```

</environment_config>

<wiring_verification>

## 連線驗證模式

連線驗證檢查元件是否實際通訊。這是大多數存根隱藏的地方。

### 模式：元件 → API

**檢查：** 元件是否實際呼叫 API？

```bash
# 查詢 fetch/axios 呼叫
grep -E "fetch\(['\"].*$api_path|axios\.(get|post).*$api_path" "$component_path"

# 驗證未被註釋掉
grep -E "fetch\(|axios\." "$component_path" | grep -v "^.*//.*fetch"

# 檢查響應被使用
grep -E "await.*fetch|\.then\(|setData|setState" "$component_path"
```

**危險訊號：**
```typescript
// Fetch 存在但響應被忽略：
fetch('/api/messages')  // 無 await，無 .then，無賦值

// Fetch 在註釋中：
// fetch('/api/messages').then(r => r.json()).then(setMessages)

// Fetch 到錯誤的端點：
fetch('/api/message')  // 拼寫錯誤 - 應該是 /api/messages
```

### 模式：API → 資料庫

**檢查：** API 路由是否實際查詢資料庫？

```bash
# 查詢資料庫呼叫
grep -E "prisma\.$model|db\.query|Model\.find" "$route_path"

# 驗證被 await
grep -E "await.*prisma|await.*db\." "$route_path"

# 檢查結果被返回
grep -E "return.*json.*data|res\.json.*result" "$route_path"
```

**危險訊號：**
```typescript
// 查詢存在但結果未返回：
await prisma.message.findMany()
return Response.json({ ok: true })  // 返回靜態值，非查詢結果

// 查詢未被 await：
const messages = prisma.message.findMany()  // 缺少 await
return Response.json(messages)  // 返回 Promise，非資料
```

### 模式：表單 → 處理器

**檢查：** 表單提交是否實際做些什麼？

```bash
# 查詢 onSubmit 處理器
grep -E "onSubmit=\{|handleSubmit" "$component_path"

# 檢查處理器有內容
grep -A 10 "onSubmit.*=" "$component_path" | grep -E "fetch|axios|mutate|dispatch"

# 驗證不僅僅是 preventDefault
grep -A 5 "onSubmit" "$component_path" | grep -v "only.*preventDefault" -i
```

**危險訊號：**
```typescript
// 處理器僅阻止預設：
onSubmit={(e) => e.preventDefault()}

// 處理器僅日誌：
const handleSubmit = (data) => {
  console.log(data)
}

// 處理器為空：
onSubmit={() => {}}
```

### 模式：狀態 → 渲染

**檢查：** 元件是否渲染狀態，而非硬編碼內容？

```bash
# 查詢 JSX 中的狀態使用
grep -E "\{.*messages.*\}|\{.*data.*\}|\{.*items.*\}" "$component_path"

# 檢查狀態的 map/render
grep -E "\.map\(|\.filter\(|\.reduce\(" "$component_path"

# 驗證動態內容
grep -E "\{[a-zA-Z_]+\." "$component_path"  # 變數插值
```

**危險訊號：**
```tsx
// 硬編碼而非狀態：
return <div>
  <p>Message 1</p>
  <p>Message 2</p>
</div>

// 狀態存在但未渲染：
const [messages, setMessages] = useState([])
return <div>No messages</div>  // 總是顯示 "no messages"

// 渲染錯誤的狀態：
const [messages, setMessages] = useState([])
return <div>{otherData.map(...)}</div>  // 使用不同資料
```

</wiring_verification>

<verification_checklist>

## 快速驗證清單

對於每種工件型別，執行此清單：

### 元件清單
- [ ] 檔案存在於預期路徑
- [ ] 匯出函式/const 元件
- [ ] 返回 JSX（非 null/空）
- [ ] 渲染中無佔位符文本
- [ ] 使用 props 或 state（非靜態）
- [ ] 事件處理器有真實實現
- [ ] 匯入正確解析
- [ ] 在應用某處被使用

### API 路由清單
- [ ] 檔案存在於預期路徑
- [ ] 匯出 HTTP 方法處理器
- [ ] 處理器超過 5 行
- [ ] 查詢資料庫或服務
- [ ] 返回有意義的響應（非空/佔位符）
- [ ] 有錯誤處理
- [ ] 驗證輸入
- [ ] 從前端呼叫

### 模式清單
- [ ] 模型/表已定義
- [ ] 有所有預期欄位
- [ ] 欄位有適當型別
- [ ] 如需要關係已定義
- [ ] 遷移存在且已應用
- [ ] 客戶端已生成

### Hook/工具清單
- [ ] 檔案存在於預期路徑
- [ ] 匯出函式
- [ ] 有有意義的實現（非空返回）
- [ ] 在應用某處被使用
- [ ] 返回值被消費

### 連線清單
- [ ] 元件 → API: fetch/axios 呼叫存在且使用響應
- [ ] API → 資料庫: 查詢存在且結果返回
- [ ] 表單 → 處理器: onSubmit 呼叫 API/mutation
- [ ] 狀態 → 渲染: 狀態變量出現在 JSX 中

</verification_checklist>

<automated_verification_script>

## 自動化驗證方法

對於驗證子代理，使用此模式：

```bash
# 1. 檢查存在
check_exists() {
  [ -f "$1" ] && echo "EXISTS: $1" || echo "MISSING: $1"
}

# 2. 檢查存根模式
check_stubs() {
  local file="$1"
  local stubs=$(grep -c -E "TODO|FIXME|placeholder|not implemented" "$file" 2>/dev/null || echo 0)
  [ "$stubs" -gt 0 ] && echo "STUB_PATTERNS: $stubs in $file"
}

# 3. 檢查連線（元件呼叫 API）
check_wiring() {
  local component="$1"
  local api_path="$2"
  grep -q "$api_path" "$component" && echo "WIRED: $component → $api_path" || echo "NOT_WIRED: $component → $api_path"
}

# 4. 檢查實質性（超過 N 行，有預期模式）
check_substantive() {
  local file="$1"
  local min_lines="$2"
  local pattern="$3"
  local lines=$(wc -l < "$file" 2>/dev/null || echo 0)
  local has_pattern=$(grep -c -E "$pattern" "$file" 2>/dev/null || echo 0)
  [ "$lines" -ge "$min_lines" ] && [ "$has_pattern" -gt 0 ] && echo "SUBSTANTIVE: $file" || echo "THIN: $file ($lines lines, $has_pattern matches)"
}
```

對每個必須有工件執行這些檢查。彙總結果到 VERIFICATION.md。

</automated_verification_script>

<human_verification_triggers>

## 何時需要人工驗證

有些事情無法程式設計驗證。標記這些需要人工測試：

**始終人工：**
- 視覺外觀（看起來對嗎？）
- 使用者流程完成（能實際做那件事嗎？）
- 即時行為（WebSocket、SSE）
- 外部服務整合（Stripe、郵件傳送）
- 錯誤訊息清晰度（訊息有幫助嗎？）
- 效能感覺（感覺快嗎？）

**如不確定則人工：**
- grep 無法追蹤的複雜連線
- 依賴狀態的動態行為
- 邊緣情況和錯誤狀態
- 移動端響應式
- 無障礙性

**人工驗證請求格式：**
```markdown
## 需要人工驗證

### 1. 聊天訊息傳送
**測試：** 輸入訊息並點擊發送
**預期：** 訊息出現在列表中，輸入框清空
**檢查：** 重新整理後訊息是否持久？

### 2. 錯誤處理
**測試：** 斷開網路，嘗試傳送
**預期：** 錯誤訊息出現，訊息未丟失
**檢查：** 重連後能重試嗎？
```

</human_verification_triggers>

<checkpoint_automation_reference>

## 檢查點前自動化

關於自動化優先的檢查點模式、伺服器生命週期管理、CLI 安裝處理和錯誤恢復協議，請參閱：

**@~/.claude/get-shit-done/references/checkpoints.md** → `<automation_reference>` 部分

關鍵原則：
- Claude 在呈現檢查點**之前**設定驗證環境
- 使用者從不執行 CLI 命令（僅訪問 URL）
- 伺服器生命週期：檢查點前啟動、處理埠衝突、持續執行
- CLI 安裝：安全處自動安裝，否則檢查點讓使用者選擇
- 錯誤處理：檢查點前修復損壞環境，絕不呈現有失敗設定的檢查點

</checkpoint_automation_reference>