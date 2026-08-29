// API クライアント。Vite の proxy 経由で /api を叩きます。
import type { TripPayload, MemoPage, MemoImageMeta, Expense, ExpenseExtraction } from "./types";
import type { ChatMessage } from "./hooks/useSpotChat";
import type { MemoChatMessage } from "./hooks/useMemoChat";

/** メモの抽出/添付に使う画像（base64・プレフィックス無し）。 */
export interface MemoImage {
  data: string;
  mimeType: string;
}

/** 取り込んだ元画像の配信 URL。version（updated_at）を付けて回転後のキャッシュを更新する。 */
export const memoImageUrl = (id: string, version?: string) =>
  `/api/memo/images/${id}${version ? `?v=${encodeURIComponent(version)}` : ""}`;

/**
 * 領収書ファイルの配信 URL。<img>/<iframe> は X-Project-Id ヘッダを付けられないため、
 * projectId をクエリで渡す（サーバはヘッダ／クエリの両方を受け付ける）。
 * version（updated_at）はキャッシュ更新用。
 */
export const expenseImageUrl = (id: string, version?: string) => {
  const params = new URLSearchParams();
  const pid = getActiveProject();
  if (pid) params.set("projectId", pid);
  if (version) params.set("v", version);
  const qs = params.toString();
  return `/api/expenses/images/${id}${qs ? `?${qs}` : ""}`;
};

/** チャットセッション一覧の 1 行（サーバの chat_sessions より）。 */
export interface ChatSessionSummary {
  id: string;
  title: string | null;
  message_count: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
  has_history: boolean;
}

/** Google マップの評価（★）・写真。Places API から取得し DB に30日キャッシュ。 */
export interface SpotRating {
  rating: number;
  userRatingCount: number;
  googleMapsUri: string | null;
  photoUrls: string[]; // Places の写真 URL（lh3.googleusercontent.com）。複数枚。
}
export interface SpotRatingsResponse {
  configured: boolean; // GOOGLE_MAPS_API_KEY が設定されているか（未設定でもキャッシュは返る）
  ratings: Record<string, SpotRating | null>;
}

/** ジオコーディング結果（地名→座標）。 */
export interface GeocodeResult {
  name: string; // 短い名称（from_name 用）
  label: string; // 表示用の詳細（名称, 都市, 州, 国）
  lng: number;
  lat: number;
}

/** OSRM の経路候補（移動データ作成用）。 */
export interface OsrmRoute {
  distance: number; // m
  duration: number; // s
  geometry: { type: "LineString"; coordinates: [number, number][] };
  via?: string; // 主な経路（道路名のまとめ）
  roads?: string[]; // 経由する主な道路名
  waypoints?: string[]; // 通過する町名（逆ジオコード）
}

/** ユーザーのロール。 */
export type Role = "admin" | "user";

/** ログイン中のユーザー情報（/auth/me）。 */
export interface Me {
  email: string;
  name: string;
  role: Role;
  /** 本人が設定した表示名（未設定は null）。UI 表示は displayName ?? name。 */
  displayName?: string | null;
  /** アバター表示用 URL（アップロード or Google 写真、無ければ null）。 */
  avatarUrl?: string | null;
}

/** 管理ダッシュボード（/admin）が扱うユーザー台帳の 1 行。 */
export interface AdminUser {
  sub: string;
  email: string;
  name: string;
  /** アプリの利用許可（承認制）。false は承認待ち。 */
  allowed: boolean;
  role: Role;
  displayName?: string;
  picture?: string;
  avatar?: string;
  /** 初回ログイン（JIT 登録）の日時（ISO 8601）。 */
  createdAt?: string;
  /** 最終更新日時（ISO 8601）。 */
  updatedAt?: string;
}

/** 管理 API がアクセスを拒んだ理由（画面の出し分け用）。 */
export type AdminDeniedReason = "forbidden" | "unauthorized" | "unconfigured";

/** 管理 API のアクセス拒否（403 / 401 / 503）。画面で理由別の案内を出す。 */
export class AdminAccessError extends Error {
  constructor(readonly reason: AdminDeniedReason) {
    super(`admin access denied: ${reason}`);
    this.name = "AdminAccessError";
  }
}

