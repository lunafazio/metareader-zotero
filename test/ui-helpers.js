// Helper prefix for zeval scripts driving the MetaReader tab UI of item 1 (dev testing only).
const fix = () => Zotero.Prefs.get("__fixdir", true);
async function mrOpen(itemID = 1) {
  const T = win.Zotero_Tabs;
  let tab = T._tabs.find((t) => t.type === "metareader" && t.data.metareaderItemID === itemID);
  if (!tab) {
    await win.ZoteroPane.selectItem(itemID);
    await win.ZoteroPane.buildItemContextMenu();
    [...win.document.getElementById("zotero-itemmenu").children].find((e) => e.getAttribute("data-l10n-id") === "metareader-open").doCommand();
    for (let i = 0; i < 60 && !(tab = T._tabs.find((t) => t.type === "metareader" && t.data.metareaderItemID === itemID)); i++) await Zotero.Promise.delay(250);
    await Zotero.Promise.delay(6000);
  }
  T.select(tab.id);
  const b = win.document.getElementById(tab.id).querySelector("browser");
  return { cw: b.contentWindow, d: b.contentDocument };
}
const sleep = (ms) => Zotero.Promise.delay(ms);
async function waitFor(fn, ms = 20000) {
  for (let t = 0; t < ms; t += 200) { const v = fn(); if (v) return v; await sleep(200); }
  throw new Error("timeout waiting for " + fn);
}
async function shot(file) {
  win.resizeTo(1500, 950);
  await sleep(300);
  const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  c.width = win.innerWidth; c.height = win.innerHeight;
  c.getContext("2d").drawWindow(win, 0, 0, c.width, c.height, "#fff");
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  await IOUtils.write(file, new Uint8Array(await blob.arrayBuffer()));
}
async function dropFiles(cw, target, names) {
  const files = [];
  for (const n of names) files.push({ name: n, data: await IOUtils.read(PathUtils.join(fix(), n)) });
  cw.wrappedJSObject.__mrFiles = Cu.cloneInto(files, cw);
  cw.wrappedJSObject.__mrTarget = target.wrappedJSObject ?? target;
  cw.wrappedJSObject.eval(`(() => { const dt = new DataTransfer(); for (const f of __mrFiles) dt.items.add(new File([f.data], f.name)); __mrTarget.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
}
const txt = (el) => el?.textContent.replace(/\s+/g, " ").trim();
