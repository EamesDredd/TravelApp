export type Category = 'sight' | 'breakfast' | 'meal';

export const CATEGORY_LABEL: Record<Category, string> = {
  sight: '景點',
  breakfast: '早餐',
  meal: '午晚餐',
};

export const CATEGORY_ICON: Record<Category, string> = {
  sight: '📍',
  breakfast: '🥐',
  meal: '🍜',
};

export interface SearchSource {
  title: string;
  url: string;
}

export interface SpotSearchResult {
  summary: string;
  sources: SearchSource[];
  provider: string;
  at: number;
}

export interface Spot {
  id: string;
  name: string;
  category: Category;
  /** Free-text address or "city, area"; also used as the Google Maps query. */
  address?: string;
  /** WGS-84 coordinates. Converted to GCJ-02 only when talking to Amap. */
  lat?: number;
  lng?: number;
  /** How the coordinates were found: auto = searched by the app (may be off), manual = picked by the user. */
  geo?: 'auto' | 'manual';
  note?: string;
  /** Suggested visit length in minutes. */
  durationMin?: number;
  search?: SpotSearchResult;
}

export interface PlanItem {
  id: string;
  spotId: string;
  /** "HH:MM" */
  time?: string;
  note?: string;
}

export interface Day {
  id: string;
  title?: string;
  items: PlanItem[];
}

/** auto = decide from the spots' coordinates; cn = Amap; intl = Google Maps. */
export type MapRegion = 'auto' | 'cn' | 'intl';

export type TravelMode = 'driving' | 'transit' | 'walking';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  /** Human-readable list of changes the assistant applied in this turn. */
  actions?: string[];
  /** Trip snapshot from before this turn's changes, for one-tap undo. */
  undo?: TripSnapshot;
  undone?: boolean;
  sources?: SearchSource[];
  /** Relay mode, user message: the request's tag and the trip version it was sent from. */
  relay?: { tag: string; fp: string };
  /** Relay mode, assistant message: the request tag it answered and the trip version it produced. */
  relayBase?: string;
  relayResult?: string;
  /** Fingerprint of the applied operations, to spot the same reply pasted twice. */
  relayOps?: string;
  /** Message the user can send back to the AI to fix problems in its block. */
  relayFix?: string;
  /** Block version (rev) this reply carried. */
  relayRev?: number;
  /** The trip before this request's first applied reply; later replies to the request apply on top of it. */
  relayStart?: TripSnapshot;
  /** A later reply to the same request replaced this one. */
  superseded?: boolean;
  at: number;
}

export interface TripSnapshot {
  name: string;
  destination: string;
  startDate?: string;
  days: Day[];
  spots: Spot[];
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Trip extends TripSnapshot {
  id: string;
  mapRegion: MapRegion;
  /** Geocoded centre of the destination, used for region detection and search bias. */
  center?: LatLng;
  chat: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /**
   * Plan versions this copy is built on, newest first (fingerprints of versions shared from or
   * imported into this device, and of the versions those were built on), and when the newest one
   * last changed (0 if unknown). Tells, on an import, which of the two copies is newer.
   */
  synced?: { seen: string[]; at: number };
}

/** relay = send to the user's own Claude / ChatGPT app (no API key). */
export type AIProvider = 'relay' | 'claude' | 'openai';

export interface Settings {
  provider: AIProvider;
  claudeKey: string;
  claudeModel: string;
  openaiKey: string;
  openaiModel: string;
  /** OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 */
  openaiBaseUrl: string;
  /** Let the model search the web while chatting (Claude / official OpenAI only). */
  chatWebSearch: boolean;
  googleMapsKey: string;
  amapKey: string;
  amapSecurityCode: string;
  /** Open Google Maps / Amap links in the phone's app when it has one. */
  preferMapApps: boolean;
}
