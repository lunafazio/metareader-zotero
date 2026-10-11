// The UI runs unprivileged in a content <browser> (resource://metareader/ui/). It posts api calls as
// "metareader-call" DOM events; the bridge answers with "metareader-reply". Only methods of the tab's Api
// object can be invoked.
import type { Api } from "./backend";

export const UI_ORIGIN = "resource://metareader/ui/";
const Cu = Components.utils;
const sessions = new Map<any, Api>(); // browser element → api

function reply(win: any, detail: object) {
  win.dispatchEvent(new win.CustomEvent("metareader-reply", { detail: Cu.cloneInto(detail, win) }));
}

async function onCall(api: Api, win: any, e: Event) {
  // Copy the request out of the content compartment before looking at it.
  const { id, method, args } = Cu.cloneInto(Cu.waiveXrays((e as CustomEvent).detail), globalThis);
  try {
    const fn = Object.hasOwn(api, method) ? (api as any)[method] : undefined;
    if (typeof fn !== "function") throw new Error(`unknown method ${method}`);
    reply(win, { id, ok: (await fn(...args)) ?? null });
  } catch (err) {
    reply(win, { id, err: (err as Error)?.message ?? String(err) });
  }
}

// Attach the call listener to every new UI window before its scripts run (also covers reloads).
const observer = {
  observe(win: any) {
    for (const [browser, api] of sessions) {
      if (win !== browser.contentWindow) continue;
      if (!win.location.href.startsWith(UI_ORIGIN)) return;
      win.addEventListener("metareader-call", (e: Event) => onCall(api, win, e), false, true); // wantsUntrusted: sent by content
      return;
    }
  },
};

export function startBridge() {
  Services.obs.addObserver(observer, "content-document-global-created");
}

export function stopBridge() {
  Services.obs.removeObserver(observer, "content-document-global-created");
  sessions.clear();
}

export const attach = (browser: any, api: Api) => sessions.set(browser, api);
export const detach = (browser: any) => sessions.delete(browser);
