import "./style.css";
import { api, Config, FileInfo, reconstructAbstract } from "./api";
import { Block, Box, DocModel, IdGen, Sentence, sentencesFrom } from "./model";
import { detectKind, parseSource, SourceKind } from "./parsers";
import { PdfView } from "./pdfview";
import { ReproView } from "./repro";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const STRUCTURED: SourceKind[] = ["tei", "jats", "docling", "text", "other"];

document.querySelector("#app")!.innerHTML = `
<header>
  <span id="paper-title"></span>
  <span id="status"></span>
  <button id="view-btn" class="primary" disabled>Next: reproducibility →</button>
  <button id="settings-btn" title="Settings">⚙ Settings</button>
</header>
<div id="repro-view" class="hidden"></div>
<main id="reader-view">
  <aside id="sidebar">
    <nav class="tabs"><button data-tab="outline" class="on">Outline</button><button data-tab="sources">Sources</button></nav>
    <section id="tab-outline" class="tab"><div id="outline" class="empty">Load a DOI to begin.</div></section>
    <section id="tab-sources" class="tab hidden">
      <div class="actions">
        <button id="fetch-btn" disabled>Fetch online formats</button>
        <label class="btn" id="upload-label">Upload files…<input id="upload" type="file" multiple accept=".pdf,.xml,.nxml,.json,.md,.txt" hidden /></label>
      </div>
      <div class="actions">
        <button id="grobid-btn" disabled title="PDF → TEI via local GROBID server">Run GROBID</button>
        <button id="docling-btn" disabled title="PDF → Docling JSON via local docling CLI">Run Docling</button>
      </div>
      <ul id="files"></ul>
      <fieldset id="claude-box">
        <legend>Reconcile with Claude</legend>
        <p class="hint">Tick sources above, then let Claude merge them into a new TEI version (claude.tei.xml).</p>
        <textarea id="claude-extra" rows="2" placeholder="Optional extra instructions"></textarea>
        <button id="claude-btn" disabled>Reconcile selected</button>
      </fieldset>
      <pre id="log"></pre>
    </section>
  </aside>
  <section id="pdf-pane">
    <div class="pane-head">
      <select id="pdf-select"></select>
      <span class="spacer"></span>
      <button id="zoom-out">−</button><button id="zoom-fit">Fit</button><button id="zoom-in">+</button>
    </div>
    <div id="pdf"></div>
  </section>
  <section id="text-pane">
    <div class="pane-head">
      <label>Reference: <select id="ref-select"></select></label>
      <span class="spacer"></span>
      <span id="ref-info" class="hint"></span>
    </div>
    <div id="text" class="empty">No reference text.</div>
  </section>
</main>
<dialog id="settings">
  <form method="dialog">
    <h2>Settings</h2>
    <label>OpenAlex API key <input name="openalex_api_key" type="password" autocomplete="off" /></label>
    <p class="hint">Needed for OpenAlex-hosted PDFs and GROBID XML (content.openalex.org).</p>
    <label>Contact e-mail (polite pool) <input name="mailto" type="email" /></label>
    <label>GROBID URL <input name="grobid_url" /></label>
    <label>Docling command <input name="docling_cmd" /></label>
    <label>Claude CLI command <input name="claude_cmd" /></label>
    <label>Claude model (optional) <input name="claude_model" placeholder="default" /></label>
    <label>Code editor command (optional) <input name="editor_cmd" placeholder="auto: code, codium, cursor, zed, subl, xdg-open" /></label>
    <menu><button value="cancel">Cancel</button><button value="save" class="primary">Save</button></menu>
  </form>
</dialog>`;

// ---------- state ----------

const pdf = new PdfView($("#pdf"));
pdf.clear();
let doi = "";
let files: FileInfo[] = [];
let meta: any = null;
let currentRef = "";
let currentPdf = "";
const models = new Map<string, DocModel>();
const kinds = new Map<string, SourceKind>();

interface Target { text: string; boxes?: Box[]; fallback?: Box[] }
let targets = new Map<string, Target>();

/** Session restore hints, consumed by refreshFiles(). */
let restore: { ref?: string; pdf?: string } | undefined;
let view: "reader" | "repro" = "reader";

