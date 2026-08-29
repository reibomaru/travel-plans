import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import "./index.css";
import i18n from "./i18n";
import { ThemeProvider } from "./theme";
import { TripProvider } from "./store";
import { AuthGate } from "./components/AuthGate";
import { OnboardingProvider } from "./components/onboarding/OnboardingProvider";
import { ProjectProvider } from "./project";
import Layout from "./components/Layout";
import ProjectsPage from "./pages/ProjectsPage";
import ItineraryPage from "./pages/ItineraryPage";
import BudgetPage from "./pages/BudgetPage";
import SpotsPage from "./pages/SpotsPage";
import MemoListPage from "./pages/MemoListPage";
import MemoDetailPage from "./pages/MemoDetailPage";
import AdminPage from "./pages/AdminPage";

// 地図(deck.gl)は重いので必要時のみ遅延ロード
const MapPage = lazy(() => import("./pages/MapPage"));

/** /projects/:projectId 配下: アクティブプロジェクトを設定し、旅程データと Layout を提供する。
 *  key={projectId} 相当の再マウントで、プロジェクト切替時に子が再ロードされる。 */
function ProjectShell() {
  const { projectId = "" } = useParams();
  return (
    <ProjectProvider key={projectId} projectId={projectId}>
      <TripProvider>
        <Layout />
      </TripProvider>
    </ProjectProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthGate>
        <OnboardingProvider>
        <Routes>
          {/* ログイン後のトップ: プロジェクト一覧 */}
          <Route path="/" element={<ProjectsPage />} />
          {/* 管理ダッシュボード（admin 限定・Basic 認証は server/admin.ts） */}
          <Route path="/admin" element={<AdminPage />} />
          {/* プロジェクト配下（共有テナント） */}
          <Route path="/projects/:projectId" element={<ProjectShell />}>
            <Route index element={<Navigate to="itinerary" replace />} />
            <Route
              path="map"
              element={
                <Suspense fallback={<div className="p-10 text-center text-slate-400 dark:text-slate-500">{i18n.t("layout:mapLoading")}</div>}>
                  <MapPage />
                </Suspense>
              }
            />
            <Route path="itinerary" element={<ItineraryPage />} />
            <Route path="budget" element={<BudgetPage />} />
            <Route path="spots" element={<SpotsPage />} />
            <Route path="memo" element={<MemoListPage />} />
            <Route path="memo/:id" element={<MemoDetailPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </OnboardingProvider>
        </AuthGate>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>
);
