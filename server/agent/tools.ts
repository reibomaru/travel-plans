// ============================================================
//  AI エージェント用のカスタムツール群。
//
//  設計方針（プレビュー承認制）:
//   - エージェントは DB を直接書き換えない。
//   - 変更は必ず propose_* ツールで「提案」として SSE に流すだけ。
//   - 実際の保存はユーザーが UI のボタンを押したときに REST 経由で行う。
//   - 読み取り（list_spots）と情報補完（web_search / fetch_url /
//     geocode）はツール内で完結してよい（副作用なし）。
// ============================================================
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import * as spotsRepo from "../../db/spots-repo.ts";
import * as memoRepo from "../../db/memo-repo.ts";
import * as itineraryRepo from "../../db/itinerary-repo.ts";
import { htmlToText } from "./html.ts";
import type { EmitFn } from "./runner.ts";

/** createSpotTools のオプション。 */
export interface SpotToolsOptions {
  db: DatabaseSync;
  emit: EmitFn;
  /** websearchapi.ai の API キー */
  webSearchApiKey: string;
}

/**
 * 提案カードの ID。toolCall id 由来にすることで、SSE 直後だけでなく
 * 履歴復元（JSONL の toolCall id）でも同じ ID になり、保存/破棄の状態を保てる。
 */
function proposalIdFor(toolCallId: string): string {
  return `prop-${toolCallId}`;
}

const text = (s: string): AgentToolResult<unknown> =>
  ({ content: [{ type: "text", text: s }], details: undefined }) as AgentToolResult<unknown>;

/** 許可フィールドのみを提案の下書きとして抜き出す。 */
function pickFields(p: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  for (const k of fields) {
    if (p[k] !== undefined && p[k] !== null) draft[k] = p[k];
  }
  return draft;
}

/** メモ提案で下書きに載せるフィールド（history.ts の MEMO_PROPOSAL_FIELDS と揃える）。 */
export const MEMO_PROPOSAL_FIELDS = ["title", "body"] as const;

/** spots（行きたい候補）の一覧を返す読み取り専用ツール（spot / memo 双方で共有）。 */
function makeListSpots(db: DatabaseSync): ToolDefinition {
  return defineTool({
    name: "list_spots",
    label: "候補一覧",
    description:
      "現在登録されている行きたいスポット候補の一覧を返す。重複チェックや、更新・削除の対象 id を特定するために使う。",
    promptSnippet: "list_spots() — 既存の候補一覧を取得",
    parameters: Type.Object({}),
    async execute() {
      const spots = spotsRepo.listSpots(db);
      if (spots.length === 0) return text("候補はまだ 1 件もありません。");
      const lines = spots.map(
        (s) =>
          `#${s.id} ${s.name}${s.name_en ? ` (${s.name_en})` : ""} / ${s.country ?? "?"}${
            s.city ? "・" + s.city : ""
          } / ${s.category ?? "未分類"} / 座標${
            s.lat != null && s.lng != null ? "あり" : "なし"
          }${s.google_maps_url ? " / Mapリンクあり" : ""}`,
      );
      return text(`現在 ${spots.length} 件:\n${lines.join("\n")}`);
    },
  });
}