// ---------- status / busy ----------

let busy = 0;
function status(msg: string, kind: "info" | "error" = "info") {
  const el = $("#status");
  el.textContent = msg;
  el.className = kind;
}
function log(lines: string | string[]) {
  const el = $("#log");
  el.textContent += (Array.isArray(lines) ? lines : [lines]).join("\n") + "\n";
  el.scrollTop = el.scrollHeight;
}
async function task<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  busy++;
  document.body.classList.add("busy");
  status(label + "…");
  updateButtons();
  try {
    const r = await fn();
    status(label + " — done");
    return r;
  } catch (e) {
    const msg = String(e);
    status(label + " failed: " + msg.split("\n")[0], "error");
    log(`[${label}] ${msg}`);
    return undefined;
  } finally {
    busy--;
    if (!busy) document.body.classList.remove("busy");
    updateButtons();
  }
}

function updateButtons() {
  const has = !!doi;
  $<HTMLButtonElement>("#fetch-btn").disabled = !has || busy > 0;
  $<HTMLButtonElement>("#grobid-btn").disabled = !currentPdf || busy > 0;
  $<HTMLButtonElement>("#docling-btn").disabled = !currentPdf || busy > 0;
  $<HTMLButtonElement>("#claude-btn").disabled = !has || busy > 0 || !selectedSources().length;
  $("#upload-label").classList.toggle("disabled", !has);
}

// ---------- loading a paper ----------

async function loadDoi(input: string) {
  const d = input.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "");
  if (!d) return;
  doi = d;
  models.clear();
  currentRef = "";
  currentPdf = "";
  loadedPdf = "";
  kinds.clear();
  pdf.clear("Loading…");
  $("#log").textContent = "";
  // Items without a DOI are keyed "zotero:<item key>" and have no OpenAlex record.
  meta = d.startsWith("zotero:") ? null : await task("Fetching OpenAlex metadata", () => api.fetchOpenAlex(d));
  await refreshFiles();
  if (!meta) {
    try { meta = JSON.parse(await api.readText(d, "openalex.json")); } catch { /* offline & never fetched */ }
  }
  document.title = `MetaReader — ${meta?.title ?? d}`;
  $("#paper-title").textContent = meta?.title ?? (d.startsWith("zotero:") ? "" : d);
  if (!files.some((f) => kinds.get(f.name) === "pdf") || !files.some((f) => STRUCTURED.includes(kinds.get(f.name)!))) {
    await fetchFormats();
  } else render();
  restore = undefined;
  $<HTMLButtonElement>("#view-btn").disabled = false;
  if (view === "repro") await repro.open();
  saveSession();
}

async function fetchFormats() {
  const out = await task("Fetching online formats", () => api.fetchFormats(doi));
  if (out) log(out);
  await refreshFiles();
}

async function refreshFiles() {
  files = await api.listFiles(doi);
  for (const f of files) {
    if (kinds.has(f.name)) continue;
    let head: string | undefined;
    if (/\.(xml|nxml|json)$/i.test(f.name)) {
      head = new TextDecoder().decode((await api.readFile(doi, f.name)).slice(0, 4000));
    }
    kinds.set(f.name, detectKind(f.name, head));
  }
  const pdfs = files.filter((f) => kinds.get(f.name) === "pdf").map((f) => f.name);
  const refs = files.filter((f) => STRUCTURED.includes(kinds.get(f.name)!)).map((f) => f.name);
  if (!pdfs.includes(currentPdf)) currentPdf = restore?.pdf && pdfs.includes(restore.pdf) ? restore.pdf : pdfs.includes("source.pdf") ? "source.pdf" : pdfs[0] ?? "";
  if (!refs.includes(currentRef)) currentRef = restore?.ref && refs.includes(restore.ref) ? restore.ref : pickDefaultRef(refs);
  renderFiles();
  await showPdf(currentPdf);
  await showRef(currentRef);
}

