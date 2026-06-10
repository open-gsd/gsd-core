# GSD Core ドキュメント

ドキュメントは 4 つの象限で構成されています。**チュートリアル**は実践で学ぶ、**ハウツーガイド**は特定のタスクを解決する、**リファレンス**は信頼できる情報を示す、**解説**はコンセプトと設計上の決定を探求する。

言語バージョン: [English](../) · [Português (pt-BR)](../pt-BR/README.md) · **日本語** · [简体中文](../zh-CN/README.md) · [한국어](../ko-KR/README.md)

---

## チュートリアル

- [はじめてのプロジェクト](tutorials/your-first-project.md) — インストールから最初のフェーズ出荷まで、確実な一本道
- [既存コードベースのオンボーディング](tutorials/onboarding-an-existing-codebase.md) — ブラウンフィールドのリポジトリに GSD Core を導入する

---

## How-to guides

- [ランタイムへのインストール](how-to/install-on-your-runtime.md) — サポートされる全 16 ランタイムのランタイム別インストール手順
- [フェーズを議論する](how-to/discuss-a-phase.md) — 計画を始める前に実装上の決定事項を記録する
- [フェーズを計画する](how-to/plan-a-phase.md) — リサーチを実行し、作業を分解し、計画の品質を検証する
- [フェーズを実行する](how-to/execute-a-phase.md) — 新鮮なコンテキストのサブエージェントで並列ウェーブとして計画を実行する
- [検証と出荷](how-to/verify-and-ship.md) — 完成した作業を確認し、障害を診断し、PR を作成する
- [フェーズを自律的に実行する](how-to/run-phases-autonomously.md) — 無人フェーズ実行に自律モードを使用する
- [クイックおよびファストタスクを処理する](how-to/handle-quick-and-fast-tasks.md) — フェーズループ外のアドホック作業に `/gsd-quick` と `/gsd-fast` を使用する
- [モデルプロファイルを設定する](how-to/configure-model-profiles.md) — クオリティ・バランス・バジェットのモデルティア間を切り替える
- [クロス AI レビューをセットアップする](how-to/set-up-cross-ai-review.md) — プライマリエージェントが生成したコードをレビューする 2 番目の AI を設定する
- [ワークストリームで並列作業する](how-to/work-in-parallel-with-workstreams.md) — ワークストリームを使って独立した作業ラインを同時に実行する
- [ワークスペースで作業を隔離する](how-to/isolate-work-with-workspaces.md) — ワークスペースを使って実験的またはリスクのある変更をサンドボックス化する
- [失敗した実行をデバッグする](how-to/debug-a-failed-execution.md) — 壊れたまたは不完全なフェーズ実行を診断・回復する
- [スパイクとスケッチ](how-to/spike-and-sketch.md) — 計画を確定する前の探索的作業に `/gsd-spike` と `/gsd-sketch` を使用する
- [UI フェーズを設計する](how-to/design-a-ui-phase.md) — フロントエンドおよびビジュアル作業に UI フェーズループを使用する
- [トラッカーイシューから GSD を動かす](how-to/drive-gsd-from-a-tracker-issue.md) — GitHub、Linear、または Jira のイシューからフェーズを開始する
- [GSD 2 から移行する](how-to/migrate-from-gsd-2.md) — 既存の GSD 2 プロジェクトを GSD Core にアップグレードする
- [GSD をアップデートする](how-to/update-gsd.md) — インストーラーを再実行して最新リリースを取得する
- [回復とトラブルシューティング](how-to/recover-and-troubleshoot.md) — よくある問題を修正し、コンテキストを再構築し、アンインストールする

---

## リファレンス

- [コマンド](COMMANDS.md) — フラグと例を含むすべてのコマンド
- [設定](CONFIGURATION.md) — 完全な設定スキーマ、モデルプロファイル、Git ブランチ戦略
- [CLI ツール](CLI-TOOLS.md) — ワークフローとエージェント向け `gsd-tools.cjs` プログラマティック API
- [機能](FEATURES.md) — 完全な機能インデックス
- [インベントリ](INVENTORY.md) — インストール済みスキルとサーフェスマップ
- [STATE.md スキーマ](reference/state-md.md) — `.planning/STATE.md` のフィールド別リファレンス
- [CONTEXT.md スキーマ](reference/context-md.md) — `.planning/phases/<N>/CONTEXT.md` のフィールド別リファレンス
- [PLAN.md スキーマ](reference/plan-md.md) — `.planning/phases/<N>/PLAN.md` のフィールド別リファレンス
- [計画アーティファクト](reference/planning-artifacts.md) — すべての `.planning/` ファイルとその役割

---

## 解説

- [コンテキストエンジニアリング](explanation/context-engineering.md) — コンテキストの腐敗がどのように形成され、GSD Core がどのように防ぐか
- [フェーズループ](explanation/the-phase-loop.md) — Discuss → Plan → Execute → Verify → Ship サイクルの設計理念
- [マルチエージェントオーケストレーション](explanation/multi-agent-orchestration.md) — サブエージェントがどのように生成・スコープ設定・調整されるか
- [セキュリティモデル](explanation/security-model.md) — 信頼境界、パーミッション、安全な自動化
- [アーキテクチャ](ARCHITECTURE.md) — システムアーキテクチャ、エージェントモデル、データフロー
- [ディスカスモード](workflow-discuss-mode.md) — `/gsd-discuss-phase` の assumptions モードと interview モード
- [コンテキストモニタリング](context-monitor.md) — コンテキストウィンドウ監視フックのアーキテクチャ
- [イシュー駆動オーケストレーション](issue-driven-orchestration.md) — 既存のプリミティブを使ってトラッカーイシューから GSD を動かすレシピ

---

## Related

- [ルート README](../README.md) — ランディングページ、クイックスタート、ドキュメント概要
- [変更履歴](../../CHANGELOG.md) — リリース履歴
