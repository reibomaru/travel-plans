// ============================================================
//  管理ダッシュボード（利用承認）。#103
//
//  新規ユーザーは users に allowed=false（承認待ち）で JIT 登録される
//  （server/users.ts）。その承認を GCP コンソール / gcloud ではなく画面から
//  行うための、管理者向けルート一式。
//
//  アクセス制御は二段構え:
//    1. Basic 認証（ADMIN_BASIC_USER / ADMIN_BASIC_PASS）… /admin 配下すべて
//       （SPA の画面 + API）。未設定なら 503 で閉じる（フェイルクローズ）。
//    2. Google SSO の role=admin … /admin/api/* のみ（画面自体は素の JS で
//       秘密を含まないため、実データは必ず API 側で止める）。
//
//  ルート:
//    GET   /admin                  管理ダッシュボード（SPA へフォールバック）
//    GET   /admin/api/users        ユーザー一覧
//    PATCH /admin/api/users/:sub   allowed / role の更新
//
//  最初の admin は ADMIN_EMAILS（server/users.ts）でログイン時に昇格させる。
// ============================================================
import type { Hono, MiddlewareHandler } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { requireAuth } from "./auth.ts";
import { listAllUsers, updateUserByAdmin, type Role } from "./users.ts";

const BASIC_REALM = 'Basic realm="shiori admin", charset="UTF-8"';

/** Basic 認証の資格情報（未設定なら null＝ダッシュボードごと無効）。 */
function basicCredentials(): { user: string; pass: string } | null {
  const user = process.env.ADMIN_BASIC_USER || "";
  const pass = process.env.ADMIN_BASIC_PASS || "";
  return user && pass ? { user, pass } : null;
}

/** 長さの違いも含めて情報を漏らさない定数時間比較（SHA-256 で長さを揃える）。 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Basic 認証。/admin 配下（画面 + API）の一次ゲート。
 * 資格情報が未設定なら「管理ダッシュボードは無効」として 503 を返す
 * （空パスワードで素通りさせない）。
 */
export const adminBasicAuth: MiddlewareHandler = async (c, next) => {
  const cred = basicCredentials();
  if (!cred) {
    return c.json({ error: "管理ダッシュボードは未設定です（ADMIN_BASIC_USER / ADMIN_BASIC_PASS）。" }, 503);
  }
  const m = /^Basic\s+(\S+)$/i.exec(c.req.header("Authorization") || "");
  if (m) {
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
    // ユーザー名が違うときも必ず両方比較し、レスポンス時間から手掛かりを与えない。
    const userOk = safeEqual(user, cred.user);
    const passOk = safeEqual(pass, cred.pass);
    if (userOk && passOk) return next();
  }
  return c.body(null, 401, { "WWW-Authenticate": BASIC_REALM });
};

/** ログイン済みユーザーが role=admin であることを要求する（requireAuth の後に置く）。 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (c.get("userRole") !== "admin") return c.json({ error: "管理者のみアクセスできます。" }, 403);
  return next();
};

/** リクエストボディの role を検証する（不正値は undefined ではなく null で区別）。 */
function parseRole(v: unknown): Role | null | undefined {
  if (v === undefined) return undefined;
  return v === "admin" || v === "user" ? v : null;
}

/**
 * Hono アプリに /admin/* ルートを登録する。
 * 静的配信（SPA フォールバック）より前に呼ぶこと。Hono は登録後のルートにのみ
 * middleware を適用するため、順序が重要。
 */
export function registerAdminRoutes(app: Hono): void {
  if (!basicCredentials()) {
    console.warn("⚠ ADMIN_BASIC_USER / ADMIN_BASIC_PASS が未設定です。管理ダッシュボード(/admin)は無効です。");
  }

  // 画面と API の両方に Basic 認証。"/admin" 単体は "/admin/*" に含まれないので別途登録する。
  app.use("/admin", adminBasicAuth);
  app.use("/admin/*", adminBasicAuth);
  // API はさらにログイン必須 + role=admin。
  app.use("/admin/api/*", requireAuth, requireAdmin);

  app.get("/admin/api/users", async (c) => c.json(await listAllUsers()));

  app.patch("/admin/api/users/:sub", async (c) => {
    const sub = c.req.param("sub");
    const body = (await c.req.json().catch(() => ({}))) as { allowed?: unknown; role?: unknown };

    const allowed = body.allowed === undefined ? undefined : body.allowed === true;
    if (body.allowed !== undefined && typeof body.allowed !== "boolean") {
      return c.json({ error: "allowed は真偽値で指定してください。" }, 400);
    }
    const role = parseRole(body.role);
    if (role === null) return c.json({ error: "role は admin か user を指定してください。" }, 400);
    if (allowed === undefined && role === undefined) return c.json({ error: "変更内容がありません。" }, 400);

    // 自分自身の権限剥奪は締め出しにつながるため禁止する（他の admin に依頼させる）。
    if (sub === c.get("userId") && (allowed === false || role === "user")) {
      return c.json({ error: "自分自身の管理者権限・利用許可は取り消せません。" }, 400);
    }

    const rec = await updateUserByAdmin(sub, { allowed, role });
    if (!rec) return c.json({ error: "ユーザーが見つかりません。" }, 404);
    return c.json(rec);
  });
}