/** Prefer formats with sentence coordinates. */
function pickDefaultRef(refs: string[]): string {
  const order = ["claude.tei.xml", "grobid.tei.xml", "openalex.tei.xml"];
  return order.find((r) => refs.includes(r)) ?? refs.find((r) => kinds.get(r) === "jats") ?? refs[0] ?? "";
}

let loadedPdf = "";
async function showPdf(name: string, force = false) {
  currentPdf = name;
  const sel = $<HTMLSelectElement>("#pdf-select");
  const pdfs = files.filter((f) => kinds.get(f.name) === "pdf");
  sel.innerHTML = pdfs.length ? pdfs.map((f) => `<option ${f.name === name ? "selected" : ""}>${esc(f.name)}</option>`).join("") : `<option>(no PDF)</option>`;
  if (!name) {
    loadedPdf = "";
    pdf.clear("No PDF available. Upload one from the Sources tab.");
    return;
  }
  if (name === loadedPdf && !force) return;
  loadedPdf = name;
  await task("Opening PDF", async () => {
    await pdf.load(await api.readFile(doi, name));
    pdf.fitWidth();
  });
  updateButtons();
  saveSession();
}

async function showRef(name: string) {
  currentRef = name;
  const sel = $<HTMLSelectElement>("#ref-select");
  const refs = files.filter((f) => STRUCTURED.includes(kinds.get(f.name)!));
  sel.innerHTML = refs.length
    ? refs.map((f) => `<option value="${esc(f.name)}" ${f.name === name ? "selected" : ""}>${esc(f.name)} (${kinds.get(f.name)})</option>`).join("")
    : `<option value="">(metadata only)</option>`;
  if (name && !models.has(name)) {
    await task(`Parsing ${name}`, async () => models.set(name, parseSource(name, await api.readText(doi, name))));
  }
  render();
  saveSession();
}

// ---------- rendering ----------

function metaModel() {
  const ids = new IdGen();
  const abstract = reconstructAbstract(meta?.abstract_inverted_index);
  return { title: meta?.title as string | undefined, abstract: abstract ? sentencesFrom(abstract, ids).map((s) => ({ ...s, id: "m-" + s.id })) : [] };
}

function render() {
  targets = new Map();
  const model = currentRef ? models.get(currentRef) : undefined;
  const m = metaModel();
  if (m.title) targets.set("m-title", { text: m.title });
  m.abstract.forEach((s) => targets.set(s.id, { text: s.text }));
  if (model) registerTargets(model);
  $("#ref-info").textContent = model ? `${model.sections.length} sections · ${countSentences(model)} sentences${hasCoords(model) ? " · with PDF coordinates" : ""}` : "";
  renderOutline(model, m);
  renderText(model, m);
}

function countSentences(m: DocModel) {
  return m.sections.reduce((n, s) => n + s.blocks.reduce((k, b) => k + (b.kind === "p" ? b.sentences.length : b.caption.length), 0), 0);
}
function hasCoords(m: DocModel) {
  return m.sections.some((s) => s.blocks.some((b) => b.boxes?.length || (b.kind === "p" && b.sentences.some((x) => x.boxes))));
}

function registerTargets(model: DocModel) {
  const sent = (s: Sentence) => targets.set(s.id, { text: s.text, boxes: s.boxes, fallback: s.fallbackBoxes });
  for (const sec of model.sections) {
    targets.set(sec.id, { text: sec.title, boxes: sec.titleBoxes });
    for (const b of sec.blocks) {
      const sentences = b.kind === "p" ? b.sentences : b.caption;
      sentences.forEach(sent);
      const allBoxes = sentences.flatMap((s) => s.boxes ?? []);
      targets.set(b.id, { text: sentences.map((s) => s.text).join(" "), boxes: b.boxes ?? (allBoxes.length ? allBoxes : undefined) });
    }
  }
}

