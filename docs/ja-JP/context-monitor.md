# コンテキストウィンドウモニター

ツール使用後に実行されるフック（Claude Code では `PostToolUse`、Gemini CLI では `AfterTool`）で、コンテキストウィンドウの使用量が高くなった際にエージェントに警告します。

## 問題

ステータスラインはコンテキスト使用量を**ユーザー**に表示しますが、**エージェント**自身はコンテキストの制限を認識していません。コンテキストが不足すると、エージェントは限界に達するまで作業を続行し、状態を保存できないままタスクの途中で止まる可能性があります。

## 仕組み

1. ステータスラインフックがコンテキストメトリクスを `/tmp/claude-ctx-{session_id}.json` に書き込む
2. 各ツール使用後、コンテキストモニターがこのメトリクスを読み取る
3. 残りコンテキストがしきい値を下回ると、`additionalContext` として警告を注入する
4. エージェントが会話内で警告を受け取り、適切に対応できる

## しきい値

| レベル | 残量 | エージェントの動作 |
|-------|-----------|----------------|
| Normal | > 35% | 警告なし |
| WARNING | <= 35% | 現在のタスクをまとめ、新しい複雑な作業の開始を避ける |
| CRITICAL | <= 25% | 即座に停止し、状態を保存する（`/gsd-pause-work`） |

## デバウンス

エージェントへの繰り返し警告を防ぐため：
- 最初の警告は即座に発火
- 以降の警告は間に 5 回のツール使用が必要
- 深刻度のエスカレーション（WARNING -> CRITICAL）はデバウンスをバイパス

## アーキテクチャ

```
Statusline Hook (gsd-statusline.js)
    | writes
    v
/tmp/claude-ctx-{session_id}.json
    ^ reads
    |
Context Monitor (gsd-context-monitor.js, PostToolUse/AfterTool)
    | injects
    v
additionalContext -> Agent sees warning
```

ブリッジファイルはシンプルな JSON オブジェクトです：

```json
{
  "session_id": "abc123",
  "remaining_percentage": 28.5,
  "used_pct": 71,
  "timestamp": 1708200000
}
```

## GSD との統合

GSD の `/gsd-pause-work` コマンドは実行状態を保存します。WARNING メッセージはこのコマンドの使用を提案し、CRITICAL メッセージは即座の状態保存を指示します。

## セットアップ

両フックは `npx @opengsd/gsd-core` のインストール時に自動的に登録されます——通常の状況では手動の手順は不要です。フック設定の詳細、しきい値のオーバーライド、手動登録の例については、[設定](CONFIGURATION.md) を参照してください。

簡単な参考として：ステータスラインフックは `settings.json` に `statusLine` として登録されます；コンテキストモニター（`gsd-context-monitor.js`）は `PostToolUse` フックとして登録されます（Gemini CLI の場合は `AfterTool`）。どちらのエントリも、インストーラーを実行した Node 実行ファイルの絶対パスを使います。Windows PowerShell では、引用符付きの実行ファイルパスに `&` をプレフィックスしてください。

## 安全性

- フックは全体を try/catch で囲み、エラー時はサイレントに終了
- ツール実行をブロックしない — モニターが壊れてもエージェントのワークフローを壊してはならない
- 古いメトリクス（60 秒以上前）は無視
- ブリッジファイルが存在しない場合も正常に処理（サブエージェント、新規セッション）

---

## Related

- [アーキテクチャ](ARCHITECTURE.md)
- [設定](CONFIGURATION.md)
- [ドキュメント索引](README.md)
