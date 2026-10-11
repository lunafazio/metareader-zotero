import { api, ReproFile, RunResult } from "../api";
import type { DocModel } from "../model";
import type { PdfView } from "../pdfview";
import { compareAll, CompareRow, CompareSettings, STATUS_LABEL } from "./compare";
import { extractJson, figureTargets, indexDoc, planPrompt, resultsPrompt, toPlan, toTargets } from "./llm";
import { buildReport } from "./report";
import {
  AnalysisPlan, COMPARATORS, PLAN_JSON_SCHEMA, PlanStep, ReproducedOutput, RESULTS_OUTPUT_JSON_SCHEMA, RESULTS_SCHEMA_JSON_SCHEMA,
  ResultsSchema, TargetResult, validateOutput, validatePlan, validateResultsSchema,
} from "./schemas";
import { agentPrompt, masterScript, packageReadme, TEMPLATES, TemplateId, TODO_MARK } from "./templates";
import { SelectionTree } from "./tree";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const STATE_FILE = ".metareader/state.json";
const STEPS = ["Targets & inputs", "Analysis plan", "Master script", "Code generation", "Run & compare", "Report & package"];

export interface ReaderContext {
  doi(): string;
  meta(): any;
  model(): DocModel | undefined;
  refName(): string;
  pdf: PdfView;
  status(msg: string, kind?: "info" | "error"): void;
}

interface ReproState {
  version: 1;
  step: number;
  source: string; // reference document the selections refer to
  targetSel: string[];
  planSel: string[];
  schema?: ResultsSchema;
  plan?: AnalysisPlan;
  template: TemplateId;
  script: string;
  scriptDirty: boolean;
  packaged?: { template: TemplateId; at: string };
  command: string;
  allowExec: boolean;
  lastRun?: { code: number | null; duration_ms: number; at: string };
  lastCodegen?: { code: number | null; duration_ms: number; at: string };
  compare: CompareSettings;
  reportPath?: string;
  zipPath?: string;
}

const freshState = (): ReproState => ({
  version: 1, step: 0, source: "", targetSel: [], planSel: [], template: "r", script: "", scriptDirty: false,
  command: "", allowExec: true, compare: { rounding: "reported", threshold: 5 },
});

