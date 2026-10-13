// Tiny DOM builder. Every value is inserted as a text node or a property, never parsed as markup, so nothing that
// comes from the server (a payment note, a merchant name) can inject script into the till.

export type Child = Node | string | number | false | null | undefined | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, unknown> | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value') (el as unknown as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (kid: Child): void => {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}

let toastHost: HTMLElement | null = null;
export function toast(message: string, kind: '' | 'error' = ''): void {
  toastHost ??= document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  toastHost?.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

export async function copyText(text: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = old), 1200);
  } catch {
    toast('Could not copy automatically. Select the text and copy it.', 'error');
  }
}
