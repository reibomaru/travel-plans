# 🗺️ shiori

[![deploy](https://github.com/reibomaru/shiori/actions/workflows/deploy.yml/badge.svg)](https://github.com/reibomaru/shiori/actions/workflows/deploy.yml)

AI と一緒に旅行計画を作る、セルフホストの旅のしおりアプリ。[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) を使い、ブラウザで AI に話しかけながら、移動ルート・日ごとの旅程・行きたいスポット・予算・旅のメモを **1つの SQLite** にまとめて編集し、そのまま PDF に出力できる。

## Features

- 🗺️ **地図・移動ルート** — deck.gl 製の地図で、経由地を番号付きピン、区間を線（空路は弧、地上移動は GeoJSON 実経路）で表示。標準/衛星/地形/淡色のベースマップを切り替えられる。
- 🗓️ **旅程** — 日ごとの予定を、ドラッグ&ドロップのビルダーで追加・編集・並べ替え。
- 🧭 **スポット候補** — 行きたい場所を一覧・地図で管理。Google の評価（★）・写真や Instagram ギャラリーも表示。
- 💰 **予算** — 費目ごとの予算を管理。
- 📝 **メモ** — 旅のメモ。画像の取り込み・情報抽出や、ページ間の関係グラフ（Mermaid）に対応。
- 🤖 **AI アシスタント** — 自然文の指示から Web を調べてスポットやメモを**提案**（プレビュー承認制）。画像添付にも対応。
- 🖨️ **PDF 出力** — 操作用 UI を隠した印刷レイアウトで、ブラウザから「PDF に保存」。

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 24（リポジトリの `.nvmrc` で固定。標準の `node:sqlite` と TypeScript 型ストリップを使うため）
- [pnpm](https://pnpm.io/) 9 以上

`nvm` 利用時はリポジトリ直下で `nvm use`（`.nvmrc` を読む）。開発フロー・貢献手順は [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照。

### 1. Install

```bash
git clone https://github.com/reibomaru/shiori.git
cd shiori
pnpm install
```

### 2. Configure

AI アシスタントを使う場合は、環境変数を設定する（使わない場合はスキップ可）。

```bash
cp .env.example .env
```

初期データ（サンプルの旅程）を SQLite に投入する。

```bash
pnpm db:init
```

### 3. Run

```bash
pnpm dev   # API(:8080) と Vite(:5173) を同時起動
```

ブラウザで http://localhost:5173 を開く。データを作り直したいときは `pnpm db:reset`。

## Using Skills

Claude Code の [`travel-plan`](.claude/skills/travel-plan/SKILL.md) Skill が、移動ルート / 旅程 / 候補スポット / 予算をまとめて編集する（1つの DB で密結合しているため1スキルに集約）。内部的には次の CLI を使う:

```bash
node scripts/travel.ts summary                     # まず全体把握
node scripts/travel.ts route | legs | days | spots | budget
node scripts/travel.ts add-spot '{"name":"…", "url":"…"}'
node scripts/travel.ts add-item 7 '{"time":"15:00","type":"spot","title":"…"}'
node scripts/sql.ts "<SQL>"                          # CLI に無い操作用の逃げ道
```

移動区間の実経路は GeoJSON / GPX を取り込める（`set-geojson` / `set-gpx`）ほか、`scripts/osrm-route.ts` で OSRM から補完できる。

スポット画面（`/spots`）やメモ画面（`/memo`）の **AI アシスタント**タブでは、Skill を使わずブラウザから直接 AI に依頼できる。AI は DB を直接書き換えず、提案カードを確認・修正して「保存」したときに反映される（プレビュー承認制）。

## User approval (admin dashboard)

ログインは許可制。新規ユーザーは Firestore の `users` に `allowed: false`（承認待ち）で
登録され、承認されるまでアプリを使えない。承認は `/admin` の管理ダッシュボードから行う
（ユーザー一覧・承認 / 承認取り消し・ロール変更）。

アクセス制御は二段構え:

1. **Basic 認証** — `/admin` 配下（画面 + API）。`ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS` が
   両方設定されているときだけ有効で、未設定なら `/admin` は 503 で閉じる。
2. **`role: admin`（Google SSO）** — `/admin/api/*`。非 admin は 403。

最初の管理者は `ADMIN_EMAILS`（カンマ区切り）で作る。ここに挙げたメールはログイン時に
`allowed: true` / `role: admin` へ自動昇格する。以降のロール変更はダッシュボードから行える。

## Configuration

管理ダッシュボード（`.env`）で使う環境変数:

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_BASIC_USER` | （未設定で `/admin` 無効） | `/admin` の Basic 認証ユーザー名 |
| `ADMIN_BASIC_PASS` | （未設定で `/admin` 無効） | `/admin` の Basic 認証パスワード |
| `ADMIN_EMAILS` | （任意） | 初期管理者のメール（カンマ区切り）。ログイン時に `allowed`/`admin` へ昇格 |

AI アシスタント（`.env`）で使う環境変数:

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | （必須） | Gemini の API キー（https://aistudio.google.com/apikey） |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | 使用モデル（複雑な調べ物は `gemini-3-pro-preview`） |
| `WEBSEARCH_API_KEY` | （任意） | `web_search` 用（https://websearchapi.ai）。未設定だと web_search だけ無効 |
| `GOOGLE_MAPS_API_KEY` | （任意） | スポットの Google 評価（★）・写真取得用。`spot_place_cache` に30日キャッシュ |

## Documentation

- [`.claude/skills/travel-plan/SKILL.md`](.claude/skills/travel-plan/SKILL.md) — データ編集 Skill と操作レシピ（`recipes/`）
- [`docs/er-diagram.md`](docs/er-diagram.md) — データモデル（SQLite）
- [`docs/gcp-deployment-design.md`](docs/gcp-deployment-design.md) — 本番デプロイ設計（Cloud Run / Litestream）
- スキーマ変更は `db/migrations/` に連番 SQL を追加し、`node db/migrate.ts` で適用（本番は `.github/workflows/deploy.yml` が push 時に自動 migrate → deploy）
- インフラ（Cloud Run / Artifact Registry / IAM / GCS）は [`infra/terraform`](infra/terraform) で管理

構成: **SQLite**（`node:sqlite`）/ **Hono** API / **React 19 + Vite + React Router + Tailwind CSS v4** / **deck.gl**（地図）/ **pi-coding-agent + Gemini**（AI）/ **Docker → Cloud Run + Litestream**（本番）。
