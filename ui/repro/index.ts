import { api, ReproFile, RunResult } from "../api";
import type { DocModel } from "../model";
import type { PdfView } from "../pdfview";
import { compareAll, CompareRow, STATUS_LABEL } from "./compare";
import {
  addStepDialog, addTargetDialog, agentDialog, callDetailsDialog, confirmDialog, esc, llmDialog, LlmChoice, modal, PLAN_PRESETS,
  scannedCounts, TARGET_PRESETS, trunc,
} from "./dialogs";
import { extractJson, figureTargets, indexDoc, planPrompt, resultsPrompt, toStepDrafts, toTargets } from "./llm";
import { buildReport } from "./report";
import {
  AnalysisPlan, COMPARATORS, PLAN_JSON_SCHEMA, ReproducedOutput, RESULTS_OUTPUT_JSON_SCHEMA, RESULTS_SCHEMA_JSON_SCHEMA,
  ResultsSchema, TargetResult, validateOutput, validatePlan, validateResultsSchema,
} from "./schemas";
import {
  allEntries, buildPlan, buildSchema, Entry, findEntry, InputMeta, inputsManifest, isModified, Item, LlmCall, LlmGroup, loadState,
  move, nextNumber, ReproState, restore, roleFor, ROLES, Role, setField, StepDraft, uid, usedInputs, value,
} from "./state";
import { agentPrompt, masterScript, packageReadme, TEMPLATES, TemplateId, TODO_MARK } from "./templates";

const STATE_FILE = ".metareader/state.json";
const STEPS = ["Inputs", "Targets", "Analysis plan", "Master script", "Code generation", "Run & compare", "Report & package"];
const STEP = { inputs: 0, targets: 1, plan: 2, script: 3, codegen: 4, run: 5, report: 6 };

export interface ReaderContext {
  doi(): string;
  meta(): any;
  model(): DocModel | undefined;
  refName(): string;
  pdf: PdfView;
  status(msg: string, kind?: "info" | "error"): void;
}

/** How one entry table (targets or plan steps) renders and parses its columns. */
interface TableSpec<T extends { id: string }> {
  key: "targets" | "steps";
  noun: string;
  items(): Item<T>[];
  head: string[];
  cells(v: T, disabled: boolean): string[];
  parse(field: string, raw: string, v: T): unknown;
  empty: string;
  top?: string;
  bottom?: string;
}

const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const nearEnd = (el: Element) => el.scrollHeight - el.scrollTop - el.clientHeight < 8;
const list = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
const modelOf = (argv: string[]) => (argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "");

export class ReproView {
  private doi = "";
  private state: ReproState = loadState(null);
  private files: ReproFile[] = [];
  private folder = "";
  private running = new Set<string>();
  private poll?: number;
  private output?: ReproducedOutput;
  private outputCheck?: { errors: string[]; warnings: string[] };
  private rows?: CompareRow[];
  private blobUrls: string[] = [];
  private saveTimer?: number;
  private renderedStep = -1;
  /** Scroll position of the agent activity list across re-renders. */
  private eventsKeep?: { top: number; atEnd: boolean };

