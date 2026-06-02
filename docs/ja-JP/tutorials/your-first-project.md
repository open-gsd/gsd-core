# はじめてのプロジェクト

このチュートリアルでは、GSD Core をインストールし、シンプルなコマンドライン To-Do アプリをゼロから作成します。1フェーズ、1プルリクエスト、完全なループを体験します。終わる頃には、コアフェーズループのすべてのコマンドを少なくとも一度は実行し、各コマンドが生成する計画アーティファクトを確認しているはずです。

---

## 作るもの

To-Do アイテムをローカルの JSON ファイルに保存し、追加・一覧表示・完了マークができる Node.js CLI ツールです。1セッションで完成できる小さなプロジェクトで、Node.js 標準ライブラリのみを使用するため、追加インストールは不要です。

---

## 前提条件

- **Node.js 18 以降** — `node --version` が `v18.x.x` 以上を表示すること。
- **Claude Code** — 使用するプロジェクトディレクトリで開いていること。
- 初回インストール用のインターネット接続。

他のツールは不要です。GSD Core 自体は次のステップでインストールします。

---

## ステップ 1 — GSD Core のインストール

プロジェクトディレクトリでターミナルを開き、以下を実行します:

```bash
npx @opengsd/gsd-core@latest
```

インストーラーが、使用している AI コーディングランタイムとグローバルインストールかカレントプロジェクトへのインストールかを確認します。今は **Claude Code** と **local**（このプロジェクトのみ）を選択してください。

以下のような出力が表示されます:

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

プロジェクト内に `.claude/` ディレクトリが作成されます。これが GSD Core のコマンドとエージェントの格納場所です。

> ローカルとグローバルの違いについて: ローカルインストールはスキルのバージョンをこのプロジェクトに固定します。グローバルインストールを行う場合は、[ランタイムへのインストール](../how-to/install-on-your-runtime.md) を参照してください。

---

## ステップ 2 — 権限フラグ付きで Claude Code を起動

GSD Core は、ファイルの読み書きを行うサブエージェントを生成します。すべてのファイル操作に対して確認を求められないよう、権限フラグを付けて Claude Code を起動してください:

```bash
claude --dangerously-skip-permissions
```

プロジェクトディレクトリで Claude Code のプロンプトが表示されます。

---

## ステップ 3 — プロジェクトの作成

Claude Code のプロンプトで以下のスラッシュコマンドを入力します:

```text
/gsd-new-project
```

GSD Core が会話を開始し、最初に1つの質問をします:

```text
What do you want to build?
```

以下のように入力してください:

```text
A Node.js CLI tool for managing to-do items. Users run `todo add "buy milk"`,
`todo list`, and `todo done 1`. Items are saved to a local todos.json file.
No external dependencies — Node built-ins only.
```

GSD Core がいくつかの確認事項について質問します。自然に答えてください。1つのプランも書く前に、あなたの意図を理解しようとしています。

質問が終わると、ドメインリサーチの実行を提案します。この規模のプロジェクトであればリサーチをスキップできます。プロンプトが表示されたら **Skip research** を選択してください。

次に GSD Core がワークフロー設定（モード、粒度、リサーチエージェント）を選択するよう求めます。それぞれ推奨デフォルトを選択してください。これらの設定は `.planning/config.json` に書き込まれます。

最後に、ロードマッパーのサブエージェントが実行されます（「Spawning roadmapper…」という通知が表示されますが、これは正常です。約1分かかります）。完了すると、GSD Core が提案するロードマップを提示します。単一フェーズのプロジェクトでは次のようになります:

```text
Proposed Roadmap

1 phase | 4 requirements mapped | All v1 requirements covered ✓

| # | Phase              | Goal                                    | Requirements      |
|---|--------------------|-----------------------------------------|-------------------|
| 1 | Core CLI           | add / list / done commands, todos.json  | CLI-01 … CLI-04   |
```

**Approve** と入力してロードマップを承認してください。

**`.planning/` に作成されるファイル:**

```text
.planning/
  PROJECT.md          ← プロジェクトの説明と要件
  REQUIREMENTS.md     ← すべての v1 機能の REQ-ID
  ROADMAP.md          ← フェーズ 1、ステータス: pending
  STATE.md            ← セッションメモリ、現在位置
  config.json         ← ワークフロー設定
```

今すぐ `.planning/ROADMAP.md` を開いて読んでください。フェーズ 1 にはゴール、満たすべき要件のリスト、成功基準が含まれています。成功基準とは、実行によって達成すべき観測可能な動作です。

---

## ステップ 4 — コンテキストをクリアしてフェーズ 1 を議論

GSD Core はフレッシュなコンテキストを前提に設計されています。各フェーズの前にメインセッションウィンドウをクリアしてください:

```text
/clear
```

次に、フェーズ 1 の議論を開始します:

```text
/gsd-discuss-phase 1
```

GSD Core がフェーズのゴールを読み取り、実装の方針について質問します。これは「何を」作るかではなく、「どのように」作るかを決める質問です。会話の例:

```text
> How should done items be stored — mark them in place or move them?
  Mark them in place with a "done" flag.

> Should `todo list` show completed items by default?
  No, hide them unless --all is passed.

> Error format when todos.json doesn't exist yet?
  Create it silently on first add.
```

議論が終了すると、GSD Core が以下のファイルを書き込みます:

