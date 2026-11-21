/**
 * Boot diagnostics banner.
 *
 * Everything the user sees in this app is drawn by UIKit inside the WebGL
 * canvas - there is no DOM mirror of the panel. So when one setup step throws,
 * the window keeps showing the room and the avatar with no interface at all,
 * and the only trace is a line in the console that nobody reads on a phone or
 * in a headset.
 *
 * This module turns such a failure into a visible strip at the top of the
 * window, so "the UI is missing" always comes with a reason. It also mirrors
 * the message to the console for remote debugging.
 */

let banner: HTMLDivElement | undefined;
let lastMessage = '';

/** Show (or update) the top-of-window failure strip. */
export function reportBootIssue(summary: string, error?: unknown): void {
  const detail =
    error instanceof Error ? error.message : error == null ? '' : String(error);
  const message = detail ? `${summary}: ${detail}` : summary;
  console.error(`[agent-body] ${message}`, error);
  if (typeof document === 'undefined' || document.body == null) return;
  if (message === lastMessage && banner?.isConnected) return;
  lastMessage = message;
  if (banner == null) {
    banner = document.createElement('div');
    banner.id = 'boot-diagnostics';
    banner.setAttribute('role', 'alert');
    // Inline styles: this banner must survive a stylesheet failure too.
    banner.style.cssText = [
      'position:fixed',
      'inset:0 0 auto 0',
      'z-index:2147483647',
      'margin:0',
      'padding:8px 12px',
      'background:#7f1d1d',
      'color:#fff',
      'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'white-space:pre-wrap',
      'pointer-events:none',
    ].join(';');
    document.body.append(banner);
  }
  banner.textContent = message;
}
