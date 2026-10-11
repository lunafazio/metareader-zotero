// Helper prefix for zeval scripts: `call(method, ...args)` goes through the real UI→plugin bridge of the
// selected MetaReader tab.
const mrTab = win.Zotero_Tabs._tabs.find((t) => t.type === "metareader");
const mrBrowser = mrTab && win.document.getElementById(mrTab.id).querySelector("browser");
const cw = mrBrowser?.contentWindow;
let seq = 1e6;
const call = (method, ...args) => new Promise((resolve, reject) => {
  const id = ++seq;
  const h = (e) => {
    const d = Cu.waiveXrays(e.detail);
    if (d.id !== id) return;
    cw.removeEventListener("metareader-reply", h);
    d.err !== undefined ? reject(new Error(d.err)) : resolve(Cu.cloneInto(d.ok, globalThis));
  };
  cw.addEventListener("metareader-reply", h, false, true);
  cw.dispatchEvent(new cw.CustomEvent("metareader-call", { detail: Cu.cloneInto({ id, method, args }, cw) }));
});
const attempt = async (f) => { try { return await f(); } catch (e) { return "ERR: " + e.message; } };
