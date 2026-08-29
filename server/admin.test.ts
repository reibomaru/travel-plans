// ============================================================
//  管理ダッシュボード（#103）のアクセス制御と承認操作の結合テスト。
//
//  検証するのは二段構えのゲート:
//    1. Basic 認証（ADMIN_BASIC_USER / ADMIN_BASIC_PASS）… 未設定なら 503、
//       資格情報が違えば 401。
//    2. Google SSO の role=admin … 未ログインは 401、非 admin は 403。
//  さらに承認操作（allowed の更新）と、自分自身の権限剥奪の拒否も確認する。
//
//  Basic 認証の資格情報はリクエストごとに env から読むため（server/admin.ts）、
//  テスト内で process.env を差し替えるだけで「未設定」の分岐も検証できる。
//  一方 SESSION_SECRET は auth.ts が読み込み時に固定するので、env を立ててから
//  admin.ts を動的 import する。
//
//  実行前提: Firestore エミュレータが起動していること（pnpm test が面倒を見る）。
// ============================================================
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { firestore, upsertUserOnLogin } from "./users.ts";

const COLLECTION = process.env.FIRESTORE_USERS_COLLECTION || "users";
const EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST; // 本番 Firestore を触らない保険
const SECRET = "test-session-secret-for-admin-routes";
const BASIC = { user: "admin-user", pass: "admin-pass" };

const ADMIN_SUB = "test-admin-dashboard-admin";
const MEMBER_SUB = "test-admin-dashboard-member";
const BOOTSTRAP_SUB = "test-admin-dashboard-bootstrap";

// auth.ts は SESSION_SECRET を読み込み時に固定するため、import より前に立てる。
process.env.SESSION_SECRET = SECRET;
const { registerAdminRoutes } = await import("./admin.ts");

const authHeader = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

/** テスト用のセッション Cookie（server/auth.ts と同じクレーム構造）。 */
async function sessionCookie(sub: string, email: string, role: "admin" | "user"): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const token = await sign({ sub, email, name: email, role, exp }, SECRET, "HS256");
  return `session=${token}`;
}

/** Basic 認証の資格情報を設定/解除する（admin.ts はリクエスト毎に env を読む）。 */
function setBasicEnv(enabled: boolean): void {
  if (enabled) {
    process.env.ADMIN_BASIC_USER = BASIC.user;
    process.env.ADMIN_BASIC_PASS = BASIC.pass;
  } else {
    delete process.env.ADMIN_BASIC_USER;
    delete process.env.ADMIN_BASIC_PASS;
  }
}

/** /admin ルートだけを載せた Hono アプリ。 */
function buildApp(): Hono {
  const app = new Hono();
  registerAdminRoutes(app);
  return app;
}

function ref(sub: string) {
  return firestore().collection(COLLECTION).doc(sub);
}

