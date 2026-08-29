// ============================================================
//  ユーザー台帳 + Firestore クライアント。
//
//  認証（Google SSO）で解決した Google `sub` をキーに、ユーザーの
//  プロフィール（email/name とロール、表示名・アバター）と利用許可（allowed）を
//  Firestore の users コレクションで管理する。ログインは許可制: 新規ユーザーは
//  allowed=false（承認待ち）で登録され、承認（allowed=true）されるまでアプリを
//  使えない。承認済みユーザーの中で、どのプロジェクトを見られるかはプロジェクト
//  メンバーシップ（server/projects.ts）が担う。role は将来のプラットフォーム
//  管理用に保持する（現状は未使用）。
//
//  承認は Firestore の該当ドキュメントを allowed=true にする
//  （初期は GCP コンソール / gcloud で直接編集）。
//
//  プロフィール（displayName / avatar）は本人が随時編集でき、/auth/me が
//  毎回読み出して反映する（セッション JWT は再発行しない）。
//
//  Firestore クライアントは projects.ts と共有する（firestore() を export）。
//  認証情報は Cloud Run では ADC（実行 SA）、ローカルでは
//  GOOGLE_APPLICATION_CREDENTIALS か Firestore エミュレータを使う。
// ============================================================
import { Firestore, FieldValue } from "@google-cloud/firestore";

const COLLECTION = process.env.FIRESTORE_USERS_COLLECTION || "users";

/** ユーザーのロール（将来のプラットフォーム管理用）。 */
export type Role = "admin" | "user";

/** ログインユーザーの識別情報 + プロフィール。 */
export interface UserRecord {
  sub: string;
  email: string;
  name: string;
  /** アプリの利用許可（承認制）。新規は false、承認で true。 */
  allowed: boolean;
  role: Role;
  /** 本人が設定した表示名（未設定なら name を使う）。 */
  displayName?: string;
  /** Google プロフィール写真 URL（ログイン時に取得・アバター初期値）。 */
  picture?: string;
  /** 本人がアップロードしたアバター（リサイズ済みの data URL）。 */
  avatar?: string;
  /** 承認完了メールを送った時刻（ISO 文字列）。未送信は undefined（#102・冪等キー）。 */
  approvalNotifiedAt?: string;
}

/** 不明値を安全に Role へ丸める（既定 user）。 */
function toRole(v: unknown): Role {
  return v === "admin" ? "admin" : "user";
}

/** Firestore ドキュメントを UserRecord へマップする。 */
function toUserRecord(id: string, x: Record<string, unknown>): UserRecord {
  return {
    sub: id,
    email: typeof x.email === "string" ? x.email : "",
    name: typeof x.name === "string" ? x.name : "",
    allowed: x.allowed === true,
    role: toRole(x.role),
    displayName: typeof x.displayName === "string" ? x.displayName : undefined,
    picture: typeof x.picture === "string" ? x.picture : undefined,
    avatar: typeof x.avatar === "string" ? x.avatar : undefined,
    approvalNotifiedAt: typeof x.approvalNotifiedAt === "string" ? x.approvalNotifiedAt : undefined,
  };
}

/** アバター表示用 URL（アップロード優先、無ければ Google 写真）。 */
export function avatarUrlOf(rec: Pick<UserRecord, "avatar" | "picture">): string | null {
  return rec.avatar || rec.picture || null;
}

let _fs: Firestore | null = null;
/** 共有 Firestore クライアント（users / projects で使う）。 */
export function firestore(): Firestore {
  if (!_fs) {
    _fs = new Firestore({
      // projectId は Cloud Run ではメタデータから自動解決される。ローカルは env で指定。
      projectId: process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || undefined,
      databaseId: process.env.FIRESTORE_DATABASE_ID || "(default)",
    });
  }
  return _fs;
}

/**
 * ログイン時に users を JIT upsert し、利用許可とロールを返す。
 * - 新規: allowed=false（承認待ち）/ role=user で作成。
 * - 既存: email / name / picture / updatedAt を更新し、既存の allowed / role を返す。
 * 利用可否は「ログイン時のみ」判定する（server/auth.ts のコールバック）。
 */
