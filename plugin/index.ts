// Plugin entry point; bootstrap.js loads this bundle and forwards the lifecycle calls.
import { startBridge, stopBridge } from "./bridge";
import { registerItemPane } from "./itempane";
import { isPackage } from "./package";
import { stopAll } from "./processes";
import { itemDOI, openMetaReader, patchTabs, topItem } from "./tabs";

let cleanups: (() => void)[] = [];
const windowCleanups = new Map<any, () => void>();
let chromeHandle: any;
let origOpen: any;

const resProto = () => Services.io.getProtocolHandler("resource").QueryInterface(Components.interfaces.nsIResProtocolHandler);
const report = (p: Promise<unknown>) => p.catch((e) => Zotero.logError(e));

/** Items the context menu applies to: a regular item, or any of its children. */
function targetItem(items: any[] | undefined) {
  if (items?.length !== 1) return undefined;
  const item = topItem(items[0]);
  return item?.isRegularItem() ? item : undefined;
}

export function startup({ id, rootURI }: { id: string; rootURI: string }) {
  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"].getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [["content", "metareader", "content/"]]);
  // The UI is served unprivileged from resource://metareader/ui/ (not exposed to web content).
  resProto().setSubstitution("metareader", Services.io.newURI(rootURI + "content/"));
  startBridge();

  const menuIDs = [
    Zotero.MenuManager.registerMenu({
      menuID: "metareader-item",
      pluginID: id,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          l10nID: "metareader-open",
          icon: "chrome://metareader/content/icons/package.svg",
          onShowing: (_e: Event, ctx: any) => ctx.setVisible(!!targetItem(ctx.items)),
          onCommand: (_e: Event, ctx: any) => report(openMetaReader(targetItem(ctx.items))),
        },
      ],
    }),
  ];
  cleanups.push(() => menuIDs.forEach((m) => m && Zotero.MenuManager.unregisterMenu(m)));
  cleanups.push(registerItemPane(id));

  // Double-clicking the package attachment opens MetaReader instead of the HTML overview.
  origOpen = Zotero.FileHandlers.open;
  Zotero.FileHandlers.open = async function (item: any, ...rest: unknown[]) {
    if (isPackage(item)) {
      await openMetaReader(item);
      return true;
    }
    return origOpen.call(this, item, ...rest);
  };
  cleanups.push(() => {
    Zotero.FileHandlers.open = origOpen;
  });

  for (const win of Zotero.getMainWindows()) onMainWindowLoad({ window: win });
}

export function onMainWindowLoad({ window }: { window: any }) {
  window.MozXULElement.insertFTLIfNeeded("metareader.ftl");
  windowCleanups.set(window, patchTabs(window));
}

export function onMainWindowUnload({ window }: { window: any }) {
  windowCleanups.get(window)?.();
  windowCleanups.delete(window);
  window.document.querySelector('link[href="metareader.ftl"]')?.remove();
}

export function shutdown() {
  for (const win of Zotero.getMainWindows()) onMainWindowUnload({ window: win });
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
  stopAll();
  stopBridge();
  resProto().setSubstitution("metareader", null);
  chromeHandle?.destruct();
  chromeHandle = null;
}

export { itemDOI };
