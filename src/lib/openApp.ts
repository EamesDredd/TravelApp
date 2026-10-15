/* Opening map links in the Google Maps / Amap app when the phone has it. */
import type { AppLink } from './maps';

export type Platform = 'ios' | 'android' | 'other';

export function detectPlatform(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0): Platform {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export const APP_NAME: Record<AppLink['app'], string> = { google: 'Google 地圖', amap: '高德地圖' };

/** Whether this iPhone has each app, as the user told us (a web page cannot find out). */
export type AppAnswers = Partial<Record<AppLink['app'], boolean>>;

const KEY = 'travel-planner-map-apps';

export function readAnswers(): AppAnswers {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function saveAnswer(app: AppLink['app'], has: boolean) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAnswers(), [app]: has }));
  } catch {
    /* asked again next time */
  }
}

export function forgetAnswers() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

/**
 * What a tap on the link should do: leave it to the browser (the web page in a new tab), or
 * go to the app's address. On iPhone the first tap for each app asks whether it is installed.
 */
export function planOpen(
  link: AppLink,
  platform: Platform,
  preferApp: boolean,
  answers: AppAnswers,
): { kind: 'web' } | { kind: 'app'; url: string } | { kind: 'ask' } {
  if (!preferApp) return { kind: 'web' };
  if (platform === 'android' && link.android) return { kind: 'app', url: link.android };
  if (platform === 'ios' && link.ios) {
    const has = answers[link.app];
    if (has === undefined) return { kind: 'ask' };
    return has ? { kind: 'app', url: link.ios } : { kind: 'web' };
  }
  return { kind: 'web' };
}

/** Click handler for a map link (`<a href={link.web} target="_blank">`). */
export function openMapLink(e: { preventDefault(): void }, link: AppLink, preferApp: boolean) {
  let plan = planOpen(link, detectPlatform(), preferApp, readAnswers());
  if (plan.kind === 'ask') {
    const has = confirm(
      `要用「${APP_NAME[link.app]}」App 開啟嗎？\n\n手機有安裝就按「確定」，之後都會直接開 App；沒有安裝請按「取消」改用網頁版。（可在設定更改）`,
    );
    saveAnswer(link.app, has);
    plan = has && link.ios ? { kind: 'app', url: link.ios } : { kind: 'web' };
  }
  if (plan.kind !== 'app') return; // the link opens the web page itself
  e.preventDefault();
  // Android: Chrome opens the app, or the web page when it is not installed.
  location.href = plan.url;
}