```text
.planning/phases/01-core-cli/CONTEXT.md
```

そのファイルを開いてください。`## Implementation Decisions` セクションに、あなたが述べた内容が正確に記録されています。プランナーはこのファイルを読み込みます。ここで行った決定はすべてのタスクプランに反映されます。

---

## ステップ 5 — フェーズ 1 の計画

```text
/gsd-plan-phase 1
```

4つのリサーチサブエージェントが並行して実行されます（「Spawning 4 researchers…」という通知が表示されます。1〜5分かかります。中断しないでください）。

完了すると、プランナーが CONTEXT.md とリサーチ結果を読み込み、アトミックなタスクプランを作成します。次に、プランチェッカーが各プランがフェーズのゴールを達成しているか検証してから保存します。

**作成されるファイル:**

```text
.planning/phases/01-core-cli/
  RESEARCH.md         ← ドメイン調査の結果
  01-01-PLAN.md       ← タスク: todos.json の読み書きヘルパーの作成
  01-02-PLAN.md       ← タスク: add / list / done コマンドの実装
```

`01-01-PLAN.md` を開いてください。タスク名、対象ファイル、アクションステップ、検証コマンド、完了条件が含まれた `<task>` ブロックがあります。`<verify>` タグに注目してください。GSD Core のエグゼキューターはコードを書いた後にそのコマンドを実行します。

---

## ステップ 6 — フェーズ 1 の実行

```text
/gsd-execute-phase 1
```

GSD Core はプランをウェーブ（独立したプランが並行実行される単位）にグループ化し、プランごとに新しい 200k コンテキストのエグゼキューターを生成し、各タスクをアトミックにコミットします。

以下のような出力が表示されます:

```text
Wave 1 (parallel):
  [Executor A] → 01-01-PLAN.md (read/write helpers)   ✓ committed
  [Executor B] → 01-02-PLAN.md (CLI commands)          ✓ committed

[Verifier] Checking codebase against phase goals...
  CLI-01 todo add   ✓
  CLI-02 todo list  ✓
  CLI-03 todo done  ✓
  CLI-04 --all flag ✓
  Status: PASS
```

**作成されるファイル:**

```text
.planning/phases/01-core-cli/
  01-01-SUMMARY.md    ← Executor A がビルドしてコミットした内容
  01-02-SUMMARY.md    ← Executor B がビルドしてコミットした内容
  VERIFICATION.md     ← 要件カバレッジ: PASS
```

CLI を実行してみましょう:

```bash
node todo.js add "buy milk"
node todo.js add "write tests"
node todo.js list
node todo.js done 1
node todo.js list
```

アイテムが表示され、完了マークを付けた後にアイテム 1 がデフォルトリストから消えているはずです。これが GSD Core によって実現された最初の成果です。

---

## ステップ 7 — 成果物の検証

```text
/gsd-verify-work 1
```

GSD Core がフェーズの成功基準を抽出し、それぞれについて確認します:

```text
[1/3] Can you run `node todo.js add "buy milk"` without errors?
> yes

[2/3] Does `node todo.js list` show only incomplete items by default?
> yes

[3/3] Does `node todo.js done 1` mark item 1 complete and hide it from the default list?
> yes

All 3 checks passed. Phase 1 verified.
```

いずれかのチェックが失敗した場合、GSD Core が根本原因を診断して修正プランを作成します。`/gsd-execute-phase 1` を再度実行して修正を適用し、その後 `/gsd-verify-work 1` を再実行してください。

**作成されるファイル:**

```text
.planning/phases/01-core-cli/UAT.md   ← すべてのチェックとその結果
```

---

## ステップ 8 — リリース

```text
/gsd-ship 1
```

GSD Core が自動生成された本文付きのプルリクエストを作成します。PR の本文には常に Summary、Changes、Requirements Addressed、Verification、Key Decisions が含まれます。

以下のような出力が表示されます:

```text
Pull request created: https://github.com/your-org/your-repo/pull/1

Title: feat(phase-1): core CLI — add / list / done commands
```

これが1つのフェーズにおける完全なループです。アイデアからマージされた PR まで。

---

## 学んだこと

- `npx @opengsd/gsd-core@latest` を使った GSD Core のインストール方法。
- `/gsd-new-project` が会話を `.planning/` アーティファクトに裏付けられたロードマップに変換する仕組み。
- `/gsd-discuss-phase` が計画前に実装の意思決定を記録する仕組み。
- `/gsd-plan-phase` が並行リサーチャーを生成してアトミックなタスクプランを作成する仕組み。
- `/gsd-execute-phase` がプランを並行ウェーブで実行し各タスクをコミットする仕組み。
- `/gsd-verify-work` が成功基準を確認し、必要に応じて修正プランを生成する仕組み。
- `/gsd-ship` が検証済みフェーズをプルリクエストに変換する仕組み。

マルチフェーズプロジェクトの場合は、各フェーズでステップ 4〜8 を繰り返し、`/gsd-progress --next` を実行して GSD Core に次のステップを自動検出させてください。

---

## Related

- [フェーズループ](../explanation/the-phase-loop.md) — ループがこの形状である理由
- [ハウツーガイド](../README.md#how-to-guides) — 特定の状況に対応したタスク重視のレシピ
- [既存コードベースのオンボーディング](onboarding-an-existing-codebase.md) — ブラウンフィールドリポジトリへの GSD Core の導入