const trunc = (s: string, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function renderOutline(model: DocModel | undefined, m: ReturnType<typeof metaModel>) {
  const el = $("#outline");
  if (!doi) return;
  el.classList.remove("empty");
  const authors: any[] = meta?.authorships ?? [];
  let html = `<details open class="o-meta"><summary class="o-head">📇 Metadata</summary><ul>`;
  if (m.title) html += `<li data-hid="m-title" class="o-item">Title: ${esc(trunc(m.title))}</li>`;
  if (authors.length) html += `<li class="o-plain">Authors: ${esc(trunc(authors.map((a) => a.author?.display_name).join(", "), 90))}</li>`;
  if (meta?.publication_year) html += `<li class="o-plain">Year: ${meta.publication_year}</li>`;
  const venue = meta?.primary_location?.source?.display_name;
  if (venue) html += `<li class="o-plain">Venue: ${esc(venue)}</li>`;
  if (meta?.open_access) html += `<li class="o-plain">OA: ${esc(meta.open_access.oa_status ?? "")}${meta.open_access.is_oa ? " ✓" : ""}</li>`;
  if (m.abstract.length) {
    html += `<li><details><summary class="o-sub">Abstract (OpenAlex)</summary><ul>${m.abstract.map((s) => `<li data-hid="${s.id}" class="o-item o-sent">${esc(trunc(s.text))}</li>`).join("")}</ul></details></li>`;
  }
  html += `</ul></details>`;

  if (!model) {
    html += `<p class="hint">No structured full text yet — fetch, upload, or generate one in the Sources tab.</p>`;
  } else {
    html += `<div class="o-label">Document · ${esc(model.source)}</div>`;
    for (const sec of model.sections) {
      html += `<details class="o-sec" style="margin-left:${(sec.level - 1) * 10}px"><summary class="o-head" data-hid="${sec.id}">§ ${esc(trunc(sec.title || "(untitled)", 60))}</summary><ul>`;
      let pn = 0;
      for (const b of sec.blocks) html += outlineBlock(b, b.kind === "p" ? ++pn : 0);
      html += `</ul></details>`;
    }
  }
  el.innerHTML = html;
}

function outlineBlock(b: Block, pn: number): string {
  const sentences = b.kind === "p" ? b.sentences : b.caption;
  const icon = b.kind === "p" ? `¶${pn}` : b.kind === "table" ? "▦" : "🖼";
  const label = b.kind === "p" ? trunc(sentences[0]?.text ?? "", 50) : `${b.label}`;
  const items = sentences.map((s) => `<li data-hid="${s.id}" class="o-item o-sent">${esc(trunc(s.text))}</li>`).join("");
  return `<li class="o-block o-${b.kind}"><details><summary data-hid="${b.id}" class="o-item"><b>${icon}</b> ${esc(label)}</summary><ul>${items}</ul></details></li>`;
}

function renderText(model: DocModel | undefined, m: ReturnType<typeof metaModel>) {
  const el = $("#text");
  if (!doi) return;
  el.classList.remove("empty");
  const authors: any[] = meta?.authorships ?? [];
  let html = `<article><div class="meta-card">`;
  if (m.title) html += `<h1 data-hid="m-title">${esc(m.title)}</h1>`;
  if (authors.length) html += `<p class="authors">${authors.map((a) => esc(a.author?.display_name ?? "")).join(", ")}</p>`;
  html += `<p class="venue">${esc([meta?.primary_location?.source?.display_name, meta?.publication_year, meta?.doi].filter(Boolean).join(" · "))}</p>`;
  if (!model && m.abstract.length) html += `<h2>Abstract</h2><p>${m.abstract.map(sentSpan).join(" ")}</p>`;
  html += `</div>`;
  if (model) {
    for (const sec of model.sections) {
      const h = Math.min(6, sec.level + 1);
      html += `<section id="t-${sec.id}"><h${h} data-hid="${sec.id}">${esc(sec.title)}</h${h}>`;
      for (const b of sec.blocks) html += textBlock(b);
      html += `</section>`;
    }
  }
  el.innerHTML = html + `</article>`;
}

const sentSpan = (s: Sentence) => `<span class="sent${s.boxes ? " exact" : ""}" data-hid="${s.id}">${esc(s.text)}</span>`;

function textBlock(b: Block): string {
  if (b.kind === "p") return `<p id="t-${b.id}" data-block="${b.id}">${b.sentences.map(sentSpan).join(" ")}</p>`;
  const cap = `<figcaption><b data-hid="${b.id}">${esc(b.label)}</b> ${b.caption.map(sentSpan).join(" ")}</figcaption>`;
  if (b.kind === "figure") return `<figure id="t-${b.id}" class="fig">${cap}</figure>`;
  const rows = b.rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("")}</tr>`).join("");
  return `<figure id="t-${b.id}" class="tbl">${cap}${rows ? `<div class="tbl-wrap"><table>${rows}</table></div>` : ""}</figure>`;
}

// ---------- hover → PDF highlight ----------

let hoverToken = 0;
async function activate(hid: string | null, scrollText: boolean) {
  document.querySelectorAll(".active").forEach((e) => e.classList.remove("active"));
  const token = ++hoverToken;
  if (!hid) return pdf.highlight(null);
  document.querySelectorAll(`[data-hid="${hid}"]`).forEach((e) => e.classList.add("active"));
  if (scrollText) document.querySelector(`#text [data-hid="${hid}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  const t = targets.get(hid);
  if (!t || !pdf.loaded) return;
  let boxes: Box[] | null | undefined = t.boxes;
  if (!boxes?.length) {
    const hint = t.fallback?.map((b) => b.page);
    boxes = await pdf.findText(t.text, hint);
    if (token !== hoverToken) return;
    boxes ??= t.fallback;
  }
  pdf.highlight(boxes, true, t.boxes?.length || boxes !== t.fallback ? "hl" : "hl hl-approx");
}

