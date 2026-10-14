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

/**
 * Phones get the share sheet (which lists the Claude and ChatGPT apps);
 * desktops get the text copied. Must be called straight from a tap/click.
 */
export async function sendToAiApp(text: string): Promise<SendResult> {
  const phone = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  if (phone && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return 'cancelled';
      // Some targets reject long text; fall through to copying.
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

export const AI_APP_LINKS = [
  { label: 'Claude', url: 'https://claude.ai/new' },
  { label: 'ChatGPT', url: 'https://chatgpt.com/' },
];
