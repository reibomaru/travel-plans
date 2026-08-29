// ============================================================
//  利用承認 → 承認完了メール送信（#102）。
//
//  管理ダッシュボード（#103）から呼ばれる承認操作の本体。allowed を false→true に
//  切り替え、実際に切り替わったとき「だけ」本人へ承認完了メールを送る。
//
//  設計方針:
//    - 冪等: 二重の防御。(1) allowed の遷移は setUserAllowed がトランザクションで
//      検知し、true→true では changed=false になり送らない。(2) 送信自体も
//      approvalNotifiedAt（送信済みタイムスタンプ）で 1 回に収束させる。
//    - 疎結合: メール送信の失敗は承認処理を失敗させない。失敗はログに残し、
//      approvalNotifiedAt を戻して次の承認操作で再送できるようにする。
// ============================================================
import {
  setUserAllowed,
  claimApprovalNotification,
  releaseApprovalNotification,
  type SetAllowedResult,
  type UserRecord,
} from "./users.ts";
import { sendMail } from "./mail.ts";

/** ログイン導線に使うサービスの URL（APP_BASE_URL 優先・ローカルは Vite の既定）。 */
function loginUrl(): string {
  const base = process.env.APP_BASE_URL || "http://localhost:5173";
  return base.replace(/\/$/, "") + "/";
}

/** HTML メール本文向けのエスケープ（宛先メール等のユーザー由来文字列用）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 承認完了メールの件名・本文（当面は日本語のみ。i18n は将来検討）。 */
export function buildApprovalEmail(email: string): { subject: string; html: string; text: string } {
  const url = loginUrl();
  const subject = "【shiori】利用申請が承認されました";
  const text = [
    `${email} 様`,
    "",
    "shiori の利用申請が承認されました。ご利用いただけるようになりました。",
    "",
    "下記の URL からログイン（Google アカウントで再ログイン）してご利用ください。",
    url,
    "",
    "――",
    "このメールは送信専用です。",
  ].join("\n");
  const html = `<!doctype html>
<html lang="ja">
<body style="margin:0;padding:24px;background:#0b1120;font-family:'Ubuntu','Noto Sans JP',system-ui,-apple-system,'Hiragino Sans',sans-serif;color:#e2e8f0;">
  <div style="max-width:30rem;margin:0 auto;padding:32px;border-radius:16px;background:rgba(255,255,255,.05);line-height:1.8;box-shadow:inset 0 0 0 1px rgba(34,211,238,.15);">
    <div style="font-family:'Ubuntu Mono',ui-monospace,Menlo,monospace;font-size:24px;font-weight:700;letter-spacing:.04em;color:#22d3ee;margin-bottom:18px;">shiori</div>
    <h1 style="font-size:20px;margin:0 0 14px;color:#f1f5f9;">利用申請が承認されました</h1>
    <p style="margin:0 0 12px;font-size:14px;color:#cbd5e1;">アカウント（<b style="color:#f1f5f9;">${escapeHtml(email)}</b>）の利用申請が承認されました。<br />ご利用いただけるようになりました。</p>
    <p style="margin:0 0 12px;font-size:14px;color:#cbd5e1;">下記のボタンからログイン（Google アカウントで再ログイン）してご利用ください。</p>
    <p><a href="${escapeHtml(url)}" style="display:inline-block;margin-top:10px;padding:10px 18px;border-radius:10px;background:#22d3ee;color:#0b1120;font-weight:600;text-decoration:none;">shiori を開く</a></p>
    <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">ボタンが開けない場合は次の URL をブラウザに貼り付けてください:<br />${escapeHtml(url)}</p>
  </div>
</body>
</html>`;
  return { subject, html, text };
}

/**
 * 承認完了メールを冪等に送る。approvalNotifiedAt で送信枠を確保し、未送信のときだけ
 * 実送信する。送信失敗時は枠を戻し、例外は投げない（承認処理と疎結合に保つ）。
 */
export async function sendApprovalNotification(sub: string): Promise<void> {
  let user: UserRecord | null = null;
  try {
    user = await claimApprovalNotification(sub);
  } catch (e) {
    console.error("承認完了メールの送信枠確保に失敗しました:", e);
    return;
  }
  if (!user) return; // 送信済み・未承認・存在しない
  if (!user.email) {
    console.warn(`承認完了メール: ユーザー ${sub} に email が無いため送信をスキップします。`);
    return;
  }
  try {
    const { subject, html, text } = buildApprovalEmail(user.email);
    await sendMail({ to: user.email, subject, html, text });
  } catch (e) {
    console.error(`承認完了メールの送信に失敗しました（sub=${sub}）:`, e);
    // 次の承認操作で再送できるよう送信枠を戻す。
    await releaseApprovalNotification(sub).catch((e2) =>
      console.error("承認完了メールの送信枠の巻き戻しに失敗しました:", e2),
    );
  }
}

/**
 * ユーザーを承認する（allowed: false→true）。#103 の承認 UI／エンドポイントから呼ぶ想定。
 * 実際に false→true へ切り替わったときだけ承認完了メールを送る（メール送信は疎結合で、
 * 失敗しても承認自体は成功扱い）。
 */
export async function approveUser(sub: string): Promise<SetAllowedResult> {
  const res = await setUserAllowed(sub, true);
  if (res.changed) {
    await sendApprovalNotification(sub);
  }
  return res;
}
