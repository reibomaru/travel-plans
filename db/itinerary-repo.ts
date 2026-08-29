// ============================================================
//  旅程（days / items）のデータアクセスを 1 か所に集約。
//  REST ハンドラ（server/index.ts の GET /api/trip）と AI エージェントの
//  ツール（server/agent/tools.ts の list_itinerary）の両方から呼び出し、
//  「days に items をネストして返す」ロジックを共有する。
//  ※ 書き込みは従来どおり REST（/api/days・/api/items）が担当する。
// ============================================================
import type { DatabaseSync } from "node:sqlite";
import type { Day, Item } from "../shared/types.ts";

/** 全日程を day_no 順で取得し、各日に予定（items）を時系列でネストして返す。 */
export function listItinerary(db: DatabaseSync): Day[] {
  const days = db.prepare("SELECT * FROM days ORDER BY day_no").all() as unknown as Day[];
  const allItems = db
    .prepare("SELECT * FROM items ORDER BY day_id, sort_order, time")
    .all() as unknown as Item[];
  for (const d of days) d.items = allItems.filter((it) => it.day_id === d.id);
  return days;
}
