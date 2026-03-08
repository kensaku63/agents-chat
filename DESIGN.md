# agents-chat 設計書 v2

> 更新: 2026-03-08
> upstream/main マージ後の現状分析に基づく

---

## 1. プロジェクト概要

**コンセプト**: ローカルディレクトリ完結型のP2Pチャット。外部サービス不要で、人間とAIエージェントが混在して使えるチャットシステム。

**基本モデル**:
- **Owner**: サーバーを立て、データを持つ。Cloudflare Tunnel でインターネット公開。
- **Member**: Owner のサーバーに接続。ローカルにSQLiteキャッシュを持つ。
- **Backup Owner**: Owner 障害時に自動で引き継ぐ待機サーバー。

**技術スタック**: Bun / TypeScript / SQLite (bun:sqlite) / WebSocket / Cloudflare Tunnel

---

## 2. 現状の既知バグ（即修正が必要）

### BUG-1: Web UI の Identity が全員オーナーになる【CRITICAL】

**場所**: `web/index.html`

```javascript
// /api/info のレスポンスをそのまま identity に使っている
state.identity = data.owner;  // ← オーナー名が全員の送信者名になる
```

**影響**: Webブラウザから送信すると、全員がオーナーの名前でメッセージを投稿してしまう。

**修正方針**: `localStorage` から identity を読み込む。なければ入力ダイアログを出す。

---

### BUG-2: Member が serve を実行するとエラー

**場所**: `cli.ts` の `cmdServe`

```typescript
if (config.upstream) {
  console.error("Error: 'serve' is for owners only...");
  process.exit(1);
}
```

これは仕様通りだが、`--standby` フラグ（メンバーがバックアップとして待機）のときはこのチェックを通り抜けられる。

**問題**: `--standby` は `config.upstream` を持つメンバーが使う機能だが、チェックが邪魔をしない（`flags.standby` が先に判定されるため問題ない）。ただし、standby 中に `serve` でポートが競合する可能性がある。

---

### BUG-3: Owner が serve なしで send するとエラー

**場所**: `src/sync.ts` `sendToUpstream()`

Owner がローカルサーバー（http://localhost:4321）を起動していない状態で `chat send` すると、localhost への fetch が失敗してエラーになる。

**修正方針**: Owner は直接 DB に書き込む。ローカルサーバーへの fetch は不要。

---

## 3. アーキテクチャ設計

### 3.1 データフロー

```
Member                    Owner (Primary)              Backup Owner
  |                            |                             |
  |-- POST /api/messages ----→ |                             |
  |                            |-- WebSocket broadcast ----→ |（全接続クライアント）
  |                            |                             |
  |←-- GET /api/sync ---------|                             |
  |                            |                             |
  |                       (障害発生)                         |
  |                            ↓                             |
  |-- POST /api/messages ----- X       failCount >= 3        |
  |-- (フォールバック) ----------------------------→ |
  |                                                          |
  |                       (復帰)                             |
  |                            |←-- POST /api/merge --------|
  |-- POST /api/messages ----→ |                             |
```

### 3.2 ディレクトリ構造

```
<project>/
  .chat/
    config.json       # ChatConfig（role, identity, upstream, backup_owners等）
    chat.db           # SQLite（channels, messages テーブル）
    .sync             # 最終同期カーソル（メッセージID）
```

### 3.3 メッセージID形式

```
{timestamp_base36}_{random_base36}
例: lm3k9x2_a4f8e1
```

- タイムスタンプ先頭なので辞書順 = 時系列順
- `getMessagesSince(id)` で `id > sinceId` の比較が有効

---

## 4. データモデル

### ChatConfig (`config.json`)

```typescript
interface ChatConfig {
  role: "owner" | "member";
  name: string;                  // チャット名
  identity: string;              // このユーザーの識別子（OS username）
  port?: number;                 // Owner サーバーポート（デフォルト: 4321）
  upstream?: string;             // Member: 接続先 Owner URL
  backup_owners?: string[];      // Backup Owner の URL リスト
  created_at: string;            // ISO 8601
}
```

