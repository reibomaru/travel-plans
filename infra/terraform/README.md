# しおり 本番インフラ（Terraform）

Cloud Run + Litestream + GCS + Secret Manager + Workload Identity Federation 一式。
設計の背景は [`docs/gcp-deployment-design.md`](../../docs/gcp-deployment-design.md) を参照。

`terraform apply` は手動で実行する。

## 作成されるリソース

- Cloud Run **Service**（`shiori`）: フロント静的配信 + Hono API + Litestream 常駐。min=max=1、CPU 常時割当、公開（認証はアプリ層の Google SSO・招待制。`/api/*` は認証必須）。
- Cloud Run **Job**（`shiori-migrate`）: マイグレーション実行用。
- **Artifact Registry**（Docker リポジトリ）。
- **GCS バケット** 2 つ: `*-state`（Litestream レプリカ + backups）、`*-sessions`（AI チャット履歴 JSONL, FUSE マウント）。
- **Firestore**（`(default)`, Native）: `users`（プロフィール）と `projects`（プロジェクト・メンバー）の台帳。実行 SA に `roles/datastore.user`。
- **Secret Manager**: `GEMINI_API_KEY` / `WEBSEARCH_API_KEY` / `GOOGLE_MAPS_API_KEY` / `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `SESSION_SECRET` / `RESEND_API_KEY`（入れ物のみ。値は手動投入）。
- **IAM**: 実行 SA、デプロイ SA、GitHub Actions 用 Workload Identity 連携。

## 手順

### 1. 事前準備（1 回だけ）

```bash
gcloud auth application-default login
gcloud config set project <PROJECT_ID>

# tfstate 用バケットを作成し、versions.tf の backend の bucket 名を書き換える。
gcloud storage buckets create gs://<PROJECT_ID>-tfstate \
  --location=asia-northeast1 --uniform-bucket-level-access
```

### 2. 変数設定

```bash
cp terraform.tfvars.example terraform.tfvars
# project_id などを編集
```

### 3. apply

```bash
terraform init
terraform plan
terraform apply
```

初回はイメージが未 push のため、Service/Job はダミーイメージ
（`cloudrun/container/hello`）で作成される。実イメージは GitHub Actions が差し替える
（Terraform は image の変更を無視する設定）。

### 4. シークレットの値を投入

```bash
printf '%s' "$GEMINI_API_KEY"      | gcloud secrets versions add GEMINI_API_KEY --data-file=-
printf '%s' "$WEBSEARCH_API_KEY"   | gcloud secrets versions add WEBSEARCH_API_KEY --data-file=-
printf '%s' "$GOOGLE_MAPS_API_KEY" | gcloud secrets versions add GOOGLE_MAPS_API_KEY --data-file=-
# 認証（Google SSO）。OAuth クライアント（Web）を GCP コンソールで作成して取得する。
printf '%s' "$GOOGLE_OAUTH_CLIENT_ID"     | gcloud secrets versions add GOOGLE_OAUTH_CLIENT_ID --data-file=-
printf '%s' "$GOOGLE_OAUTH_CLIENT_SECRET" | gcloud secrets versions add GOOGLE_OAUTH_CLIENT_SECRET --data-file=-
# JWT Cookie の署名鍵（十分に長いランダム文字列。例 openssl rand -hex 32）。
openssl rand -hex 32 | gcloud secrets versions add SESSION_SECRET --data-file=-
# 承認完了メール（#102）の送信に使う Resend の API キー（https://resend.com で取得）。
printf '%s' "$RESEND_API_KEY" | gcloud secrets versions add RESEND_API_KEY --data-file=-
```

> **注意**: Cloud Run は各シークレットの `version=latest` を環境変数として参照するため、
> 値が 1 バージョンも無いシークレットがあるとデプロイ（Service 更新）に失敗する。
> `RESEND_API_KEY` を含め、**上の値投入は Service が起動する前に済ませておく**こと。
>
> **差出人アドレス**: 承認完了メールの `MAIL_FROM` は非秘匿値のため Terraform 管理
> （`var.mail_from`・既定 `shiori <no-reply@booklet-ai.com>`）。Resend 側でドメイン検証を
> 済ませたアドレスに合わせる（別ドメインなら `terraform.tfvars` で `mail_from` を上書き）。

> **OAuth クライアント**: GCP コンソール「API とサービス → 認証情報」で OAuth 2.0 クライアント（Web）を作成し、
> 承認済みリダイレクト URI に `<本番の origin>/auth/google` を登録する。
> **アクセス境界（許可制ログイン + プロジェクト招待）**: ログインは**許可制**。新規ユーザーは Firestore
> `users` に `allowed=false`（承認待ち）で登録され、`allowed=true`（初期は GCP コンソール / gcloud で直接編集）
> にするまでアプリを使えない。承認済みユーザーの中で、データはプロジェクト単位
> （`data/{projectId}/travel.db`）に分離され、参加は**メール招待**（Firestore `projects.memberEmails`）。
> 各ユーザーは自分がメンバーのプロジェクトのみ閲覧・編集できる。

### 5. GitHub Actions 用の Variables を設定

`terraform output` の値を GitHub リポジトリの **Variables** に登録する:

| GitHub Variable | 値 |
| --- | --- |
| `GCP_PROJECT_ID` | プロジェクト ID |
| `GCP_REGION` | `asia-northeast1` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `terraform output -raw workload_identity_provider` |
| `GCP_DEPLOY_SA` | `terraform output -raw deployer_service_account` |
| `SERVICE_NAME` | `shiori` |

### 6. 初回デプロイ

`main` へ push すると `deploy` ワークフローが実イメージをビルド・デプロイする。
`db/migrations/` に差分がある push では、デプロイ前に単一ライタ窓での
マイグレーションを自動で挟む（コード変更のみの push は無停止でデプロイ）。

## 注意

- コンテナ内スクリプト（`migrate-job.sh` / Litestream 起動 entrypoint / `db/migrate.ts`）は
  **アプリ側実装**で用意する。CI/インフラはそれらの存在を前提にしている。
- マイグレーションは利用者のいない時間帯に実行する（単一ライタ窓の制約）。