export class ReproView {
  private doi = "";
  private state = freshState();
  private files: ReproFile[] = [];
  private folder = "";
  private tree?: SelectionTree;
  private running = new Set<string>();
  private poll?: number;
  private output?: ReproducedOutput;
  private outputCheck?: { errors: string[]; warnings: string[] };
  private rows?: CompareRow[];
  private blobUrls: string[] = [];
  private saveTimer?: number;
  /** Re-renders only the side panel of tree steps, so the tree keeps its expand state. */
  private side?: () => void;

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
        this.state = { ...freshState(), ...JSON.parse(await api.reproReadText(doi, STATE_FILE)) };
      } catch {
        this.state = freshState();
      }
      this.folder = await api.reproPath(doi);
    }
    if (step !== undefined) this.state.step = step;
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
    this.refresh();
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
      this.refresh();
    }
  }

  private refresh() {
    if (this.side) this.side();
    else this.render();
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
  }

  private filesIn(dir: string) {
    return this.files.filter((f) => f.path.startsWith(dir + "/")).map((f) => f.path);
  }

  // ---------- rendering ----------

  private render() {
    const s = this.state.step;
    this.root.querySelector("#rp-steps")!.innerHTML = STEPS.map((t, i) => `<button data-step="${i}" class="${i === s ? "on" : ""}">${i + 1}. ${t}</button>`).join("");
    (this.root.querySelector("#rp-back") as HTMLButtonElement).disabled = s === 0;
    const next = this.root.querySelector("#rp-next") as HTMLButtonElement;
    next.disabled = s === STEPS.length - 1;
    next.textContent = s === 3 ? "Next: full run →" : "Next →";
    const body = this.root.querySelector<HTMLElement>("#rp-body")!;
    const scroll = body.querySelector(".rp-scroll-keep")?.scrollTop;
    this.side = undefined;
    [this.renderTargets, this.renderPlan, this.renderScript, this.renderCodegen, this.renderRun, this.renderReport][s].call(this, body);
    if (scroll !== undefined) body.querySelector(".rp-scroll-keep")?.scrollTo(0, scroll);
    this.managePolling();
  }

  private managePolling() {
    const need = (this.state.step === 3 && this.running.has("codegen")) || (this.state.step === 4 && this.running.has("run"));
    if (need && !this.poll) this.poll = window.setInterval(() => this.pollStatus(), 2500);
    if (!need && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private async pollStatus() {
    await this.refreshFiles();
    if (this.state.step === 3) await this.updateCodegenStatus();
    if (this.state.step === 4) await this.updateRunLog();
  }

  private needModel(body: HTMLElement): DocModel | undefined {
    const model = this.ctx.model();
    if (!model) {
      body.innerHTML = `<div class="empty">No structured reference text. Choose or generate one in the Reader first.</div>`;
      return undefined;
    }
    return model;
  }

  private sourceWarning(): string {
    const ref = this.ctx.refName();
    return this.state.source && this.state.source !== ref
      ? `<p class="warn">Selections were made on <b>${esc(this.state.source)}</b>, but the current reference text is <b>${esc(ref)}</b>. Switch back in the Reader, or reselect here.</p>`
      : "";
  }

  // ---------- step 1: targets & inputs ----------

  private renderTargets(body: HTMLElement) {
    const model = this.needModel(body);
    if (!model) return;
    body.innerHTML = `
    <div class="rp-cols">
      <section class="rp-card rp-tree-card">
        <h3>Reproduction targets — select text</h3>
        ${this.sourceWarning()}
        <div class="actions">
          <button data-sel="numbers">+ Sentences with numbers</button>
          <button data-sel="results">+ "Results" sections</button>
          <button data-sel="floats">+ All tables &amp; figures</button>
          <button data-sel="none">Clear</button>
        </div>
        <div id="rp-tree" class="rp-scroll"></div>
      </section>
      <section id="rp-side" class="rp-side rp-scroll"></section>
    </div>`;

    this.tree = new SelectionTree(body.querySelector("#rp-tree")!, model, {
      floats: true,
      onChange: () => {
        this.state.targetSel = this.tree!.ids;
        this.state.source = this.ctx.refName();
        this.save();
        this.side?.();
      },
    });
    this.tree.ids = this.state.targetSel;

    body.querySelectorAll<HTMLButtonElement>("[data-sel]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = this.tree!;
        const mode = b.dataset.sel;
        if (mode === "none") t.select(() => true, false);
        if (mode === "floats") t.select((_, __, k) => k !== "sentence");
        // digits, ignoring citation brackets and years
        if (mode === "numbers") t.select((_, text, k) => k === "sentence" && /\d/.test(text.replace(/\[\d+(?:[,–-]\s*\d+)*\]|\b(19|20)\d\d\b/g, "")));
        if (mode === "results") {
          const ids = new Set(model.sections.filter((s) => /result|finding/i.test(s.title)).flatMap((s) => s.blocks.flatMap((b) => (b.kind === "p" ? b.sentences.map((x) => x.id) : []))));
          t.select((id) => ids.has(id));
        }
      }),
    );
    const sideEl = body.querySelector<HTMLElement>("#rp-side")!;
    this.side = () => this.renderTargetsSide(sideEl, model);
    this.side();
  }

  private renderTargetsSide(el: HTMLElement, model: DocModel) {
    const schema = this.state.schema;
    const errs = schema ? validateResultsSchema(schema) : [];
    const { sentences, blocks } = indexDoc(model);
    const sel = this.state.targetSel;
    const nS = sel.filter((id) => sentences.has(id)).length;
    const nT = sel.filter((id) => blocks.get(id)?.block.kind === "table").length;
    const nF = sel.filter((id) => blocks.get(id)?.block.kind === "figure").length;
    const extracting = this.running.has("extract");
    const scroll = el.scrollTop;
    el.innerHTML = `
        ${this.inputsCard()}
        <div class="rp-card">
          <h3>Results schema</h3>
          <p>Selected: <b>${nS}</b> sentences, <b>${nT}</b> tables, <b>${nF}</b> figures.</p>
          <div class="actions">
            <button id="rp-extract" class="primary" ${extracting || !(nS + nT + nF) ? "disabled" : ""}>${extracting ? "Extracting…" : "Extract results with Claude"}</button>
            <label><input type="checkbox" id="rp-append" ${schema?.results.length ? "checked" : ""}/> append to existing</label>
            ${schema ? `<button id="rp-clear-schema">Discard schema</button>` : ""}
          </div>
          <p class="hint">Figures are added directly (no LLM); sentences and tables are parsed by Claude into typed results with unique IDs.</p>
          ${schema ? this.validationBox(errs, [], "Results schema") + this.schemaTable(schema) : ""}
        </div>`;
    el.scrollTop = scroll;
    this.bindInputs(el);
    el.querySelector("#rp-extract")?.addEventListener("click", () => this.extractResults(model));
    el.querySelector("#rp-clear-schema")?.addEventListener("click", () => {
      if (!confirm("Discard all extracted results?")) return;
      this.state.schema = undefined;
      this.save();
      this.refresh();
    });
    this.bindSchemaTable(el);
  }

  private inputsCard(): string {
    const list = (dir: string) =>
      this.filesIn(dir).map((p) => `<li><code>${esc(p.slice(dir.length + 1))}</code> <span class="muted">${(this.files.find((f) => f.path === p)!.size / 1024).toFixed(0)} KB</span> <button data-del="${esc(p)}" title="Remove">✕</button></li>`).join("") || `<li class="muted">none</li>`;
    return `<div class="rp-card">
      <h3>Inputs</h3>
      <h4>Data files</h4><ul class="rp-files">${list("data")}</ul>
      <label class="btn">Upload data…<input type="file" multiple hidden data-upload="data" /></label>
      <h4>Code files <span class="muted">(optional: original analysis code, used as reference for generation)</span></h4><ul class="rp-files">${list("code")}</ul>
      <label class="btn">Upload code…<input type="file" multiple hidden data-upload="code" /></label>
    </div>`;
  }

  private bindInputs(body: HTMLElement) {
    body.querySelectorAll<HTMLInputElement>("input[data-upload]").forEach((inp) =>
      inp.addEventListener("change", async () => {
        const dir = inp.dataset.upload!;
        const list = Array.from(inp.files ?? []);
        inp.value = "";
        await this.busy("upload", `Uploading ${list.length} file(s)`, async () => {
          for (const f of list) await api.reproWrite(this.doi, `${dir}/${f.name.replace(/[\\/]/g, "_")}`, new Uint8Array(await f.arrayBuffer()));
          await this.refreshFiles();
        });
      }),
    );
    body.querySelectorAll<HTMLButtonElement>("button[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm(`Remove ${b.dataset.del}?`)) return;
        await api.reproDelete(this.doi, b.dataset.del!);
        await this.refreshFiles();
        this.refresh();
      }),
    );
  }

  private validationBox(errors: string[], warnings: string[], what: string): string {
    if (!errors.length && !warnings.length) return `<p class="ok">✓ ${esc(what)} is valid.</p>`;
    return `${errors.length ? `<div class="warn"><b>⚠ ${esc(what)} is not compliant (${errors.length} problem${errors.length > 1 ? "s" : ""}):</b><ul>${errors.slice(0, 30).map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : `<p class="ok">✓ ${esc(what)} is valid.</p>`}
      ${warnings.length ? `<details class="warn-soft"><summary>${warnings.length} warning(s)</summary><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}`;
  }

  private schemaTable(schema: ResultsSchema): string {
    const row = (r: TargetResult, i: number) => {
      const exp = r.type === "table" ? `<span class="muted">${(r.expected as string[][])?.length ?? 0}×${(r.expected as string[][])?.[0]?.length ?? 0} table</span>` : r.type === "figure" ? `<span class="muted">figure</span>` : `<input data-f="expected" data-i="${i}" value="${esc(r.expected)}" size="8" />`;
      const cmp = r.type === "number" ? `<select data-f="comparator" data-i="${i}">${COMPARATORS.map((c) => `<option ${((r.comparator ?? "=") === c && "selected") || ""}>${c}</option>`).join("")}</select>` : "";
      return `<tr>
        <td><b>${r.id}</b><br><span class="badge">${r.type}</span></td>
        <td><textarea data-f="description" data-i="${i}" rows="2">${esc(r.description)}</textarea><div class="quote">“${esc(trunc(r.quote, 200))}” <span class="muted">— ${esc(r.source_label ?? "")}</span></div></td>
        <td class="nowrap">${cmp} ${exp}</td>
        <td>${r.type === "number" ? `<input data-f="decimals" data-i="${i}" value="${r.decimals ?? ""}" size="2" title="decimals as reported" />` : ""}</td>
        <td>${r.type === "number" ? `<input data-f="unit" data-i="${i}" value="${esc(r.unit ?? "")}" size="4" />` : ""}</td>
        <td><button data-rm="${i}" title="Remove">✕</button></td></tr>`;
    };
    return `<table class="rp-table"><tr><th>ID</th><th>Description / quote</th><th>Expected</th><th>dp</th><th>Unit</th><th></th></tr>${schema.results.map(row).join("")}</table>`;
  }

  private bindSchemaTable(body: HTMLElement) {
    const schema = this.state.schema;
    if (!schema) return;
    body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-f]").forEach((el) =>
      el.addEventListener("change", () => {
        const r = schema.results[Number(el.dataset.i)];
        const f = el.dataset.f!;
        const v = el.value.trim();
        if (f === "expected") r.expected = r.type === "number" && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
        else if (f === "decimals") r.decimals = v === "" ? undefined : Math.max(0, parseInt(v, 10) || 0);
        else if (f === "comparator") r.comparator = v === "=" ? undefined : (v as TargetResult["comparator"]);
        else if (f === "unit") r.unit = v || undefined;
        else if (f === "description") r.description = v;
        this.save();
        if (f === "expected" || f === "decimals") this.refresh();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => {
        schema.results.splice(Number(b.dataset.rm), 1);
        this.save();
        this.refresh();
      }),
    );
  }

  private async extractResults(model: DocModel) {
    const { sentences, blocks } = indexDoc(model);
    const sel = this.state.targetSel;
    const sentIds = sel.filter((id) => sentences.has(id));
    const tableIds = sel.filter((id) => blocks.get(id)?.block.kind === "table");
    const figIds = sel.filter((id) => blocks.get(id)?.block.kind === "figure");
    const append = (this.root.querySelector("#rp-append") as HTMLInputElement | null)?.checked ?? false;
    await this.busy("extract", "Extracting results", async () => {
      const existing = append ? this.state.schema?.results ?? [] : [];
      const start = Math.max(0, ...existing.map((r) => parseInt(r.id.slice(1), 10) || 0));
      let found: TargetResult[] = [];
      if (sentIds.length || tableIds.length) {
        const out = await api.claudePrompt(this.doi, resultsPrompt(model, sentIds, tableIds));
        found = toTargets(extractJson(out), model, start);
      }
      const haveFig = new Set(existing.filter((r) => r.type === "figure").flatMap((r) => r.source_ids));
      const figs = figureTargets(model, figIds.filter((id) => !haveFig.has(id)), start + found.length);
      const meta = this.ctx.meta();
      this.state.schema = {
        schema_version: "1.0",
        paper: { doi: this.doi, title: meta?.title },
        source_document: this.ctx.refName(),
        results: [...existing, ...found, ...figs],
      };
      this.state.source = this.ctx.refName();
      this.save();
    });
  }

  // ---------- step 2: analysis plan ----------

  private renderPlan(body: HTMLElement) {
    const model = this.needModel(body);
    if (!model) return;
    body.innerHTML = `
    <div class="rp-cols">
      <section class="rp-card rp-tree-card">
        <h3>Analysis plan — select methods text</h3>
        ${this.sourceWarning()}
        <div class="actions">
          <button data-sel="methods">+ Methods-like sections</button>
          <button data-sel="none">Clear</button>
        </div>
        <div id="rp-tree" class="rp-scroll"></div>
      </section>
      <section id="rp-side" class="rp-side rp-scroll"></section>
    </div>`;

    this.tree = new SelectionTree(body.querySelector("#rp-tree")!, model, {
      floats: false,
      onChange: () => {
        this.state.planSel = this.tree!.ids;
        this.state.source = this.ctx.refName();
        this.save();
        this.side?.();
      },
    });
    this.tree.ids = this.state.planSel;
    body.querySelectorAll<HTMLButtonElement>("[data-sel]").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.sel === "none") return this.tree!.select(() => true, false);
        const ids = new Set(model.sections.filter((s) => /method|material|procedure|analys|statistic|data|model|design|measure/i.test(s.title)).flatMap((s) => s.blocks.flatMap((x) => (x.kind === "p" ? x.sentences.map((y) => y.id) : []))));
        this.tree!.select((id) => ids.has(id));
      }),
    );
    const sideEl = body.querySelector<HTMLElement>("#rp-side")!;
    this.side = () => this.renderPlanSide(sideEl, model);
    this.side();
  }

  private renderPlanSide(el: HTMLElement, model: DocModel) {
    this.syncLoadSteps();
    const plan = this.state.plan;
    const errs = plan ? validatePlan(plan) : [];
    const planning = this.running.has("plan");
    const { sentences } = indexDoc(model);
    const nS = this.state.planSel.filter((id) => sentences.has(id)).length;
    const data = this.filesIn("data");
    const scroll = el.scrollTop;
    el.innerHTML = `
        <div class="rp-card">
          <h3>Steps</h3>
          ${!data.length ? `<p class="warn">No data files uploaded yet (step 1). Load steps are generated from uploaded data.</p>` : ""}
          ${!this.state.schema ? `<p class="warn-soft">No results schema yet; steps won't be linked to result IDs.</p>` : ""}
          <div class="actions">
            <button id="rp-mkplan" class="primary" ${planning || !nS ? "disabled" : ""}>${planning ? "Planning…" : `Build plan from ${nS} sentences with Claude`}</button>
            <button id="rp-addstep" ${plan ? "" : "disabled"}>+ Add step</button>
            ${plan ? `<button id="rp-clear-plan">Discard plan</button>` : ""}
          </div>
          ${plan ? this.validationBox(errs, [], "Analysis plan") + this.stepsList(plan) : `<p class="hint">Load steps (one per data file) are always first and a results step is always last; the steps in between come from the selected text and can be reordered.</p>`}
        </div>`;
    el.scrollTop = scroll;
    el.querySelector("#rp-mkplan")?.addEventListener("click", () => this.buildPlan(model));
    el.querySelector("#rp-clear-plan")?.addEventListener("click", () => {
      if (!confirm("Discard the analysis plan?")) return;
      this.state.plan = undefined;
      this.save();
      this.refresh();
    });
    el.querySelector("#rp-addstep")?.addEventListener("click", () => {
      const p = this.state.plan!;
      const n = Math.max(...p.steps.map((s) => parseInt(s.id.slice(1), 10) || 0)) + 1;
      const resultsIdx = p.steps.findIndex((s) => s.kind === "results");
      const prev = p.steps[resultsIdx - 1];
      const step: PlanStep = { id: `S${String(n).padStart(2, "0")}`, kind: "analysis", summary: "New step", quote: "", source_ids: [], inputs: [], depends_on: prev ? [prev.id] : [], produces: [] };
      p.steps.splice(resultsIdx, 0, step);
      p.steps[p.steps.length - 1].depends_on.push(step.id);
      if (!this.state.scriptDirty) this.state.script = "";
      this.save();
      this.refresh();
    });
    this.bindSteps(el);
  }

  /** Keep load steps in sync with uploaded data files. */
  private syncLoadSteps() {
    const plan = this.state.plan;
    if (!plan) return;
    const data = this.filesIn("data");
    const loads = plan.steps.filter((s) => s.kind === "load");
    const stale = loads.filter((s) => !data.includes(s.inputs[0])).map((s) => s.id);
    let changed = stale.length > 0;
    plan.steps = plan.steps.filter((s) => !stale.includes(s.id));
    plan.steps.forEach((s) => (s.depends_on = s.depends_on.filter((d) => !stale.includes(d))));
    const have = new Set(plan.steps.filter((s) => s.kind === "load").map((s) => s.inputs[0]));
    let n = Math.max(0, ...plan.steps.map((s) => parseInt(s.id.slice(1), 10) || 0));
    const insertAt = plan.steps.filter((s) => s.kind === "load").length;
    const added = data.filter((f) => !have.has(f)).map((f): PlanStep => ({ id: `S${String(++n).padStart(2, "0")}`, kind: "load", summary: `Load ${f}`, quote: "", source_ids: [], inputs: [f], depends_on: [], produces: [] }));
    if (added.length) {
      plan.steps.splice(insertAt, 0, ...added);
      changed = true;
    }
    if (changed) this.save();
  }

  private stepsList(plan: AnalysisPlan): string {
    const nLoad = plan.steps.filter((s) => s.kind === "load").length;
    const last = plan.steps.length - 1;
    return `<ol class="rp-steps">${plan.steps
      .map((s, i) => {
        const locked = s.kind === "load" || s.kind === "results";
        const canUp = !locked && i > nLoad;
        const canDown = !locked && i < last - 1;
        return `<li class="rp-step k-${s.kind}">
          <div class="rp-step-head"><b>${s.id}</b> <span class="badge">${s.kind}</span>
            <span class="spacer"></span>
            ${locked ? `<span class="muted" title="Load steps are always first and the results step last">🔒</span>` : `<button data-mv="${i}" data-d="-1" ${canUp ? "" : "disabled"}>↑</button><button data-mv="${i}" data-d="1" ${canDown ? "" : "disabled"}>↓</button><button data-rmstep="${i}">✕</button>`}
          </div>
          <textarea data-sf="summary" data-i="${i}" rows="2">${esc(s.summary)}</textarea>
          ${s.quote ? `<div class="quote">“${esc(s.quote)}”</div>` : ""}
          <div class="rp-step-meta">
            <label>depends on <input data-sf="depends_on" data-i="${i}" value="${esc(s.depends_on.join(", "))}" /></label>
            ${s.kind !== "load" && s.kind !== "results" ? `<label>produces <input data-sf="produces" data-i="${i}" value="${esc(s.produces.join(", "))}" /></label>` : s.inputs.length ? `<code>${esc(s.inputs.join(", "))}</code>` : `<span class="muted">produces all results</span>`}
          </div>
        </li>`;
      })
      .join("")}</ol>`;
  }

  private bindSteps(body: HTMLElement) {
    const plan = this.state.plan;
    if (!plan) return;
    const touched = () => {
      if (!this.state.scriptDirty) this.state.script = "";
      this.save();
    };
    body.querySelectorAll<HTMLButtonElement>("[data-mv]").forEach((b) =>
      b.addEventListener("click", () => {
        const i = Number(b.dataset.mv);
        const j = i + Number(b.dataset.d);
        [plan.steps[i], plan.steps[j]] = [plan.steps[j], plan.steps[i]];
        touched();
        this.refresh();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>("[data-rmstep]").forEach((b) =>
      b.addEventListener("click", () => {
        const [gone] = plan.steps.splice(Number(b.dataset.rmstep), 1);
        // Re-wire dependents to the removed step's own dependencies.
        for (const s of plan.steps) if (s.depends_on.includes(gone.id)) s.depends_on = [...new Set([...s.depends_on.filter((d) => d !== gone.id), ...gone.depends_on])];
        touched();
        this.refresh();
      }),
    );
    body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-sf]").forEach((el) =>
      el.addEventListener("change", () => {
        const s = plan.steps[Number(el.dataset.i)];
        const f = el.dataset.sf!;
        if (f === "summary") s.summary = el.value.trim();
        else (s as any)[f] = el.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
        touched();
        if (f !== "summary") this.refresh();
      }),
    );
  }

  private async buildPlan(model: DocModel) {
    if (this.state.plan && !confirm("Replace the current plan?")) return;
    const data = this.filesIn("data");
    await this.busy("plan", "Building analysis plan", async () => {
      const out = await api.claudePrompt(this.doi, planPrompt(model, this.state.planSel, data, this.filesIn("code"), this.state.schema));
      this.state.plan = toPlan(extractJson(out), data, this.state.schema);
      if (!this.state.scriptDirty) this.state.script = "";
      this.save();
    });
  }

  // ---------- step 3: master script ----------

  private scriptFor(t: TemplateId) {
    const plan = this.state.plan ?? { schema_version: "1.0" as const, steps: [] };
    return masterScript(t, plan, this.state.schema, this.ctx.meta()?.title ?? this.doi);
  }

  private renderScript(body: HTMLElement) {
    const st = this.state;
    if (!st.script) {
      st.script = this.scriptFor(st.template);
      st.scriptDirty = false;
    }
    const issues = [
      !st.schema && "no results schema (step 1)",
      !st.plan && "no analysis plan (step 2)",
      st.schema && validateResultsSchema(st.schema).length && "results schema is not valid",
      st.plan && validatePlan(st.plan).length && "analysis plan is not valid",
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
        <div class="actions"><button id="rp-package" class="primary" ${this.running.has("package") ? "disabled" : ""}>${st.packaged ? "Update package" : "OK — create package"}</button></div>
        ${st.packaged ? `<p class="ok">✓ Package created ${esc(new Date(st.packaged.at).toLocaleString())} (${TEMPLATES[st.packaged.template].label}).</p>` : ""}
        ${this.files.length ? `<details ${st.packaged ? "open" : ""}><summary>${this.files.length} files</summary><pre class="rp-tree-txt">${esc(this.files.map((f) => f.path).join("\n"))}</pre></details>` : ""}
      </section>
      <section class="rp-card rp-editor">
        <div class="rp-editor-head"><h3>${esc(TEMPLATES[st.template].script)}</h3><span class="badge">${todo} × ${TODO_MARK}</span>${st.scriptDirty ? `<span class="muted">edited</span>` : ""}<span class="spacer"></span><button id="rp-regen">Regenerate from plan</button></div>
        <textarea id="rp-script" spellcheck="false">${esc(st.script)}</textarea>
      </section>
    </div>`;

    body.querySelectorAll<HTMLInputElement>("input[name=tpl]").forEach((r) =>
      r.addEventListener("change", () => {
        if (st.scriptDirty && !confirm("Switching template regenerates the script and discards your edits. Continue?")) return this.render();
        st.template = r.value as TemplateId;
        st.script = this.scriptFor(st.template);
        st.scriptDirty = false;
        st.command = TEMPLATES[st.template].command;
        this.save();
        this.render();
      }),
    );
    body.querySelector("#rp-regen")!.addEventListener("click", () => {
      if (st.scriptDirty && !confirm("Discard your edits and regenerate from the plan?")) return;
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
    body.querySelector("#rp-copy-path")!.addEventListener("click", () => navigator.clipboard.writeText(this.folder));
    body.querySelector("#rp-package")!.addEventListener("click", () => this.createPackage());
  }

  private async createPackage() {
    const st = this.state;
    if (!st.schema || !st.plan) return this.showError("Create package", "A results schema (step 1) and an analysis plan (step 2) are required.");
    const errs = [...validateResultsSchema(st.schema), ...validatePlan(st.plan)];
    if (errs.length && !confirm(`The schemas have ${errs.length} validation problem(s):\n\n${errs.slice(0, 8).join("\n")}\n\nCreate the package anyway?`)) return;
    const scriptPath = TEMPLATES[st.template].script;
    const existing = this.files.find((f) => f.path === scriptPath);
    if (existing) {
      const cur = await api.reproReadText(this.doi, scriptPath);
      if (cur !== st.script && !cur.includes(TODO_MARK) && !confirm(`${scriptPath} in the folder already contains generated code. Overwrite it with the placeholder script?`)) {
        await this.busy("package", "Updating package (keeping script)", () => this.writePackage(false));
        return;
      }
    }
    await this.busy("package", "Creating package", () => this.writePackage(true));
  }

  private async writePackage(writeScript: boolean) {
    const st = this.state;
    const doi = this.doi;
    const title = this.ctx.meta()?.title ?? doi;
    const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
    await this.cropFigures();
    await api.reproWrite(doi, "results_schema.json", json(st.schema));
    await api.reproWrite(doi, "analysis_plan.json", json(st.plan));
    await api.reproWrite(doi, "schemas/results_schema.schema.json", json(RESULTS_SCHEMA_JSON_SCHEMA));
    await api.reproWrite(doi, "schemas/analysis_plan.schema.json", json(PLAN_JSON_SCHEMA));
    await api.reproWrite(doi, "schemas/results_output.schema.json", json(RESULTS_OUTPUT_JSON_SCHEMA));
    if (writeScript) await api.reproWrite(doi, TEMPLATES[st.template].script, st.script);
    await api.reproWrite(doi, "AGENT_PROMPT.md", this.prompt());
    await api.reproWrite(doi, "README.md", packageReadme(st.template, title, doi));
    await api.reproWrite(doi, "outputs/figures/.keep", "");
    st.packaged = { template: st.template, at: new Date().toISOString() };
    st.command ||= TEMPLATES[st.template].command;
    this.save();
    await this.refreshFiles();
  }

  /** Save crops of the original figures into targets/figures/<id>.png. */
  private async cropFigures() {
    const model = this.ctx.model();
    const figs = this.state.schema?.results.filter((r) => r.type === "figure") ?? [];
    if (!model || !figs.length || !this.ctx.pdf.loaded) return;
    const { blocks } = indexDoc(model);
    for (const r of figs) {
      const b = blocks.get(r.source_ids[0])?.block;
      if (!b) continue;
      let page: number | undefined;
      if (!b.boxes?.length) page = (await this.ctx.pdf.findText(r.quote.slice(0, 120)))?.[0]?.page;
      const blob = await this.ctx.pdf.renderRegion(b.boxes, page);
      if (!blob) continue;
      r.figure_file = `targets/figures/${r.id}.png`;
      await api.reproWrite(this.doi, r.figure_file, new Uint8Array(await blob.arrayBuffer()));
    }
  }

  private prompt() {
    return agentPrompt(this.state.template, { folder: this.folder, hasCode: this.filesIn("code").length > 0, dataFiles: this.filesIn("data") });
  }

  // ---------- step 4: code generation ----------

  private renderCodegen(body: HTMLElement) {
    const st = this.state;
    const gen = this.running.has("codegen");
    const prompt = `cd ${JSON.stringify(this.folder)}\n\n${this.prompt()}`;
    body.innerHTML = `
    ${!st.packaged ? `<p class="warn">Create the package in step 3 first.</p>` : ""}
    <div class="rp-cols">
      <section class="rp-side rp-scroll">
        <div class="rp-card">
          <h3>Option A — headless Claude Code</h3>
          <p>Runs <code>claude -p</code> inside the package folder with file edit permissions, using AGENT_PROMPT.md.</p>
          <label><input type="checkbox" id="rp-exec" ${st.allowExec ? "checked" : ""}/> allow it to run R / Python / Snakemake to test the code</label>
          <div class="actions">
            <button id="rp-gen" class="primary" ${gen || !st.packaged ? "disabled" : ""}>${gen ? "Generating…" : "Generate code"}</button>
            <button id="rp-gen-stop" ${gen ? "" : "disabled"}>Stop</button>
          </div>
          ${st.lastCodegen ? `<p class="muted">Last run: exit ${st.lastCodegen.code}, ${(st.lastCodegen.duration_ms / 1000).toFixed(0)} s, ${esc(new Date(st.lastCodegen.at).toLocaleString())}</p>` : ""}
        </div>
        <div class="rp-card">
          <h3>Option B — your own agent</h3>
          <p>Paste this into Claude Code (or another agent) in a terminal:</p>
          <textarea readonly rows="12" class="mono" id="rp-prompt">${esc(prompt)}</textarea>
          <div class="actions"><button id="rp-copy-prompt">Copy prompt</button><button id="rp-copy-path">Copy folder path</button></div>
        </div>
      </section>
      <section class="rp-card rp-scroll">
        <div class="rp-editor-head"><h3>Folder status</h3><span class="spacer"></span><button id="rp-refresh">↻ Refresh</button></div>
        <div id="rp-gen-status"><p class="muted">Loading…</p></div>
      </section>
    </div>`;
    body.querySelector("#rp-exec")!.addEventListener("change", (e) => {
      st.allowExec = (e.target as HTMLInputElement).checked;
      this.save();
    });
    body.querySelector("#rp-gen")!.addEventListener("click", () => this.generate());
    body.querySelector("#rp-gen-stop")!.addEventListener("click", () => api.stopTask("codegen"));
    body.querySelector("#rp-copy-prompt")!.addEventListener("click", () => navigator.clipboard.writeText(prompt).then(() => this.setStatus("Prompt copied")));
    body.querySelector("#rp-copy-path")!.addEventListener("click", () => navigator.clipboard.writeText(this.folder).then(() => this.setStatus("Path copied")));
    body.querySelector("#rp-refresh")!.addEventListener("click", async () => {
      await this.refreshFiles();
      await this.updateCodegenStatus();
    });
    this.updateCodegenStatus();
  }

  private async generate() {
    await this.writePackageFilesOnly();
    const r = await this.busy("codegen", "Generating code with Claude", () => api.claudeCodegen(this.doi, this.prompt(), this.state.allowExec));
    if (r) this.state.lastCodegen = { code: r.code, duration_ms: r.duration_ms, at: new Date().toISOString() };
    this.save();
    await this.refreshFiles();
    if (this.state.step === 3) await this.updateCodegenStatus();
  }

  /** Refresh AGENT_PROMPT.md in case data/code changed since packaging. */
  private async writePackageFilesOnly() {
    await api.reproWrite(this.doi, "AGENT_PROMPT.md", this.prompt());
  }

  private async updateCodegenStatus() {
    const el = this.root.querySelector("#rp-gen-status");
    if (!el) return;
    const scriptPath = TEMPLATES[this.state.template].script;
    let todo = "—";
    try {
      const script = await api.reproReadText(this.doi, scriptPath);
      const n = (script.match(/TODO\(LLM\)/g) ?? []).length;
      todo = n ? `<span class="warn-inline">${n} × ${TODO_MARK} remaining</span>` : `<span class="ok">✓ no ${TODO_MARK} markers left</span>`;
    } catch {
      todo = `<span class="warn-inline">${esc(scriptPath)} not found</span>`;
    }
    const events = await this.codegenEvents();
    const now = Date.now();
    const age = (t: number) => { const s = (now - t) / 1000; return s < 60 ? `${s.toFixed(0)} s ago` : s < 3600 ? `${(s / 60).toFixed(0)} min ago` : new Date(t).toLocaleString(); };
    const recent = [...this.files].sort((a, b) => b.modified - a.modified);
    el.innerHTML = `
      <p><b>${esc(scriptPath)}</b>: ${todo}${this.running.has("codegen") ? ` · <span class="pulse">Claude is working…</span>` : ""}</p>
      ${events.length ? `<h4>Agent activity</h4><ul class="rp-events">${events.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      <h4>Files (most recently modified first)</h4>
      <table class="rp-table"><tr><th>Path</th><th>Size</th><th>Modified</th></tr>${recent.map((f) => `<tr class="${now - f.modified < 60000 ? "fresh" : ""}"><td><code>${esc(f.path)}</code></td><td>${(f.size / 1024).toFixed(1)} KB</td><td>${age(f.modified)}</td></tr>`).join("")}</table>`;
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
        if (ev.type === "system" && ev.subtype === "init") out.push(`▶ started (${ev.model ?? "claude"})`);
        if (ev.type === "assistant")
          for (const c of ev.message?.content ?? []) {
            if (c.type === "tool_use") out.push(`🔧 ${c.name} ${c.input?.file_path ?? c.input?.command ?? c.input?.pattern ?? ""}`.trim());
            if (c.type === "text" && c.text?.trim()) out.push(`💬 ${trunc(c.text.trim().replace(/\s+/g, " "), 200)}`);
          }
        if (ev.type === "result") out.push(`${ev.is_error ? "✗" : "✓"} finished: ${trunc(String(ev.result ?? "").replace(/\s+/g, " "), 300)}`);
      } catch {
        out.push(trunc(line, 200));
      }
    }
    return out.slice(-25);
  }

  // ---------- step 5: run & compare ----------

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

  private async updateRunLog() {
    const el = this.root.querySelector("#rp-log");
    if (!el) return;
    try {
      const lines = (await api.reproReadText(this.doi, "outputs/run.log")).split("\n");
      el.textContent = (lines.length > 300 ? `… (${lines.length - 300} earlier lines)\n` : "") + lines.slice(-300).join("\n");
      el.scrollTop = el.scrollHeight;
    } catch {
      el.textContent = "(no run yet)";
    }
  }

  private async loadOutput() {
    const schema = this.state.schema;
    if (!schema) return this.showError("Load results", "No results schema.");
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
    if (this.state.schema && this.output) this.rows = compareAll(this.state.schema, this.output, this.state.compare);
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

  // ---------- step 6: report & zip ----------

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
    if (!st.schema || !st.plan) return this.showError("Report", "Results schema and analysis plan are required.");
    await this.busy("report", "Generating report", async () => {
      if (!this.rows) await this.loadOutput();
      const rows = this.rows ?? compareAll(st.schema!, undefined, st.compare);
      await this.refreshFiles(true);
      const figures = new Map<string, { original?: string; reproduced?: string }>();
      for (const r of rows.filter((x) => x.target.type === "figure"))
        figures.set(r.target.id, { original: await this.dataUrl(r.target.figure_file), reproduced: await this.dataUrl(r.out?.file) });
      const meta = this.ctx.meta();
      const html = buildReport({
        title: meta?.title ?? this.doi,
        doi: this.doi,
        authors: (meta?.authorships ?? []).map((a: any) => a.author?.display_name).join(", "),
        schema: st.schema!,
        plan: st.plan!,
        rows,
        settings: st.compare,
        files: this.files.filter((f) => f.path !== "report.html"),
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
