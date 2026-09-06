import { registerSW } from "virtual:pwa-register";

// Service Worker を登録する。registerType は "autoUpdate"（vite.config.ts）のため、
// 新しい SW が用意でき次第、自動で有効化してページをリロードし、最新のアプリシェルに切り替える。
// データ API（/api）はキャッシュしない方針なので、リロードで古い画面が残ることはない。
export function setupPWA() {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // autoUpdate 運用のため、新バージョン検知時はそのまま適用してリロードする。
      updateSW(true);
    },
  });
}
