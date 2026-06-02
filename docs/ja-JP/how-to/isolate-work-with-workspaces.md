# ワークスペースで作業を分離する方法

**目標:** 独立した git ワークツリー、独自の `.planning/` ルート、そして必要に応じて複数リポジトリを持つ、完全に分離された GSD 環境をフィーチャーブランチやマルチリポジトリ作業のために作成する。

**前提条件:** `git` がインストールされており、リポジトリがワークツリーをサポートしていること。マルチリポジトリのワークスペースの場合、対象リポジトリがローカルマシン上に存在するか、パスでアクセス可能であること。

---

## ワークスペースとは

ワークスペースは、1 つ以上の git ワークツリー（またはクローン）と独自の `.planning/` ルートディレクトリを組み合わせた、自己完結型の環境です。各ワークスペースには以下が含まれます。

- ソースリポジトリの `.planning/` とは**完全に独立した**独自の `.planning/` ディレクトリ（サブディレクトリではない）
- メンバーリポジトリを追跡する独自の `WORKSPACE.md` マニフェスト
- 指定されたリポジトリの git ワークツリー（デフォルト）またはフルクローン（専用ブランチ `workspace/<name>` でチェックアウト）

ワークスペースはデフォルトで `~/gsd-workspaces/<name>/` 以下に配置されます。

```
~/gsd-workspaces/
└── feature-b/
    ├── WORKSPACE.md        ← マニフェスト
    ├── .planning/          ← 完全に独立した GSD 状態
    │   ├── PROJECT.md
    │   ├── ROADMAP.md
    │   └── ...
    ├── hr-ui/              ← hr-ui リポジトリのワークツリーまたはクローン
    └── ZeymoAPI/           ← ZeymoAPI リポジトリのワークツリーまたはクローン
```

ワークスペースの `.planning/` はソースリポジトリとは独立しているため、ソースリポジトリ内に存在する計画状態との重複や競合は発生しません。

---

## 複数リポジトリのワークスペースを作成する

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
```

GSD は `~/gsd-workspaces/feature-b/` 内に `hr-ui` と `ZeymoAPI` のワークツリーを作成し、それぞれに `workspace/feature-b` ブランチをチェックアウトし、`WORKSPACE.md` を書き込み、`/gsd-new-project` に備えた空の `.planning/` ディレクトリを作成します。

場所をカスタマイズするには：

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI --path /projects/feature-b
```

---

## 現在のリポジトリのワークスペースを作成する

単一リポジトリでフィーチャーブランチの分離が必要な場合（独立したブランチ、独立した `.planning/`、main からの状態汚染なし）：

```bash
/gsd-workspace --new --name payments-rework --repos .
```

`.` は現在のリポジトリのワークツリーを作成するよう GSD に指示します。ワークツリーは `workspace/payments-rework` でチェックアウトされます。

ワークツリーの代わりにフルクローンを強制するには：

```bash
/gsd-workspace --new --name payments-rework --repos . --strategy clone
```

---

## ブランチを明示的に指定する

```bash
/gsd-workspace --new --name payments-rework --repos . --branch feature/payments-v2
```

`--branch` フラグはワークスペース内のすべてのリポジトリのブランチ名を設定します。デフォルトは `workspace/<name>` です。

---

## 対話的な質問をスキップする

```bash
/gsd-workspace --new --name payments-rework --repos . --auto
```

GSD はプロンプトなしですべてのデフォルト値を適用します。

---

## ワークスペース内で GSD を初期化する

ワークスペースを作成したら、その中に移動して GSD プロジェクトを初期化します。

```bash
cd ~/gsd-workspaces/feature-b
/gsd-new-project
```

ワークスペース内の `.planning/` ディレクトリは、そのディレクトリから実行されるすべての GSD コマンドのルートとなります。ソースリポジトリ内に存在する `.planning/` とは完全に独立しています。

---

## ワークスペースを一覧表示する

```bash
/gsd-workspace --list
```

アクティブなすべての GSD ワークスペースとそのステータスを表示します。

---

## ワークスペースを削除する

```bash
/gsd-workspace --remove feature-b
```

GSD は git ワークツリーを削除し、ワークスペースディレクトリをクリーンアップします。リモートのブランチは削除されません。ローカルのワークツリーとワークスペースディレクトリのみが対象です。

---

## ワークストリームではなくワークスペースを選ぶ場面

ワークスペースを選ぶべき場合：

- 1 つの GSD プロジェクトとして連携させる必要がある**複数のリポジトリ**（例：一緒にリリースする API リポジトリと UI リポジトリ）にまたがって作業している
- フィーチャーごとに独自のブランチ、ロックファイル、ビルド成果物を持つ**独立した git ワークツリー**が必要（あるビルド環境での依存関係インストールが他に影響しない）
- メインリポジトリの `.planning/` のサブディレクトリではなく、**完全に独立した `.planning/` ルート**が必要
- 各トラッカーイシューをワークスペースにマッピングするイシュー駆動ワークフローを採用している（[トラッカーイシューから GSD を操作する](drive-gsd-from-a-tracker-issue.md)を参照）

代わりに[ワークストリーム](work-in-parallel-with-workstreams.md)を選ぶべき場合：

- すべての作業が**1 つのリポジトリ**内にあり、同じ git 履歴を共有している
- API、UI、インフラなどの異なる関心領域で `/gsd-plan-phase` や `/gsd-discuss-phase` を並行して実行したいが、各領域の `STATE.md` ファイル間でのコンテキスト汚染を避けたい
- 関心領域ごとに別のワークツリーは不要で、計画コンテキストの切り替えで十分

---

## Related

- [ワークストリームを使って並行して作業する](work-in-parallel-with-workstreams.md)
- [トラッカーイシューから GSD を操作する](drive-gsd-from-a-tracker-issue.md)
- [コマンドリファレンス](../COMMANDS.md)
- [ドキュメント一覧](../README.md)
