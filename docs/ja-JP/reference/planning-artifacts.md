# プランニングアーティファクト リファレンス

`.planning/` ディレクトリはプロジェクトの GSD Core 共有メモリです。すべてのワークフローはここから読み取り、書き込み、意思決定の監査可能な証跡を残します。このページではすべてのファイル、その目的、どのコマンドが生成・使用するかをマッピングします。[ドキュメントインデックス](../../README.md) も参照してください。

---

## ディレクトリ構造

```
.planning/
├── PROJECT.md                          # プロジェクトのアイデンティティとコアバリュー
├── ROADMAP.md                          # マイルストーン + フェーズ一覧とゴール
├── REQUIREMENTS.md                     # 番号付きの受け入れ基準
├── STATE.md                            # 現在地を追跡するリビングドキュメント
├── config.json                         # ワークフローとモデルの設定
├── MILESTONES.md                       # マイルストーンアーカイブ（オプション）
├── BACKLOG.md                          # 延期および将来の作業（オプション）
├── LEARNINGS.md                        # 蓄積されたフェーズ横断の学習（オプション）
├── DECISIONS-INDEX.md                  # 過去の意思決定のローリングサマリー（オプション）
├── METHODOLOGY.md                      # 再利用可能な解釈フレームワーク（オプション）
├── HANDOFF.json                        # 機械可読な一時停止状態（一時的）
├── codebase/                           # コードベースマップ（オプション）
│   ├── architecture.md
│   ├── stack.md
│   └── ...
├── intel/                              # クエリ可能なシンボルインデックス（オプション、intel.enabled）
│   └── API-SURFACE.md
└── phases/
    └── <NN>-<slug>/                    # フェーズごとに1ディレクトリ
        ├── <NN>-CONTEXT.md             # 実装上の意思決定（discuss-phase）
        ├── <NN>-DISCUSSION-LOG.md      # 人間可読なディスカッション監査（discuss-phase）
        ├── <NN>-RESEARCH.md            # 技術リサーチの所見（plan-phase）
        ├── <NN>-VALIDATION.md          # Nyquist テストカバレッジ戦略（plan-phase）
        ├── <NN>-PATTERNS.md            # コードベースアナログマップ（plan-phase、オプション）
        ├── <NN>-<PP>-PLAN.md           # 実行可能プラン（plan-phase、プランごとに1つ）
        ├── <NN>-<PP>-SUMMARY.md        # 実行記録（execute-phase、プランごとに1つ）
        ├── <NN>-VERIFICATION.md        # フェーズゴール検証レポート（verify-phase）
        ├── <NN>-UAT.md                 # 永続的な UAT セッション状態（execute-phase）
        └── .continue-here.md           # 一時停止後の再開指示（pause-work）
```

---

## ルートレベルのアーティファクト

### `PROJECT.md`

| | |
|---|---|
| **用途** | プロジェクトの正規アイデンティティ: 概要、対象ユーザー、コアバリュー、要件、制約、主要な意思決定。プロダクトの進化に伴いプロジェクトライフサイクル全体を通じて更新されます。 |
| **生成元** | `/gsd-new-project`（初回作成）; 意思決定が検証されると `/gsd-complete-milestone` によって更新されます。 |
| **参照先** | すべてのプランニングワークフロー; `gsd-phase-researcher`、`gsd-planner`（コンテキスト）; `discuss-phase`（過去の意思決定）; `gsd-plan-checker`（プロジェクト制約）。 |

### `ROADMAP.md`

| | |
|---|---|
| **用途** | マイルストーンおよびフェーズ一覧。ゴール、要件 ID、成功基準、フェーズごとの正規リファレンスを含みます。プロジェクトが何をどの順序で構築するかに関する唯一の信頼できる情報源です。 |
| **生成元** | `/gsd-new-project`（初回作成）; `/gsd-phase --insert` および `/gsd-complete-milestone` によって更新されます。 |
| **参照先** | `/gsd-discuss-phase`、`/gsd-plan-phase`、`/gsd-execute-phase`; フェーズ情報を必要とするすべてのオーケストレーションコマンド; `gsd-planner`、`gsd-plan-checker`、`gsd-phase-researcher`。 |