/** 旅程（days / items）の一覧を返す読み取り専用ツール（spot / memo 双方で共有）。 */
function makeListItinerary(db: DatabaseSync): ToolDefinition {
  return defineTool({
    name: "list_itinerary",
    label: "旅程を参照",
    description:
      "旅行の全日程（days）と各日の予定（items）を時系列で取得する。何日目にどこへ行き、どの移動・食事・宿泊が入っているかを把握するために使う。各日の day_no・日付・都市と、予定ごとの時刻・種別・タイトル・メモ・概算費用が分かる。",
    promptSnippet: "list_itinerary() — 全日程と各日の予定を取得",
    parameters: Type.Object({}),
    async execute() {
      const days = itineraryRepo.listItinerary(db);
      if (days.length === 0) return text("旅程はまだ 1 日も登録されていません。");
      const blocks = days.map((d) => {
        const head = `Day${d.day_no}${d.date ? ` (${d.date})` : ""}${d.city ? ` ${d.city}` : ""}${
          d.title ? ` — ${d.title}` : ""
        }`;
        if (d.items.length === 0) return `${head}\n  （予定なし）`;
        const lines = d.items.map((it) => {
          const parts = [
            it.time ? it.time : "--:--",
            `[${it.type}]`,
            it.title,
          ];
          if (it.cost != null) parts.push(`約${it.cost.toLocaleString("ja-JP")}円`);
          let line = `  ${parts.join(" ")}`;
          if (it.note && it.note.trim()) line += `\n    ${it.note.trim().slice(0, 300)}`;
          return line;
        });
        return `${head}\n${lines.join("\n")}`;
      });
      return text(`全 ${days.length} 日:\n\n${blocks.join("\n\n")}`);
    },
  });
}

/** memo_pages の一覧を返す読み取り専用ツール（spot / memo 双方で共有）。 */
function makeListMemoPages(db: DatabaseSync): ToolDefinition {
  return defineTool({
    name: "list_memo_pages",
    label: "メモを参照",
    description:
      "ユーザーがメモ機能に保存した情報を一覧で取得する。じゃらん等の宿・スポット紹介ページの画像から抽出したテキストや、自由記述のメモが入っている。各メモの id・タイトル・内容が分かる。",
    promptSnippet: "list_memo_pages() — ユーザーのメモ（抽出情報）を取得",
    parameters: Type.Object({}),
    async execute() {
      const pages = memoRepo.listMemoPages(db);
      if (pages.length === 0) return text("メモはまだ 1 件もありません。");
      const blocks = pages.map((p) => {
        // body(自由記述) と text(画像からの抽出) を結合し、長すぎる場合は切り詰める。
        const content = [p.body, p.text]
          .filter((s): s is string => !!s && !!s.trim())
          .join("\n")
          .slice(0, 2000);
        return `#${p.id} ${p.title}\n${content || "（内容なし）"}`;
      });
      return text(`メモ ${pages.length} 件:\n\n${blocks.join("\n\n---\n\n")}`);
    },
  });
}

/**
 * リクエスト 1 回分のツール一式を生成する。
 */
