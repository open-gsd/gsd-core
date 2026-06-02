# 回復とトラブルシューティングの方法

**目標:** コンテキストの喪失や状態の破損からインストール失敗やパーミッションエラーまで、条件分岐レシピ構造を使って一般的な問題を特定して修正する。

**前提条件:** GSD Core がインストール済みであること。インストールの問題については、[ランタイムへのインストール](install-on-your-runtime.md)を参照してください。

---

## コンテキストとセッションの問題

### 現在の位置を見失った場合

```bash
/gsd-progress
```

すべての状態ファイルを読み込み、現在地と次にすべきことを正確に教えてくれます。

正しい次のステップに自動的に進むには：

```bash
/gsd-progress --next
```

### 新しいセッションを開始してコンテキストを復元する必要がある場合

```bash
/gsd-resume-work
```

最後のハンドオフから、現在のフェーズ・計画上の決定・作業が停止した場所を含む完全なセッションコンテキストを復元します。

### 長いセッションで品質が低下している場合

主要なコマンド間でコンテキストウィンドウをクリアします。

```bash
/clear
```

その後、状態を復元します。

```bash
/gsd-resume-work
```

GSD は新鮮なコンテキストを前提に設計されています。すべてのサブエージェントはすでにクリーンな 200k ウィンドウを取得します。メインセッションは時間とともに劣化します。プッシュし続けるのではなく、クリアして再開することが正しい対処法です。

### 停止前にコンテキストを保存したい場合

```bash
/gsd-pause-work
```

現在の位置を含む `.planning/HANDOFF.json` を作成します。セッション後のサマリーを `.planning/reports/` にも書き込む場合は `--report` を追加します。

```bash
/gsd-pause-work --report
```

---

## 計画整合性の問題

### `.planning/` の整合性が不確かな場合

```bash
/gsd-health
```

エラー、警告、情報ノートにわたるステータスを報告します。

| ステータス | 意味 |
|--------|---------|
| `HEALTHY` | 期待される成果物がすべて存在し、正しい形式である |
| `DEGRADED` | 対処すべき警告があるが作業は続行できる |
| `BROKEN` | 実行をブロックする重大なエラーがある |

自動修復可能な一般的な問題（エラー E004、E005；警告 W003、W008）：

```bash
/gsd-health --repair
```

これにより不足している `STATE.md` が再作成され、破損した `config.json` がデフォルトにリセットされ、不足している設定キーが追加されます。`PROJECT.md` や `ROADMAP.md` は上書きされません。

### STATE.md が存在しないフェーズを参照している場合

これは警告 `W002` を生成します。状態 CLI を使って診断と修復を行います。

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state validate
```

書き込まずに同期で何が変わるかをプレビューします。

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync --verify
```

同期を適用します。

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync
```

これらのコマンドはディスク上の実際のプロジェクト状態から `STATE.md` を再構築します。手動での `STATE.md` 編集に代わるものです。

### 「Project already initialised」と表示される場合

`.planning/PROJECT.md` がすでに存在します。`/gsd-new-project` は安全チェックです。本当に最初からやり直したい場合は、まず `.planning/` ディレクトリを削除します。

```bash
rm -rf .planning/
```

その後 `/gsd-new-project` を再実行します。

### コンテキストウィンドウの使用率が高い場合

```bash
/gsd-health --context
```

コンテキストウィンドウ使用率ガードを調査します。60% で警告、70% でクリティカル。警告閾値を超えている場合は、次の主要なコマンドを開始する前に `/clear` を実行してから `/gsd-resume-work` を実行してください。

---

## 実行の問題

### エグゼキューターが Bash コマンドで「Permission denied」になる場合

GSD の `gsd-executor` サブエージェントには書き込み可能な Bash アクセスが必要です。`~/.claude/settings.json` の `permissions.allow` に必要なパターンを追加します。最低限：

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git checkout:*)"
```

スタック固有のパターン（Rails、Python、Node、Rust）については、`docs/USER-GUIDE.md` の「Executor Subagent Gets Permission denied」の下にある完全な表を参照してください。

プロジェクト単位の代替手段：プロジェクトルートの `.claude/settings.local.json` に同じブロックを追加する。

### 実行が失敗するか、スタブが生成される場合

プランが過度に野心的でないか確認してください。プランには最大でも 2〜3 個のタスクを含めるべきです。タスクが大きすぎると、単一のコンテキストウィンドウが確実に生成できる範囲を超えます。より小さいスコープでフェーズを再計画します。

```bash
/gsd-plan-phase 1
```

何が起きたかを体系的に診断するには、[フェーズ実行の失敗をデバッグする](debug-a-failed-execution.md)を参照してください。

### 並行実行がビルドロックエラーやプリコミットフック失敗を引き起こす場合

これは複数のエージェントが同時にビルドツールをトリガーすることで発生します。GSD は v1.26 以降、これを自動的に処理します。古いバージョンを使用している場合、またはまだ競合が見られる場合は、並行実行を無効にします。

```bash
/gsd-settings
```

`parallelization.enabled` を `false` に設定します。

### サブエージェントが失敗しているように見えるがコミットが行われている場合

何かが壊れていると判断する前に git ログを確認します。

```bash
git log --oneline -10
```

Claude Code の既知の分類バグで、作業が成功したのに失敗と報告される場合があります。GSD のオーケストレーターは実際の出力をスポットチェックしますが、不一致が見られる場合はコミットが真実です。

---

## プランとフェーズの問題

### プランが意図と異なる、または整合していない場合

