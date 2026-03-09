# SPEC: Per-Reader Unread Management

## Problem

現在の未読管理は `.chat/.read_cursor`（単一ファイル）で全エージェント・全ユーザーが共有している。

- `directore` が `chat unread` を実行 → カーソルが進む → `plan-kun` の未読が消える
- 旧 `--for` フラグはメンションフィルターのみで、カーソルは全体で共有のまま進んでいた
- エージェントごとに関心のあるチャンネルが異なるのに、全チャンネルの未読が混在する

## Solution

リーダー（人間・エージェント）ごとに独立した既読カーソルを持たせる。

## Design

### 1. Storage: `read_cursors/` ディレクトリ

`.chat/.read_cursor`（単一テキストファイル）を廃止し、`.chat/read_cursors/` ディレクトリに移行。リーダーごとに1ファイル。

```
.chat/read_cursors/
  kensaku       → m1abc_123
  directore     → m1abc_456
  plan-kun      → m1abc_400
```

- ファイル名: リーダー名（人間名またはエージェント名）
- ファイル内容: 最後に読んだメッセージ ID（プレーンテキスト）
- 1リーダー1ファイルなので、並行書き込みの競合が発生しない
- 旧 `.read_cursor` は無視（移行処理なし。各リーダーの初回実行でカーソルが作られる）

### 2. CLI: `chat unread <reader>`

```
chat unread <reader> [--peek] [--text]
```

- `<reader>`: 必須の位置引数。リーダー名を指定する。
- `--peek`: カーソルを更新しない
- `--text`: テキスト出力

#### Validation（エラー優先、フォールバックなし）

| 判定 | 条件 | 未読取得範囲 |
|------|------|-------------|
| Agent | `getAgentConfigs()` に存在 | 購読チャンネル + 全チャンネルからの @メンション |
| Human | `members` テーブルに `type='human'` で存在 | 全チャンネル（`_system` 除外） |
| Error | どちらにも該当しない | `Error: Unknown reader "<name>". Register as agent (chat agent create) or ensure member exists.` |

```bash
# OK: 登録済みエージェント
$ chat unread directore

# OK: 既知の人間メンバー
$ chat unread kensaku

# Error: 未登録の名前
$ chat unread typo-name
Error: Unknown reader "typo-name". Register as agent (chat agent create) or ensure member exists.
```

### 3. Agent channel filtering

エージェントの `agent_config.channels` を購読チャンネルとして使用する。新しいフィールドは追加しない。

```
agent_config.channels = ["planning", "general"]
```

未読取得ロジック（エージェント、購読チャンネルあり）:

```sql
SELECT * FROM messages
WHERE id > :cursor
  AND (
    channel IN (:subscribed_channels)   -- 購読チャンネルは全メッセージ
    OR content LIKE '%@agent_name%'     -- 他チャンネルはメンションのみ
  )
  AND channel != '_system'
ORDER BY id ASC
```

エージェント、購読チャンネルなし（`channels: []`）:

```sql
-- メンションのみ返す（全メッセージにフォールバックしない）
SELECT * FROM messages
WHERE id > :cursor
  AND content LIKE '%@agent_name%'
  AND channel != '_system'
ORDER BY id ASC
```

人間の場合:

```sql
SELECT * FROM messages
WHERE id > :cursor
  AND channel != '_system'
ORDER BY id ASC
```

### 4. Cursor isolation

各リーダーのカーソルは完全に独立:

- `chat unread directore` → `directore` のカーソルのみ更新
- `chat unread plan-kun` → `plan-kun` のカーソルのみ更新
- `chat unread kensaku` → `kensaku` のカーソルのみ更新
- 他のリーダーのカーソルには一切影響しない

### 5. Agent onboarding

新エージェント作成後、エージェント自身が以下のフローを実行する（特別なコマンドは不要）:

```bash
# 1. 自分の設定を確認
chat agent list --text

# 2. 購読チャンネルのサマリーを取得
chat summary latest planning
chat summary latest general

# 3. 最近のメッセージを読む
chat read planning --last 50
chat read general --last 50

# 4. 重要な情報をメモリに保存
chat memory add "planningチャンネルの方針: ..." --agent-name <name> --tag onboarding
chat memory add "generalの重要な決定: ..." --agent-name <name> --tag onboarding

# 5. 未読カーソルを現在位置にセット（過去分を既読にする）
chat unread <name>
```

## Changes

### src/config.ts

