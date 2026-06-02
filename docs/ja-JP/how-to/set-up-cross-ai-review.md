# クロス AI レビューの設定方法

**目的:** プランレビューに参加する AI レビュアーを設定し、プランニング済みフェーズのレビューを実行し、HIGH 重大度の懸念がなくなるまでフィードバックを反映してプランを収束させます。

**前提条件:** フェーズがプランニング済みであること（`.planning/phases/` に `{phase}-PLAN.md` ファイルが存在する）。少なくとも 1 つの外部 AI CLI がインストールされ認証済みであること。

---

## 使用するレビュアーを決める

GSD Core は Gemini CLI、Claude（別セッション）、Codex CLI、CodeRabbit、OpenCode、Qwen Code、Cursor、Antigravity CLI、Ollama、LM Studio、llama.cpp の任意の組み合わせにレビューリクエストをルーティングできます。

各レビュアーは `PLAN.md` ファイルに対して同じ構造化プロンプトを独立して実行します。モデルによって盲点が異なるため、複数レビュアーのコンセンサスは単一レビュアーよりも多くの問題を検出できます。

**外部 CLI がまだインストールされていない場合**は、少なくとも 1 つをインストールしてください:

```bash
# Gemini CLI（Google 認証情報で無料）
npm install -g @google/gemini-cli

# Antigravity CLI（Google 認証情報で無料）
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Codex CLI
npm install -g @openai/codex
```

---

## デフォルトレビュアーを設定する（オプション）

デフォルトでは `/gsd-review` は検出されたすべての CLI を実行します。プロジェクトのデフォルトとして特定のサブセットを固定するには:

```bash
/gsd-config --integrations
```

インテグレーションウィザードは API キー、コードレビュー CLI のルーティング、`review.default_reviewers` リストをカバーします。フラグなしのデフォルトとして使用したいレビュアーのリストを設定します。例: `["gemini","codex"]`。

または `gsd-tools` で直接設定することもできます:

```bash
gsd config-set review.default_reviewers '["gemini","codex"]'
```

インテグレーション設定スキーマの全体（API キー、レビュアーごとのモデルオーバーライド、ローカルサーバーのホストアドレス）については [設定](../CONFIGURATION.md) を参照してください。

---

## レビューを実行する

### 標準レビュー（設定済みのデフォルトまたは検出されたすべての CLI を使用）

```bash
/gsd-review --phase 3
```

GSD は各レビュアーを順番に呼び出し、構造化されたフィードバック（サマリー、強み、HIGH/MEDIUM/LOW の懸念事項、提案、リスク評価）を収集し、結合された出力を `.planning/phases/03-.../03-REVIEWS.md` に書き込みます。

### 1 回限りの実行で特定のレビュアーを選ぶ

```bash
/gsd-review --phase 3 --gemini
/gsd-review --phase 3 --codex
/gsd-review --phase 3 --cursor
```

明示的なフラグはその実行に限り `--all` のデフォルトと `review.default_reviewers` の両方を上書きします。

### 利用可能なすべてのレビュアーを並列実行する

```bash
/gsd-review --phase 3 --all
```

`--all` は設定を常に上書きし、設定済みのローカルモデルサーバー（Ollama、LM Studio、llama.cpp）を含む、検出されたすべてのセットを実行します。

### ローカルモデルサーバーのレビュアー

Ollama または LM Studio をローカルで実行している場合、サーバーに到達可能であれば `--all` で自動的に含まれます。明示的に指定することもできます:

```bash
/gsd-review --phase 3 --ollama
/gsd-review --phase 3 --lm-studio
```

デフォルト（`localhost:11434` / `localhost:1234`）が合わない場合は、`/gsd-config --integrations` で `review.*` キーの下にホストアドレスとモデル選択を設定してください。

---

## レビュー出力を読む

`{padded_phase}-REVIEWS.md` ファイルには以下が含まれます:

- 重要度別に分類された懸念事項を含む各レビュアーの個別レビュー
- 2 人以上のレビュアーが提起した懸念事項を統合した**コンセンサスサマリー**セクション — 最優先シグナルのためにここから読み始めてください
- レビュアー間で意見が分かれた箇所の**相違する見解**セクション

---

## フィードバックをプランに取り込む

出力を確認したら、フィードバックを取り込んでリプランします:

```bash
/gsd-plan-phase 3 --reviews
```

プランナーは `REVIEWS.md` を読み込み、懸念事項に対応するようプランを調整してから保存します。

---

## plan–review–replan ループを自動化する

HIGH 重大度の懸念事項がすべて解決されるまで反復したい場合はコンバージェンスループを使用します:

```bash
/gsd-plan-review-convergence 3
```

これは `plan-phase → review → replan → re-review` を最大 3 サイクル（デフォルト）実行します。HIGH 懸念事項のカウントがゼロになるとループが終了します。

### 特定のレビュアーとのコンバージェンス

```bash
/gsd-plan-review-convergence 3 --codex
/gsd-plan-review-convergence 3 --gemini
```

### すべてのレビュアーと高いサイクル上限でのコンバージェンス

```bash
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

**ストール検知:** サイクルをまたいで HIGH 懸念事項のカウントが減少していない場合、GSD は警告します。サイクル上限に達しても HIGH 懸念事項が残っている場合、エスカレーションゲートが表示され、続行するか手動でレビューするかを確認します。

---

## 条件: どのレビュアーを選ぶか

| 状況 | 推奨アプローチ |
|-----------|---------------------|
| Gemini CLI がすでにインストール済み | `--gemini` は常に良い出発点のレビュアー |
| 無料のマルチレビュアーカバレッジが欲しい | `--gemini` + `--agy`（両方とも Google 認証情報を使用） |
| プロジェクトが OpenAI 中心 | OpenAI モデルの観点のために `--codex` を追加 |
| GitHub Copilot のモデルが欲しい | `--opencode` を追加 |
| API コストを完全に避けたい | Ollama にローカルモデルを設定して `--ollama` を使用 |
| リリース前に最大限のカバレッジが必要 | `/gsd-plan-review-convergence N --all` |
| 素早く反復して高速なフィードバックが欲しい | 1 つの CLI を選ぶ: `/gsd-review --phase N --gemini` |

---

## Related

- [検証とシッピング](verify-and-ship.md)
- [設定](../CONFIGURATION.md)
- [コマンド](../COMMANDS.md)
- [ドキュメント索引](../README.md)
