// MetaReader opens as a Zotero tab: a content <browser> with the UI inside the tab's container.
import { makeApi, normalizeDoi } from "./backend";
import { attach, detach, UI_ORIGIN } from "./bridge";
import { ensurePackage } from "./package";
import { stopAll } from "./processes";

export const TAB_TYPE = "metareader";

export const topItem = (item: any) => (item.isTopLevelItem() ? item : Zotero.Items.get(item.parentItemID));

export function itemDOI(item: any): string {
  if (!item?.isRegularItem()) return "";
  let doi = "";
  try {
    doi = item.getField("DOI");
  } catch {
    /* item type has no DOI field */
  }
  if (!doi) doi = (item.getField("extra") || "").match(/^DOI:\s*(\S+)/im)?.[1] ?? "";
  return normalizeDoi(Zotero.Utilities.cleanDOI(doi) || "");
}

export async function openMetaReader(item: any, win = Zotero.getMainWindow()) {
  const parent = topItem(item);
  if (!parent?.isRegularItem()) return;
  const tabs = win.Zotero_Tabs;
  const existing = tabs._tabs.find((t: any) => t.type === TAB_TYPE && t.data?.metareaderItemID === parent.id);
  if (existing) {
    tabs.select(existing.id);
    return;
  }
  const pkg = await ensurePackage(parent);
  const doi = itemDOI(parent);
  const browser = win.document.createXULElement("browser");
  browser.setAttribute("type", "content");
  browser.setAttribute("flex", "1");
  browser.setAttribute("disablehistory", "true");
  const { container } = tabs.add({
    type: TAB_TYPE,
    title: parent.getDisplayTitle(),
    // Not `itemID`: Zotero treats tabs with data.itemID as reader/note tabs in several places.
    data: { metareaderItemID: parent.id },
    select: true,
    onClose: () => {
      detach(browser);
      stopAll(`${pkg.key}:`);
    },
  });
  container.appendChild(browser);
  attach(browser, makeApi({ parent, pkg, doi }));
  // The UI keys papers by DOI; items without one get a stable placeholder key.
  browser.setAttribute("src", `${UI_ORIGIN}index.html?doi=${encodeURIComponent(doi || `zotero:${parent.key}`)}`);
}

/** Keep MetaReader tabs out of Zotero's saved session: Zotero can't restore tab types it doesn't know. */
export function patchTabs(win: any) {
  const tabs = win.Zotero_Tabs;
  const orig = tabs.getState;
  tabs.getState = function (...args: unknown[]) {
    return orig.apply(this, args).filter((t: any) => t.type !== TAB_TYPE);
  };
  return () => {
    tabs.getState = orig;
    const ids = tabs._tabs.filter((t: any) => t.type === TAB_TYPE).map((t: any) => t.id);
    if (ids.length) tabs.close(ids);
  };
}