export async function upsertUserOnLogin(
  sub: string,
  email: string,
  name: string,
  picture?: string,
): Promise<UserRecord> {
  const ref = firestore().collection(COLLECTION).doc(sub);
  const snap = await ref.get();
  const now = new Date().toISOString();
  const pic = picture ? { picture } : {};

  if (!snap.exists) {
    const doc = { sub, email, name, allowed: false, role: "user", createdAt: now, updatedAt: now, ...pic };
    await ref.set(doc);
    return toUserRecord(sub, doc);
  }

  const data = snap.data() ?? {};
  const patch = { email, name, updatedAt: now, ...pic };
  await ref.set(patch, { merge: true });
  return toUserRecord(sub, { ...data, ...patch });
}

// ============================================================
//  BYOK（ユーザー自身の Gemini API キー）の利用量・上限（#93）。
//
//  API キー本体は Secret Manager 等に置き（server/apiKeys.ts）、ここでは
//  「BYOK 登録の有無フラグ」と「共有キー利用時の月次コスト集計・上限」だけを
//  users ドキュメントで管理する。集計は per-user・月次（UTC）で、共有キーを
//  使ったときだけ加算する（BYOK 利用時はコストがユーザー負担のため対象外）。
// ============================================================

/** AI 利用状態（BYOK 有無・当月の消費・上限）。 */
export interface AiUsageState {
  /** BYOK（自分の API キー）を登録済みか。 */
  hasByokKey: boolean;
  /** 集計が記録されている月（"YYYY-MM"・UTC）。 */
  usageMonth: string;
  /** usageMonth の共有キー利用の累計コスト（USD）。上限判定に使う。 */
  usageCostUsd: number;
  /** usageMonth の BYOK 利用の累計コスト（USD）。表示のみ（上限は適用しない）。 */
  byokUsageCostUsd: number;
  /** ユーザーごとの月次上限の上書き（未設定は null → 環境変数の既定を使う）。 */
  limitUsd: number | null;
}

/** 現在の集計対象月（"YYYY-MM"・UTC）。月初(UTC)に自然にリセットされる。 */
export function currentUsageMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** users ドキュメントから BYOK 利用状態を読む（未登録・未集計は 0 として返す）。 */
export async function getAiUsageState(sub: string): Promise<AiUsageState> {
  const snap = await firestore().collection(COLLECTION).doc(sub).get();
  const x = (snap.exists ? snap.data() : {}) ?? {};
  return {
    hasByokKey: x.hasByokKey === true,
    usageMonth: typeof x.usageMonth === "string" ? x.usageMonth : "",
    usageCostUsd: typeof x.usageCostUsd === "number" ? x.usageCostUsd : 0,
    byokUsageCostUsd: typeof x.byokUsageCostUsd === "number" ? x.byokUsageCostUsd : 0,
    limitUsd: typeof x.sharedKeyMonthlyLimitUsd === "number" ? x.sharedKeyMonthlyLimitUsd : null,
  };
}

/** BYOK 登録の有無フラグを立てる/降ろす（キー本体の保存は apiKeys.ts）。 */
export async function setByokKeyFlag(sub: string, has: boolean): Promise<void> {
  await firestore()
    .collection(COLLECTION)
    .doc(sub)
    .set({ hasByokKey: has, updatedAt: new Date().toISOString() }, { merge: true });
}

/**
 * AI 利用コストを当月の集計へ加算する（トランザクションで月替わりも処理）。
 * 共有キー(shared)分と BYOK(byok)分を別々のフィールドに積む。usageMonth が当月と
 * 異なれば両方を 0 にリセットしてから当月ぶんとして記録し直す（片方だけ古い値が
 * 残らないよう、書き込むフィールド以外もリセットする）。
 */
export async function recordAiUsage(sub: string, costUsd: number, source: "shared" | "byok"): Promise<void> {
  if (!(costUsd > 0)) return;
  const ref = firestore().collection(COLLECTION).doc(sub);
  const month = currentUsageMonth();
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const x = (snap.exists ? snap.data() : {}) ?? {};
    const sameMonth = x.usageMonth === month;
    const shared = sameMonth && typeof x.usageCostUsd === "number" ? x.usageCostUsd : 0;
    const byok = sameMonth && typeof x.byokUsageCostUsd === "number" ? x.byokUsageCostUsd : 0;
    tx.set(
      ref,
      {
        usageMonth: month,
        usageCostUsd: shared + (source === "shared" ? costUsd : 0),
        byokUsageCostUsd: byok + (source === "byok" ? costUsd : 0),
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  });
}

