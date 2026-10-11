// Item pane section listing the MetaReader Package contents: the "second level" below the package
// attachment, which Zotero's item tree can't show (attachments can't have child items).
import { Entry, formatSize, getPackage, isPackage, listPackage, onPackageChanged, packageDir } from "./package";
import { openMetaReader, topItem } from "./tabs";

const ICON = "chrome://metareader/content/icons/package.svg";
const countFiles = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

function packageFor(item: any) {
  if (isPackage(item)) return item;
  return item?.isRegularItem() ? getPackage(item) : undefined;
}

interface Dir {
  dirs: Map<string, Dir>;
  files: Entry[];
  size: number;
  count: number;
}

function buildTree(files: Entry[]): Dir {
  const root: Dir = { dirs: new Map(), files: [], size: 0, count: 0 };
  for (const f of files) {
    const parts = f.path.split("/");
    let d = root;
    d.size += f.size;
    d.count++;
    for (const part of parts.slice(0, -1)) {
      if (!d.dirs.has(part)) d.dirs.set(part, { dirs: new Map(), files: [], size: 0, count: 0 });
      d = d.dirs.get(part)!;
      d.size += f.size;
      d.count++;
    }
    d.files.push(f);
  }
  return root;
}

function renderDir(doc: any, dir: Dir, base: string, depth: number): any {
  const ul = doc.createElement("ul");
  ul.className = "metareader-tree";
  for (const [name, sub] of dir.dirs) {
    const li = doc.createElement("li");
    const details = doc.createElement("details");
    if (depth === 0 && dir.dirs.size === 1) details.open = true;
    const summary = doc.createElement("summary");
    summary.textContent = `${name}/`;
    const meta = doc.createElement("span");
    meta.className = "metareader-meta";
    meta.textContent = `${countFiles(sub.count)} · ${formatSize(sub.size)}`;
    summary.append(" ", meta);
    details.append(summary, renderDir(doc, sub, PathUtils.join(base, name), depth + 1));
    li.append(details);
    ul.append(li);
  }
  for (const f of dir.files) {
    const li = doc.createElement("li");
    const a = doc.createElement("a");
    a.textContent = f.path.split("/").pop()!;
    a.href = "#";
    const path = PathUtils.join(base, f.path.split("/").pop()!);
    a.title = `${path}\nClick: open · Shift-click: show in file manager`;
    a.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      if (e.shiftKey) Zotero.File.reveal(path);
      else Zotero.launchFile(path);
    });
    const meta = doc.createElement("span");
    meta.className = "metareader-meta";
    meta.textContent = formatSize(f.size);
    li.append(a, " ", meta);
    ul.append(li);
  }
  return ul;
}

const STYLE = `
.metareader-tree { list-style: none; margin: 0; padding-inline-start: 14px; }
.metareader-section > .metareader-tree { padding-inline-start: 0; }
.metareader-tree li { margin: 2px 0; overflow-wrap: anywhere; }
.metareader-tree summary { cursor: default; }
.metareader-tree a { color: var(--fill-primary); text-decoration: none; }
.metareader-tree a:hover { text-decoration: underline; }
.metareader-meta { color: var(--fill-secondary); font-size: 0.9em; }
.metareader-empty { color: var(--fill-secondary); }
`;

export function registerItemPane(pluginID: string): () => void {
  let refreshCurrent: (() => Promise<void>) | undefined;
  let currentPkgID: number | undefined;
  const unlisten = onPackageChanged((_parent, pkg) => {
    if (pkg.id === currentPkgID) refreshCurrent?.();
  });

  const paneID = Zotero.ItemPaneManager.registerSection({
    paneID: "metareader-package",
    pluginID,
    header: { l10nID: "metareader-pane-header", icon: ICON },
    sidenav: { l10nID: "metareader-pane-sidenav", icon: ICON },
    onItemChange: ({ item, tabType, setEnabled }: any) => {
      setEnabled(tabType === "library" && !!packageFor(item));
      return true;
    },
    onRender: ({ body }: any) => {
      body.replaceChildren();
    },
    onAsyncRender: async ({ doc, body, item, setSectionSummary, refresh }: any) => {
      const pkg = packageFor(item);
      if (!pkg) return;
      refreshCurrent = refresh;
      currentPkgID = pkg.id;
      const dir = packageDir(pkg);
      const files = await listPackage(dir);
      const tree = buildTree(files);
      setSectionSummary(`${countFiles(tree.count)} · ${formatSize(tree.size)}`);
      const style = doc.createElement("style");
      style.textContent = STYLE;
      const wrap = doc.createElement("div");
      wrap.className = "metareader-section";
      if (files.length) wrap.append(renderDir(doc, tree, dir, 0));
      else {
        const p = doc.createElement("p");
        p.className = "metareader-empty";
        p.textContent = "Empty. Open the item in MetaReader to fetch or generate files.";
        wrap.append(p);
      }
      body.replaceChildren(style, wrap);
    },
    sectionButtons: [
      {
        type: "metareader-open",
        icon: "chrome://metareader/content/icons/open.svg",
        l10nID: "metareader-pane-open",
        onClick: ({ item }: any) => openMetaReader(topItem(item)).catch((e: unknown) => Zotero.logError(e)),
      },
      {
        type: "metareader-reveal",
        icon: "chrome://metareader/content/icons/folder.svg",
        l10nID: "metareader-pane-reveal",
        onClick: ({ item }: any) => {
          const pkg = packageFor(item);
          if (pkg) Zotero.File.reveal(PathUtils.join(packageDir(pkg), "metareader-package.html"));
        },
      },
    ],
  });
  return () => {
    unlisten();
    if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID);
  };
}