export function createSpotTools({ db, emit, webSearchApiKey }: SpotToolsOptions): ToolDefinition[] {
  const list_spots = makeListSpots(db);

  const list_memo_pages = makeListMemoPages(db);

  const proposalFields = {
    name: Type.String({ description: "スポット名（日本語）" }),
    name_en: Type.Optional(Type.String({ description: "英語名" })),
    category: Type.Optional(Type.String({ description: "カテゴリ（観光/食事/自然/美術館 など）" })),
    city: Type.Optional(Type.String({ description: "都市名" })),
    country: Type.Optional(Type.String({ description: "国名（スイス / フランス など）" })),
    lat: Type.Optional(Type.Number({ description: "緯度。不明なら省略可" })),
    lng: Type.Optional(Type.Number({ description: "経度。不明なら省略可" })),
    url: Type.Optional(Type.String({ description: "公式サイトの URL" })),
    google_maps_url: Type.Optional(Type.String({ description: "Google マップのリンク。口コミ・評価はリンク先で確認するため、評価値などは保存しない" })),
    note: Type.Optional(Type.String({ description: "メモ・見どころ" })),
    source: Type.Optional(Type.String({ description: "情報の出典（URL やサイト名）" })),
  };

  const propose_upsert_spot = defineTool({
    name: "propose_upsert_spot",
    label: "候補の追加/更新を提案",
    description:
      "スポットの新規追加（id 省略）または既存候補の更新（id 指定）をユーザーに提案する。DB には書き込まず、ユーザーが UI で承認して初めて保存される。緯度経度は分かる範囲で埋め、出典(source)・公式 URL・Google マップのリンク(google_maps_url)もできるだけ付ける。口コミや星評価はリンク先で見られるので保存しない。",
    promptSnippet: "propose_upsert_spot({id?, name, ...}) — 追加/更新を提案（保存はユーザー承認後）",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "更新対象の既存スポット id（UUID）。新規追加なら省略" })),
      ...proposalFields,
    }),
    async execute(toolCallId, p) {
      const op = p.id != null ? "update" : "create";
      let current = null;
      if (p.id != null) {
        current = spotsRepo.getSpot(db, p.id);
        if (!current) return text(`id=${p.id} の候補が見つかりません。list_spots で id を確認してください。`);
      }
      const tempId = proposalIdFor(toolCallId);
      const spot = pickFields(p as Record<string, unknown>, spotsRepo.SPOT_FIELDS);
      await emit("proposal", { tempId, op, id: p.id ?? null, spot, current });
      return text(
        `${op === "update" ? "更新" : "追加"}の提案を表示しました（「${p.name}」）。` +
          `ユーザーが画面の「保存」を押すと確定します。あなたは保存しないでください。`,
      );
    },
  });

  const propose_delete_spot = defineTool({
    name: "propose_delete_spot",
    label: "候補の削除を提案",
    description:
      "既存候補の削除をユーザーに提案する。DB には書き込まず、ユーザーが UI で承認して初めて削除される。",
    promptSnippet: "propose_delete_spot({id}) — 削除を提案（実行はユーザー承認後）",
    parameters: Type.Object({
      id: Type.String({ description: "削除対象の既存スポット id（UUID）" }),
    }),
    async execute(toolCallId, p) {
      const current = spotsRepo.getSpot(db, p.id);
      if (!current) return text(`id=${p.id} の候補が見つかりません。list_spots で id を確認してください。`);
      const tempId = proposalIdFor(toolCallId);
      await emit("proposal", { tempId, op: "delete", id: p.id, spot: null, current });
      return text(`「${current.name}」の削除を提案しました。ユーザーが「削除」を押すと確定します。`);
    },
  });

  const geocode = defineTool({
    name: "geocode",
    label: "ジオコーディング",
    description:
      "地名・住所・施設名から緯度経度を取得する（OpenStreetMap / Nominatim）。propose_upsert_spot の lat/lng を埋める前に使う。",
    promptSnippet: "geocode(query) — 地名→緯度経度",
    parameters: Type.Object({
      query: Type.String({ description: "施設名や住所（例: Château de Chillon, Montreux）" }),
    }),
    async execute(_id, p, signal) {
      try {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("q", p.query);
        url.searchParams.set("format", "json");
        url.searchParams.set("limit", "1");
        const res = await fetch(url, {
          signal: signal ?? undefined,
          headers: { "User-Agent": "shiori/1.0 (shiori spot agent)" },
        });
        if (!res.ok) return text(`ジオコーディング失敗: HTTP ${res.status}`);
        const arr = await res.json();
        if (!Array.isArray(arr) || arr.length === 0) return text(`「${p.query}」の座標は見つかりませんでした。`);
        const r = arr[0];
        return text(
          `lat=${Number(r.lat)}, lng=${Number(r.lon)}\n名称: ${r.display_name ?? "(不明)"}`,
        );
      } catch (err) {
        return text(`ジオコーディングエラー: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  const resolve_map_url = defineTool({
    name: "resolve_map_url",
    label: "地図リンク解決",
    description:
      "Google マップの共有リンク（maps.app.goo.gl / goo.gl/maps の短縮URLや google.com/maps の長いURL）を辿って、地名・緯度経度を取り出す。ユーザーが地図リンクを貼ったら、まずこれで地名と座標を取得してから propose_upsert_spot に渡す（lat/lng はここで得た値を使い、geocode は不要）。",
    promptSnippet: "resolve_map_url(url) — Googleマップ共有リンク→地名・緯度経度",
    parameters: Type.Object({
      url: Type.String({ description: "Google マップの共有URL（maps.app.goo.gl など）" }),
    }),
    async execute(_id, p, signal) {
      // 注意: ブラウザ風 UA だと Google は 200 のインタースティシャルを返し redirect しない。
      // 非ブラウザ UA（下記）だとサーバー側 30x で最終 URL が得られる。
      const ua = "shiori/1.0 (shiori spot agent)";
      // fetch の redirect:"manual" は Location を隠す（opaqueredirect）ため、
      // redirect:"follow" で辿って最終 URL（res.url）を使う。本文は不要なので破棄する。
      let url = p.url;
      const alreadyResolved = /\/maps\//.test(p.url) || /@-?\d/.test(p.url) || /!3d-?\d/.test(p.url);
      try {
        if (!alreadyResolved) {
          const res = await fetch(p.url, {
            redirect: "follow",
            signal: signal ?? undefined,
            headers: { "User-Agent": ua },
          });
          url = res.url || p.url;
          try {
            await res.body?.cancel();
          } catch {
            /* noop */
          }
        }
      } catch (err) {
        return text(`地図リンクの解決に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 地名: /place/<name>/   座標: !3d<lat>!4d<lng>（実地点）優先、無ければ @lat,lng（地図中心）
      let name: string | null = null;
      const pm = url.match(/\/place\/([^/@?]+)/);
      if (pm) name = decodeURIComponent(pm[1].replace(/\+/g, " "));
      let lat: number | null = null;
      let lng: number | null = null;
      const dm = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
      if (dm) {
        lat = Number(dm[1]);
        lng = Number(dm[2]);
      } else {
        const am = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (am) {
          lat = Number(am[1]);
          lng = Number(am[2]);
        }
      }

      if (name == null && lat == null) {
        return text(
          `このリンクからは地名・座標を取り出せませんでした（解決後URL: ${url}）。ユーザーにスポット名を尋ねてください。`,
        );
      }
      return text(
        `地名: ${name ?? "(不明)"}\n` +
          `lat: ${lat ?? "(不明)"}\nlng: ${lng ?? "(不明)"}\n` +
          `解決後URL: ${url}\n` +
          `この name/lat/lng を使って propose_upsert_spot で提案してください（google_maps_url にはこの解決後URL か元の共有URLを入れる）。`,
      );
    },
  });

  const fetch_url = defineTool({
    name: "fetch_url",
    label: "URL 取得",
    description:
      "指定 URL のページ本文をプレーンテキストで取得する。ユーザーが貼った URL や、web_search で見つけた公式ページから、英名・カテゴリ・概要・出典を読み取るために使う。短縮URL/302 リダイレクトは自動で辿り、最終的に着地した URL も併せて返す（リダイレクト先が Google マップなら resolve_map_url の利用を検討）。",
    promptSnippet: "fetch_url(url) — ページ本文を取得（リダイレクト先も追う）",
    parameters: Type.Object({
      url: Type.String({ description: "取得する URL" }),
    }),
    async execute(_id, p, signal) {
      try {
        // 非ブラウザ UA。Google 等はブラウザ風 UA だと 30x を返さずインタースティシャルになるため。
        const res = await fetch(p.url, {
          signal: signal ?? undefined,
          headers: { "User-Agent": "shiori/1.0 (shiori spot agent)" },
          redirect: "follow", // 302 等は最後まで辿り、res.url に最終 URL が入る
        });
        // 着地先が元URLと違う（=リダイレクトされた）なら、その最終URLを明示する
        const redirectedNote = res.url && res.url !== p.url ? `リダイレクト先: ${res.url}\n\n` : "";
        if (!res.ok) return text(`${redirectedNote}取得失敗: HTTP ${res.status}`);
        const body = await res.text();
        const plain = htmlToText(body).slice(0, 4000);
        return text(redirectedNote + (plain || "(本文を抽出できませんでした)"));
      } catch (err) {
        return text(`取得エラー: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  const web_search = defineTool({
    name: "web_search",
    label: "Web 検索",
    description:
      "Web を検索して、スポットの公式ページ・概要・所在地などの最新情報を得る。URL が分からないスポットを名前だけで調べるときに使う。",
    promptSnippet: "web_search(query) — Web 検索",
    parameters: Type.Object({
      query: Type.String({ description: "検索クエリ" }),
      max_results: Type.Optional(Type.Number({ description: "最大件数（既定 5・最大 10）" })),
    }),
    async execute(_id, p, signal) {
      if (!webSearchApiKey) {
        return text("Web 検索の設定がありません。サーバーの環境変数 WEBSEARCH_API_KEY を .env に設定してください。");
      }
      const limit = Math.min(p.max_results ?? 5, 10);
      console.log(`[web_search] query="${p.query}" maxResults=${limit} → websearchapi.ai`);
      try {
        const res = await fetch("https://api.websearchapi.ai/ai-search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${webSearchApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: p.query, maxResults: limit, includeContent: false }),
          signal: signal ?? undefined,
        });
        if (!res.ok) {
          console.error(`[web_search] HTTP ${res.status} query="${p.query}"`);
          return text(`検索失敗: HTTP ${res.status}（websearchapi.ai）`);
        }
        const data = await res.json() as { organic?: Array<{ title?: string; url?: string; description?: string }> };
        const results = (data.organic ?? []).slice(0, limit);
        console.log(`[web_search] query="${p.query}" → ${results.length} 件`);
        if (results.length === 0) return text("検索結果が見つかりませんでした。");
        const formatted = results
          .map((r, i) => {
            const lines = [`${i + 1}. ${r.title}`, `   URL: ${r.url}`];
            if (r.description) lines.push(`   ${r.description}`);
            return lines.join("\n");
          })
          .join("\n\n");
        return text(formatted);
      } catch (err) {
        console.error(`[web_search] error query="${p.query}":`, err instanceof Error ? err.message : err);
        return text(
          `検索エラー: ${err instanceof Error ? err.message : String(err)}（websearchapi.ai に接続できません）`,
        );
      }
    },
  });

  return [list_spots, list_memo_pages, propose_upsert_spot, propose_delete_spot, resolve_map_url, geocode, fetch_url, web_search];
}

/** createMemoTools のオプション。 */
export interface MemoToolsOptions {
  db: DatabaseSync;
  emit: EmitFn;
}

/**
 * メモ編集エージェント用のツール一式。
 * スポットと同じくプレビュー承認制で、DB は直接書き換えず propose_* で提案するだけ。
 */
export function createMemoTools({ db, emit }: MemoToolsOptions): ToolDefinition[] {
  const list_memo_pages = makeListMemoPages(db);
  // 旅程・スポットは読み取り専用で参照だけできる（編集は各担当エージェント/UI に任せる）。
  const list_itinerary = makeListItinerary(db);
  const list_spots = makeListSpots(db);

  const get_memo_page = defineTool({
    name: "get_memo_page",
    label: "メモを取得",
    description:
      "指定した id のメモページの現在の内容（タイトル・本文）を取得する。編集を提案する前に、対象メモの現在の内容を正確に把握するために使う。",
    promptSnippet: "get_memo_page({id}) — メモ 1 件の現在の内容を取得",
    parameters: Type.Object({
      id: Type.String({ description: "対象メモページの id（UUID）" }),
    }),
    async execute(_toolCallId, p) {
      const page = memoRepo.getMemoPage(db, p.id);
      if (!page) return text(`id=${p.id} のメモが見つかりません。list_memo_pages で id を確認してください。`);
      // 旧バージョンで画像から取り込んだ情報(html/text)が残っていれば、本文へ取り込む参考として併記する。
      const legacy = (page.text?.trim() || (page.html ? htmlToText(page.html) : "")).slice(0, 4000);
      const parts = [
        `id: ${page.id}`,
        `タイトル: ${page.title}`,
        `本文(body, Markdown):\n${page.body?.trim() || "（空）"}`,
      ];
      if (legacy) parts.push(`参考（過去に画像から取り込んだ情報。必要なら本文へまとめてよい）:\n${legacy}`);
      return text(parts.join("\n\n"));
    },
  });

  const propose_upsert_memo_page = defineTool({
    name: "propose_upsert_memo_page",
    label: "メモの作成/編集を提案",
    description:
      "メモページの新規作成（id 省略）または既存メモの編集（id 指定）をユーザーに提案する。DB には書き込まず、ユーザーが画面のボタンで承認して初めて保存される。" +
      "タイトル(title)と本文(body, Markdown)を編集できる。誤字修正・要約・整形・追記や、添付画像から読み取った内容の本文への反映など、ユーザーの指示に沿って変更後の内容を渡す。" +
      "変更するフィールドだけを渡し（変更しないフィールドは省略）、body を変更するときは変更後の全文を渡す。表などは Markdown で表現する。",
    promptSnippet: "propose_upsert_memo_page({id?, title?, body?}) — メモの作成/編集を提案（保存はユーザー承認後）",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "編集対象の既存メモ id（UUID）。新規作成なら省略" })),
      title: Type.Optional(Type.String({ description: "メモのタイトル" })),
      body: Type.Optional(Type.String({ description: "本文（Markdown）。変更後の全文を渡す" })),
    }),
    async execute(toolCallId, p) {
      const op = p.id != null ? "update" : "create";
      let current = null;
      if (p.id != null) {
        current = memoRepo.getMemoPage(db, p.id);
        if (!current) return text(`id=${p.id} のメモが見つかりません。list_memo_pages で id を確認してください。`);
      }
      // 変更するフィールドだけを提案に載せる。空文字は「未指定」として扱い、
      // 既存の本文/HTML を誤って空にしないようにする（クリアは UI で行う）。
      const page = pickFields(p as Record<string, unknown>, MEMO_PROPOSAL_FIELDS);
      for (const k of Object.keys(page)) {
        if (typeof page[k] === "string" && page[k].trim() === "") delete page[k];
      }
      if (Object.keys(page).length === 0) {
        return text("変更内容（title / body / html のいずれか）が指定されていません。");
      }
      const tempId = proposalIdFor(toolCallId);
      await emit("proposal", { tempId, op, id: p.id ?? null, page, current });
      return text(
        `${op === "update" ? "編集" : "作成"}の提案を表示しました。` +
          `ユーザーが画面の「保存」を押すと確定します。あなたは保存しないでください。`,
      );
    },
  });

  const propose_delete_memo_page = defineTool({
    name: "propose_delete_memo_page",
    label: "メモの削除を提案",
    description:
      "既存メモページの削除をユーザーに提案する。DB には書き込まず、ユーザーが画面のボタンで承認して初めて削除される。",
    promptSnippet: "propose_delete_memo_page({id}) — メモの削除を提案（実行はユーザー承認後）",
    parameters: Type.Object({
      id: Type.String({ description: "削除対象の既存メモ id（UUID）" }),
    }),
    async execute(toolCallId, p) {
      const current = memoRepo.getMemoPage(db, p.id);
      if (!current) return text(`id=${p.id} のメモが見つかりません。list_memo_pages で id を確認してください。`);
      const tempId = proposalIdFor(toolCallId);
      await emit("proposal", { tempId, op: "delete", id: p.id, page: null, current });
      return text(`「${current.title}」の削除を提案しました。ユーザーが「削除」を押すと確定します。`);
    },
  });

  return [
    list_memo_pages,
    list_itinerary,
    list_spots,
    get_memo_page,
    propose_upsert_memo_page,
    propose_delete_memo_page,
  ];
}
