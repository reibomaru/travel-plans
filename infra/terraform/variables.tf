variable "project_id" {
  type        = string
  description = "デプロイ先の GCP プロジェクト ID。"
  # 単一プロジェクト前提。project_id は秘密ではなく versions.tf の backend にも露出済みなので
  # default 化して terraform.tfvars を不要にする（別プロジェクトに向けるときだけ上書き）。
  default = "shinbun-489215"
}

variable "region" {
  type        = string
  description = "リソースを配置するリージョン。"
  default     = "asia-northeast1"
}

variable "service_name" {
  type        = string
  description = "Cloud Run サービス名。関連リソースの接頭辞にも使う。"
  default     = "shiori"
}

variable "github_repository" {
  type        = string
  description = "GitHub Actions からの Workload Identity 連携を許可するリポジトリ（owner/repo）。"
  default     = "reibomaru/shiori"
}

variable "placeholder_image" {
  type        = string
  description = <<-EOT
    初回 apply 時にイメージがまだ Artifact Registry に無いため使うダミーイメージ。
    実イメージは GitHub Actions がデプロイ時に差し替える（image は lifecycle で無視）。
  EOT
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

# アプリのシークレット名（値は Terraform では設定せず、gcloud で手動投入する）。
variable "secret_ids" {
  type        = list(string)
  description = "Secret Manager に作成するシークレット ID。値は手動で追加する。"
  default = [
    "GEMINI_API_KEY",
    "WEBSEARCH_API_KEY",
    "GOOGLE_MAPS_API_KEY",
    # 認証（Google SSO）: OAuth クライアント資格情報と JWT Cookie 署名鍵。
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "SESSION_SECRET",
    # メール送信（承認完了メールなど・#102）: Resend の API キー。
    "RESEND_API_KEY",
  ]
}

# 利用許可は Firestore の users コレクション（allowed フラグ）で管理する。
# 承認は初期は GCP コンソール / gcloud で該当ドキュメントを allowed=true にする。

variable "app_base_url" {
  type        = string
  description = "OAuth リダイレクト URI 組み立て用のアプリのベース URL。<app_base_url>/auth/google が Google に送られるので、承認済みリダイレクト URI と一致させる。空ならリクエストから自動解決（Cloud Run では http/host のズレで mismatch になりやすいので明示推奨）。"
  # 公開はカスタムドメイン（外部 HTTPS LB）経由。run.app は ingress で遮断済み。
  default = "https://booklet-ai.com"
}

variable "mail_from" {
  type        = string
  description = "承認完了メール等の差出人アドレス（#102）。Resend で検証済みのドメイン/アドレスを指定する。"
  default     = "shiori <no-reply@booklet-ai.com>"
}

variable "domain" {
  type        = string
  description = "アプリを公開するカスタムドメイン（apex）。Cloud DNS マネージドゾーンと managed SSL 証明書に使う。"
  default     = "booklet-ai.com"
}

variable "dns_zone_name" {
  type        = string
  description = "Cloud DNS マネージドゾーンのリソース名（GCP 内部の識別子。ドメイン名とは別）。"
  default     = "booklet-ai"
}

variable "cpu" {
  type        = string
  description = "Cloud Run サービスの CPU。Litestream 常駐のため CPU 常時割当（cpu_idle=false）で使う。"
  default     = "1"
}

variable "memory" {
  type        = string
  description = "Cloud Run サービス/ジョブのメモリ。"
  default     = "512Mi"
}