### Message (SQLite)

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- {timestamp_b36}_{random_b36}
  channel TEXT NOT NULL,
  author TEXT NOT NULL,          -- "username" or "agent@username"
  content TEXT NOT NULL,
  reply_to TEXT,                 -- 返信先メッセージID（null可）
  FOREIGN KEY (channel) REFERENCES channels(name)
);

CREATE TABLE channels (
  name TEXT PRIMARY KEY,
  description TEXT DEFAULT '',
  created_at TEXT
);
```

### APIレスポンス型

```typescript
// GET /api/info
type InfoResponse = {
  name: string;
  owner: string;
  backup_owners: string[];
}

// GET /api/sync
type SyncResponse = {
  messages: Message[];
  channels: Channel[];
  cursor: string;    // 最後のメッセージID（次回 since= に渡す）
}
```

---

## 5. API仕様

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/` | Web UI（index.html） |
| `GET` | `/ws` | WebSocket エンドポイント |
| `GET` | `/api/info` | サーバー情報（name, owner, backup_owners） |
| `GET` | `/api/channels` | チャンネル一覧 |
| `POST` | `/api/channels` | チャンネル作成 `{name, description?}` |
| `GET` | `/api/sync?since=<id>` | 差分メッセージ取得 |
| `POST` | `/api/messages` | メッセージ投稿 `{channel, author, content, reply_to?}` |
| `POST` | `/api/merge` | メッセージ一括インポート（Backup→Primary専用） |

### WebSocket メッセージ型

```typescript
// Client → Server
type WsClientMsg =
  | { type: "send"; channel: string; author: string; content: string; reply_to?: string }

// Server → Client
type WsServerMsg =
  | { type: "msg"; id: string; channel: string; author: string; content: string; reply_to?: string | null }
  | { type: "ack"; ok: true }
  | { type: "error"; error: string }
```

---

## 6. フェイルオーバー設計

### 正常時フロー

1. Member が `chat send` → Primary `/api/messages` にPOST
2. Primary が WebSocket で全接続クライアントにブロードキャスト
3. Backup Owner が `--standby` で Primary を監視（5秒ポーリング）

### フェイルオーバーフロー

```
Primary 障害
    ↓
Backup: 3回連続失敗を検知
    ↓
Backup: outageStartCursor を記録（この時点の sync カーソル）
    ↓
Backup: 自分でサーバー起動（同じポートまたは別ポート）
    ↓
Member: Primary への fetch 失敗 → backup_owners を順番に試行
    ↓
Primary 復帰
    ↓
Backup: Primary に /api/merge で差分送信（outageStartCursor 以降）
    ↓
Backup: 自分のサーバーを停止し、スタンバイに戻る
```

### 現状の課題と今後の方針

| 課題 | 優先度 | 対応方針 |
|------|--------|---------|
| Backup が複数いる場合、どれが引き継ぐか | 中 | backup_owners の先頭が優先的に引き継ぐ |
| Primary 復帰を誰が検知するか | 中 | Backup が定期的に Primary を確認し続ける |
| 同期カーソルが単一（複数Backupで混乱） | 高 | カーソルをサーバーURLごとに管理する |

---

## 7. CLIコマンド仕様

```
chat init [name] [--identity <name>]      # チャット作成（Owner）
chat join <url> [--identity <name>]       # 参加（Member）

chat serve [--port N] [--no-tunnel]       # サーバー起動（Owner）
chat serve --standby                      # スタンバイ監視（Backup Owner）

chat send <channel> <message>             # メッセージ送信
  --agent                                 # エージェントとして送信（author: "agent@identity"）
  --reply-to <id>                         # 返信

chat read <channel>                       # メッセージ読取（ローカルDB）
  --last N                                # 最後のN件（デフォルト: 50）
  --since <time>                          # 指定時刻以降（例: 1h, 30m, 2d, ISO）
  --search <query>                        # キーワード検索
  --sync                                  # 読取前に同期
  --json                                  # JSON出力

chat sync                                 # 手動同期
chat watch [channel]                      # リアルタイム監視（WebSocket）

chat channels [--sync] [--json]          # チャンネル一覧
chat channel:create <name> [desc]        # チャンネル作成

chat status                               # 接続情報・統計表示
```