### `REQUIREMENTS.md`

| | |
|---|---|
| **用途** | 番号付きのチェック可能な受け入れ基準。各要件はロードマップフェーズにマッピングされる ID（例: `AUTH-01`）を持ちます。フェーズが実行されると要件を完了済みとしてマークします。 |
| **生成元** | `/gsd-new-project`（初回作成）; `execute-phase` によって要件が完了済みとしてマークされます。 |
| **参照先** | `gsd-planner`（プランはすべてのフェーズ要件 ID に対処しなければならない）; `gsd-plan-checker` ディメンション1（要件カバレッジ）; `discuss-phase`（過去の要件）。 |

### `STATE.md`

| | |
|---|---|
| **用途** | 現在地を追跡するリビングドキュメント — 現在のフェーズとプラン、進捗指標、蓄積された意思決定、セッション継続性ノート。すべてのワークフロー実行の開始時に読み込まれます。重要なアクションのたびに更新されます。 |
| **生成元** | `/gsd-new-project`（初回作成）; すべてのフェーズワークフロー、`/gsd-pause-work`、`/gsd-resume-work` によって継続的に更新されます。 |
| **参照先** | すべてのオーケストレーションワークフロー; `/gsd-progress`; `/gsd-quick` 経由のアドホックタスク実行; `gsd-planner` および `gsd-phase-researcher`（プロジェクトの意思決定）。 |

完全なフィールドリファレンスは [STATE.md スキーマ](state-md.md) を参照してください。

### `config.json`

| | |
|---|---|
| **用途** | ワークフロー設定: モデルプロファイル、リサーチおよびプランチェッカーのトグル、Git ブランチング戦略、Nyquist バリデーション、並列化設定、エージェントごとのモデルオーバーライド。 |
| **生成元** | `/gsd-new-project`（初回作成）; `/gsd-settings`（インタラクティブ編集）。 |
| **参照先** | すべてのワークフローとサブエージェント — `gsd-tools query config-get` 経由で初期化時に読み込まれます。 |

完全なスキーマは [CONFIGURATION](../../CONFIGURATION.md) を参照してください。

### `MILESTONES.md`（オプション）

| | |
|---|---|
| **用途** | 完了したマイルストーンの履歴記録。各マイルストーンのクローズ時に追記されます。何がいつリリースされたかのアーカイブスナップショットを提供します。 |
| **生成元** | `/gsd-complete-milestone`。 |
| **参照先** | `/gsd-audit-milestone`; 人間によるレビュー。 |

### `DECISIONS-INDEX.md`（オプション）

| | |
|---|---|
| **用途** | 過去のフェーズの CONTEXT.md ファイルに記録された意思決定の有界ローリングサマリー。存在する場合、`discuss-phase` は最大3つの過去 CONTEXT.md ファイルを個別に読む代わりにこの単一ファイルを読み取り、コンテキスト予算を節約します。 |
| **生成元** | 過去フェーズの数がローリング読み取り閾値を超えたときに生成されます。 |
| **参照先** | `discuss-phase`（`load_prior_context` ステップ）。 |

### `HANDOFF.json`（一時的）

| | |
|---|---|
| **用途** | 作業が中断されたときに書き込まれる機械可読な一時停止状態。再開ポイント、進行中のコンテキスト、継続指示を含みます。再開時に一度だけ使用されます。 |
| **生成元** | `/gsd-pause-work`。 |
| **参照先** | `/gsd-resume-work`。 |

---

## フェーズごとのアーティファクト

すべてのフェーズごとのファイルは `.planning/phases/<NN>-<slug>/` 以下に配置されます。`NN` はゼロパディングされたフェーズ番号、`slug` はハイフン区切りのフェーズ名です。