  constructor(private root: HTMLElement, private ctx: ReaderContext) {
    root.innerHTML = `
      <nav id="rp-steps"></nav>
      <div id="rp-body"></div>
      <footer id="rp-foot"><button id="rp-back">← Back</button><span id="rp-status"></span><button id="rp-next" class="primary">Next →</button></footer>`;
    root.querySelector("#rp-back")!.addEventListener("click", () => this.go(this.state.step - 1));
    root.querySelector("#rp-next")!.addEventListener("click", () => this.go(this.state.step + 1));
    root.querySelector("#rp-steps")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-step]");
      if (b) this.go(Number(b.dataset.step));
    });
  }

  get currentStep() {
    return this.state.step;
  }

  /** Called whenever the view becomes visible. */
  async open(step?: number) {
    const doi = this.ctx.doi();
    if (!doi) {
      this.root.querySelector("#rp-body")!.innerHTML = `<div class="empty">Load a paper first.</div>`;
      return;
    }
    if (doi !== this.doi) {
      this.doi = doi;
      this.output = this.rows = this.outputCheck = undefined;
      try {
        this.state = loadState(JSON.parse(await api.reproReadText(doi, STATE_FILE)));
      } catch {
        this.state = loadState(null);
      }
      this.folder = await api.reproPath(doi);
    }
    if (step !== undefined) this.state.step = Math.min(step, STEPS.length - 1);
    await this.refreshFiles();
    this.render();
  }

  close() {
    clearInterval(this.poll);
    this.poll = undefined;
  }

  private save() {
    clearTimeout(this.saveTimer);
    const doi = this.doi;
    const json = JSON.stringify(this.state, null, 2);
    this.saveTimer = window.setTimeout(() => api.reproWrite(doi, STATE_FILE, json).catch(() => {}), 300);
  }

  private go(step: number) {
    if (step < 0 || step >= STEPS.length) return;
    this.state.step = step;
    this.save();
    this.render();
  }

  private setStatus(msg: string, kind: "info" | "error" = "info") {
    const el = this.root.querySelector("#rp-status")!;
    el.textContent = msg;
    el.className = kind;
    this.ctx.status(msg, kind);
  }

  private async busy<T>(key: string, label: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.running.add(key);
    this.setStatus(`⏳ ${label}…`);
    this.render();
    try {
      const r = await fn();
      this.setStatus(`${label} — done`);
      return r;
    } catch (e) {
      this.setStatus(`${label} failed: ${String(e).split("\n")[0]}`, "error");
      this.showError(label, String(e));
      return undefined;
    } finally {
      this.running.delete(key);
      this.render();
    }
  }

  private showError(label: string, msg: string) {
    const dlg = document.createElement("dialog");
    dlg.className = "rp-error";
    dlg.innerHTML = `<h3>${esc(label)} failed</h3><pre>${esc(msg)}</pre><form method="dialog"><button>Close</button></form>`;
    document.body.append(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
  }

  private async refreshFiles(hash = false) {
    this.files = await api.reproList(this.doi, hash).catch(() => []);
    this.syncInputs();
  }

  /** Keep the inputs table in step with inputs/ on disk: new files get a guessed role, deleted ones disappear. */
  private syncInputs() {
    const st = this.state;
    const onDisk = this.files.filter((f) => f.path.startsWith("inputs/"));
    const paths = new Set(onDisk.map((f) => f.path));
    const kept = st.inputs.filter((i) => paths.has(i.path));
    let changed = kept.length !== st.inputs.length;
    const known = new Set(kept.map((i) => i.path));
    for (const f of onDisk) {
      if (known.has(f.path)) continue;
      kept.push({ path: f.path, role: roleFor(f.path), note: "" });
      changed = true;
    }
    const archives = st.archives.filter((a) => kept.some((i) => i.path.startsWith(a.dir + "/")));
    changed ||= archives.length !== st.archives.length;
    st.inputs = kept;
    st.archives = archives;
    if (changed) this.save();
  }

  private schema(): ResultsSchema | undefined {
    return buildSchema(this.state, { doi: this.doi, title: this.ctx.meta()?.title });
  }

  private plan(): AnalysisPlan | undefined {
    return buildPlan(this.state);
  }

  // ---------- rendering ----------

  private render() {
    const s = this.state.step;
    this.root.querySelector("#rp-steps")!.innerHTML = STEPS.map((t, i) => `<button data-step="${i}" class="${i === s ? "on" : ""}">${i + 1}. ${t}</button>`).join("");
    (this.root.querySelector("#rp-back") as HTMLButtonElement).disabled = s === 0;
    const next = this.root.querySelector("#rp-next") as HTMLButtonElement;
    next.disabled = s === STEPS.length - 1;
    next.textContent = s === STEP.codegen ? "Next: full run →" : "Next →";
    const body = this.root.querySelector<HTMLElement>("#rp-body")!;
    // Keep scroll positions when re-rendering the same step.
    const sameStep = this.renderedStep === s;
    const top = body.scrollTop;
    const ev = body.querySelector("#rp-events");
    if (ev && sameStep) this.eventsKeep = { top: ev.scrollTop, atEnd: nearEnd(ev) };
    [this.renderInputs, this.renderTargets, this.renderPlan, this.renderScript, this.renderCodegen, this.renderRun, this.renderReport][s].call(this, body);
    if (sameStep) body.scrollTop = top;
    this.renderedStep = s;
    this.managePolling();
  }

  private managePolling() {
    const s = this.state.step;
    const need = (s === STEP.codegen && this.running.has("codegen")) || (s === STEP.run && this.running.has("run"));
    if (need && !this.poll) this.poll = window.setInterval(() => this.pollStatus(), 2500);
    if (!need && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private async pollStatus() {
    await this.refreshFiles();
    if (this.state.step === STEP.codegen) await this.updateCodegenStatus();
    if (this.state.step === STEP.run) await this.updateRunLog();
  }

  private sourceWarning(): string {
    const ref = this.ctx.refName();
    return this.state.source && this.state.source !== ref
      ? `<p class="warn">Article references were marked in <b>${esc(this.state.source)}</b>, but the current reference text is <b>${esc(ref)}</b>. Switch back in the Reader before marking more content.</p>`
      : "";
  }

  private validationBox(errors: string[], warnings: string[], what: string): string {
    if (!errors.length && !warnings.length) return `<p class="ok">✓ ${esc(what)} is valid.</p>`;
    return `${errors.length ? `<div class="warn"><b>⚠ ${esc(what)} is not compliant (${errors.length} problem${errors.length > 1 ? "s" : ""}):</b><ul>${errors.slice(0, 30).map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : `<p class="ok">✓ ${esc(what)} is valid.</p>`}
      ${warnings.length ? `<details class="warn-soft"><summary>${warnings.length} warning(s)</summary><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}`;
  }

  // ---------- step 1: inputs ----------

  private renderInputs(body: HTMLElement) {
    const st = this.state;
    const size = (p: string) => this.files.find((f) => f.path === p)?.size ?? 0;
    const archiveOf = (p: string) => st.archives.find((a) => p.startsWith(a.dir + "/"));
    const roleSelect = (i: InputMeta) => `<select data-role ${i.excluded ? "disabled" : ""}>${ROLES.map((r) => `<option ${r === i.role ? "selected" : ""}>${r}</option>`).join("")}</select>`;
    const note = (i: InputMeta) => `<input data-note value="${esc(i.note)}" placeholder="note" ${i.excluded ? "disabled" : ""} />`;
    const loose = st.inputs.filter((i) => !archiveOf(i.path));
    let rows = loose
      .map((i) => `<tr data-path="${esc(i.path)}"><td><code>${esc(i.path.slice("inputs/".length))}</code></td><td>${roleSelect(i)}</td><td>${note(i)}</td><td class="nowrap">${sizeText(size(i.path))}</td><td><button data-del-file title="Delete this file">✕</button></td></tr>`)
      .join("");
    for (const a of st.archives) {
      const members = st.inputs.filter((i) => i.path.startsWith(a.dir + "/"));
      const off = members.filter((i) => i.excluded).length;
      rows += `<tr class="rp-archive" data-archive="${esc(a.dir)}"><td colspan="3"><span class="badge">zip</span> <b>${esc(a.name)}</b> <span class="muted">unpacked to ${esc(a.dir)}/ · ${members.length} files${off ? `, ${off} not used` : ""}</span></td><td class="nowrap">${sizeText(members.reduce((n, i) => n + size(i.path), 0))}</td><td><button data-del-archive title="Remove the archive and all its files">✕</button></td></tr>`;
      rows += members
        .map((i) => `<tr class="rp-nested ${i.excluded ? "rp-disabled" : ""}" data-path="${esc(i.path)}"><td><code>${esc(i.path.slice(a.dir.length + 1))}</code></td><td>${roleSelect(i)}</td><td>${note(i)}</td><td class="nowrap">${sizeText(size(i.path))}</td><td>${i.excluded ? `<button data-include title="Use this file again">↺ Use</button>` : `<button data-exclude title="Don't use this file (it stays in the unpacked archive)">✕</button>`}</td></tr>`)
        .join("");
    }
    const counts = ROLES.map((r) => `${usedInputs(st, r).length} ${r}`).join(" · ");
    body.innerHTML = `
    <div class="rp-card rp-drop">
      <div class="rp-editor-head"><h3>Input files</h3><span class="muted">${counts}</span><span class="spacer"></span>
        <label class="btn primary ${this.running.has("upload") ? "disabled" : ""}">Add files…<input type="file" multiple hidden id="rp-add-files" /></label></div>
      <p class="hint">The study's data and, if available, the authors' original code. The role is guessed from the file type and can be changed; notes are passed on to the LLM and the report. Zip archives are unpacked; files inside an archive can be left out without changing the archive. You can also drop files here.</p>
      <table class="rp-table rp-inputs"><thead><tr><th>File</th><th>Role</th><th>Note</th><th>Size</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="muted">No input files yet.</td></tr>`}</tbody></table>
    </div>`;

    const card = body.querySelector<HTMLElement>(".rp-drop")!;
    body.querySelector<HTMLInputElement>("#rp-add-files")!.addEventListener("change", (e) => {
      const inp = e.target as HTMLInputElement;
      const files = Array.from(inp.files ?? []);
      inp.value = "";
      if (files.length) this.addInputs(files);
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      card.classList.add("over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("over");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) this.addInputs(files);
    });
    const meta = (el: Element) => st.inputs.find((i) => i.path === el.closest<HTMLElement>("tr[data-path]")!.dataset.path);
    body.querySelectorAll<HTMLSelectElement>("select[data-role]").forEach((sel) =>
      sel.addEventListener("change", () => {
        meta(sel)!.role = sel.value as Role;
        this.save();
        body.querySelector(".rp-editor-head .muted")!.textContent = ROLES.map((r) => `${usedInputs(st, r).length} ${r}`).join(" · ");
      }),
    );
    body.querySelectorAll<HTMLInputElement>("input[data-note]").forEach((inp) =>
      inp.addEventListener("change", () => {
        meta(inp)!.note = inp.value.trim();
        this.save();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>("[data-exclude], [data-include]").forEach((b) =>
      b.addEventListener("click", () => {
        meta(b)!.excluded = b.hasAttribute("data-exclude") || undefined;
        this.save();
        this.render();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>("[data-del-file]").forEach((b) =>
      b.addEventListener("click", async () => {
        const path = meta(b)!.path;
        if (!(await confirmDialog("Delete input file", `Delete <code>${esc(path)}</code> from the package?`, "Delete", true))) return;
        await api.reproDelete(this.doi, path);
        await this.refreshFiles();
        this.render();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>("[data-del-archive]").forEach((b) =>
      b.addEventListener("click", async () => {
        const dir = b.closest<HTMLElement>("tr")!.dataset.archive!;
        const a = st.archives.find((x) => x.dir === dir)!;
        const n = st.inputs.filter((i) => i.path.startsWith(dir + "/")).length;
        if (!(await confirmDialog("Remove archive", `Remove <b>${esc(a.name)}</b> and all ${n} files unpacked from it?`, "Remove", true))) return;
        await api.reproDelete(this.doi, dir);
        st.archives = st.archives.filter((x) => x !== a);
        await this.refreshFiles();
        this.render();
      }),
    );
  }

  private async addInputs(files: File[]) {
    await this.busy("upload", `Adding ${files.length} file(s)`, async () => {
      for (const f of files) {
        if (/\.zip$/i.test(f.name)) {
          const r = await api.reproUnzip(this.doi, f, "inputs");
          this.state.archives.push({ name: f.name, dir: r.dir });
          continue;
        }
        const name = f.name.replace(/[\\/]/g, "_");
        let path = `inputs/${name}`;
        for (let i = 2; this.files.some((x) => x.path === path); i++) path = `inputs/${name.replace(/(\.[^.]*)?$/, (ext) => `-${i}${ext}`)}`;
        await api.reproWrite(this.doi, path, new Uint8Array(await f.arrayBuffer()));
        this.files.push({ path, size: f.size, modified: Date.now(), sha256: null });
      }
      await this.refreshFiles();
    });
  }

  // ---------- entry tables (targets, plan steps) ----------

  private itemsTable<T extends { id: string }>(spec: TableSpec<T>): string {
    const items = spec.items();
    const ncol = spec.head.length + 3;
    const rows = items.map((it, i) => (it.t === "llm" ? this.groupRows(spec, it, i, items.length, ncol) : this.entryRow(spec, it, undefined, i, items.length))).join("");
    return `<table class="rp-table rp-items" data-table="${spec.key}"><thead><tr><th title="Use">Use</th><th>ID</th>${spec.head.map((h) => `<th>${h}</th>`).join("")}<th></th></tr></thead>
      <tbody>${spec.top ?? ""}${rows || `<tr><td colspan="${ncol}" class="muted">${spec.empty}</td></tr>`}${spec.bottom ?? ""}</tbody></table>`;
  }

  private entryRow<T extends { id: string }>(spec: TableSpec<T>, e: Entry<T>, group: LlmGroup<T> | undefined, i: number, n: number): string {
    const v = value(e);
    return `<tr data-uid="${e.uid}" class="${group ? "rp-nested" : ""} ${e.disabled ? "rp-disabled" : ""}">
      <td><input type="checkbox" data-act="toggle" ${e.disabled ? "" : "checked"} title="Use this ${spec.noun}" /></td>
      <td class="rp-id">${this.idCell(e)}</td>
      ${spec.cells(v, !!e.disabled).map((c) => `<td>${c}</td>`).join("")}
      <td class="nowrap rp-row-actions">${this.rowActions(e, group, i, n)}</td></tr>`;
  }

  private idCell(e: Entry<{ id: string }>) {
    return `<b>${esc(value(e).id)}</b>${e.edit ? `<br><span class="badge rp-edited" title="Changed from the LLM's extraction">edited</span>` : ""}`;
  }

  private rowActions(e: Entry<unknown>, group: LlmGroup<unknown> | undefined, i: number, n: number) {
    const moves = `<button data-act="up" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button><button data-act="down" title="Move down" ${i === n - 1 ? "disabled" : ""}>↓</button>`;
    if (group) return moves + (isModified(e) ? `<button data-act="restore" title="Restore the LLM's extraction">↺ Restore</button>` : "");
    return moves + `<button data-act="remove" title="Delete">✕</button>`;
  }

  private groupSummary<T>(spec: TableSpec<any>, g: LlmGroup<T>) {
    const off = g.entries.filter((e) => e.disabled).length;
    const edited = g.entries.filter((e) => e.edit).length;
    const c = g.call.scanned;
    const scanned = [`${c.sentences} sentences`, c.tables && `${c.tables} tables`, c.figures && `${c.figures} figures`].filter(Boolean).join(", ");
    return `${esc(new Date(g.call.at).toLocaleString())} · model ${esc(g.call.model || "default")} · scanned ${scanned} · ${g.entries.length} ${spec.noun}s${off ? `, ${off} not used` : ""}${edited ? `, ${edited} edited` : ""}`;
  }

  private groupRows<T extends { id: string }>(spec: TableSpec<T>, g: LlmGroup<T>, i: number, n: number, ncol: number): string {
    const head = `<tr class="rp-group" data-uid="${g.uid}"><td colspan="${ncol}"><div class="rp-group-head">
        <button data-act="collapse" class="rp-twisty" title="${g.collapsed ? "Expand" : "Collapse"}">${g.collapsed ? "▸" : "▾"}</button>
        <b>LLM call</b><span class="muted rp-group-sum">${this.groupSummary(spec, g)}</span><span class="spacer"></span>
        <button data-act="details">Call details</button>
        <button data-act="up" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button><button data-act="down" title="Move down" ${i === n - 1 ? "disabled" : ""}>↓</button>
        <button data-act="discard" class="danger-text">Discard…</button></div></td></tr>`;
    return head + (g.collapsed ? "" : g.entries.map((e, j) => this.entryRow(spec, e, g, j, g.entries.length)).join(""));
  }

  private bindTable<T extends { id: string }>(body: HTMLElement, spec: TableSpec<T>, after: () => void) {
    const table = body.querySelector<HTMLElement>(`table[data-table="${spec.key}"]`);
    if (!table) return;
    const locate = (el: Element) => {
      const tr = el.closest<HTMLElement>("tr[data-uid]");
      return tr ? { tr, hit: findEntry(spec.items(), tr.dataset.uid!) } : undefined;
    };
    table.addEventListener("change", (ev) => {
      const el = ev.target as HTMLInputElement;
      const at = locate(el);
      const e = at?.hit?.entry;
      if (!at || !e) return;
      if (el.dataset.act === "toggle") {
        e.disabled = !el.checked || undefined;
        this.save();
        return this.render();
      }
      const f = el.dataset.f;
      if (!f) return;
      setField(e, f as keyof T, spec.parse(f, el.value.trim(), value(e)) as T[keyof T]);
      this.save();
      // Update markers in place so the next field the user clicked keeps focus.
      at.tr.querySelector(".rp-id")!.innerHTML = this.idCell(e);
      const list = at.hit!.list as unknown[];
      at.tr.querySelector(".rp-row-actions")!.innerHTML = this.rowActions(e, at.hit!.group, list.indexOf(e), list.length);
      const g = at.hit!.group;
      if (g) table.querySelector(`tr[data-uid="${g.uid}"] .rp-group-sum`)!.innerHTML = this.groupSummary(spec, g);
      after();
    });
    table.addEventListener("click", async (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
      const at = b && locate(b);
      if (!b || !at?.hit) return;
      const { entry, group, list } = at.hit;
      const act = b.dataset.act;
      const target = (entry ?? group)!;
      if (act === "up" || act === "down") move(list as unknown[], (list as unknown[]).indexOf(target), act === "up" ? -1 : 1);
      if (act === "restore" && entry) restore(entry);
      if (act === "remove" && entry) {
        if (!(await confirmDialog(`Delete ${spec.noun}`, `Delete <b>${esc(value(entry).id)}</b>?`, "Delete", true))) return;
        (list as unknown[]).splice((list as unknown[]).indexOf(entry), 1);
      }
      if (group && !entry) {
        if (act === "collapse") group.collapsed = !group.collapsed || undefined;
        if (act === "details") return void callDetailsDialog(`LLM call · ${spec.noun}s`, group.call);
        if (act === "discard") {
          const edited = group.entries.filter((e) => isModified(e)).length;
          const ok = await confirmDialog(
            "Discard LLM call",
            `Remove this LLM call and all ${group.entries.length} ${spec.noun}s extracted by it${edited ? `, including your changes to ${edited} of them` : ""}? This can't be undone.`,
            "Discard",
            true,
          );
          if (!ok) return;
          (list as unknown[]).splice((list as unknown[]).indexOf(group), 1);
        }
      }
      this.save();
      this.render();
    });
  }

  private async addEntry<T extends { id: string }>(items: Item<T>[], v: T | undefined) {
    if (!v) return;
    items.push({ t: "row", uid: uid(), base: v, manual: true });
    if (v && (v as any).source_ids?.length) this.state.source = this.ctx.refName();
    this.save();
    this.render();
  }

  /** Run a prompt chosen in the LLM dialog and add its extractions as one group. */
  private async runLlm<T>(key: string, label: string, items: Item<T>[], choice: LlmChoice, scanned: LlmCall["scanned"], toEntries: (output: string) => T[]) {
    await this.busy(key, label, async () => {
      const t0 = Date.now();
      const output = await api.claudePrompt(this.doi, choice.prompt, { model: choice.model });
      const values = toEntries(output);
      const call: LlmCall = {
        at: new Date().toISOString(), argv: choice.argv, model: modelOf(choice.argv), instructions: choice.instructions,
        prompt: choice.prompt, output, duration_ms: Date.now() - t0, scanned,
      };
      items.push({ t: "llm", uid: uid(), call, entries: values.map((base) => ({ t: "row", uid: uid(), base })) });
      this.state.source = this.ctx.refName();
      this.save();
    });
  }

  private withInstructions = (prompt: string, instructions: string) => (instructions ? `${prompt}\nAdditional instructions:\n${instructions}\n` : prompt);

  // ---------- step 2: targets ----------

  private targetSpec(): TableSpec<TargetResult> {
    return {
      key: "targets",
      noun: "target",
      items: () => this.state.targets,
      head: ["Type", "Description / quote", "Expected", "Cmp", "dp", "Unit"],
      empty: "No targets yet. Generate them with the LLM or add them by hand.",
      cells: (r, dis) => {
        const d = dis ? "disabled" : "";
        const exp = r.type === "table" ? `<span class="muted">${(r.expected as string[][])?.length ?? 0}×${(r.expected as string[][])?.[0]?.length ?? 0} table</span>` : r.type === "figure" ? `<span class="muted">figure</span>` : `<input data-f="expected" value="${esc(r.expected)}" size="8" ${d} />`;
        return [
          `<span class="badge">${r.type}</span>`,
          `<textarea data-f="description" rows="2" ${d}>${esc(r.description)}</textarea>${r.quote ? `<div class="quote">“${esc(trunc(r.quote, 220))}” <span class="muted">— ${esc(r.source_label ?? "")}${r.source_ids.length ? ` (${r.source_ids.length} ref${r.source_ids.length > 1 ? "s" : ""})` : ""}</span></div>` : ""}`,
          exp,
          r.type === "number" ? `<select data-f="comparator" ${d}>${COMPARATORS.map((c) => `<option ${(r.comparator ?? "=") === c ? "selected" : ""}>${c}</option>`).join("")}</select>` : "",
          r.type === "number" ? `<input data-f="decimals" value="${r.decimals ?? ""}" size="2" title="decimals as reported" ${d} />` : "",
          r.type === "number" ? `<input data-f="unit" value="${esc(r.unit ?? "")}" size="4" ${d} />` : "",
        ];
      },
      parse: (f, v, r) => {
        if (f === "expected") return r.type === "number" && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
        if (f === "decimals") return v === "" ? undefined : Math.max(0, parseInt(v, 10) || 0);
        if (f === "comparator") return v === "=" ? undefined : v;
        if (f === "unit") return v || undefined;
        return v;
      },
    };
  }

  private renderTargets(body: HTMLElement) {
    const model = this.ctx.model();
    const schema = this.schema();
    const spec = this.targetSpec();
    const generating = this.running.has("llm-targets");
    body.innerHTML = `
    <div class="rp-card">
      <div class="rp-editor-head"><h3>Reproduction targets</h3><span class="spacer"></span>
        <button id="rp-add-row">+ Add target…</button>
        <button id="rp-llm" class="primary" ${generating || !model ? "disabled" : ""} title="${model ? "" : "Needs a structured reference text (Reader)"}">${generating ? "Generating…" : "Generate with LLM…"}</button></div>
      ${this.sourceWarning()}
      <p class="hint">The reported results the reproduction should recompute. Rows from an LLM call are grouped under it; your changes are kept on top of the LLM's extraction and can be restored. Unticked rows are not used.</p>
      <div id="rp-valid">${schema ? this.validationBox(validateResultsSchema(schema), [], "Results schema") : ""}</div>
      ${this.itemsTable(spec)}
    </div>`;
    this.bindTable(body, spec, () => {
      const s = this.schema();
      body.querySelector("#rp-valid")!.innerHTML = s ? this.validationBox(validateResultsSchema(s), [], "Results schema") : "";
    });
    body.querySelector("#rp-add-row")!.addEventListener("click", async () => {
      const id = `R${String(nextNumber(this.state.targets, "R")).padStart(3, "0")}`;
      this.addEntry(this.state.targets, await addTargetDialog(model, id));
    });
    body.querySelector("#rp-llm")!.addEventListener("click", () => this.generateTargets(model!));
  }

  private async generateTargets(model: DocModel) {
    const choice = await llmDialog({
      title: "Generate targets with LLM",
      intro: "The LLM reads the marked sentences and tables and returns one target per reported result. Marked figures are added as figure targets directly.",
      model,
      floats: true,
      presets: TARGET_PRESETS,
      initial: this.state.targetSel,
      buildPrompt: (ids, instr) => {
        const { sentences, blocks } = indexDoc(model);
        return this.withInstructions(resultsPrompt(model, ids.filter((id) => sentences.has(id)), ids.filter((id) => blocks.get(id)?.block.kind === "table")), instr);
      },
      command: (m) => api.llmCommand(this.doi, "prompt", { model: m }),
    });
    if (!choice) return;
    this.state.targetSel = choice.ids;
    const { blocks } = indexDoc(model);
    const figIds = choice.ids.filter((id) => blocks.get(id)?.block.kind === "figure");
    const haveFig = new Set(allEntries(this.state.targets).filter((e) => e.base.type === "figure").flatMap((e) => e.base.source_ids));
    const scanned = scannedCounts(model, choice.ids);
    const start = nextNumber(this.state.targets, "R") - 1;
    if (!scanned.sentences && !scanned.tables) {
      // Only figures: nothing for the LLM to read.
      for (const f of figureTargets(model, figIds.filter((id) => !haveFig.has(id)), start)) this.state.targets.push({ t: "row", uid: uid(), base: f, manual: true });
      this.save();
      return this.render();
    }
    await this.runLlm("llm-targets", "Generating targets", this.state.targets, choice, scanned, (out) => {
      const found = toTargets(extractJson(out), model, start);
      return [...found, ...figureTargets(model, figIds.filter((id) => !haveFig.has(id)), start + found.length)];
    });
  }

  // ---------- step 3: analysis plan ----------

  private stepSpec(plan: AnalysisPlan | undefined): TableSpec<StepDraft> {
    const fixed = (s: AnalysisPlan["steps"][number], note: string) =>
      `<tr class="rp-fixed"><td title="Added automatically">🔒</td><td><b>${s.id}</b></td><td><span class="badge">${s.kind}</span></td><td>${esc(s.summary)} <span class="muted">${note}</span></td><td>${s.inputs.map((p) => `<code>${esc(p)}</code>`).join(" ")}</td><td>${esc(s.depends_on.join(", "))}</td><td>${s.kind === "results" ? `<span class="muted">all targets</span>` : ""}</td><td></td></tr>`;
    const loads = plan?.steps.filter((s) => s.kind === "load") ?? [];
    const out = plan?.steps.find((s) => s.kind === "results");
    return {
      key: "steps",
      noun: "step",
      items: () => this.state.steps,
      head: ["Kind", "Summary / quote", "Inputs", "Depends on", "Produces"],
      empty: "No steps yet. Generate them with the LLM or add them by hand.",
      top: loads.map((s) => fixed(s, "(one per data file of step 1)")).join(""),
      bottom: out ? fixed(out, "") : "",
      cells: (s, dis) => {
        const d = dis ? "disabled" : "";
        return [
          `<select data-f="kind" ${d}>${["analysis", "transform"].map((k) => `<option ${s.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select>`,
          `<textarea data-f="summary" rows="2" ${d}>${esc(s.summary)}</textarea>${s.quote ? `<div class="quote">“${esc(trunc(s.quote, 220))}”</div>` : ""}`,
          `<input data-f="inputs" value="${esc(s.inputs.join(", "))}" ${d} title="data files, comma-separated" />`,
          `<input data-f="depends_on" value="${esc(s.depends_on.join(", "))}" size="8" ${d} title="step ids, comma-separated" />`,
          `<input data-f="produces" value="${esc(s.produces.join(", "))}" size="10" ${d} title="target ids, comma-separated" />`,
        ];
      },
      parse: (f, v) => (f === "inputs" || f === "depends_on" || f === "produces" ? list(v) : v),
    };
  }

  private renderPlan(body: HTMLElement) {
    const st = this.state;
    const model = this.ctx.model();
    const plan = this.plan();
    const spec = this.stepSpec(plan);
    const generating = this.running.has("llm-plan");
    const warnings = [
      !usedInputs(st, "data").length && "No data files in step 1; load steps are generated from them.",
      !this.schema()?.results.length && "No targets yet (step 2); steps can't be linked to target ids.",
    ].filter(Boolean) as string[];
    body.innerHTML = `
    <div class="rp-card">
      <div class="rp-editor-head"><h3>Analysis plan</h3><span class="spacer"></span>
        <button id="rp-add-row">+ Add step…</button>
        <button id="rp-llm" class="primary" ${generating || !model ? "disabled" : ""} title="${model ? "" : "Needs a structured reference text (Reader)"}">${generating ? "Generating…" : "Generate with LLM…"}</button></div>
      ${this.sourceWarning()}
      ${warnings.map((w) => `<p class="warn-soft">${esc(w)}</p>`).join("")}
      <p class="hint">Load steps (one per data file) always come first and the results step last; the steps in between run in table order. Rows from an LLM call are grouped under it; your changes are kept on top of the LLM's extraction and can be restored.</p>
      <div id="rp-valid">${plan ? this.validationBox(validatePlan(plan), [], "Analysis plan") : ""}</div>
      ${this.itemsTable(spec)}
    </div>`;
    this.bindTable(body, spec, () => {
      const p = this.plan();
      body.querySelector("#rp-valid")!.innerHTML = p ? this.validationBox(validatePlan(p), [], "Analysis plan") : "";
    });
    body.querySelector("#rp-add-row")!.addEventListener("click", async () => {
      const id = `S${String(nextNumber(st.steps, "S")).padStart(2, "0")}`;
      const draft = await addStepDialog(model, id, {
        dataInputs: usedInputs(st, "data").map((i) => i.path),
        steps: allEntries(st.steps).filter((e) => !e.disabled).map((e) => ({ id: value(e).id, summary: value(e).summary })),
        targets: (this.schema()?.results ?? []).map((r) => ({ id: r.id, description: r.description })),
      });
      this.addEntry(st.steps, draft);
    });
    body.querySelector("#rp-llm")!.addEventListener("click", () => this.generateSteps(model!));
  }

  private async generateSteps(model: DocModel) {
    const st = this.state;
    const promptInputs = (role: Role) => usedInputs(st, role).map((i) => ({ path: i.path, note: i.note }));
    const choice = await llmDialog({
      title: "Generate analysis steps with LLM",
      intro: "The LLM turns the marked methods text into ordered analysis steps, linked to the data files and target ids.",
      model,
      floats: false,
      presets: PLAN_PRESETS,
      initial: st.planSel,
      buildPrompt: (ids, instr) => this.withInstructions(planPrompt(model, ids, promptInputs("data"), promptInputs("code"), this.schema()), instr),
      command: (m) => api.llmCommand(this.doi, "prompt", { model: m }),
    });
    if (!choice) return;
    st.planSel = choice.ids;
    const start = nextNumber(st.steps, "S");
    await this.runLlm("llm-plan", "Generating analysis steps", st.steps, choice, scannedCounts(model, choice.ids), (out) =>
      toStepDrafts(extractJson(out), usedInputs(st, "data").map((i) => i.path), start),
    );
  }

  // ---------- step 4: master script ----------

  private scriptFor(t: TemplateId) {
    const plan = this.plan() ?? { schema_version: "1.0" as const, steps: [] };
    return masterScript(t, plan, this.schema(), this.ctx.meta()?.title ?? this.doi);
  }

  private renderScript(body: HTMLElement) {
    const st = this.state;
    if (!st.scriptDirty) st.script = this.scriptFor(st.template);
    const schema = this.schema();
    const plan = this.plan();
    const issues = [
      !schema?.results.length && "no targets (step 2)",
      !plan && "no analysis plan (step 3)",
      schema && validateResultsSchema(schema).length && "results schema is not valid",
      plan && validatePlan(plan).length && "analysis plan is not valid",
    ].filter(Boolean) as string[];
    const todo = (st.script.match(/TODO\(LLM\)/g) ?? []).length;

    body.innerHTML = `
    <div class="rp-cols rp-cols-script">
      <section class="rp-card">
        <h3>Template</h3>
        <div class="rp-templates">${(Object.keys(TEMPLATES) as TemplateId[])
          .map((t) => `<label class="rp-tpl ${t === st.template ? "on" : ""}"><input type="radio" name="tpl" value="${t}" ${t === st.template ? "checked" : ""}/> <b>${TEMPLATES[t].label}</b><br><code>${TEMPLATES[t].script}</code></label>`)
          .join("")}</div>
        <h3>Package</h3>
        ${issues.length ? `<div class="warn">⚠ ${issues.map(esc).join("<br>⚠ ")}</div>` : ""}
        <p>Folder: <code class="path">${esc(this.folder)}</code> <button id="rp-copy-path">Copy</button></p>
        <p class="hint">Creating the package writes the files below and commits them to a git repository in the folder (initialized on first use), so later changes, e.g. by the code generation, can be tracked.</p>
        <div class="actions"><button id="rp-package" class="primary" ${this.running.has("package") ? "disabled" : ""}>${st.packaged ? "Update package" : "OK — create package"}</button></div>
        ${st.packaged ? `<p class="ok">✓ Package ${st.packaged.commit ? "committed" : "created"} ${esc(new Date(st.packaged.at).toLocaleString())} (${TEMPLATES[st.packaged.template].label})${st.packaged.commit ? `<br><code>${esc(st.packaged.commit)}</code>` : ""}</p>` : ""}
        ${this.files.length ? `<details ${st.packaged ? "open" : ""}><summary>${this.files.length} files</summary><pre class="rp-tree-txt">${esc(this.files.map((f) => f.path).join("\n"))}</pre></details>` : ""}
      </section>
      <section class="rp-card rp-editor">
        <div class="rp-editor-head"><h3>${esc(TEMPLATES[st.template].script)}</h3><span class="badge">${todo} × ${TODO_MARK}</span>${st.scriptDirty ? `<span class="muted">edited</span>` : ""}<span class="spacer"></span><button id="rp-regen">Regenerate from plan</button></div>
        <textarea id="rp-script" spellcheck="false">${esc(st.script)}</textarea>
      </section>
    </div>`;

    body.querySelectorAll<HTMLInputElement>("input[name=tpl]").forEach((r) =>
      r.addEventListener("change", async () => {
        if (st.scriptDirty && !(await confirmDialog("Switch template", "Switching template regenerates the script and discards your edits.", "Switch", true))) return this.render();
        st.template = r.value as TemplateId;
        st.script = this.scriptFor(st.template);
        st.scriptDirty = false;
        st.command = TEMPLATES[st.template].command;
        this.save();
        this.render();
      }),
    );
    body.querySelector("#rp-regen")!.addEventListener("click", async () => {
      if (st.scriptDirty && !(await confirmDialog("Regenerate script", "Discard your edits and regenerate from the plan?", "Regenerate", true))) return;
      st.script = this.scriptFor(st.template);
      st.scriptDirty = false;
      this.save();
      this.render();
    });
    body.querySelector("#rp-script")!.addEventListener("input", (e) => {
      st.script = (e.target as HTMLTextAreaElement).value;
      st.scriptDirty = true;
      this.save();
    });
    body.querySelector("#rp-copy-path")!.addEventListener("click", () => navigator.clipboard.writeText(this.folder).then(() => this.setStatus("Path copied")));
    body.querySelector("#rp-package")!.addEventListener("click", () => this.createPackage());
  }

  private async createPackage() {
    const st = this.state;
    const schema = this.schema();
    const plan = this.plan();
    if (!schema?.results.length || !plan) return this.showError("Create package", "Targets (step 2) and an analysis plan (step 3) are required.");
    const errs = [...validateResultsSchema(schema), ...validatePlan(plan)];
    if (errs.length && !(await confirmDialog("Validation problems", `The schemas have ${errs.length} validation problem(s):<ul>${errs.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>Create the package anyway?`, "Create anyway"))) return;
    const scriptPath = TEMPLATES[st.template].script;
    let writeScript = true;
    if (this.files.some((f) => f.path === scriptPath)) {
      const cur = await api.reproReadText(this.doi, scriptPath);
      if (cur !== st.script && !cur.includes(TODO_MARK))
        writeScript = await confirmDialog("Overwrite script?", `<code>${esc(scriptPath)}</code> in the folder already contains generated code. Overwrite it with the placeholder script? (Its current version stays in the git history.)`, "Overwrite", true);
    }
    await this.busy("package", writeScript ? "Creating package" : "Updating package (keeping script)", () => this.writePackage(writeScript));
  }

  private async writePackage(writeScript: boolean) {
    const st = this.state;
    const doi = this.doi;
    const title = this.ctx.meta()?.title ?? doi;
    const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
    await this.cropFigures();
    const first = !st.packaged;
    await api.reproWrite(doi, "results_schema.json", json(this.schema()));
    await api.reproWrite(doi, "analysis_plan.json", json(this.plan()));
    await api.reproWrite(doi, "inputs.json", json(inputsManifest(st)));
    await api.reproWrite(doi, "schemas/results_schema.schema.json", json(RESULTS_SCHEMA_JSON_SCHEMA));
    await api.reproWrite(doi, "schemas/analysis_plan.schema.json", json(PLAN_JSON_SCHEMA));
    await api.reproWrite(doi, "schemas/results_output.schema.json", json(RESULTS_OUTPUT_JSON_SCHEMA));
    if (writeScript) await api.reproWrite(doi, TEMPLATES[st.template].script, st.script);
    await api.reproWrite(doi, "AGENT_PROMPT.md", this.prompt());
    await api.reproWrite(doi, "README.md", packageReadme(st.template, title, doi));
    await api.reproWrite(doi, "outputs/figures/.keep", "");
    const git = await api.reproGit(doi, first ? "Create reproduction package" : "Update reproduction package");
    st.packaged = { template: st.template, at: new Date().toISOString(), commit: git.committed ? git.head : st.packaged?.commit };
    st.command ||= TEMPLATES[st.template].command;
    this.save();
    await this.refreshFiles();
  }

  /** Save crops of the original figures into targets/figures/<id>.png. */
  private async cropFigures() {
    const model = this.ctx.model();
    const figs = this.schema()?.results.filter((r) => r.type === "figure") ?? [];
    if (!model || !figs.length || !this.ctx.pdf.loaded) return;
    const { blocks } = indexDoc(model);
    for (const r of figs) {
      const b = blocks.get(r.source_ids[0])?.block;
      if (!b) continue;
      let page: number | undefined;
      if (!b.boxes?.length) page = (await this.ctx.pdf.findText(r.quote.slice(0, 120)))?.[0]?.page;
      const blob = await this.ctx.pdf.renderRegion(b.boxes, page);
      if (!blob) continue;
      const path = `targets/figures/${r.id}.png`;
      await api.reproWrite(this.doi, path, new Uint8Array(await blob.arrayBuffer()));
      this.state.figureFiles[r.id] = path;
    }
  }

  private prompt() {
    return agentPrompt(this.state.template, { folder: this.folder, inputs: this.state.inputs });
  }

  // ---------- step 5: code generation ----------

  private renderCodegen(body: HTMLElement) {
    const st = this.state;
    const gen = this.running.has("codegen");
    body.innerHTML = `
    <div class="rp-card">
      <h3>Generate the code</h3>
      ${!st.packaged ? `<p class="warn">Create the package in step 4 first.</p>` : ""}
      <div class="rp-gen-row">
        <div><b>Headless LLM agent</b><div class="hint">Runs without interaction in the package folder and implements the ${TODO_MARK} markers itself. Progress appears below; the result is committed to the package's git repository.</div></div>
        <button id="rp-gen" class="primary" ${gen || !st.packaged ? "disabled" : ""}>${gen ? "Generating…" : "Run headless…"}</button>
        <button id="rp-gen-stop" ${gen ? "" : "disabled"}>Stop</button>
      </div>
      <div class="rp-gen-row">
        <div><b>Your own editor</b><div class="hint">Opens the package folder in your code editor (set in ⚙ Settings, otherwise the first one found). The suggested prompt tells an agent what to implement.</div></div>
        <button id="rp-editor" ${st.packaged ? "" : "disabled"}>Open in external editor</button>
        <button id="rp-copy-prompt" ${st.packaged ? "" : "disabled"}>Copy suggested prompt</button>
      </div>
      ${st.lastCodegen ? `<p class="muted">Last headless run: exit ${st.lastCodegen.code}, ${(st.lastCodegen.duration_ms / 1000).toFixed(0)} s, ${esc(new Date(st.lastCodegen.at).toLocaleString())}${st.lastCodegen.commit ? ` · <code>${esc(st.lastCodegen.commit)}</code>` : ""}</p>` : ""}
    </div>
    <div class="rp-card">
      <div class="rp-editor-head"><h3>Folder status</h3><span class="spacer"></span><button id="rp-refresh">↻ Refresh</button></div>
      <p id="rp-gen-summary" class="muted">Loading…</p>
      <h4 id="rp-events-head" hidden>Agent activity</h4>
      <ul id="rp-events" class="rp-events" hidden></ul>
      <h4>Files (most recently modified first)</h4>
      <div id="rp-gen-files"></div>
    </div>`;
    body.querySelector("#rp-gen")!.addEventListener("click", () => this.generate());
    body.querySelector("#rp-gen-stop")!.addEventListener("click", () => api.stopTask("codegen"));
    body.querySelector("#rp-editor")!.addEventListener("click", async () => {
      try {
        await api.reproWrite(this.doi, "AGENT_PROMPT.md", this.prompt());
        const name = await api.openInEditor(this.doi);
        this.setStatus(`Opened the package folder in ${name}`);
      } catch (e) {
        this.showError("Open in external editor", String(e));
      }
    });
    const copyBtn = body.querySelector<HTMLButtonElement>("#rp-copy-prompt")!;
    copyBtn.addEventListener("click", async () => {
      const prompt = this.prompt();
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        // Clipboard refused (e.g. no user activation): let the user copy it by hand.
        const dlg = modal("rp-llm rp-agent", `<h3>Suggested prompt</h3><p class="hint">Copying to the clipboard failed; the prompt is selected below, press Ctrl+C.</p><textarea class="mono rp-prompt" readonly>${esc(prompt)}</textarea><form method="dialog"><menu><button class="primary">Close</button></menu></form>`);
        dlg.querySelector("textarea")!.select();
        return;
      }
      this.setStatus("Suggested prompt copied to the clipboard; paste it into the agent in your editor.");
      copyBtn.textContent = "✓ Suggested prompt copied";
      setTimeout(() => (copyBtn.textContent = "Copy suggested prompt"), 3000);
    });
    body.querySelector("#rp-refresh")!.addEventListener("click", async () => {
      await this.refreshFiles();
      await this.updateCodegenStatus();
    });
    this.updateCodegenStatus();
  }

  private async generate() {
    const st = this.state;
    const prompt = this.prompt();
    const choice = await agentDialog({ prompt, allowExec: st.allowExec, command: (m, exec) => api.llmCommand(this.doi, "codegen", { model: m, allowExec: exec }) });
    if (!choice) return;
    st.allowExec = choice.allowExec;
    this.save();
    await api.reproWrite(this.doi, "AGENT_PROMPT.md", prompt);
    const r = await this.busy("codegen", "Generating code with the LLM agent", () => api.claudeCodegen(this.doi, prompt, choice.allowExec, { model: choice.model }));
    if (r) {
      const git = await api.reproGit(this.doi, `Code generated by the headless LLM agent (exit ${r.code})`).catch(() => undefined);
      st.lastCodegen = { code: r.code, duration_ms: r.duration_ms, at: new Date().toISOString(), commit: git ? (git.committed ? git.head : "no changes to commit") : undefined };
    }
    this.save();
    await this.refreshFiles();
    if (st.step === STEP.codegen) this.render();
  }

  private async updateCodegenStatus() {
    const summary = this.root.querySelector("#rp-gen-summary");
    if (!summary) return;
    const scriptPath = TEMPLATES[this.state.template].script;
    let todo: string;
    try {
      const script = await api.reproReadText(this.doi, scriptPath);
      const n = (script.match(/TODO\(LLM\)/g) ?? []).length;
      todo = n ? `<span class="warn-inline">${n} × ${TODO_MARK} remaining</span>` : `<span class="ok">✓ no ${TODO_MARK} markers left</span>`;
    } catch {
      todo = `<span class="warn-inline">${esc(scriptPath)} not found</span>`;
    }
    summary.className = "";
    summary.innerHTML = `<b>${esc(scriptPath)}</b>: ${todo}${this.running.has("codegen") ? ` · <span class="pulse">the agent is working…</span>` : ""}`;
    this.appendEvents(await this.codegenEvents());
    const now = Date.now();
    const age = (t: number) => { const s = (now - t) / 1000; return s < 60 ? `${s.toFixed(0)} s ago` : s < 3600 ? `${(s / 60).toFixed(0)} min ago` : new Date(t).toLocaleString(); };
    const recent = [...this.files].sort((a, b) => b.modified - a.modified);
    this.root.querySelector("#rp-gen-files")!.innerHTML = `<table class="rp-table"><tr><th>Path</th><th>Size</th><th>Modified</th></tr>${recent.map((f) => `<tr class="${now - f.modified < 60000 ? "fresh" : ""}"><td><code>${esc(f.path)}</code></td><td>${(f.size / 1024).toFixed(1)} KB</td><td>${age(f.modified)}</td></tr>`).join("")}</table>`;
  }

  /**
   * Append only new activity lines, so the list keeps its scroll position. It follows new messages while
   * scrolled to the end; scrolled up, it stays where it is.
   */
  private appendEvents(events: string[]) {
    const ul = this.root.querySelector<HTMLUListElement>("#rp-events");
    if (!ul) return;
    ul.hidden = !events.length;
    this.root.querySelector<HTMLElement>("#rp-events-head")!.hidden = !events.length;
    const atEnd = nearEnd(ul);
    if (events.length < ul.children.length) ul.replaceChildren(); // a new run replaced the log
    const fresh = ul.children.length === 0;
    for (const text of events.slice(ul.children.length)) {
      const li = document.createElement("li");
      li.textContent = text;
      ul.append(li);
    }
    if (fresh) {
      const keep = this.eventsKeep;
      this.eventsKeep = undefined;
      ul.scrollTop = !keep || keep.atEnd ? ul.scrollHeight : keep.top;
    } else if (atEnd) ul.scrollTop = ul.scrollHeight;
  }

  private async codegenEvents(): Promise<string[]> {
    let text = "";
    try {
      text = await api.reproReadText(this.doi, ".metareader/codegen.jsonl");
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "system" && ev.subtype === "init") out.push(`▶ started (${ev.model ?? "default model"})`);
        if (ev.type === "assistant")
          for (const c of ev.message?.content ?? []) {
            if (c.type === "tool_use") out.push(`🔧 ${c.name} ${c.input?.file_path ?? c.input?.command ?? c.input?.pattern ?? ""}`.trim());
            if (c.type === "text" && c.text?.trim()) out.push(`💬 ${trunc(c.text.trim().replace(/\s+/g, " "), 300)}`);
          }
        if (ev.type === "result") out.push(`${ev.is_error ? "✗" : "✓"} finished: ${trunc(String(ev.result ?? "").replace(/\s+/g, " "), 300)}`);
      } catch {
        out.push(trunc(line, 200));
      }
    }
    return out;
  }

  // ---------- step 6: run & compare ----------

  private renderRun(body: HTMLElement) {
    const st = this.state;
    st.command ||= TEMPLATES[st.template].command;
    const running = this.running.has("run");
    const cs = st.compare;
    body.innerHTML = `
    <div class="rp-card">
      <h3>Full run</h3>
      <div class="actions rp-cmd">
        <code class="muted">${esc(this.folder)} $</code>
        <input id="rp-cmd" class="mono" value="${esc(st.command)}" />
        <button id="rp-run" class="primary" ${running ? "disabled" : ""}>${running ? "Running…" : "Run"}</button>
        <button id="rp-stop" ${running ? "" : "disabled"}>Stop</button>
        <button id="rp-cmd-reset" title="Reset to template default">↺</button>
      </div>
      ${st.lastRun ? `<p class="${st.lastRun.code === 0 ? "ok" : "warn-inline"}">Last run: exit code ${st.lastRun.code}, ${(st.lastRun.duration_ms / 1000).toFixed(1)} s, ${esc(new Date(st.lastRun.at).toLocaleString())}</p>` : ""}
      <details ${running || st.lastRun?.code ? "open" : ""}><summary>Run log (outputs/run.log)</summary><pre id="rp-log" class="rp-log">…</pre></details>
    </div>
    <div class="rp-card">
      <div class="rp-editor-head"><h3>Comparison</h3><span class="spacer"></span>
        <label>Rounding <select id="rp-round"><option value="reported" ${cs.rounding === "reported" ? "selected" : ""}>as reported</option>${[0, 1, 2, 3, 4, 5, 6].map((d) => `<option value="${d}" ${cs.rounding === d ? "selected" : ""}>${d} decimals</option>`).join("")}</select></label>
        <label>Flag deviation &gt; <input id="rp-thr" type="number" min="0" step="0.5" value="${cs.threshold}" style="width:5em" /> %</label>
        <button id="rp-load" class="primary">Load reproduced results</button>
      </div>
      <div id="rp-compare">${this.compareHtml()}</div>
    </div>`;

    body.querySelector("#rp-cmd")!.addEventListener("change", (e) => {
      st.command = (e.target as HTMLInputElement).value;
      this.save();
    });
    body.querySelector("#rp-cmd-reset")!.addEventListener("click", () => {
      st.command = TEMPLATES[st.template].command;
      this.save();
      this.render();
    });
    body.querySelector("#rp-run")!.addEventListener("click", () => this.runPipeline());
    body.querySelector("#rp-stop")!.addEventListener("click", () => api.stopTask("run"));
    body.querySelector("#rp-load")!.addEventListener("click", () => this.loadOutput());
    body.querySelector("#rp-round")!.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      cs.rounding = v === "reported" ? "reported" : Number(v);
      this.recompare();
    });
    body.querySelector("#rp-thr")!.addEventListener("change", (e) => {
      cs.threshold = Math.max(0, Number((e.target as HTMLInputElement).value) || 0);
      this.recompare();
    });
    this.updateRunLog();
    this.loadFigureImages();
  }

  private async runPipeline() {
    const cmd = (this.root.querySelector("#rp-cmd") as HTMLInputElement).value.trim();
    this.state.command = cmd;
    const r: RunResult | undefined = await this.busy("run", `Running ${cmd}`, () => api.reproRun(this.doi, cmd));
    if (r) {
      this.state.lastRun = { code: r.code, duration_ms: r.duration_ms, at: new Date().toISOString() };
      this.save();
      await this.refreshFiles();
      if (r.code === 0 && this.files.some((f) => f.path === "outputs/results.json")) await this.loadOutput();
      else this.render();
    }
  }

  /** Same scrolling rule as the agent activity: follow the end of the log unless scrolled up. */
  private async updateRunLog() {
    const el = this.root.querySelector("#rp-log");
    if (!el) return;
    const atEnd = el.textContent === "…" || nearEnd(el);
    try {
      const lines = (await api.reproReadText(this.doi, "outputs/run.log")).split("\n");
      el.textContent = (lines.length > 300 ? `… (${lines.length - 300} earlier lines)\n` : "") + lines.slice(-300).join("\n");
      if (atEnd) el.scrollTop = el.scrollHeight;
    } catch {
      el.textContent = "(no run yet)";
    }
  }

  private async loadOutput() {
    const schema = this.schema();
    if (!schema) return this.showError("Load results", "No targets.");
    try {
      const raw = JSON.parse(await api.reproReadText(this.doi, "outputs/results.json"));
      const v = validateOutput(raw, schema);
      this.outputCheck = { errors: v.errors, warnings: v.warnings };
      this.output = v.output;
      this.setStatus(v.errors.length ? `Loaded results — ${v.errors.length} schema problem(s)` : "Loaded reproduced results", v.errors.length ? "error" : "info");
    } catch (e) {
      this.output = undefined;
      this.outputCheck = { errors: [`Could not read outputs/results.json: ${e}`], warnings: [] };
    }
    this.recompare();
  }

  private recompare() {
    this.save();
    const schema = this.schema();
    if (schema && this.output) this.rows = compareAll(schema, this.output, this.state.compare);
    const el = this.root.querySelector("#rp-compare");
    if (el) {
      el.innerHTML = this.compareHtml();
      this.loadFigureImages();
    }
  }

  private compareHtml(): string {
    if (!this.outputCheck) return `<p class="hint">Run the pipeline, then load <code>outputs/results.json</code>.</p>`;
    const head = this.validationBox(this.outputCheck.errors, this.outputCheck.warnings, "outputs/results.json");
    if (!this.rows) return head;
    const counts = this.rows.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
    const summary = `<p class="rp-summary">${Object.entries(counts).map(([k, v]) => `<span class="st st-${k}">${STATUS_LABEL[k as keyof typeof STATUS_LABEL]}: ${v}</span>`).join(" ")}</p>`;
    const rows = this.rows
      .map((r) => {
        const main = `<tr><td><b>${r.target.id}</b></td><td>${esc(r.target.description)}<div class="quote">“${esc(trunc(r.target.quote, 160))}”</div></td><td class="nowrap">${esc(r.expectedText)}</td><td class="nowrap">${esc(r.reproducedText)}${r.out?.note ? `<div class="muted">${esc(r.out.note)}</div>` : ""}</td><td>${r.deviation !== undefined && Number.isFinite(r.deviation) ? r.deviation.toFixed(2) + "%" : ""}</td><td class="st st-${r.status}">${STATUS_LABEL[r.status]}</td></tr>`;
        if (r.target.type === "figure")
          return main + `<tr><td></td><td colspan="5"><div class="rp-figs"><figure><figcaption>Original</figcaption><img data-fig-orig="${esc(r.target.figure_file ?? "")}" alt="(no crop)"/></figure><figure><figcaption>Reproduced</figcaption><img data-fig-rep="${esc(r.out?.file ?? "")}" alt="(not produced)"/></figure></div></td></tr>`;
        if (r.cells)
          return main + `<tr><td></td><td colspan="5"><details><summary>Cells (${r.matched}/${r.total})</summary><div class="tbl-wrap"><table class="rp-cells">${r.cells.map((row) => `<tr>${row.map((c) => `<td class="st-${c.status}" title="expected ${esc(c.expected)}${c.deviation !== undefined ? ` · dev ${c.deviation.toFixed(2)}%` : ""}">${esc(c.reproduced)}<br><small>${esc(c.expected)}</small></td>`).join("")}</tr>`).join("")}</table></div></details></td></tr>`;
        return main;
      })
      .join("");
    return head + summary + `<table class="rp-table"><tr><th>ID</th><th>Result</th><th>Reported</th><th>Reproduced</th><th>Dev.</th><th>Status</th></tr>${rows}</table>`;
  }

  private async loadFigureImages() {
    this.blobUrls.forEach(URL.revokeObjectURL);
    this.blobUrls = [];
    for (const img of this.root.querySelectorAll<HTMLImageElement>("img[data-fig-orig], img[data-fig-rep]")) {
      const path = img.dataset.figOrig ?? img.dataset.figRep;
      if (!path) continue;
      try {
        const url = URL.createObjectURL(new Blob([await api.reproRead(this.doi, path)]));
        this.blobUrls.push(url);
        img.src = url;
      } catch { /* leave alt text */ }
    }
  }

  // ---------- step 7: report & zip ----------

  private renderReport(body: HTMLElement) {
    const st = this.state;
    body.innerHTML = `
    <div class="rp-card">
      <h3>Reproduction report</h3>
      ${!this.rows ? `<p class="warn-soft">Results not loaded yet; the report will load outputs/results.json automatically.</p>` : ""}
      <div class="actions">
        <button id="rp-report" class="primary" ${this.running.has("report") ? "disabled" : ""}>Generate report.html</button>
        <button id="rp-zip" ${st.reportPath && !this.running.has("zip") ? "" : "disabled"}>OK — create ZIP</button>
      </div>
      ${st.reportPath ? `<p class="ok">Report: <code class="path">${esc(st.reportPath)}</code> <button data-copy="${esc(st.reportPath)}">Copy path</button></p>` : ""}
      ${st.zipPath ? `<p class="ok">ZIP: <code class="path">${esc(st.zipPath)}</code> <button data-copy="${esc(st.zipPath)}">Copy path</button></p>` : ""}
    </div>
    <iframe id="rp-preview" class="rp-preview" sandbox=""></iframe>`;
    body.querySelector("#rp-report")!.addEventListener("click", () => this.generateReport());
    body.querySelector("#rp-zip")!.addEventListener("click", async () => {
      const p = await this.busy("zip", "Creating ZIP", () => api.reproZip(this.doi));
      if (p) {
        st.zipPath = p;
        this.save();
        this.render();
      }
    });
    body.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => b.addEventListener("click", () => navigator.clipboard.writeText(b.dataset.copy!)));
    if (st.reportPath) api.reproReadText(this.doi, "report.html").then((html) => ((body.querySelector("#rp-preview") as HTMLIFrameElement).srcdoc = html)).catch(() => {});
  }

  private async generateReport() {
    const st = this.state;
    const schema = this.schema();
    const plan = this.plan();
    if (!schema || !plan) return this.showError("Report", "Targets and an analysis plan are required.");
    await this.busy("report", "Generating report", async () => {
      if (!this.rows) await this.loadOutput();
      const rows = this.rows ?? compareAll(schema, undefined, st.compare);
      await this.refreshFiles(true);
      const figures = new Map<string, { original?: string; reproduced?: string }>();
      for (const r of rows.filter((x) => x.target.type === "figure"))
        figures.set(r.target.id, { original: await this.dataUrl(r.target.figure_file), reproduced: await this.dataUrl(r.out?.file) });
      const meta = this.ctx.meta();
      const html = buildReport({
        title: meta?.title ?? this.doi,
        doi: this.doi,
        authors: (meta?.authorships ?? []).map((a: any) => a.author?.display_name).join(", "),
        schema,
        plan,
        rows,
        settings: st.compare,
        files: this.files.filter((f) => f.path !== "report.html"),
        inputs: st.inputs,
        template: st.template,
        command: st.command || TEMPLATES[st.template].command,
        run: st.lastRun,
        validation: this.outputCheck ?? { errors: ["outputs/results.json not loaded"], warnings: [] },
        figures,
        generatedAt: new Date().toLocaleString(),
      });
      await api.reproWrite(this.doi, "report.html", html);
      st.reportPath = `${this.folder}/report.html`;
      st.zipPath = undefined;
      this.save();
    });
  }

  private async dataUrl(path?: string): Promise<string | undefined> {
    if (!path) return undefined;
    try {
      const blob = new Blob([await api.reproRead(this.doi, path)], { type: path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg" : "image/png" });
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result as string);
        fr.readAsDataURL(blob);
      });
    } catch {
      return undefined;
    }
  }

  /** Session snapshot for restoring the view after restart. */
  snapshot() {
    return { step: this.state.step };
  }
}
