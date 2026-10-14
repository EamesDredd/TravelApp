/* Provider-neutral definition of what the AI assistant may do to a trip.
 * Everything here is pure so it can be unit-tested without any network. */
import type { Category, Day, PlanItem, Spot, TripSnapshot } from '../../types';
import { CATEGORY_LABEL } from '../../types';
import { hasCoords, isMainlandChina } from '../geo';
import { isCategory, makeItem, makeSpot, resizeDays, scheduledDays } from '../tripOps';
import { formatDayDate, normalizeTime, parseDate, toIsoDate, weekdayName } from '../util';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const SPOT_FIELDS = {
  name: { type: 'string', description: '地點名稱（使用當地常用名稱，可附中文）' },
  category: {
    type: 'string',
    enum: ['sight', 'breakfast', 'meal'],
    description: 'sight=景點、breakfast=早餐、meal=午餐或晚餐',
  },
  address: { type: 'string', description: '地址，或至少「城市 區域」，用於地圖搜尋' },
  lat: { type: 'number', description: '緯度（WGS-84）。不確定就省略' },
  lng: { type: 'number', description: '經度（WGS-84）。不確定就省略' },
  note: { type: 'string', description: '簡短備註，例如特色、營業時間、預約提醒' },
  duration_min: { type: 'integer', description: '建議停留分鐘數' },
};

const NEW_SPOT = {
  type: 'object',
  properties: SPOT_FIELDS,
  required: ['name', 'category'],
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'add_candidates',
    description:
      '新增地點到候選清單（不會排進每日行程）。回傳每個新地點的 id，之後可在 set_day_plans 用 spot_id 引用。',
    parameters: {
      type: 'object',
      properties: { spots: { type: 'array', items: NEW_SPOT, minItems: 1 } },
      required: ['spots'],
    },
  },
  {
    name: 'set_day_plans',
    description:
      '以完整清單取代指定天數的行程；沒列出的天數維持不變。每個項目要有 spot_id（既有候選地點）或 new_spot（同時加入候選清單）。day 超過目前天數時會自動增加天數。要清空某天就傳空的 items。',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              day: { type: 'integer', minimum: 1, description: '第幾天（從 1 開始）' },
              title: { type: 'string', description: '當天主題，例如「東山・祇園散策」' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    spot_id: { type: 'string', description: '既有候選地點的 id，例如 s_ab12' },
                    new_spot: NEW_SPOT,
                    time: { type: 'string', description: '開始時間 HH:MM（24 小時制）' },
                    note: { type: 'string', description: '這個行程項目的備註，例如交通方式' },
                  },
                },
              },
            },
            required: ['day', 'items'],
          },
        },
      },
      required: ['days'],
    },
  },
  {
    name: 'update_spots',
    description: '修改或刪除候選地點（刪除時也會從每日行程移除）。',
    parameters: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              spot_id: { type: 'string' },
              ...SPOT_FIELDS,
              delete: { type: 'boolean', description: 'true = 刪除這個地點' },
            },
            required: ['spot_id'],
          },
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'update_trip',
    description: '修改旅程基本資料：名稱、目的地、出發日期、總天數（減少天數會移除最後幾天的行程）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        destination: { type: 'string' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        day_count: { type: 'integer', minimum: 1, maximum: 60 },
      },
    },
  },
];

export const SYSTEM_PROMPT = `你是「旅遊行程規劃」App 內建的旅遊規劃助理。使用者正在這個 App 裡安排旅程，你可以和他討論，也可以透過工具直接修改 App 裡的資料。

App 的資料：
- 候選地點：分成 sight（景點）、breakfast（早餐）、meal（午晚餐）三類。每個地點有 id（例如 s_ab12）、名稱、地址、座標（WGS-84）、備註。
- 每日行程：第 1 天、第 2 天……每天是一串有順序的項目，每個項目指向一個候選地點，可以有開始時間（HH:MM）與備註。
- 每次對話都會附上「目前行程狀態」，以最新的狀態為準；之前對話中提到的內容可能已被使用者手動修改。

使用工具的原則：
- 使用者要你安排、調整、新增或刪除時，直接用工具修改，不必再徵求同意；改完用幾句話說明做了什麼（例如每天的主軸與排序理由）。
- 使用者只是詢問意見或資訊時，先用文字回答，不要擅自修改行程。
- 依遠近安排時，用候選地點的座標把鄰近的地點排在同一天，並依順路的動線排序、避免來回折返；同時考慮開放時間、停留時間、交通時間與用餐時段（早餐約 07:00–09:30、午餐 11:30–13:30、晚餐 17:30–20:00），填入合理的開始時間。
- 優先使用既有候選地點的 spot_id。需要新地點（例如補上順路的餐廳）時用 new_spot，盡量附上地址與大略座標；不確定的座標寧可省略也不要亂猜。
- set_day_plans 會用你給的清單完整取代那一天，所以要列出那天所有項目，包含原本要保留的。
- 一天不要排得太滿，保留彈性時間。
- 回答使用繁體中文（台灣用語），精簡、以條列為主。`;