### `<NN>-CONTEXT.md`

| | |
|---|---|
| **用途** | プランニング開始前に収集された実装上の意思決定。フェーズ境界（`<domain>`）、`D-NN` 識別子付きのロックされた意思決定（`<decisions>`）、正規のドキュメント参照（`<canonical_refs>`）、既存のコードのインサイト（`<code_context>`）、具体的な参考例（`<specifics>`）、延期されたアイデア（`<deferred>`）を含みます。 |
| **生成元** | `/gsd-discuss-phase`（インタラクティブなディスカッションまたは PRD/ADR エクスプレスパス）。 |
| **参照先** | `gsd-phase-researcher`（調査すべき内容）; `gsd-planner`（ロックされた意思決定）; `gsd-plan-checker` ディメンション7（コンテキスト準拠）。 |

完全なフィールドリファレンスは [CONTEXT.md スキーマ](context-md.md) を参照してください。

### `<NN>-DISCUSSION-LOG.md`

| | |
|---|---|
| **用途** | discuss-phase セッションの人間可読な監査証跡: 議論された領域、提示されたオプション、行われた選択、延期されたアイデア、Claude の裁量に任せられた項目。自動化されたワークフローには使用されません。 |
| **生成元** | `/gsd-discuss-phase`（`git_commit` ステップ）。 |
| **参照先** | 人間によるレビュー; 振り返り。 |

### `<NN>-RESEARCH.md`

| | |
|---|---|
| **用途** | プランニング前に生成される技術リサーチの所見。「このフェーズをうまくプランニングするために何を知る必要があるか？」という問いに答えます — ドメイン分析、パターン、リスク、Architectural Responsibility Map、Validation Architecture セクション（Nyquist ゲートで使用）をカバーします。 |
| **生成元** | `/gsd-plan-phase`（`gsd-phase-researcher` エージェント経由）。 |
| **参照先** | `gsd-planner`（プランニングインプット）; `gsd-plan-checker` ディメンション7c（ティア準拠）、ディメンション8（Nyquist）、ディメンション11（リサーチ解決）; `gsd-pattern-mapper`（ファイルリストのソース）。 |

### `<NN>-VALIDATION.md`

| | |
|---|---|
| **用途** | RESEARCH.md の `## Validation Architecture` セクションから導出された Nyquist インスパイアのバリデーション戦略。プランが遵守しなければならない自動テストカバレッジ要件を指定します。 |
| **生成元** | `/gsd-plan-phase`（ステップ5.5、`workflow.nyquist_validation` が有効で RESEARCH.md に Validation Architecture セクションが含まれる場合）。 |
| **参照先** | `gsd-plan-checker` ディメンション8（チェック8e ゲート — Nyquist チェック進行前に存在しなければならない）; `gsd-verifier`。 |

### `<NN>-PATTERNS.md`

| | |
|---|---|
| **用途** | `gsd-pattern-mapper` によって生成されたコードベースアナログマップ。このフェーズで作成または変更される各ファイルに対して、最も近い既存のアナログを特定し、ファイルの役割とデータフローを分類し、具体的なコード抜粋を抽出します。プランナーを一貫したパターンに向けます。 |
| **生成元** | `/gsd-plan-phase`（`gsd-pattern-mapper` エージェント経由、オプション; `workflow.pattern_mapper: false` の場合はスキップ）。 |
| **参照先** | `gsd-planner`（パターンガイダンス）; `gsd-plan-checker` ディメンション12（パターン準拠）。 |

### `<NN>-<PP>-PLAN.md`

