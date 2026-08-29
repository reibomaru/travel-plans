# ============================================================
#  Cloud Run: Service（アプリ本体）と Job（マイグレーション）
#
#  image は初回 apply ではダミー。実イメージは GitHub Actions が
#  `gcloud run deploy/jobs update --image ...` で差し替えるため、
#  lifecycle で image の変更を無視する（Terraform が戻さない）。
# ============================================================

locals {
  # Service / Job で共通のアプリ環境変数（シークレット以外）。
  common_env = {
    # 単一ライタ用の Litestream/migrate Job が参照する DB パス（後続の per-DB 対応まで残置）。
    TRAVEL_DB = "${local.data_mount_path}/travel.db"
    # ユーザーごと storage 分離: data/{userId}/travel.db と agent-sessions/{userId}/ に分離する。
    TRAVEL_DATA_DIR    = local.data_mount_path
    AGENT_SESSIONS_DIR = "${local.data_mount_path}/${local.sessions_subdir}"
    NODE_ENV           = "production"
    LITESTREAM_BUCKET  = google_storage_bucket.state.name
    LITESTREAM_PATH    = local.litestream_prefix
    # 認証（Google SSO）。利用可否は Firestore の users 台帳で判定する。
    APP_BASE_URL          = var.app_base_url
    FIRESTORE_PROJECT_ID  = var.project_id
    FIRESTORE_DATABASE_ID = google_firestore_database.users.name
    # メール送信（承認完了メールなど・#102）。RESEND_API_KEY があれば自動で resend が
    # 選ばれるが、本番は明示する。差出人は検証済みアドレスを指定する。
    MAIL_PROVIDER = "resend"
    MAIL_FROM     = var.mail_from
  }
}

# ---- アプリ本体（フロント静的配信 + Hono API + Litestream 常駐）----
resource "google_cloud_run_v2_service" "app" {
  name                = var.service_name
  location            = var.region
  deletion_protection = false
  # 外部 HTTPS LB（Serverless NEG）と内部トラフィックのみ許可し、
  # *.run.app への直アクセスは塞ぐ。公開は booklet-ai.com（LB）経由に限定する。
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.runtime.email

    # SQLite の単一ライタ制約を守るため常に 1 インスタンス。
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    # AI チャット履歴 JSONL を GCS FUSE でマウント。
    volumes {
      name = "sessions"
      gcs {
        bucket    = google_storage_bucket.sessions.name
        read_only = false
      }
    }

    containers {
      image = var.placeholder_image

      ports {
        container_port = 8080
      }

      # Litestream を常駐させるため CPU を常時割り当てる（リクエスト外でもレプリケート）。
      resources {
        cpu_idle          = false
        startup_cpu_boost = true
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      volume_mounts {
        name       = "sessions"
        mount_path = "${local.data_mount_path}/${local.sessions_subdir}"
      }

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      # シークレットは最新版を環境変数として注入。
      dynamic "env" {
        for_each = google_secret_manager_secret.app
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.services,
    google_secret_manager_secret_iam_member.runtime_accessor,
    google_storage_bucket_iam_member.runtime_bucket,
  ]
}

# 未認証呼び出しを許可（公開）。ただし ingress を LB 限定にしているため、
# 実際に到達できるのは外部 HTTPS LB 経由のみ（*.run.app 直アクセスは ingress で遮断）。
# ログイン導線（/auth/*）とアプリ層の認証（Google SSO・/api/* は認証必須）で守る。
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = google_cloud_run_v2_service.app.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---- マイグレーション Job -----------------------------------
# 単一ライタ窓（サービスを min=0 に退避した状態）で実行する前提。
# entrypoint は `litestream restore → node db/migrate.ts → litestream で確定` を行う
# 想定（コンテナ側スクリプトはアプリ実装で用意する）。
resource "google_cloud_run_v2_job" "migrate" {
  name                = "${var.service_name}-migrate"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.runtime.email
      max_retries     = 0
      timeout         = "600s"

      containers {
        image = var.placeholder_image

        # マイグレーション用エントリポイント（アプリ実装で用意する）。
        command = ["/app/migrate-job.sh"]

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }

        dynamic "env" {
          for_each = local.common_env
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = google_secret_manager_secret.app
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value.secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.services,
    google_secret_manager_secret_iam_member.runtime_accessor,
    google_storage_bucket_iam_member.runtime_bucket,
  ]
}