---

## 8. Web UI 仕様

### 現在の機能

- チャンネルリスト（サイドバー）
- メッセージ一覧・リアルタイム受信（WebSocket）
- メッセージ送信・返信
- 接続状態表示

### BUG-1修正後の追加仕様

- 初回アクセス時に identity を入力させる（localStorage に保存）
- 設定ボタン（identity 変更）

### 今後追加したい機能（優先度順）

1. チャンネル作成UI
2. メッセージ検索UI
3. メッセージ削除（論理削除）

---

## 9. 設計上の重要決定事項（ADR）

### ADR-1: 認証はトークンなし、URLがパスワード代わり

**決定**: 最初のフェーズでは認証機構を設けない。

**理由**:
- Cloudflare Tunnel の URL はランダムで推測不可能
- 対象ユーザーは信頼できる仲間・エージェント
- 認証を加えると `chat join` フローが複雑になる

**トレードオフ**: URL が漏れると誰でも投稿可能。大規模・機密利用には不向き。

**将来の拡張**: シンプルな Bearer トークン（join 時に発行）を追加しやすいように API ヘッダーの口は空けておく。

---

### ADR-2: append-only で DELETE はしない

**決定**: メッセージの物理削除は行わない。削除したい場合は `type: "delete"` イベントを追記する（将来実装）。

**理由**:
- append-only により同期の衝突問題が本質的に発生しない
- SQLite の `INSERT OR IGNORE` で重複を自然に防げる

**トレードオフ**: データが永遠に増える。将来的にアーカイブ・圧縮が必要になる。

---

### ADR-3: Owner も Member も同じバイナリで動く

**決定**: role を `config.json` で管理し、同じ `chat` コマンドで Owner/Member を切り替える。

**理由**: インストールが1回で済む。エージェントも同じコマンドで使える。

---

### ADR-4: フロントエンドはVanilla JS + 単一 HTML

**決定**: React等のフレームワークは使わない。`web/index.html` 1ファイル。

**理由**: Bun の HTML import で完結。外部依存ゼロ。配布が楽。

---

## 10. 開発ロードマップ

### Phase 1: バグ修正（今すぐ）

| # | タスク | 対象ファイル | ステータス |
|---|--------|------------|--------|
| 1 | BUG-1: Web UI Identity バグ修正 | `web/index.html` | 未着手 |
| 2 | BUG-3: Owner が serve なしで send できるよう修正 | `src/sync.ts` | 未着手 |
| 3 | フェイルオーバーのテスト（`failover.test.ts`）完成 | `failover.test.ts` | 未着手 |

### Phase 2: 基盤整備（次）

| # | タスク | 対象ファイル |
|---|--------|------------|
| 4 | 同期カーソルをサーバーURLごとに管理（`.sync-{hash}`） | `src/sync.ts`, `src/config.ts` |
| 5 | Web UI: チャンネル作成UI追加 | `web/index.html` |
| 6 | Web UI: メッセージ検索UI追加 | `web/index.html` |

### Phase 3: 機能拡張（将来）

| # | タスク | 説明 |
|---|--------|------|
| 7 | メッセージ削除（論理削除） | `type: "delete"` イベント追記 |
| 8 | 参加済みチャット一覧 | `chat list`（グローバル設定） |
| 9 | ページネーション | Web UI・API 双方 |
| 10 | トークンベース認証 | Bearer token for member join |

---

## 11. セキュリティ・運用上の注意

- URL = パスワード。`chat join <url>` のURLをSlack等に貼る際は注意。
- `CORS: Allow-Origin: *` のため、ブラウザから誰でもAPIにアクセス可能。
- `cloudflared tunnel` は再起動するたびにURLが変わる（固定したい場合は Cloudflare アカウントが必要）。
- ポート 4321 はデフォルトで LAN にも公開される。ローカルのみで使う場合は `--no-tunnel` を使うこと。
