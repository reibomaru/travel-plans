import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 新バージョン配信時に SW を自動更新し、リロードで反映する（stale なキャッシュを避ける）。
      registerType: "autoUpdate",
      // 登録は src/pwa.ts の registerSW で自前に行うため、自動注入は無効化する（二重登録防止）。
      injectRegister: null,
      // favicon / apple-touch-icon などもプリキャッシュ対象に含める。
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "shiori｜AI と一緒につくる、旅のしおり",
        short_name: "shiori",
        description:
          "移動ルート・日ごとの旅程・行きたいスポット・予算・メモをひとつにまとめて編集し、そのまま PDF に。AI と話しながら旅の計画をつくる、旅のしおりアプリ。",
        lang: "ja",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0b1120",
        theme_color: "#0b1120",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // ビルド成果物（アプリシェル）のみプリキャッシュする。
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // 地図(deck.gl)や図表(mermaid/katex/cytoscape)など、オンライン時のみ使う重い遅延ロードチャンクは
        // プリキャッシュから除外し、必要時にネットワーク取得する（初回インストールを軽くする）。
        globIgnores: [
          "assets/MapPage-*.js",
          "assets/katex-*.js",
          "assets/cytoscape*.js",
          "assets/*Diagram-*.js",
          "assets/swimlanes-*.js",
          "assets/cynefin-*.js",
        ],
        // SPA フォールバック。ただし API と OAuth はサーバーへ通す（キャッシュ/フォールバックしない）。
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api/, /^\/auth/],
        // データ API はキャッシュしない方針のため、runtimeCaching は定義しない（＝常にネットワーク）。
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    proxy: {
      // フロント(5173) から /api・/auth を API サーバーへ転送（既定 8080。VITE_API_TARGET で上書き可）。
      // /auth はブラウザのトップレベル遷移（Google OAuth リダイレクト）も含めて中継する。
      "/api": process.env.VITE_API_TARGET || "http://localhost:8080",
      "/auth": process.env.VITE_API_TARGET || "http://localhost:8080",
    },
  },
});