| | |
|---|---|
| **用途** | フェーズ内の単一作業単位の実行可能プラン。YAML フロントマター（ウェーブ、依存関係、ファイル、要件、`must_haves`）、目的、コンテキスト参照、`<read_first>`、`<action>`、`<verify>`、`<acceptance_criteria>` フィールドを持つ XML 構造化タスク、検証基準を含みます。 |
| **生成元** | `/gsd-plan-phase`（`gsd-planner` エージェント経由）。プランごとに1ファイル — 例: `03-02-PLAN.md` はフェーズ3、プラン2。 |
| **参照先** | `/gsd-execute-phase`（エグゼキューターエージェントがプランを読んでタスクを実行）; `gsd-plan-checker`（実行前の品質レビュー）; `gsd-verifier`（実行後の検証のために `must_haves` を読む）。 |

完全なフィールドリファレンスは [PLAN.md スキーマ](plan-md.md) を参照してください。

### `<NN>-<PP>-SUMMARY.md`

| | |
|---|---|
| **用途** | プラン完了後に書き込まれる実行記録。構築された内容、プランからの逸脱、受け入れ基準に対するセルフチェック、フェーズの依存グラフを記録します。 |
| **生成元** | `execute-phase` エグゼキューターエージェント（各プランの実行終了時に書き込まれます）。 |
| **参照先** | `/gsd-progress`（フェーズステータス）; `gsd-planner`（後続のプランが以前のプラン出力への真の依存を持つ場合）; `milestone-summary`。 |

### `<NN>-VERIFICATION.md`

| | |
|---|---|
| **用途** | フェーズゴール検証レポート。実行後に実際のコードベースに対してすべてのプランの `must_haves.truths`、`must_haves.artifacts`、`must_haves.key_links` を確認します。`status: passed | gaps_found | human_needed` を記録します。 |
| **生成元** | `/gsd-verify-work`（または `/gsd-execute-phase` 内の検証ステップ）。 |
| **参照先** | `plan-phase` クローズドフェーズゲート（`status: passed` の VERIFICATION.md はフェーズを `Complete` としてマークし、`--force` なしの再プランニングをブロックする）; `/gsd-progress`; 人間によるレビュー。 |

### `<NN>-UAT.md`

| | |
|---|---|
| **用途** | 永続的な UAT セッション追跡。ライブ UAT セッション全体を通じて各テストケース、期待される観察可能な動作、結果、開発者のレスポンスを記録します。YAML フロントマター（`status`、`phase`、`source`、タイムスタンプ）を持ちます。 |
| **生成元** | `/gsd-audit-uat`（インタラクティブな UAT セッション）。 |
| **参照先** | `/gsd-audit-uat`（以前の UAT セッションの再開）。 |

### `.continue-here.md`

| | |
|---|---|
| **用途** | フェーズの作業が一時停止されたときに書き込まれる人間可読な再開指示。再開エージェントのためのコンテキストを含みます: 重要なアンチパターン、ブロッキング問題、必要な参照、再開するための正確なコマンド。 |
| **生成元** | `/gsd-pause-work`。 |
| **参照先** | フェーズで開始するすべてのワークフロー — `discuss-phase` と `plan-phase` は両方ともエントリ時にこのファイルを確認し、処理を進める前にエージェントが `blocking` アンチパターンへの理解を示すことを要求します。 |

---

## 命名規則

| セグメント | フォーマット | 例 |
|---|---|---|
| フェーズディレクトリ | `<NN>-<slug>` | `03-post-feed` |
| フェーズレベルファイル | `<NN>-<ARTIFACT>.md` | `03-CONTEXT.md` |
| プランレベルファイル | `<NN>-<PP>-<ARTIFACT>.md` | `03-02-PLAN.md` |
| `NN` | ゼロパディングされたフェーズ番号 | フェーズ3は `03` |
| `PP` | フェーズ内のゼロパディングされたプラン番号 | プラン2は `02` |

`config.json` に `project_code` が設定されている場合、フェーズディレクトリはプロジェクトコードをプレフィックスとして使用します: プロジェクトコード `CK`、フェーズ3の場合は `CK-03-post-feed`。

---

## Related

- [STATE.md スキーマ](state-md.md)
- [CONTEXT.md スキーマ](context-md.md)
- [PLAN.md スキーマ](plan-md.md)
- [docs index](../../README.md)