/** 表示に使う名前を返す（displayName 優先、無ければ name、最後に email）。 */
export const displayNameOf = (u: { displayName?: string | null; name?: string; email: string }) =>
  u.displayName || u.name || u.email;

/** BYOK（自分の Gemini API キー）の状態（GET /api/byok）。 */
export interface ByokStatus {
  /** BYOK を登録済みか。 */
  hasKey: boolean;
  /** 次のリクエストで使われるキーの出所（byok=自分のキー / shared=共有キー）。 */
  source: "byok" | "shared";
  /** 共有キー利用時の当月の消費と上限。 */
  usage: { month: string; costUsd: number; limitUsd: number };
  /** サーバに共有キーが設定されているか（未設定なら未登録ユーザーは AI を使えない）。 */
  sharedKeyConfigured: boolean;
}

/** プロジェクト（テナント）の一覧行。 */
export interface Project {
  id: string;
  name: string;
  ownerSub: string;
  ownerEmail: string;
  memberEmails: string[];
}

/** プロジェクトのメンバー情報。 */
export interface ProjectMembers {
  ownerEmail: string;
  members: string[];
}

// アクティブプロジェクト（URL の /projects/{id} から ProjectProvider が設定する）。
// ドメイン API リクエストに X-Project-Id ヘッダとして付与する。
let activeProjectId: string | null = null;
export function setActiveProject(id: string | null): void {
  activeProjectId = id;
}
export function getActiveProject(): string | null {
  return activeProjectId;
}
/** SSE など fetch を直接呼ぶ箇所で使う X-Project-Id ヘッダ。 */
export function projectHeader(): Record<string, string> {
  return activeProjectId ? { "X-Project-Id": activeProjectId } : {};
}

async function http<T>(url: string, method: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  // ドメイン API（/api/trip 等）は対象プロジェクトをヘッダで指定する。
  // プロジェクト管理 API（/api/projects*）はヘッダ不要（付いても無害）。
  if (activeProjectId && url.startsWith("/api/") && !url.startsWith("/api/projects")) {
    headers["X-Project-Id"] = activeProjectId;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin", // 認証セッション Cookie を送る
  });
  // セッション切れ（未認証）はリロードして認証ゲート（ログイン画面）に戻す。
  if (res.status === 401) {
    window.location.reload();
    throw new Error("unauthenticated");
  }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  // 空ボディ（Content-Length: 0 や 204）を res.json() に渡すと
  // "Unexpected end of JSON input" で落ちるため、テキストを見てから解釈する。
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * 管理 API 用の fetch。http() と違い 401 でリロードせず、アクセス拒否を
 * AdminAccessError として投げ返す（画面が理由別の案内を出せるようにする）。
 */