let hoverTimer: number | undefined;
for (const sel of ["#outline", "#text"]) {
  const root = $(sel);
  root.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-hid]");
    if (!el || el.classList.contains("active")) return;
    clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => activate(el.dataset.hid!, sel === "#outline"), 60);
  });
  root.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-hid]");
    if (el && sel === "#outline") activate(el.dataset.hid!, true);
  });
}

// ---------- sources tab ----------

function selectedSources(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("#files input[type=checkbox]:checked")).map((c) => c.value);
}

function renderFiles() {
  const ul = $("#files");
  ul.innerHTML = files
    .map((f) => {
      const k = kinds.get(f.name)!;
      const usable = k !== "openalex";
      const zotero = f.attachment ? `<span class="badge k-zotero" title="Zotero attachment of this item">Zotero</span>` : "";
      return `<li>
        ${usable ? `<input type="checkbox" value="${esc(f.name)}" title="Include in Claude reconciliation" />` : `<span class="cb-pad"></span>`}
        <span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="badge k-${k}">${k}</span>${zotero}
        <span class="size">${(f.size / 1024).toFixed(0)} KB</span>
        ${k === "pdf" ? `<button data-act="pdf" data-name="${esc(f.name)}" title="Show in PDF pane">👁</button>` : STRUCTURED.includes(k) ? `<button data-act="ref" data-name="${esc(f.name)}" title="Use as reference text">👁</button>` : `<span class="cb-pad"></span>`}
        ${k !== "openalex" && !f.attachment ? `<button data-act="del" data-name="${esc(f.name)}" title="Delete">✕</button>` : ""}
      </li>`;
    })
    .join("");
  updateButtons();
}

$("#files").addEventListener("change", updateButtons);
$("#files").addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!btn) return;
  const name = btn.dataset.name!;
  if (btn.dataset.act === "pdf") await showPdf(name);
  if (btn.dataset.act === "ref") {
    await showRef(name);
    switchTab("outline");
  }
  if (btn.dataset.act === "del" && confirm(`Delete ${name}?`)) {
    await api.deleteFile(doi, name);
    models.delete(name);
    kinds.delete(name);
    if (name === loadedPdf) loadedPdf = "";
    await refreshFiles();
  }
});

$("#upload").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const list = Array.from(input.files ?? []);
  input.value = "";
  if (!doi || !list.length) return;
  for (const f of list) {
    const saved = await task(`Uploading ${f.name}`, () => api.uploadFile(doi, f));
    if (saved) {
      kinds.delete(saved);
      models.delete(saved);
      if (saved === loadedPdf) loadedPdf = "";
      log(`Uploaded ${saved}`);
    }
  }
  await refreshFiles();
});

