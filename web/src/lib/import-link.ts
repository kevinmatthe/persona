// A provider import link opened in this page (#5420): `<web address>/settings?tab=models#import=<base64url JSON>`, a
// model provider's settings as cindy's v1 import JSON (lib/provider-link.ts builds them). App.tsx takes it out of the
// address bar as the page loads, before anything else runs, since it may hold a key: out of the Back list, bookmarks
// and links copied from the address bar. The text waits here, in memory only (never storage, logs or error reports),
// until Settings › Model providers opens Add on it and sends it to the hub, which reads and checks every part of it
// (POST /api/v1/launchers/import/parse). Kept apart from lib/provider-link.ts: App imports this, so it is on the first
// screen, and the link builder is not.
import { BASE, stripBase } from "./base";

/** The link in `href`, when its fragment names `import`: `text`, the whole link as given (the hub reads it), and `rest`,
 *  where the address bar goes instead: the settings page on its Model providers tab, without the fragment. */
export function takeImportLink(href: string): { text: string; rest: string } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!new URLSearchParams(u.hash.replace(/^#/, "")).has("import")) return null;
  if (stripBase(u.pathname).replace(/\/+$/, "") !== "/settings") return { text: href, rest: `${BASE}/settings?tab=models` };
  // the providers are on the Model providers tab: a link to another one would leave the link waiting unseen
  const q = new URLSearchParams(u.search);
  if (q.get("tab") === "models") return { text: href, rest: u.pathname + u.search };
  q.set("tab", "models");
  return { text: href, rest: `${u.pathname}?${q.toString()}` };
}

let held: string | null = null;
const listeners = new Set<(text: string) => void>();

/** Keeps the link opened until Settings › Model providers takes it, telling it when it is open already. */
export function holdImportLink(text: string) {
  held = text;
  listeners.forEach((l) => l(text));
}

/** Calls `fn` with each link held (a page already open on the providers opened with one); returns the stop. */
export function onImportLink(fn: (text: string) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The link waiting, if any; reading leaves it (React's StrictMode runs a state's initializer twice). */
export const importLinkHeld = (): string | null => held;

/** Forgets it: the page that opened it has it now. */
export function dropImportLink() {
  held = null;
}
