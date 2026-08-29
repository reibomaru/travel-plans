import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FaPlus, FaMapLocationDot, FaUsers, FaTrash, FaPen, FaArrowRightFromBracket, FaUserShield } from "react-icons/fa6";
import { api, displayNameOf, type Project } from "../api";
import { useAuth } from "../components/AuthGate";
import { Avatar } from "../components/Avatar";
import { Tooltip } from "../components/Tooltip";
import ProfileDialog from "../components/ProfileDialog";
import MembersDialog from "../components/MembersDialog";
import RenameProjectDialog from "../components/RenameProjectDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import { Logo } from "../components/Logo";
import { useOnboarding } from "../components/onboarding/OnboardingProvider";
import { OnboardingBubble } from "../components/onboarding/OnboardingBubble";

/**
 * プロジェクト一覧・作成画面（ログイン後のトップ `/`）。
 * 自分がメンバーのプロジェクトを一覧し、開く・作成・（オーナーは）削除・メンバー管理を行う。
 */
export default function ProjectsPage() {
  const { t } = useTranslation(["projects", "common"]);
  const { me, logout } = useAuth();
  const { completeStep } = useOnboarding();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [membersOf, setMembersOf] = useState<Project | null>(null);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await api.listProjects());
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const p = await api.createProject(name.trim());
      // 初回オンボーディング中なら「プロジェクト作成」ステップを完了して次へ進める。
      completeStep("create-project");
      navigate(`/projects/${p.id}/itinerary`);
    } finally {
      setCreating(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteProject(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mesh-light min-h-screen">
      <header className="tech-mesh flex items-center justify-between border-b border-cyan-400/10 px-6 py-4 text-white">
        <div className="flex items-center gap-2.5">
          <Logo size={26} className="text-cyan-300" />
          <h1 className="brand-wordmark font-mono-tech text-xl font-bold lowercase tracking-wide">shiori</h1>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => setProfileOpen(true)}
            title={t("common:auth.editProfile")}
            className="flex items-center gap-2 rounded-lg px-2 py-1 text-slate-300 transition-colors hover:bg-white/10"
          >
            <Avatar src={me.avatarUrl} name={me.displayName ?? me.name} email={me.email} size={26} />
            <span className="max-w-[12rem] truncate">{displayNameOf(me)}</span>
          </button>
          {/* 管理ダッシュボードへの導線は admin にだけ出す（実際の制御はサーバ側）。 */}
          {me.role === "admin" && (
            <Tooltip label={t("common:auth.admin")} side="bottom">
              <Link
                to="/admin"
                aria-label={t("common:auth.admin")}
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white"
              >
                <FaUserShield size={15} />
              </Link>
            </Tooltip>
          )}
          <Tooltip label={t("common:auth.logout")} side="bottom">
            <button
              onClick={() => void logout()}
              aria-label={t("common:auth.logout")}
              className="ml-1 flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white"
            >
              <FaArrowRightFromBracket size={14} />
            </button>
          </Tooltip>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <h2 className="mb-4 text-xl font-bold text-slate-800 dark:text-slate-100">{t("projects:heading")}</h2>

        {/* 新規作成 */}
        <div data-onboarding="create-project" className="mb-6 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            // 日本語変換確定の Enter では作成しない（変換中は isComposing=true）。
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) create();
            }}
            placeholder={t("projects:createPlaceholder")}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-cyan-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
          />
          <button
            onClick={create}
            disabled={creating || !name.trim()}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
          >
            <FaPlus /> {t("common:actions.create")}
          </button>
        </div>

        {loading ? (
          <p className="py-16 text-center text-slate-400">{t("common:state.loading")}</p>
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-800">
            <p className="text-slate-500 dark:text-slate-400">{t("projects:empty.title")}</p>
            <p className="mt-1 text-sm text-slate-400 dark:text-slate-500">{t("projects:empty.hint")}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => {
              const owner = me.email.toLowerCase() === p.ownerEmail.toLowerCase();
              return (
                <li key={p.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
                  <button
                    onClick={() => navigate(`/projects/${p.id}/itinerary`)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <FaMapLocationDot className="shrink-0 text-cyan-700 dark:text-cyan-400" />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-slate-800 dark:text-slate-100">{p.name}</span>
                      <span className="text-xs text-slate-400 dark:text-slate-500">
                        {t("projects:member.count", { count: p.memberEmails.length })}
                        {owner ? t("projects:member.owner") : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => setMembersOf(p)}
                    title={t("projects:actions.members")}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
                  >
                    <FaUsers />
                  </button>
                  {owner && (
                    <button
                      onClick={() => setRenameTarget(p)}
                      title={t("projects:actions.rename")}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
                    >
                      <FaPen size={13} />
                    </button>
                  )}
                  {owner && (
                    <button
                      onClick={() => setDeleteTarget(p)}
                      title={t("common:actions.delete")}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:text-slate-500 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                    >
                      <FaTrash size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>

      <OnboardingBubble stepKey="create-project" side="bottom" />
      <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
      {membersOf && <MembersDialog project={membersOf} onClose={() => setMembersOf(null)} />}
      {renameTarget && (
        <RenameProjectDialog
          project={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={(updated) => setProjects((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))}
        />
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("projects:delete.title")}
        message={deleteTarget ? t("projects:delete.message", { name: deleteTarget.name }) : undefined}
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