async function generated(label: string, fn: () => Promise<string>) {
  const name = await task(label, fn);
  if (!name) return;
  kinds.delete(name);
  models.delete(name);
  log(`${label}: wrote ${name}`);
  await refreshFiles();
  await showRef(name);
}

$("#fetch-btn").addEventListener("click", fetchFormats);
$("#grobid-btn").addEventListener("click", () => generated("GROBID", () => api.runGrobid(doi, currentPdf)));
$("#docling-btn").addEventListener("click", () => generated("Docling", () => api.runDocling(doi, currentPdf)));
$("#claude-btn").addEventListener("click", () =>
  generated("Claude reconciliation", () => api.runClaude(doi, selectedSources(), $<HTMLTextAreaElement>("#claude-extra").value)),
);

// ---------- chrome ----------

function switchTab(tab: string) {
  sidebarTab = tab;
  saveSession();
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${tab}`));
}
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab!)));

$("#pdf-select").addEventListener("change", (e) => showPdf((e.target as HTMLSelectElement).value));
$("#ref-select").addEventListener("change", (e) => showRef((e.target as HTMLSelectElement).value));
$("#zoom-in").addEventListener("click", () => pdf.zoom(1.15));
$("#zoom-out").addEventListener("click", () => pdf.zoom(1 / 1.15));
$("#zoom-fit").addEventListener("click", () => pdf.fitWidth());

const dialog = $<HTMLDialogElement>("#settings");
$("#settings-btn").addEventListener("click", async () => {
  const cfg = await api.getConfig();
  const form = dialog.querySelector("form")!;
  for (const [k, v] of Object.entries(cfg)) (form.elements.namedItem(k) as HTMLInputElement).value = v;
  dialog.showModal();
});
dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "save") return;
  const form = dialog.querySelector("form")!;
  const cfg = Object.fromEntries(
    ["openalex_api_key", "mailto", "grobid_url", "docling_cmd", "claude_cmd", "claude_model", "editor_cmd"].map((k) => [k, (form.elements.namedItem(k) as HTMLInputElement).value.trim()]),
  ) as unknown as Config;
  await api.setConfig(cfg);
  status("Settings saved");
});

updateButtons();

// ---------- reproducibility view ----------

const repro = new ReproView($("#repro-view"), {
  doi: () => doi,
  meta: () => meta,
  model: () => (currentRef ? models.get(currentRef) : undefined),
  refName: () => currentRef,
  pdf,
  status,
});

async function setView(v: "reader" | "repro", step?: number) {
  view = v;
  $("#reader-view").classList.toggle("hidden", v !== "reader");
  $("#repro-view").classList.toggle("hidden", v !== "repro");
  $("#view-btn").textContent = v === "reader" ? "Next: reproducibility →" : "← Back to reader";
  if (v === "repro") await repro.open(step);
  else repro.close();
  saveSession();
}
$("#view-btn").addEventListener("click", () => setView(view === "reader" ? "repro" : "reader"));

// ---------- session persistence ----------

let sidebarTab = "outline";
let sessionTimer: number | undefined;
let restoring = true;
function saveSession() {
  if (restoring) return;
  clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => {
    api.saveSession({ doi, ref: currentRef, pdf: currentPdf, tab: sidebarTab, view, reproStep: repro.currentStep }).catch(() => {});
  }, 400);
}
window.addEventListener("beforeunload", () => {
  api.saveSession({ doi, ref: currentRef, pdf: currentPdf, tab: sidebarTab, view, reproStep: repro.currentStep });
});

// The plugin opens one tab per Zotero item and passes its DOI (or a zotero:<key> placeholder) in the URL;
// the session (last reference text, PDF, view) is stored per item in its MetaReader Package.
(async () => {
  const s = await api.loadSession().catch(() => null);
  try {
    if (s?.tab) switchTab(s.tab);
    const key = new URLSearchParams(location.search).get("doi");
    if (key) {
      restore = { ref: s?.ref, pdf: s?.pdf };
      await loadDoi(key);
      if (s?.view === "repro") await setView("repro", s.reproStep);
    }
  } finally {
    restoring = false;
  }
})();