export const WEB_SEARCH_NOTE = '\n- 需要最新資訊（營業時間、票價、交通、活動、天氣）時，可以使用網路搜尋，並附上來源。';

// ------------------------------------------------------------------ state text

function fmtCoord(s: Spot): string {
  return hasCoords(s) ? `${s.lat!.toFixed(5)},${s.lng!.toFixed(5)}` : '（無座標）';
}

export function describeDay(trip: TripSnapshot, i: number): string {
  const day = trip.days[i];
  const date = formatDayDate(trip.startDate, i);
  const head = `第${i + 1}天${date ? ` ${date}` : ''}${day.title ? `「${day.title}」` : ''}`;
  if (!day.items.length) return `${head}：（尚未安排）`;
  const byId = new Map(trip.spots.map((s) => [s.id, s]));
  const lines = day.items.map((it, n) => {
    const s = byId.get(it.spotId);
    const name = s ? `${CATEGORY_LABEL[s.category]}・${s.name}` : '（已刪除的地點）';
    return `  ${n + 1}. ${it.time ?? '--:--'} [${it.spotId}] ${name}${it.note ? ` — ${it.note}` : ''}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

export function describeTrip(trip: TripSnapshot, today = new Date()): string {
  const start = parseDate(trip.startDate);
  const lines: string[] = [];
  lines.push('## 目前行程狀態');
  lines.push(`- 今天日期：${toIsoDate(today)}`);
  lines.push(`- 旅程名稱：${trip.name}`);
  lines.push(`- 目的地：${trip.destination || '（未設定）'}`);
  lines.push(`- 出發日期：${start ? `${trip.startDate}（第1天是${weekdayName(start)}）` : '（未設定）'}`);
  lines.push(`- 天數：${trip.days.length}`);
  const located = trip.spots.filter(hasCoords);
  if (located.length) {
    const cn = located.filter((s) => isMainlandChina(s)).length;
    lines.push(`- 地圖：${cn * 2 >= located.length ? '中國大陸（高德地圖）' : 'Google 地圖'}`);
  }
  lines.push('');
  lines.push(`### 候選地點（共 ${trip.spots.length} 個）`);
  if (trip.spots.length) {
    lines.push('id | 類別 | 名稱 | 座標(lat,lng) | 地址 | 建議停留 | 備註 | 已排入');
    for (const s of trip.spots) {
      const days = scheduledDays(trip, s.id).map((d) => `第${d + 1}天`);
      lines.push(
        [
          s.id,
          CATEGORY_LABEL[s.category],
          s.name,
          fmtCoord(s),
          s.address || '',
          s.durationMin ? `${s.durationMin}分` : '',
          (s.note || '').replace(/\s+/g, ' ').slice(0, 80),
          days.join('、') || '未排入',
        ].join(' | '),
      );
    }
  } else {
    lines.push('（還沒有候選地點）');
  }
  lines.push('');
  lines.push('### 每日行程');
  trip.days.forEach((_, i) => lines.push(describeDay(trip, i)));
  return lines.join('\n');
}

// ------------------------------------------------------------------ applying tool calls

export interface ApplyResult {
  trip: TripSnapshot;
  /** Short human-readable lines shown in the chat bubble. */
  summary: string[];
  /** Text returned to the model as the tool result. */
  result: string;
  isError: boolean;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function readSpotFields(o: Obj): { fields?: Omit<Spot, 'id'>; error?: string } {
  const name = str(o.name);
  if (!name) return { error: '缺少 name' };
  if (!isCategory(o.category)) return { error: `「${name}」的 category 必須是 sight / breakfast / meal` };
  const fields: Omit<Spot, 'id'> = { name, category: o.category as Category };
  const address = str(o.address);
  if (address) fields.address = address;
  const lat = num(o.lat);
  const lng = num(o.lng);
  if (lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    fields.lat = lat;
    fields.lng = lng;
  }
  const note = str(o.note);
  if (note) fields.note = note;
  const dur = num(o.duration_min);
  if (dur && dur > 0) fields.durationMin = Math.round(dur);
  return { fields };
}

/** Reuse an existing spot with the same name instead of creating a duplicate. */
function findSameSpot(spots: Spot[], name: string): Spot | undefined {
  const key = name.replace(/\s+/g, '').toLowerCase();
  return spots.find((s) => s.name.replace(/\s+/g, '').toLowerCase() === key);
}

function addSpots(trip: TripSnapshot, input: Obj): ApplyResult {
  if (!Array.isArray(input.spots) || !input.spots.length) {
    return { trip, summary: [], result: 'spots 必須是非空陣列', isError: true };
  }
  const spots = [...trip.spots];
  const added: string[] = [];
  const reused: string[] = [];
  const errors: string[] = [];
  for (const raw of input.spots) {
    if (!isObj(raw)) {
      errors.push('項目格式錯誤');
      continue;
    }
    const { fields, error } = readSpotFields(raw);
    if (!fields) {
      errors.push(error!);
      continue;
    }
    const same = findSameSpot(spots, fields.name);
    if (same) {
      reused.push(`${same.id} ${same.name}（已存在）`);
      continue;
    }
    const spot = makeSpot(fields, spots);
    spots.push(spot);
    added.push(`${spot.id} ${spot.name}`);
  }
  const next = { ...trip, spots };
  const lines = [...added.map((a) => `已新增 ${a}`), ...reused, ...errors.map((e) => `錯誤：${e}`)];
  return {
    trip: next,
    summary: added.length ? [`新增 ${added.length} 個候選地點`] : [],
    result: lines.join('\n') || '沒有變更',
    isError: !added.length && errors.length > 0,
  };
}

function setDayPlans(trip: TripSnapshot, input: Obj): ApplyResult {
  if (!Array.isArray(input.days) || !input.days.length) {
    return { trip, summary: [], result: 'days 必須是非空陣列', isError: true };
  }
  let spots = [...trip.spots];
  let days: Day[] = trip.days;
  const changed: number[] = [];
  const errors: string[] = [];
  let newSpots = 0;

  const maxDay = Math.max(...input.days.map((d) => (isObj(d) ? (num(d.day) ?? 0) : 0)));
  if (maxDay > 60) return { trip, summary: [], result: 'day 最多 60', isError: true };
  if (maxDay > days.length) days = resizeDays(days, maxDay);
  days = days.map((d) => ({ ...d }));

  for (const raw of input.days) {
    if (!isObj(raw)) {
      errors.push('days 項目格式錯誤');
      continue;
    }
    const dayNo = num(raw.day);
    if (!dayNo || dayNo < 1 || !Number.isInteger(dayNo)) {
      errors.push(`day 不正確：${String(raw.day)}`);
      continue;
    }
    if (!Array.isArray(raw.items)) {
      errors.push(`第${dayNo}天缺少 items`);
      continue;
    }
    const items: PlanItem[] = [];
    const dayErrors: string[] = [];
    const pendingSpots: Spot[] = [];
    for (const rawItem of raw.items) {
      if (!isObj(rawItem)) {
        dayErrors.push('項目格式錯誤');
        continue;
      }
      let spotId = str(rawItem.spot_id);
      const all = [...spots, ...pendingSpots];
      if (spotId && !all.some((s) => s.id === spotId)) {
        dayErrors.push(`找不到 spot_id ${spotId}`);
        continue;
      }
      if (!spotId) {
        if (!isObj(rawItem.new_spot)) {
          dayErrors.push('項目需要 spot_id 或 new_spot');
          continue;
        }
        const { fields, error } = readSpotFields(rawItem.new_spot);
        if (!fields) {
          dayErrors.push(error!);
          continue;
        }
        const same = findSameSpot(all, fields.name);
        if (same) {
          spotId = same.id;
        } else {
          const spot = makeSpot(fields, all);
          pendingSpots.push(spot);
          spotId = spot.id;
        }
      }
      const time = normalizeTime(rawItem.time);
      items.push(makeItem(spotId, time, str(rawItem.note)));
    }
    if (dayErrors.length) {
      // Leave this day untouched rather than saving a half-correct plan.
      errors.push(`第${dayNo}天未更新：${dayErrors.join('；')}`);
      continue;
    }
    spots = [...spots, ...pendingSpots];
    newSpots += pendingSpots.length;
    const title = typeof raw.title === 'string' ? raw.title.trim() || undefined : days[dayNo - 1].title;
    days[dayNo - 1] = { ...days[dayNo - 1], title, items };
    changed.push(dayNo - 1);
  }

  const next: TripSnapshot = { ...trip, spots, days: changed.length ? days : trip.days };
  const summary: string[] = [];
  if (changed.length) summary.push(`更新第 ${changed.map((d) => d + 1).join('、')} 天行程`);
  if (newSpots) summary.push(`新增 ${newSpots} 個地點`);
  if (next.days.length !== trip.days.length) summary.push(`天數改為 ${next.days.length} 天`);
  const result = [
    ...changed.map((d) => describeDay(next, d)),
    ...errors.map((e) => `錯誤：${e}`),
  ].join('\n');
  return { trip: next, summary, result: result || '沒有變更', isError: !changed.length && errors.length > 0 };
}

function updateSpots(trip: TripSnapshot, input: Obj): ApplyResult {
  if (!Array.isArray(input.updates) || !input.updates.length) {
    return { trip, summary: [], result: 'updates 必須是非空陣列', isError: true };
  }
  let next: TripSnapshot = { ...trip };
  const done: string[] = [];
  const errors: string[] = [];
  let deleted = 0;
  let edited = 0;
  for (const raw of input.updates) {
    if (!isObj(raw)) continue;
    const id = str(raw.spot_id);
    const spot = next.spots.find((s) => s.id === id);
    if (!spot) {
      errors.push(`找不到 spot_id ${String(raw.spot_id)}`);
      continue;
    }
    if (raw.delete === true) {
      next = {
        ...next,
        spots: next.spots.filter((s) => s.id !== id),
        days: next.days.map((d) => ({ ...d, items: d.items.filter((it) => it.spotId !== id) })),
      };
      deleted++;
      done.push(`已刪除 ${id} ${spot.name}`);
      continue;
    }
    const patch: Partial<Spot> = {};
    const name = str(raw.name);
    if (name) patch.name = name;
    if (raw.category !== undefined) {
      if (!isCategory(raw.category)) {
        errors.push(`${id} 的 category 不正確`);
        continue;
      }
      patch.category = raw.category;
    }
    if (typeof raw.address === 'string') patch.address = raw.address.trim() || undefined;
    if (typeof raw.note === 'string') patch.note = raw.note.trim() || undefined;
    const lat = num(raw.lat);
    const lng = num(raw.lng);
    if (lat !== undefined && lng !== undefined) {
      patch.lat = lat;
      patch.lng = lng;
    }
    const dur = num(raw.duration_min);
    if (dur !== undefined) patch.durationMin = dur > 0 ? Math.round(dur) : undefined;
    next = { ...next, spots: next.spots.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
    edited++;
    done.push(`已更新 ${id} ${patch.name ?? spot.name}`);
  }
  const summary: string[] = [];
  if (edited) summary.push(`修改 ${edited} 個地點`);
  if (deleted) summary.push(`刪除 ${deleted} 個地點`);
  return {
    trip: next,
    summary,
    result: [...done, ...errors.map((e) => `錯誤：${e}`)].join('\n') || '沒有變更',
    isError: !done.length && errors.length > 0,
  };
}

function updateTrip(trip: TripSnapshot, input: Obj): ApplyResult {
  const next: TripSnapshot = { ...trip };
  const summary: string[] = [];
  const errors: string[] = [];
  const name = str(input.name);
  if (name) {
    next.name = name;
    summary.push(`旅程名稱改為「${name}」`);
  }
  if (typeof input.destination === 'string') {
    next.destination = input.destination.trim();
    summary.push(`目的地改為「${next.destination}」`);
  }
  if (input.start_date !== undefined) {
    if (typeof input.start_date === 'string' && parseDate(input.start_date)) {
      next.startDate = input.start_date;
      summary.push(`出發日期改為 ${input.start_date}`);
    } else {
      errors.push('start_date 格式應為 YYYY-MM-DD');
    }
  }
  const count = num(input.day_count);
  if (count !== undefined) {
    if (Number.isInteger(count) && count >= 1 && count <= 60) {
      next.days = resizeDays(trip.days, count);
      summary.push(`天數改為 ${count} 天`);
    } else {
      errors.push('day_count 必須是 1–60 的整數');
    }
  }
  return {
    trip: next,
    summary,
    result: [...summary, ...errors.map((e) => `錯誤：${e}`)].join('\n') || '沒有變更',
    isError: !summary.length && errors.length > 0,
  };
}

export function applyToolCall(trip: TripSnapshot, name: string, input: unknown): ApplyResult {
  if (!isObj(input)) return { trip, summary: [], result: '參數必須是 JSON 物件', isError: true };
  switch (name) {
    case 'add_candidates':
      return addSpots(trip, input);
    case 'set_day_plans':
      return setDayPlans(trip, input);
    case 'update_spots':
      return updateSpots(trip, input);
    case 'update_trip':
      return updateTrip(trip, input);
    default:
      return { trip, summary: [], result: `未知的工具：${name}`, isError: true };
  }
}