計画前に `/gsd-discuss-phase N` を実行します。プランの品質問題のほとんどは、`CONTEXT.md` があれば防げた前提から生じます。

```bash
/gsd-discuss-phase 1
```

完全なセッションを開始せずに GSD が現在行っている前提を確認するには：

```bash
/gsd-discuss-phase 3 --assumptions
```

### 実行後に何かを変更する必要がある場合

`/gsd-execute-phase` を再実行しないでください。対象を絞った修正には `/gsd-quick` を使用します。

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

または `/gsd-verify-work N` を使って UAT を通じて体系的に問題を特定・修正します。

### コマンドが「Spawning…」でフリーズしているように見える場合

待ってください。GSD サブエージェントは別のコンテキストウィンドウで動作します。その作業は進行中の間、親セッションからは見えません。スポーン行の liveness ノートがこれが期待される動作であることを確認しています。リサーチと計画エージェントは通常 1〜5 分かかります。大きなフェーズでは検証エージェントがさらに時間がかかる場合があります。

セッションを中断しないでください。セッションを終了すると進行中のサブエージェント作業が破棄されます。

10 分以上経過した場合は、Claude Code のサイドバーでエージェントタスクがまだアクティブと表示されているか確認してください。

---

## ワークフロー状態の問題

### ワークフローが破損しているか、状態が一貫していない場合

```bash
/gsd-forensics
```

または説明を添えて：

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

`/gsd-forensics` はポストモーテム調査を実行します：git 履歴の異常、成果物の整合性、STATE.md の一貫性、未コミットの作業、孤立したワークツリー。レポートを `.planning/forensics/` に書き込み、推奨される修復手順を提示します。読み取り専用であり、プロジェクトファイルを変更することはありません。

### フェーズまたはプランをロールバックする必要がある場合

```bash
/gsd-undo --phase 03          # フェーズ 3 のすべてのコミットをロールバックする
/gsd-undo --plan 03-02        # フェーズ 3 のプラン 02 のコミットをロールバックする
/gsd-undo --last 5            # 最近の 5 件の GSD コミットからインタラクティブに選ぶ
```

`/gsd-undo` はロールバック前に依存するフェーズを確認し、常に確認ゲートを表示します。

---

## インストールとアップデートの問題

### インストール後に GSD が認識されない場合

ランタイムを再起動してください。GSD はランタイムのコマンドディレクトリ（例：`~/.claude/commands/gsd/`）にスラッシュコマンドをインストールします。ほとんどのランタイムは起動時にのみ新しいコマンドを検出します。

問題が続く場合はインストールを確認します。

```bash
npx @opengsd/gsd-core@latest --claude --local
```

ランタイム固有のインストールパスとトラブルシューティングについては、[ランタイムへのインストール](install-on-your-runtime.md)を参照してください。

### アップデートがローカルの変更を上書きした場合

v1.17 以降、インストーラはローカルで変更されたファイルを `gsd-local-patches/` にバックアップします。変更を再適用します。

```bash
/gsd-update --reapply
```

### npm 経由でアップデートできない場合

npm の障害やネットワーク制限のために `npx @opengsd/gsd-core` が失敗する場合は、`docs/manual-update.md` に npm アクセスなしで動作するステップバイステップの手動アップデート手順があります。

定期的なアップデートについては、[GSD のアップデート](update-gsd.md)を参照してください。

---

## コストの問題

### モデルのコストが高すぎる場合

バジェットプロファイルに切り替えます。

```bash
/gsd-config --profile budget
```

ドメインが慣れ親しんだものであれば、設定でリサーチとプランチェックのエージェントを無効にします。

```bash
/gsd-settings
```

また、有効になっている MCP サーバーを監査してください。有効な MCP サーバーはそれぞれのツールスキーマをすべてのターンに注入します。ブラウザとプラットフォーム固有のツールはそれぞれ 20,000 トークン以上かかる場合があります。現在のフェーズに不要なものは `.claude/settings.json` で無効にしてください。

```json
{
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

---

## 回復クイックリファレンス

| 問題 | 解決策 |
|---------|---------|
| コンテキストを失った、または新しいセッション | `/gsd-resume-work` または `/gsd-progress` |
| 次のステップがわからない | `/gsd-progress --next` |
| フェーズがうまくいかなかった | `/gsd-undo --phase NN`、その後再計画する |
| 何かが壊れた | `/gsd-debug "description"`（修正なしの分析は `--diagnose` を追加） |
| STATE.md が同期していない | `state validate` その後 `state sync` |
| `.planning/` の整合性が不確か | `/gsd-health`、その後 `/gsd-health --repair` |
| ワークフロー状態が破損しているように見える | `/gsd-forensics` |
| 対象を絞った素早い修正 | `/gsd-quick` |
| プランがビジョンと一致しない | `/gsd-discuss-phase N` その後再計画する |
| コストが高くなっている | `/gsd-config --profile budget` と `/gsd-settings` でエージェントをオフにする |
| アップデートがローカルの変更を壊した | `/gsd-update --reapply` |
| セッションのサマリーが必要 | `/gsd-pause-work --report` |
| 並行実行のビルドエラー | GSD をアップデートするか `parallelization.enabled: false` を設定する |

---

## Related

- [フェーズ実行の失敗をデバッグする](debug-a-failed-execution.md)
- [ランタイムへのインストール](install-on-your-runtime.md)
- [コマンドリファレンス](../COMMANDS.md)
- [ドキュメント一覧](../README.md)
