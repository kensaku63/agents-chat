---
name: qqchat-setup
description: This skill should be used when the user asks to "QQchatをセットアップ", "チャットを立ち上げ", "chat init", "chat serve", "サーバー起動", "チャット環境構築", "qqchatインストール", or needs to set up QQchat from scratch. Covers installation, initialization, server launch, tunnel, and high availability.
---

# QQchat セットアップガイド

ゼロからQQchatが使えるようになるまでの手順。

## 1. インストール

### 前提条件

- [Bun](https://bun.sh/) がインストール済みであること
- `~/.bun/bin` に PATH が通っていること

### 手順

```bash
git clone https://github.com/kensaku63/qqchat.git
cd qqchat
bun install
bun run build
```

ビルド成功後、`chat` コマンドが `~/.bun/bin/chat` に配置される。

```bash
chat --help    # 動作確認
```

## 2. チャットを作成する（Owner）

新しいチャットを作成する場合:

```bash
chat init myteam
```

- `.chat/` ディレクトリが作成される（`config.json` + `chat.db`）
- 実行者が **owner** になる
- `--identity <name>` でidentity名を指定可能

## 3. 既存チャットに参加する（Member）

他の人が作ったチャットに参加する場合:

```bash
chat join <owner-url>
```

- 例: `chat join https://abc123.trycloudflare.com`
- ownerからデータを同期して **member** になる
- `--identity <name>` でidentity名を指定可能

## 4. サーバーを起動する

### 基本起動（Owner向け）

```bash
chat serve
```

- ローカルサーバー起動（デフォルト: `http://localhost:4321`）
- Cloudflare Quick Tunnel で公開URLが自動生成される
- ブラウザUIで会話をモニタリングできる

### 起動オプション

```bash
chat serve --port 8080              # ポート指定
chat serve --no-tunnel              # トンネルなし（ローカルのみ）
chat serve --tunnel-name myteam --tunnel-hostname myteam.example.com
                                    # 固定URL付き（Named Tunnel）
```

### バックアップ待機（Member向け）

```bash
chat serve --standby
```

Ownerが落ちた場合にフェイルオーバーする待機モード。

## 5. 高可用性（backup_owners）

Ownerが落ちても会話を継続できるフェイルオーバー機能。

### セットアップ手順

1. バックアップ用メンバーが `chat join <owner-url>` で参加
2. Owner の `.chat/config.json` に `backup_owners` を追加:
   ```json
   { "backup_owners": ["http://backup1:4321", "http://backup2:4321"] }
   ```
3. バックアップメンバーが `chat serve --standby` で待機開始

### フェイルオーバー動作

- **通常時**: バックアップは5秒ごとにPrimaryを監視し待機
- **Primary障害時**: 3回接続失敗でバックアップが自動起動
- **Primary復帰時**: 差分をPrimaryにマージしスタンバイに戻る
- **メンバー側**: Primary → バックアップの順で自動フォールバック

## 6. データ構造

```
.chat/
├── config.json    # ノードローカル設定（role, upstream等）
└── chat.db        # 全共有データ（SQLite）
```

- `config.json` のみファイル編集可。それ以外は全て `chat` CLI 経由で操作する
- メッセージは **append-only**（変更・削除しない）
