import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FaArrowLeft, FaCheck, FaRotate, FaUserShield, FaBan } from "react-icons/fa6";
import { api, displayNameOf, AdminAccessError, type AdminDeniedReason, type AdminUser, type Role } from "../api";
import { useAuth } from "../components/AuthGate";
import { Avatar } from "../components/Avatar";
import { Logo } from "../components/Logo";
import ConfirmDialog from "../components/ConfirmDialog";
import AdminSelect from "../components/admin/AdminSelect";

type Filter = "all" | "pending" | "approved";

/** 確認ダイアログを挟む操作（承認取り消し・ロール変更）。 */
interface PendingAction {
  user: AdminUser;
  patch: { allowed?: boolean; role?: Role };
  kind: "revoke" | "promote" | "demote";
}

/** ISO 8601 を「YYYY/MM/DD HH:mm」で表示する（未設定は "-"）。 */
function formatDate(iso: string | undefined, locale: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 承認状態のバッジ。 */
function StatusBadge({ allowed }: { allowed: boolean }) {
  const { t } = useTranslation("admin");
  return allowed ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
      <FaCheck size={10} /> {t("admin:status.approved")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
      {t("admin:status.pending")}
    </span>
  );
}

/**
 * 管理ダッシュボード（`/admin`）。
 * ユーザー台帳を一覧し、利用申請の承認（allowed=true）とロール変更を行う。
 * サーバ側は Basic 認証 + role=admin の二段構え（server/admin.ts）。この画面は
 * 導線を出さないだけで、実際のアクセス制御は必ず API 側で担保される。
 */
export default function AdminPage() {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const { me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<AdminDeniedReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busySub, setBusySub] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await api.listAdminUsers());
      setDenied(null);
    } catch (e) {
      if (e instanceof AdminAccessError) setDenied(e.reason);
      else setError(t("admin:error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 台帳を更新し、一覧の当該行だけ差し替える。 */
  const applyPatch = async (user: AdminUser, patch: { allowed?: boolean; role?: Role }) => {
    setBusySub(user.sub);
    setError(null);
    try {
      const updated = await api.updateAdminUser(user.sub, patch);
      setUsers((prev) => prev.map((u) => (u.sub === updated.sub ? updated : u)));
      setPending(null);
    } catch (e) {
      if (e instanceof AdminAccessError) setDenied(e.reason);
      else setError(e instanceof Error ? e.message : t("admin:error"));
    } finally {
      setBusySub(null);
    }
  };

  const shown = useMemo(
    () => users.filter((u) => (filter === "all" ? true : filter === "pending" ? !u.allowed : u.allowed)),
    [users, filter],
  );
  const pendingCount = useMemo(() => users.filter((u) => !u.allowed).length, [users]);

  const nameOf = (u: AdminUser) => displayNameOf(u);
  const confirmLabels = pending
    ? {
        title: t(`admin:confirm.${pending.kind}.title`),
        message: t(`admin:confirm.${pending.kind}.message`, { name: nameOf(pending.user) }),
        action: t(`admin:confirm.${pending.kind}.action`),
      }
    : null;

  return (
    <div className="mesh-light min-h-screen">
      <header className="tech-mesh flex items-center justify-between gap-3 border-b border-cyan-400/10 px-4 py-4 text-white sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo size={26} className="shrink-0 text-cyan-300" />
          <h1 className="brand-wordmark font-mono-tech truncate text-xl font-bold lowercase tracking-wide">shiori</h1>
          <span className="hidden items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-cyan-200 sm:inline-flex">
            <FaUserShield size={11} /> {t("admin:heading")}
          </span>
        </div>
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          <FaArrowLeft size={13} /> <span className="hidden sm:inline">{t("admin:backToProjects")}</span>
        </Link>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">{t("admin:heading")}</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("admin:subtitle")}</p>
          </div>
          {!denied && (
            <div className="flex items-center gap-2">
              {pendingCount > 0 && (
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                  {t("admin:pendingCount", { count: pendingCount })}
                </span>
              )}
              <AdminSelect<Filter>
                value={filter}
                onSelect={setFilter}
                title={t("admin:filter.label")}
                className="w-32"
                options={[
                  { value: "all", label: t("admin:filter.all") },
                  { value: "pending", label: t("admin:filter.pending") },
                  { value: "approved", label: t("admin:filter.approved") },
                ]}
              />
              <button
                onClick={() => void load()}
                title={t("admin:reload")}
                aria-label={t("admin:reload")}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700"
              >
                <FaRotate size={13} />
              </button>
            </div>
          )}
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>
        )}

        {denied ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-800">
            <p className="font-semibold text-slate-700 dark:text-slate-200">{t(`admin:denied.${denied}.title`)}</p>
            <p className="mt-1 px-6 text-sm text-slate-400 dark:text-slate-500">{t(`admin:denied.${denied}.message`)}</p>
          </div>
        ) : loading ? (
          <p className="py-16 text-center text-slate-400">{t("common:state.loading")}</p>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-800">
            <p className="text-slate-500 dark:text-slate-400">{users.length === 0 ? t("admin:empty") : t("admin:emptyFiltered")}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {shown.map((u) => {
              // 自分自身の行は権限剥奪の導線を出さない（サーバ側でも 400 で拒否する）。
              const self = u.email.toLowerCase() === me.email.toLowerCase();
              const busy = busySub === u.sub;
              return (
                <li
                  key={u.sub}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800"
                >
                  <Avatar src={u.avatar || u.picture} name={nameOf(u)} email={u.email} size={36} />
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="flex items-center gap-1.5 truncate font-semibold text-slate-800 dark:text-slate-100">
                      {nameOf(u)}
                      {self && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                          {t("admin:self")}
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-slate-400 dark:text-slate-500">{u.email}</p>
                    <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                      {t("admin:column.createdAt")}: {formatDate(u.createdAt, i18n.language)}
                    </p>
                  </div>

                  <StatusBadge allowed={u.allowed} />

                  <AdminSelect<Role>
                    value={u.role}
                    // 自分自身の降格は締め出しになるためサーバ側でも拒否する。
                    disabled={busy || self}
                    title={t("admin:actions.changeRole")}
                    align="right"
                    className="w-28"
                    onSelect={(role) =>
                      setPending({ user: u, patch: { role }, kind: role === "admin" ? "promote" : "demote" })
                    }
                    options={[
                      { value: "user", label: t("admin:role.user") },
                      { value: "admin", label: t("admin:role.admin") },
                    ]}
                  />

                  {u.allowed ? (
                    <button
                      onClick={() => setPending({ user: u, patch: { allowed: false }, kind: "revoke" })}
                      disabled={busy || self}
                      title={t("admin:actions.revoke")}
                      aria-label={t("admin:actions.revoke")}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                    >
                      <FaBan size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={() => void applyPatch(u, { allowed: true })}
                      disabled={busy}
                      className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
                    >
                      <FaCheck size={12} /> {busy ? t("common:state.saving") : t("admin:actions.approve")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>

      <ConfirmDialog
        open={pending !== null}
        title={confirmLabels?.title ?? ""}
        message={confirmLabels?.message}
        confirmLabel={confirmLabels?.action}
        busy={busySub !== null}
        onConfirm={() => pending && void applyPatch(pending.user, pending.patch)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