async function seedUsers() {
  await ref(ADMIN_SUB).set({
    sub: ADMIN_SUB,
    email: "admin@example.com",
    name: "Admin",
    allowed: true,
    role: "admin",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await ref(MEMBER_SUB).set({
    sub: MEMBER_SUB,
    email: "member@example.com",
    name: "Member",
    allowed: false,
    role: "user",
    createdAt: "2026-02-01T00:00:00.000Z",
  });
}

async function cleanup() {
  await Promise.all(
    [ADMIN_SUB, MEMBER_SUB, BOOTSTRAP_SUB].map((sub) => ref(sub).delete().catch(() => {})),
  );
}

before(async () => {
  if (EMULATOR) await seedUsers();
});
after(async () => {
  if (EMULATOR) await cleanup();
});

test("Basic 認証が未設定なら /admin は 503（空パスワードで素通りさせない）", async () => {
  setBasicEnv(false);
  const app = buildApp();
  const res = await app.request("/admin/api/users");
  assert.equal(res.status, 503);
});

test("Basic 認証: 資格情報が無い / 間違っていれば 401 と WWW-Authenticate", async () => {
  setBasicEnv(true);
  const app = buildApp();

  const none = await app.request("/admin/api/users");
  assert.equal(none.status, 401);
  assert.match(none.headers.get("WWW-Authenticate") ?? "", /^Basic realm=/);

  const wrong = await app.request("/admin/api/users", {
    headers: { Authorization: authHeader(BASIC.user, "wrong-pass") },
  });
  assert.equal(wrong.status, 401);
});

test("Basic 認証を通っても未ログインなら 401（画面パスは Basic のみで通す）", async () => {
  setBasicEnv(true);
  const app = buildApp();
  const basic = { Authorization: authHeader(BASIC.user, BASIC.pass) };

  const api = await app.request("/admin/api/users", { headers: basic });
  assert.equal(api.status, 401);

  // /admin（画面）は SPA へフォールバックさせるため、このアプリではルート未定義 = 404。
  // 少なくとも Basic 認証で弾かれていない（401 ではない）ことを確認する。
  const page = await app.request("/admin", { headers: basic });
  assert.notEqual(page.status, 401);
  assert.notEqual(page.status, 503);
});

test(
  "非 admin は 403、admin は一覧を取得できる",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    setBasicEnv(true);
  const app = buildApp();
    const basic = { Authorization: authHeader(BASIC.user, BASIC.pass) };

    const asMember = await app.request("/admin/api/users", {
      headers: { ...basic, Cookie: await sessionCookie(MEMBER_SUB, "member@example.com", "user") },
    });
    assert.equal(asMember.status, 403);

    const asAdmin = await app.request("/admin/api/users", {
      headers: { ...basic, Cookie: await sessionCookie(ADMIN_SUB, "admin@example.com", "admin") },
    });
    assert.equal(asAdmin.status, 200);
    const users = (await asAdmin.json()) as { sub: string; allowed: boolean; createdAt?: string }[];
    const member = users.find((u) => u.sub === MEMBER_SUB);
    assert.ok(member, "承認待ちユーザーが一覧に含まれる");
    assert.equal(member.allowed, false);
    assert.equal(member.createdAt, "2026-02-01T00:00:00.000Z");
  },
);

test(
  "承認（allowed=true）が反映される",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    setBasicEnv(true);
  const app = buildApp();
    const headers = {
      Authorization: authHeader(BASIC.user, BASIC.pass),
      Cookie: await sessionCookie(ADMIN_SUB, "admin@example.com", "admin"),
      "Content-Type": "application/json",
    };

    const res = await app.request(`/admin/api/users/${MEMBER_SUB}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ allowed: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { allowed: boolean }).allowed, true);

    const snap = await ref(MEMBER_SUB).get();
    assert.equal(snap.data()?.allowed, true);
    assert.equal(snap.data()?.role, "user", "role は指定していないので変わらない");
  },
);

test(
  "自分自身の管理者権限・利用許可は取り消せない（締め出し防止）",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    setBasicEnv(true);
  const app = buildApp();
    const headers = {
      Authorization: authHeader(BASIC.user, BASIC.pass),
      Cookie: await sessionCookie(ADMIN_SUB, "admin@example.com", "admin"),
      "Content-Type": "application/json",
    };

    for (const body of [{ role: "user" }, { allowed: false }]) {
      const res = await app.request(`/admin/api/users/${ADMIN_SUB}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `${JSON.stringify(body)} は拒否される`);
    }

    const snap = await ref(ADMIN_SUB).get();
    assert.equal(snap.data()?.role, "admin");
    assert.equal(snap.data()?.allowed, true);
  },
);

test(
  "不正な role / 空のパッチは 400",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    setBasicEnv(true);
  const app = buildApp();
    const headers = {
      Authorization: authHeader(BASIC.user, BASIC.pass),
      Cookie: await sessionCookie(ADMIN_SUB, "admin@example.com", "admin"),
      "Content-Type": "application/json",
    };

    const badRole = await app.request(`/admin/api/users/${MEMBER_SUB}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ role: "superuser" }),
    });
    assert.equal(badRole.status, 400);

    const empty = await app.request(`/admin/api/users/${MEMBER_SUB}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
  },
);

test(
  "ADMIN_EMAILS のユーザーはログイン時に allowed=true / role=admin へ昇格する",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    const email = "bootstrap@example.com";
    await ref(BOOTSTRAP_SUB).delete().catch(() => {});

    // 対象外のメールなら従来どおり承認待ちで登録される。
    process.env.ADMIN_EMAILS = "someone-else@example.com";
    const plain = await upsertUserOnLogin(BOOTSTRAP_SUB, email, "Bootstrap");
    assert.equal(plain.allowed, false);
    assert.equal(plain.role, "user");

    // ADMIN_EMAILS に載せると、既存ユーザーでも次回ログインで昇格する（大小文字は無視）。
    process.env.ADMIN_EMAILS = ` other@example.com , ${email.toUpperCase()} `;
    const promoted = await upsertUserOnLogin(BOOTSTRAP_SUB, email, "Bootstrap");
    assert.equal(promoted.allowed, true);
    assert.equal(promoted.role, "admin");

    const snap = await ref(BOOTSTRAP_SUB).get();
    assert.equal(snap.data()?.role, "admin");
    delete process.env.ADMIN_EMAILS;
  },
);
