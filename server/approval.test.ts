// ============================================================
//  利用承認 → 承認完了メールの結合テスト（#102）。
//
//  Firestore エミュレータ + memory メールプロバイダで、次を確定的に検証する:
//    - 承認（false→true）で 1 通だけ送る
//    - 再承認（true→true）や既承認では送らない（冪等）
//    - allowed=false のドキュメントには送らない
//    - 送信失敗時は承認は成功扱い・送信枠は戻り再送できる
//
//  実行前提: Firestore エミュレータ起動 + MAIL_PROVIDER=memory。
//    package.json の `pnpm test` が FIRESTORE_EMULATOR_HOST を付けて実行する。
// ============================================================
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { firestore } from "./users.ts";
import { approveUser, sendApprovalNotification } from "./approval.ts";
import { __mailOutbox, __resetMailOutbox } from "./mail.ts";

const COLLECTION = process.env.FIRESTORE_USERS_COLLECTION || "users";
const SUB = "test-approval-email"; // テスト専用ドキュメント（前後で必ず削除する）
const EMAIL = "approve-me@example.com";

const EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST;

function ref() {
  return firestore().collection(COLLECTION).doc(SUB);
}

async function seed(fields: Record<string, unknown>) {
  await ref().set({ sub: SUB, email: EMAIL, name: "承認テスト", role: "user", ...fields });
}

async function readRaw(): Promise<Record<string, unknown>> {
  const snap = await ref().get();
  return (snap.exists ? snap.data() : {}) ?? {};
}

before(() => {
  process.env.MAIL_PROVIDER = "memory";
});
beforeEach(async () => {
  __resetMailOutbox();
  await ref().delete().catch(() => {});
});
after(async () => {
  await ref().delete().catch(() => {});
});

test(
  "approveUser: false→true で承認完了メールを 1 通送り、冪等キーが立つ",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    await seed({ allowed: false });

    const res = await approveUser(SUB);

    assert.equal(res.changed, true, "false→true の遷移が起きた");
    assert.equal(res.user?.allowed, true, "allowed が true になった");
    assert.equal(__mailOutbox.length, 1, "メールが 1 通送られた");
    assert.equal(__mailOutbox[0].to, EMAIL);
    assert.ok(__mailOutbox[0].subject.includes("承認"), "件名に承認の旨が含まれる");
    assert.ok(
      (__mailOutbox[0].text ?? "").includes("http"),
      "本文にログイン導線（URL）が含まれる",
    );
    const raw = await readRaw();
    assert.equal(typeof raw.approvalNotifiedAt, "string", "送信済みタイムスタンプが記録される");
  },
);

test(
  "approveUser: 二重承認では 2 通目を送らない（冪等）",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    await seed({ allowed: false });

    await approveUser(SUB);
    const second = await approveUser(SUB); // 既に true → changed=false

    assert.equal(second.changed, false, "true→true では変化なし");
    assert.equal(__mailOutbox.length, 1, "メールは 1 通のまま");
  },
);

test(
  "approveUser: 既に承認済み（approvalNotifiedAt あり）には送らない",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    await seed({ allowed: true, approvalNotifiedAt: "2020-01-01T00:00:00.000Z" });

    const res = await approveUser(SUB);

    assert.equal(res.changed, false, "true→true は変化なし");
    assert.equal(__mailOutbox.length, 0, "送信されない");
  },
);

test(
  "sendApprovalNotification: allowed=false には送らない",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    await seed({ allowed: false });

    await sendApprovalNotification(SUB);

    assert.equal(__mailOutbox.length, 0, "未承認には送らない");
    const raw = await readRaw();
    assert.equal(raw.approvalNotifiedAt, undefined, "冪等キーも立たない");
  },
);

test(
  "sendApprovalNotification: 同時呼び出しでも 1 通に収束する",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    await seed({ allowed: true });

    await Promise.all([
      sendApprovalNotification(SUB),
      sendApprovalNotification(SUB),
      sendApprovalNotification(SUB),
    ]);

    assert.equal(__mailOutbox.length, 1, "トランザクションで送信枠を確保し 1 通のみ");
  },
);

test(
  "sendApprovalNotification: 送信失敗時は送信枠を戻して再送できる",
  { skip: EMULATOR ? false : "Firestore エミュレータ未起動" },
  async () => {
    await seed({ allowed: true });

    // 一度だけ失敗させるプロバイダに差し替える（resend でも log でもない値でエラーを誘発）。
    const prev = process.env.MAIL_PROVIDER;
    process.env.MAIL_PROVIDER = "resend";
    const prevKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY; // RESEND_API_KEY 無し → sendMail が throw

    await sendApprovalNotification(SUB);
    assert.equal(__mailOutbox.length, 0, "送信は失敗した");
    const rawAfterFail = await readRaw();
    assert.equal(rawAfterFail.approvalNotifiedAt, undefined, "失敗で送信枠が戻る（再送可能）");

    // memory に戻して再送すると今度は成功して 1 通届く。
    process.env.MAIL_PROVIDER = "memory";
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey;
    await sendApprovalNotification(SUB);
    assert.equal(__mailOutbox.length, 1, "再送で 1 通届く");

    process.env.MAIL_PROVIDER = prev;
  },
);
