/* Moving text between this app and the user's Claude / ChatGPT app. */

export type SendResult = 'shared' | 'copied' | 'cancelled' | 'failed';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall back to the legacy path below */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

let sharing = false;

/**
 * Phones get the share sheet (which lists the Claude and ChatGPT apps);
 * desktops get the text copied. Must be called straight from a tap/click.
 */
export async function sendToAiApp(text: string): Promise<SendResult> {
  const phone = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  if (phone && typeof navigator.share === 'function') {
    // A second tap while the sheet is still opening must not fall through to copying.
    if (sharing) return 'cancelled';
    sharing = true;
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (err) {
      const name = (err as DOMException).name;
      if (name === 'AbortError' || name === 'InvalidStateError') return 'cancelled';
      // Some targets reject long text; try copying instead (may fail without a fresh tap).
    } finally {
      sharing = false;
    }
  }
  return (await copyText(text)) ? 'copied' : 'failed';
}

/** Clipboard text, or null when the browser refuses or it is empty. */
export async function readClipboard(): Promise<string | null> {
  try {
    const t = await navigator.clipboard?.readText?.();
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
}

/** First characters of a long text, for confirmation dialogs. */
export function preview(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const AI_APP_LINKS = [
  { label: 'Claude', url: 'https://claude.ai/new' },
  { label: 'ChatGPT', url: 'https://chatgpt.com/' },
];