```typescript
export function readReaderCursor(chatDir: string, reader: string): string {
  const p = join(chatDir, "read_cursors", reader);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8").trim();
}

export function writeReaderCursor(chatDir: string, reader: string, cursor: string): void {
  const dir = join(chatDir, "read_cursors");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, reader), cursor);
}
```

1リーダー1ファイルなので read-modify-write の競合は発生しない。

### src/db.ts

```typescript
// Before
export function getUnreadMessages(db: Database, sinceId: string, forName?: string): Message[]

// After
export function getUnreadMessages(
  db: Database,
  sinceId: string,
  opts?: {
    channels?: string[];    // 購読チャンネル（エージェント用）
    mentionName?: string;   // メンション検出名（エージェント用）
  }
): Message[]
```

実装:

```typescript
export function getUnreadMessages(
  db: Database,
  sinceId: string,
  opts?: { channels?: string[]; mentionName?: string }
): Message[] {
  const conds: string[] = ["channel != '_system'"];
  const params: any[] = [];

  if (sinceId) {
    conds.push("id > ?");
    params.push(sinceId);
  }

  if (opts?.mentionName) {
    if (opts.channels && opts.channels.length > 0) {
      const placeholders = opts.channels.map(() => "?").join(", ");
      conds.push(`(channel IN (${placeholders}) OR content LIKE ?)`);
      params.push(...opts.channels, `%@${opts.mentionName}%`);
    } else {
      conds.push("content LIKE ?");
      params.push(`%@${opts.mentionName}%`);
    }
  }

  const where = `WHERE ${conds.join(" AND ")}`;
  return db.prepare(`SELECT * FROM messages ${where} ORDER BY id ASC`).all(...params) as Message[];
}
```

### cli.ts — `cmdUnread`

```typescript
async function cmdUnread(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const reader = positional[0];

  if (!reader) {
    console.error('Error: Reader name required. Usage: chat unread <reader> [--peek] [--text]');
    process.exit(1);
  }

  const chatDir = requireChatDir();
  const config = readConfig(chatDir);
  if (config.upstream) await sync(chatDir);

  const db = openDb(chatDir);
  const agents = getAgentConfigs(db);
  const members = getMembers(db);
  const isAgent = !!agents[reader];
  const isHuman = members.some(m => m.name === reader && m.type === "human");

  if (!isAgent && !isHuman) {
    console.error(`Error: Unknown reader "${reader}". Register as agent (chat agent create) or ensure member exists.`);
    db.close();
    process.exit(1);
  }

  const cursor = readReaderCursor(chatDir, reader);
  let msgs: Message[];

  if (isAgent) {
    const channels = agents[reader].channels;
    msgs = getUnreadMessages(db, cursor, { channels, mentionName: reader });
  } else {
    msgs = getUnreadMessages(db, cursor);
  }

  if (!flags.peek && msgs.length > 0) {
    writeReaderCursor(chatDir, reader, msgs[msgs.length - 1]!.id);
  }

  // ... thread context build, output (unchanged)
}
```

### cli.ts — help text

```
  unread <reader> [--peek]         Show unread messages for a reader
    --peek                        Don't mark messages as read
    --text                        Output as human-readable text
```

### core.test.ts

追加するテストケース:

1. **Per-reader cursor isolation**: reader A の unread が reader B のカーソルに影響しない
2. **Agent channel filtering**: 購読チャンネルのメッセージ + 非購読チャンネルからのメンションが返る
3. **Agent with empty channels**: `channels: []` のエージェントはメンションのみ返る（全メッセージにフォールバックしない）
4. **Human mode**: 全チャンネル（`_system` 除外）のメッセージが返る
5. **Unknown reader error**: 未登録名でエラーが返る
6. **Cursor persistence**: `read_cursors/` ディレクトリの読み書きが正しく動く

## Migration

- 旧 `.read_cursor` は放置（新しい `read_cursors/` ディレクトリを使用）
- 各リーダーの初回 `chat unread <name>` でカーソルが空（= 全メッセージ未読）
  - エージェント: onboarding フロー（Section 5）に従い、初回実行でカーソルをセットする
  - 人間: 初回は全メッセージが返る。`--peek` で確認後に再実行してカーソルをセットするか、そのまま実行して既読にする
- 旧 `--for` フラグは削除済み（`<reader>` 位置引数に置き換え）

## Not Changed

- DB スキーマ（テーブル追加なし）
- `_system` チャンネル構造
- `agent_config` フォーマット（`channels` フィールドをそのまま活用）
- Web UI（`localStorage` で独立管理しているため影響なし）
- 同期処理（`.sync` カーソルは別管理のまま）
- メッセージ出力フォーマット（JSON / `--text` の構造は変わらない）