/** 本人のプロフィール（表示名・アバター等）を取得する。未登録は null。 */
export async function getUserProfile(sub: string): Promise<UserRecord | null> {
  const snap = await firestore().collection(COLLECTION).doc(sub).get();
  if (!snap.exists) return null;
  return toUserRecord(sub, snap.data() ?? {});
}

/**
 * 本人のプロフィールを更新する（存在必須）。
 * - displayName: 空文字 / null はフィールド削除（＝name にフォールバック）。
 * - avatar: null はフィールド削除（＝Google 写真にフォールバック）。
 * undefined のフィールドは変更しない。更新後のレコードを返す。
 */
export async function updateOwnProfile(
  sub: string,
  patch: { displayName?: string | null; avatar?: string | null },
): Promise<UserRecord | null> {
  const ref = firestore().collection(COLLECTION).doc(sub);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.displayName !== undefined) {
    update.displayName = patch.displayName ? patch.displayName : FieldValue.delete();
  }
  if (patch.avatar !== undefined) {
    update.avatar = patch.avatar === null ? FieldValue.delete() : patch.avatar;
  }
  await ref.set(update, { merge: true });

  // FieldValue.delete() の反映後の正確な状態を返すため読み直す。
  const fresh = await ref.get();
  return toUserRecord(sub, fresh.data() ?? {});
}

// ============================================================
//  利用承認とその通知（#102）。
//
//  承認は allowed を false → true にする操作。承認の入口（管理ダッシュボード）は
//  #103 が担い、ここでは「allowed の切り替え」と「承認完了メールの冪等な送信状態」
//  を Firestore で管理する低レベル API を提供する。メール本文の組み立て・送信の
//  オーケストレーションは server/approval.ts が担当する。
// ============================================================

/** setUserAllowed の結果。changed は今回の呼び出しで実際に値が変わったか。 */
export interface SetAllowedResult {
  /** false→true / true→false の遷移が今回起きたか（冪等呼び出しでは false）。 */
  changed: boolean;
  /** 更新後（既に同値だった場合は現状）のユーザーレコード。存在しなければ null。 */
  user: UserRecord | null;
}

/**
 * ユーザーの利用許可（allowed）を設定する。トランザクションで現在値と比較し、
 * 実際に変わったときだけ書き込む（冪等）。ドキュメントが無ければ何もしない。
 */
export async function setUserAllowed(sub: string, allowed: boolean): Promise<SetAllowedResult> {
  const ref = firestore().collection(COLLECTION).doc(sub);
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { changed: false, user: null };
    const data = snap.data() ?? {};
    const current = data.allowed === true;
    if (current === allowed) {
      return { changed: false, user: toUserRecord(sub, data) };
    }
    const patch = { allowed, updatedAt: new Date().toISOString() };
    tx.set(ref, patch, { merge: true });
    return { changed: true, user: toUserRecord(sub, { ...data, ...patch }) };
  });
}

/**
 * 承認完了メールの送信枠を「予約」する（冪等キー approvalNotifiedAt を立てる）。
 * - allowed=true かつ未通知（approvalNotifiedAt 無し）のときだけ枠を確保し、その
 *   ユーザーレコードを返す（＝呼び出し側は 1 回だけ送信する）。
 * - 既に通知済み・未承認・存在しない場合は null（＝送らない）。
 * トランザクションで確保するため、同時に複数回呼ばれても送信は 1 回に収束する。
 * 送信に失敗した場合は releaseApprovalNotification で枠を戻して再送可能にする。
 */
export async function claimApprovalNotification(sub: string): Promise<UserRecord | null> {
  const ref = firestore().collection(COLLECTION).doc(sub);
  return firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() ?? {};
    if (data.allowed !== true) return null; // 未承認には送らない
    if (typeof data.approvalNotifiedAt === "string") return null; // 送信済み（冪等）
    const now = new Date().toISOString();
    tx.set(ref, { approvalNotifiedAt: now, updatedAt: now }, { merge: true });
    return toUserRecord(sub, { ...data, approvalNotifiedAt: now });
  });
}

/** 送信失敗時に予約を取り消す（approvalNotifiedAt を消し、次の承認操作で再送できるようにする）。 */
export async function releaseApprovalNotification(sub: string): Promise<void> {
  await firestore()
    .collection(COLLECTION)
    .doc(sub)
    .set({ approvalNotifiedAt: FieldValue.delete(), updatedAt: new Date().toISOString() }, { merge: true });
}
