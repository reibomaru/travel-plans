// ============================================================
//  メール送信基盤（#102）。
//
//  承認完了メール等のトランザクショナルメールを送るための薄い抽象。
//  送信バックエンド（プロバイダ）は環境変数で切り替える:
//    resend … Resend の HTTP API（本番想定）。RESEND_API_KEY が必要。
//    log    … 実送信せず内容をログ出力するだけ（ローカル開発の既定）。
//    memory … プロセス内の配列に貯める（結合テスト用）。
//  MAIL_PROVIDER 未指定なら「RESEND_API_KEY があれば resend、無ければ log」。
//
//  API キー（RESEND_API_KEY）は Secret Manager で管理し、Cloud Run では環境変数
//  として注入する（GEMINI_API_KEY と同じ方針。server/apiKeys.ts 参照）。DB/Firestore
//  には置かない。
// ============================================================

/** 送信する 1 通のメール。html/text は少なくとも一方を渡す。 */
export interface MailMessage {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

/** どのプロバイダで送るかを解決する（呼び出しごとに env を読む＝テストで差し替え可能）。 */
function pickProvider(): "resend" | "log" | "memory" {
  const forced = (process.env.MAIL_PROVIDER || "").toLowerCase();
  if (forced === "resend" || forced === "log" || forced === "memory") return forced;
  return process.env.RESEND_API_KEY ? "resend" : "log";
}

/** 差出人アドレス（未設定は開発用の既定。本番では MAIL_FROM を必ず設定する）。 */
function mailFrom(): string {
  return process.env.MAIL_FROM || "shiori <onboarding@resend.dev>";
}

// ---- memory プロバイダ（テスト用の送信箱）--------------------------------
/** memory プロバイダで送ったメールの一覧（テストから参照する）。 */
export const __mailOutbox: MailMessage[] = [];
/** テスト前に送信箱を空にする。 */
export function __resetMailOutbox(): void {
  __mailOutbox.length = 0;
}

// ---- resend プロバイダ（本番）--------------------------------------------
async function sendViaResend(msg: MailMessage): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY が未設定のため Resend で送信できません。");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: mailFrom(),
      to: [msg.to],
      subject: msg.subject,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.text ? { text: msg.text } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend 送信に失敗しました（HTTP ${res.status}）: ${detail}`);
  }
}

/**
 * メールを 1 通送る。プロバイダは環境で解決する。
 * @throws 送信に失敗した場合（呼び出し側で握りつぶすかは用途次第）。
 */
export async function sendMail(msg: MailMessage): Promise<void> {
  const provider = pickProvider();
  if (provider === "memory") {
    __mailOutbox.push(msg);
    return;
  }
  if (provider === "log") {
    console.log(`📧 [mail:log] to=${msg.to} subject=${msg.subject}\n${msg.text ?? msg.html ?? ""}`);
    return;
  }
  await sendViaResend(msg);
}