async function adminHttp<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) throw new AdminAccessError("unauthorized");
  if (res.status === 403) throw new AdminAccessError("forbidden");
  if (res.status === 503) throw new AdminAccessError("unconfigured");
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error || `${method} ${url} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  // ---- 認証 ----
  // 現在のユーザーを取得。未ログインは null（認証ゲートがログイン画面を出す）。
  me: async (): Promise<Me | null> => {
    const res = await fetch("/auth/me", { credentials: "same-origin" });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`/auth/me -> ${res.status}`);
    return (await res.json()) as Me;
  },
  logout: () => fetch("/auth/logout", { method: "POST", credentials: "same-origin" }),
  // 自分のプロフィール（表示名・アバター）を更新。avatar は data URL、null で削除、
  // undefined は据え置き。更新後の Me を返す。
  updateProfile: (patch: { displayName?: string | null; avatar?: string | null }) =>
    http<Me>("/api/profile", "PATCH", patch),

  // ---- BYOK（自分の Gemini API キー）----
  getByok: () => http<ByokStatus>("/api/byok", "GET"),
  // キーを登録/更新。サーバ側で疎通確認し、無効なら 400（http が throw）。
  setByok: (apiKey: string) => http<ByokStatus>("/api/byok", "PUT", { apiKey }),
  deleteByok: () => http<ByokStatus>("/api/byok", "DELETE"),

  // ---- プロジェクト（テナント）----
  listProjects: () => http<Project[]>("/api/projects", "GET"),
  createProject: (name: string) => http<Project>("/api/projects", "POST", { name }),
  renameProject: (id: string, name: string) => http<Project>(`/api/projects/${id}`, "PATCH", { name }),
  deleteProject: (id: string) => http(`/api/projects/${id}`, "DELETE"),
  getMembers: (id: string) => http<ProjectMembers>(`/api/projects/${id}/members`, "GET"),
  addMember: (id: string, email: string) => http<ProjectMembers>(`/api/projects/${id}/members`, "POST", { email }),
  removeMember: (id: string, email: string) =>
    http<ProjectMembers>(`/api/projects/${id}/members/${encodeURIComponent(email)}`, "DELETE"),

  // ---- 管理ダッシュボード（admin 限定・Basic 認証）----
  // /admin/* は Basic 認証（ブラウザが資格情報を保持）+ role=admin の二段構え。
  // 401（未ログイン）でアプリ全体をリロードさせたくないので http() は使わない。
  listAdminUsers: () => adminHttp<AdminUser[]>("/admin/api/users", "GET"),
  updateAdminUser: (sub: string, patch: { allowed?: boolean; role?: Role }) =>
    adminHttp<AdminUser>(`/admin/api/users/${encodeURIComponent(sub)}`, "PATCH", patch),

  getTrip: () => http<TripPayload>("/api/trip", "GET"),

  updateTrip: (patch: Record<string, unknown>) => http("/api/trip", "PUT", patch),

  createDay: (body: Record<string, unknown>) => http(`/api/days`, "POST", body),
  updateDay: (id: string, patch: Record<string, unknown>) => http(`/api/days/${id}`, "PUT", patch),
  deleteDay: (id: string) => http(`/api/days/${id}`, "DELETE"),

  updateItem: (id: string, patch: Record<string, unknown>) => http(`/api/items/${id}`, "PUT", patch),
  createItem: (body: Record<string, unknown>) => http(`/api/items`, "POST", body),
  deleteItem: (id: string) => http(`/api/items/${id}`, "DELETE"),

  updateBudget: (id: string, patch: Record<string, unknown>) => http(`/api/budget/${id}`, "PUT", patch),
  createBudget: (body: Record<string, unknown>) => http(`/api/budget`, "POST", body),
  deleteBudget: (id: string) => http(`/api/budget/${id}`, "DELETE"),

  // ---- 実費（確定した予約・領収書） ----
  createExpense: (body: Record<string, unknown>) => http<Expense>(`/api/expenses`, "POST", body),
  updateExpense: (id: string, patch: Record<string, unknown>) => http<Expense>(`/api/expenses/${id}`, "PUT", patch),
  deleteExpense: (id: string) => http(`/api/expenses/${id}`, "DELETE"),
  // 領収書ファイル（画像/PDF）を実費に追加保存し、更新後の実費を返す。filename は任意。
  addExpenseImages: (id: string, images: Array<MemoImage & { filename?: string | null }>) =>
    http<Expense>(`/api/expenses/${id}/images`, "POST", { images }),
  deleteExpenseImage: (id: string) => http(`/api/expenses/images/${id}`, "DELETE"),
  // 領収書・請求書/予約完了画面のスクショや PDF から実費情報を抽出する（保存はしない）。
  extractReceipt: (files: MemoImage[]) =>
    http<{ extraction: ExpenseExtraction; warning?: string }>(`/api/expenses/extract`, "POST", { images: files }),

  getSpotRatings: () => http<SpotRatingsResponse>(`/api/spots/ratings`, "GET"),
  // 提案プレビュー用: 保存前スポットの評価・写真を名称等のクエリで取得。
  previewSpotPhotos: (q: string) =>
    http<{ configured: boolean; rating: SpotRating | null }>(
      `/api/spots/place-preview?q=${encodeURIComponent(q)}`,
      "GET"
    ),
  createSpot: (body: Record<string, unknown>) => http(`/api/spots`, "POST", body),
  updateSpot: (id: string, patch: Record<string, unknown>) => http(`/api/spots/${id}`, "PUT", patch),
  deleteSpot: (id: string) => http(`/api/spots/${id}`, "DELETE"),

  updateRoute: (id: string, patch: Record<string, unknown>) => http(`/api/route/${id}`, "PUT", patch),

  createLeg: (body: Record<string, unknown>) => http(`/api/legs`, "POST", body),
  deleteLeg: (id: string) => http(`/api/legs/${id}`, "DELETE"),
  // 地名→座標（Photon）。lat/lon を渡すと近傍を優先。tag で OSM 種別（例: 空港）に絞る。
  geocode: (q: string, bias?: { lat: number; lng: number }, tag?: string) =>
    http<{ results: GeocodeResult[]; error?: string }>(
      `/api/geocode?q=${encodeURIComponent(q)}${bias ? `&lat=${bias.lat}&lon=${bias.lng}` : ""}${
        tag ? `&tag=${encodeURIComponent(tag)}` : ""
      }`,
      "GET"
    ),
  // OSRM の経路候補を取得（from/to/vias は "lng,lat"）。経由地は from→via…→to の順。
  osrmRoute: (from: string, to: string, profile = "driving", vias: string[] = []) =>
    http<{ routes: OsrmRoute[]; error?: string }>(
      `/api/osrm?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&profile=${profile}${
        vias.length ? `&via=${encodeURIComponent(vias.join(";"))}` : ""
      }`,
      "GET"
    ),

  // ---- メモ（複数ページ） ----
  listMemoPages: () => http<MemoPage[]>(`/api/memo/pages`, "GET"),
  createMemoPage: (body: Record<string, unknown> = {}) => http<MemoPage>(`/api/memo/pages`, "POST", body),
  updateMemoPage: (id: string, patch: Record<string, unknown>) => http<MemoPage>(`/api/memo/pages/${id}`, "PUT", patch),
  deleteMemoPage: (id: string) => http(`/api/memo/pages/${id}`, "DELETE"),
  // 元画像を保存しつつ情報を抽出して HTML/テキストをページに追記し、更新後のページを返す。
  // 抽出に失敗しても元画像は保存され、warning が添えられる。
  extractMemoPage: (id: string, images: MemoImage[]) =>
    http<MemoPage & { warning?: string }>(`/api/memo/pages/${id}/extract`, "POST", { images }),
  deleteMemoImage: (id: string) => http(`/api/memo/images/${id}`, "DELETE"),
  // 画像の実体を差し替える（回転後の PNG を保存）。更新後のメタを返す。
  replaceMemoImage: (id: string, image: MemoImage) => http<MemoImageMeta>(`/api/memo/images/${id}`, "PUT", image),

  // ---- メモ編集チャットのセッション ----
  listMemoChatSessions: () => http<ChatSessionSummary[]>(`/api/memo/chat/sessions`, "GET"),
  getMemoChatSessionMessages: (id: string) =>
    http<MemoChatMessage[]>(`/api/memo/chat/sessions/${id}/messages`, "GET"),
  deleteMemoChatSession: (id: string) => http(`/api/memo/chat/sessions/${id}`, "DELETE"),
  // 提案カードの解決状態（保存/破棄）を永続化。リロード後も再保存させないため。
  resolveMemoProposal: (sessionId: string, proposalId: string, status: "saved" | "dismissed") =>
    http(`/api/memo/chat/sessions/${sessionId}/resolutions`, "POST", { proposalId, status }),

  // ---- スポット候補チャットのセッション ----
  listChatSessions: () => http<ChatSessionSummary[]>(`/api/spots/chat/sessions`, "GET"),
  getChatSessionMessages: (id: string) =>
    http<ChatMessage[]>(`/api/spots/chat/sessions/${id}/messages`, "GET"),
  deleteChatSession: (id: string) => http(`/api/spots/chat/sessions/${id}`, "DELETE"),
  // 提案カードの解決状態（保存/破棄）を永続化。リロード後も再保存させないため。
  resolveProposal: (sessionId: string, proposalId: string, status: "saved" | "dismissed") =>
    http(`/api/spots/chat/sessions/${sessionId}/resolutions`, "POST", { proposalId, status }),
};
