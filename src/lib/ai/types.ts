import type { SearchSource, TripSnapshot } from '../../types';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface TurnCallbacks {
  /** Full assistant text so far (streamed). */
  onText(text: string): void;
  /** Short status line, e.g. "正在搜尋網路…". */
  onStatus(status: string): void;
  /** The agent changed the trip; apply it to the store. */
  onApply(trip: TripSnapshot, summary: string[]): void;
}

export interface TurnInput {
  system: string;
  history: HistoryTurn[];
  userText: string;
  trip: TripSnapshot;
  webSearch: boolean;
  signal: AbortSignal;
  cb: TurnCallbacks;
}

export interface TurnResult {
  text: string;
  actions: string[];
  sources: SearchSource[];
}

/** Errors whose message is already written for the user. */
export class FriendlyError extends Error {}

export const MAX_AGENT_STEPS = 10;
