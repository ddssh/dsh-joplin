# dsh-joplin

**[DeepSeek Harness](https://github.com/deepseek-ai) 向けの Joplin ノートプラグイン** — エージェントがローカルの Joplin ノートを読み書きできるようにします。検索、全文読み出し、作成、ノートブック管理、バックリンクに対応。デフォルトは読み取り専用で、実行時の依存はゼロです。

[English](./README.md) · [简体中文](./README.zh-CN.md) · **日本語** · [한국어](./README.ko.md)

[![npm version](https://img.shields.io/npm/v/dsh-joplin.svg)](https://www.npmjs.com/package/dsh-joplin)
[![npm downloads](https://img.shields.io/npm/dm/dsh-joplin.svg)](https://www.npmjs.com/package/dsh-joplin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

---

## 主な機能

- **依存ゼロ**: Node の組み込みモジュール（`node:http` / `node:fs`）のみを使用します。Python、uv、常駐するサイドカープロセス、ビルド手順はいずれも不要です。
- **10 個のツール**: 検索、全文読み出し、ノート/ノートブックの作成、Markdown の取り込み、出リンク/バックリンク、診断。
- **デフォルトで最小権限**: 作成はオン、**更新と削除はオフ**。機能が無効な場合、ツールはリクエストを送る*前に*例外を投げるため、Joplin に一切触れません。
- **プライバシー優先**: 接続先は設定したローカルアドレスのみで、アップロードもテレメトリもありません。さらに、ノートの内容を外部へ送ることを禁じる常設のプロンプトルールを登録します。
- **ノートブックパス**: `Work/ProjectA` のような完全パス、id、一意なタイトルを受け付けます。曖昧な場合は推測せず、エラーとして報告します。
- **検索のフォールバック**: Joplin の全文検索エンドポイントが応答しない場合、プラグインはローカルスキャンへフォールバックし、結果に `engine` を付与します。
- **書き込み検証**: すべての書き込みは直後に読み戻して照合するため、本文が壊れた場合は静かに壊れるのではなく明確に失敗します。

## 動作環境

1. **Joplin デスクトップ版**がインストールされ、起動していること。
2. 「ツール → オプション → Web Clipper」で **Web Clipper サービス**が有効になっていること（デフォルトポート `41184`）。
3. 同じ画面で **API token** をコピーしておくこと。
4. DSH（DeepSeek Harness）のホスト側に Node.js **>= 20** があること。

> 対応するのは Joplin デスクトップ版の Web Clipper データ API のみです。Joplin Cloud とモバイルアプリは別の API を公開しているため動作しません。

## インストール

### 方法 1: npm レジストリ（[dsh-joplin](https://www.npmjs.com/package/dsh-joplin)）

```text
plugin_manager(action: "install_bundle", target: "dsh-joplin")
```

または:

```bash
dsh plugin --profile <profile> add dsh-joplin
```

### 方法 2: GitHub から

DSH がリポジトリをプロファイルへ直接インストールします:

```text
plugin_manager(action: "install_bundle", target: "github:ddssh/dsh-joplin")
```

### 方法 3: ローカルディレクトリから

```bash
git clone https://github.com/ddssh/dsh-joplin.git
```

次に、そのディレクトリを `target` として `install_bundle` に渡すか、または:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-joplin
```

インストール後に `joplin_*` ツールが登録されます。本プラグインはクライアント側を持たない純粋な Host プラグインなので、通常は再起動不要です。ただし **プラグインの JS を編集した後は再起動が必要**です（Node はインポート済みモジュールをキャッシュするため）。

## 設定

設定は優先度の高い順に 3 つの層から解決され、最初に見つかった空でない値が採用されます:

| 優先度 | 取得元 | 備考 |
| --- | --- | --- |
| 1 | `~/.dsh/joplin.json` | **推奨**: 即座に反映され、token を profile の YAML に置かずに済みます |
| 2 | 環境変数 `JOPLIN_TOKEN`、`JOPLIN_BASE_URL`、`JOPLIN_TIMEOUT_MS`、`JOPLIN_DEFAULT_NOTEBOOK`、`JOPLIN_ALLOW_CREATE` / `JOPLIN_ALLOW_UPDATE` / `JOPLIN_ALLOW_DELETE` | Harness の再起動が必要です |
| 3 | プラグイン設定（Settings、または profile 内の `cordis.patch.yml`） | `baseUrl`、`token`、`timeoutMs`、`defaultNotebook`、`allowCreate`、`allowUpdate`、`allowDelete` |

最小構成:

```bash
cat > ~/.dsh/joplin.json <<'JSON'
{
  "token": "your-web-clipper-token",
  "baseUrl": "http://127.0.0.1:41184"
}
JSON
chmod 600 ~/.dsh/joplin.json
```

任意フィールド: `defaultNotebook`（新しいノートの作成先。例: `Work/ProjectA`）、`timeoutMs`、`allowCreate` / `allowUpdate` / `allowDelete`。

設定が済んだら、まず `joplin_status` を呼び出してください。token がどの層から取得されたか、サービスに到達できるか、ノートブックがいくつあるかを報告します。

## ツール

| ツール | 動作 | デフォルト権限 |
| --- | --- | --- |
| `joplin_status` | 診断: token の取得元、接続性、ノートブック数、最近の更新 | 読み取り専用 |
| `joplin_list_notebooks` | 完全パスと id を含むノートブックツリー | 読み取り専用 |
| `joplin_search_notes` | スニペット付きのキーワード検索。`query` を空にして `notebook` を指定すると、そのノートブックのノートを一覧します | 読み取り専用 |
| `joplin_get_note` | ノートの全文: 本文、ノートブック、タグ、内部リンク | 読み取り専用 |
| `joplin_find_linked_notes` | 内部リンク `:/<id>` による**出リンクとバックリンク** | 読み取り専用 |
| `joplin_create_note` | ノートの作成（ノートブック指定可、ToDo として作成可） | `allowCreate`（オン） |
| `joplin_create_notebook` | ノートブックまたはサブノートブックの作成 | `allowCreate`（オン） |
| `joplin_import_markdown` | ローカルの `.md` ファイルをノートとして取り込み | `allowCreate`（オン） |
| `joplin_update_note` | タイトル/本文/ノートブック/ToDo の変更。渡したフィールドのみ変更します | `allowUpdate`（**オフ**）+ `user_confirmed` |
| `joplin_delete_note` | 削除。デフォルトはゴミ箱へ、`permanent: true` で完全削除 | `allowDelete`（**オフ**）+ `user_confirmed` |

ノートブック引数には、32 文字の id、一意なタイトル、または完全パス（`Work/ProjectA`）を指定できます。曖昧な入力では候補を列挙したエラーが発生します。

## 権限とプライバシー

### 3 つの書き込み権限（デフォルトで最小権限）

| 機能 | 設定 | デフォルト |
| --- | --- | --- |
| ノート / ノートブックの作成、Markdown の取り込み | `allowCreate` | **オン** |
| 既存ノートの変更（タイトル/本文/ノートブック/ToDo） | `allowUpdate` | **オフ** |
| ノートの削除 | `allowDelete` | **オフ** |

- 機能が無効な場合、ツールは**書き込みリクエストを一切送らずに例外を投げます**。
- 更新/削除を有効にした場合でも、呼び出し側は追加で `user_confirmed: true` を渡す必要があります。これは、ユーザーがこのターンでそのノートを明示的に指定したことを意味します。
- 解決順序は「設定ファイル > 環境変数 > プラグイン設定 > デフォルト」なので、権限を厳しくしても古い設定に妨げられることはありません。

```json
{ "token": "…", "allowUpdate": true }
```

### プライバシー

- 接続先は設定された `baseUrl`（デフォルト `http://127.0.0.1:41184`）のみで、**アップロードもテレメトリもありません**。
- 常設のプロンプトルール（`JOPLIN_NOTES`）を登録し、ノートの本文とスニペットを web 検索、ブラウザ、サブエージェント、その他のツールに送らないよう要求します。
- Markdown の取り込みでは、ファイルの内容をローカルの Joplin インスタンスにのみ送信します。

## 既知の問題（Joplin 側）

いずれも Joplin デスクトップ版 **3.7.18** で再現を確認しており、プラグイン側で回避しています:

1. **全文検索が応答しないことがある**: `GET /search?query=…` が返らない場合がありますが、`title:` 検索、`/folders`、`/notes` は高速なままです。
   プラグインは 8 秒後にローカルスキャンへフォールバックし（260 ノートで約 13 ms）、停止したエンドポイントを 10 分間スキップします。`mode: "local"` を指定するとローカルスキャンを強制できます。
2. **大きな本文は書き込み時に破損する**: リクエスト本文に生のマルチバイト UTF-8 が含まれ、かつ本文が大きい場合、本文テキスト約 16 KB ごとに `U+FFFD` が 1 文字現れます（クライアント非依存で、Python でも再現します）。
   プラグインは送信するすべての JSON ペイロードを ASCII エスケープ（`\uXXXX`）し、**書き込み後にノートを読み戻します**。不一致の場合はノートを静かに壊すのではなく `WRITE_VERIFY_FAILED` を発生させます。

## 開発とテスト

```bash
npm test          # starts an in-memory mock Joplin and exercises all 10 tools
```

スモークテストは、ノートブックツリー/パス解決、キーワード検索、ノートブック単位のノート一覧、全文読み出し、出リンク/バックリンク、作成/更新/削除、サブノートブック作成、Markdown 取り込み、3 層の設定、権限ゲート（更新/削除がデフォルトで拒否されディスクに触れないこと、`user_confirmed` の検証）、検索失敗時のフォールバック、ASCII エスケープを対象としています。

### ディレクトリ構成

```
dsh-joplin/
├── package.json          # bundle manifest: dsh.bundle.patch / icon / locale
├── cordis.patch.yml      # inserts the Host plugin row (id: dsh-joplin)
├── index.js              # Config (schemastery) + apply: tools and prompt rules
├── joplin-tools.js       # settings resolution, notebook resolution, search/link graph, tool definitions
├── joplin-client.js      # node:http client (timeouts, error translation, ASCII escaping)
├── icon.svg / locale/    # plugin card presentation
└── test/                 # mock Joplin server + smoke test
```

## クレジット

機能セットは [dweigend/joplin-mcp-server](https://github.com/dweigend/joplin-mcp-server)（Python + FastMCP）に準拠しています。本プラグインは DSH 向けにネイティブ Node で書き直したものであり、CRUD、ノートブックツリー、Markdown 取り込み、バックリンクを維持しつつ、権限ゲート、検索フォールバック、書き込み検証を追加しています。また、API がフラットなリストを返す際に元実装でノートブックパスが退化する問題も修正しています。

## ライセンス

[MIT](./LICENSE)
