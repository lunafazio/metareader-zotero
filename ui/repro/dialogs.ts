// Modal dialogs of the reproduction wizard: confirmations, adding rows by hand (with article references),
// and the model-call dialogs shown before anything is sent to the LLM.
import type { LlmCommand } from "../api";
import type { DocModel } from "../model";
import { indexDoc } from "./llm";
import { COMPARATORS, Comparator, ResultType, TargetResult } from "./schemas";
import type { StepDraft } from "./state";
import { SelectionTree } from "./tree";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function modal(cls: string, html: string): HTMLDialogElement {
  const dlg = document.createElement("dialog");
  dlg.className = `rp-dialog ${cls}`;
  dlg.innerHTML = html;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

export function confirmDialog(title: string, messageHtml: string, ok = "OK", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = modal("rp-confirm", `<h3>${esc(title)}</h3><div>${messageHtml}</div>
      <menu><button value="cancel">Cancel</button><button value="ok" class="${danger ? "danger" : "primary"}">${esc(ok)}</button></menu>`);
    dlg.querySelectorAll<HTMLButtonElement>("menu button").forEach((b) => b.addEventListener("click", () => dlg.close(b.value)));
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"));
  });
}

// ---------- article references ----------

type Pred = (id: string, text: string, kind: "sentence" | "table" | "figure") => boolean;
export interface Preset {
  label: string;
  pick(model: DocModel): Pred;
}

const sectionPreset = (label: string, re: RegExp): Preset => ({
  label,
  pick: (model) => {
    const ids = new Set(model.sections.filter((s) => re.test(s.title)).flatMap((s) => s.blocks.flatMap((b) => (b.kind === "p" ? b.sentences.map((x) => x.id) : []))));
    return (id) => ids.has(id);
  },
});

export const TARGET_PRESETS: Preset[] = [
  // digits, ignoring citation brackets and years
  { label: "+ Sentences with numbers", pick: () => (_, text, k) => k === "sentence" && /\d/.test(text.replace(/\[\d+(?:[,–-]\s*\d+)*\]|\b(19|20)\d\d\b/g, "")) },
  sectionPreset('+ "Results" sections', /result|finding/i),
  { label: "+ All tables & figures", pick: () => (_, __, k) => k !== "sentence" },
];

export const PLAN_PRESETS: Preset[] = [sectionPreset("+ Methods-like sections", /method|material|procedure|analys|statistic|data|model|design|measure/i)];

export interface Picker {
  ids(): string[];
}

/** Checkbox tree over the reference text with quick-select presets. */
export function referencePicker(el: HTMLElement, model: DocModel | undefined, opts: { floats: boolean; presets: Preset[]; initial?: string[]; onChange?: (ids: string[]) => void }): Picker {
  if (!model) {
    el.innerHTML = `<p class="muted">No structured reference text is loaded. Choose or generate one in the Reader to mark article content.</p>`;
    return { ids: () => [] };
  }
  el.innerHTML = `<div class="actions">${opts.presets.map((p, i) => `<button type="button" data-preset="${i}">${esc(p.label)}</button>`).join("")}<button type="button" data-clear>Clear</button><span class="muted rp-pick-count"></span></div><div class="rp-pick-tree"></div>`;
  const count = el.querySelector<HTMLElement>(".rp-pick-count")!;
  const update = () => {
    const ids = tree.ids;
    count.textContent = `${ids.length} selected`;
    opts.onChange?.(ids);
  };
  const tree: SelectionTree = new SelectionTree(el.querySelector(".rp-pick-tree")!, model, { floats: opts.floats, onChange: update });
  tree.ids = opts.initial ?? [];
  count.textContent = `${tree.ids.length} selected`;
  el.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => b.addEventListener("click", () => tree.select(opts.presets[Number(b.dataset.preset)].pick(model))));
  el.querySelector("[data-clear]")!.addEventListener("click", () => tree.select(() => true, false));
  return { ids: () => tree.ids };
}

/** Text of the referenced sentences / table and figure captions, in document order. */
export function referenceText(model: DocModel | undefined, ids: string[]): { quote: string; label?: string } {
  if (!model || !ids.length) return { quote: "" };
  const { sentences, blocks } = indexDoc(model);
  const parts: string[] = [];
  let label: string | undefined;
  for (const id of ids) {
    const s = sentences.get(id);
    const b = blocks.get(id);
    if (s?.sentence) {
      parts.push(s.sentence.text);
      label ??= s.section;
    } else if (b && b.block.kind !== "p") {
      parts.push(`${b.block.label}: ${b.block.caption.map((c) => c.text).join(" ")}`);
      label ??= b.block.label;
    }
  }
  return { quote: parts.join(" "), label };
}

export function scannedCounts(model: DocModel, ids: string[]) {
  const { sentences, blocks } = indexDoc(model);
  return {
    sentences: ids.filter((id) => sentences.has(id)).length,
    tables: ids.filter((id) => blocks.get(id)?.block.kind === "table").length,
    figures: ids.filter((id) => blocks.get(id)?.block.kind === "figure").length,
  };
}

/** Quote field that follows the selected references until the user edits it. */
function linkQuote(dlg: HTMLDialogElement, model: DocModel | undefined) {
  const quote = dlg.querySelector<HTMLTextAreaElement>("[name=quote]")!;
  let touched = false;
  quote.addEventListener("input", () => (touched = true));
  return (ids: string[]) => {
    if (!touched) quote.value = referenceText(model, ids).quote;
  };
}

// ---------- add rows by hand ----------

export function addTargetDialog(model: DocModel | undefined, id: string): Promise<TargetResult | undefined> {
  return new Promise((resolve) => {
    const dlg = modal("rp-add", `<form method="dialog">
      <h3>Add target ${esc(id)}</h3>
      <div class="rp-add-grid">
        <section>
          <label>Type <select name="type"><option value="number">number</option><option value="categorical">categorical</option><option value="table">table</option><option value="figure">figure</option></select></label>
          <label>Description <textarea name="description" rows="3" required placeholder="What is measured: variable, model / test, subgroup"></textarea></label>
          <div class="rp-add-row" data-for="number categorical">
            <label>Expected <input name="expected" placeholder="as reported" /></label>
            <label data-for="number">Comparator <select name="comparator">${COMPARATORS.map((c) => `<option>${c}</option>`).join("")}</select></label>
            <label data-for="number">Decimals <input name="decimals" type="number" min="0" style="width:5em" /></label>
            <label data-for="number">Unit <input name="unit" style="width:6em" /></label>
          </div>
          <label data-for="table">Expected table <textarea name="table" rows="4" class="mono" placeholder="one row per line, cells separated by tabs; header row included"></textarea></label>
          <label>Quote <textarea name="quote" rows="3" placeholder="Verbatim text from the article (filled from the marked content)"></textarea></label>
        </section>
        <section><h4>Article content this target refers to</h4><div class="rp-pick"></div></section>
      </div>
      <p class="warn rp-add-err" hidden></p>
      <menu><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">Add target</button></menu>
    </form>`);
    const form = dlg.querySelector("form")!;
    const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
    const showFor = () => {
      const t = f("type").value;
      dlg.querySelectorAll<HTMLElement>("[data-for]").forEach((el) => (el.hidden = !el.dataset.for!.split(" ").includes(t)));
    };
    f("type").addEventListener("change", showFor);
    showFor();
    const syncQuote = linkQuote(dlg, model);
    let refs: string[] = [];
    referencePicker(dlg.querySelector(".rp-pick")!, model, { floats: true, presets: [], onChange: (ids) => syncQuote((refs = ids)) });
    form.addEventListener("submit", (e) => {
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      if (submitter?.value !== "ok") return;
      const type = f("type").value as ResultType;
      const raw = f("expected").value.trim();
      const err = dlg.querySelector<HTMLElement>(".rp-add-err")!;
      let expected: TargetResult["expected"];
      if (type === "number") {
        expected = Number(raw.replace(/[−–]/g, "-"));
        if (raw === "" || Number.isNaN(expected)) {
          e.preventDefault();
          err.hidden = false;
          err.textContent = "A numeric target needs a numeric expected value.";
          return;
        }
      } else if (type === "categorical") expected = raw;
      else if (type === "table") expected = f("table").value.split("\n").filter((l) => l.trim()).map((l) => l.split("\t"));
      const { label } = referenceText(model, refs);
      const decimals = f("decimals").value;
      resolve({
        id,
        type,
        description: f("description").value.trim(),
        quote: f("quote").value.trim(),
        source_ids: refs,
        source_label: label,
        expected,
        comparator: type === "number" && f("comparator").value !== "=" ? (f("comparator").value as Comparator) : undefined,
        unit: type === "number" ? f("unit").value.trim() || undefined : undefined,
        decimals: type === "number" && decimals !== "" ? Math.max(0, parseInt(decimals, 10) || 0) : undefined,
      });
    });
    dlg.addEventListener("close", () => resolve(undefined));
  });
}

export function addStepDialog(
  model: DocModel | undefined,
  id: string,
  ctx: { dataInputs: string[]; steps: { id: string; summary: string }[]; targets: { id: string; description: string }[] },
): Promise<StepDraft | undefined> {
  const checks = (name: string, items: { value: string; label: string }[], empty: string) =>
    items.length ? `<div class="rp-checks">${items.map((x) => `<label title="${esc(x.label)}"><input type="checkbox" name="${name}" value="${esc(x.value)}" /> <b>${esc(x.value)}</b> ${esc(trunc(x.label, 70))}</label>`).join("")}</div>` : `<p class="muted">${empty}</p>`;
  return new Promise((resolve) => {
    const dlg = modal("rp-add", `<form method="dialog">
      <h3>Add step ${esc(id)}</h3>
      <div class="rp-add-grid">
        <section>
          <label>Kind <select name="kind"><option value="analysis">analysis</option><option value="transform">transform</option></select></label>
          <label>Summary <textarea name="summary" rows="3" required placeholder="What exactly to compute, specific enough to code"></textarea></label>
          <h4>Data files used</h4>${checks("inputs", ctx.dataInputs.map((p) => ({ value: p, label: "" })), "No data inputs (step 1).")}
          <h4>Depends on</h4>${checks("depends_on", ctx.steps.map((s) => ({ value: s.id, label: s.summary })), "No other steps yet.")}
          <h4>Produces</h4>${checks("produces", ctx.targets.map((t) => ({ value: t.id, label: t.description })), "No targets yet (step 2).")}
          <label>Quote <textarea name="quote" rows="3" placeholder="Verbatim text from the article (filled from the marked content)"></textarea></label>
        </section>
        <section><h4>Article content this step implements</h4><div class="rp-pick"></div></section>
      </div>
      <menu><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">Add step</button></menu>
    </form>`);
    const form = dlg.querySelector("form")!;
    const syncQuote = linkQuote(dlg, model);
    let refs: string[] = [];
    referencePicker(dlg.querySelector(".rp-pick")!, model, { floats: false, presets: PLAN_PRESETS, onChange: (ids) => syncQuote((refs = ids)) });
    const checked = (name: string) => Array.from(form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`), (c) => c.value);
    form.addEventListener("submit", (e) => {
      if (((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value !== "ok") return;
      resolve({
        id,
        kind: (form.elements.namedItem("kind") as HTMLSelectElement).value as StepDraft["kind"],
        summary: (form.elements.namedItem("summary") as HTMLTextAreaElement).value.trim(),
        quote: (form.elements.namedItem("quote") as HTMLTextAreaElement).value.trim(),
        source_ids: refs,
        inputs: checked("inputs"),
        depends_on: checked("depends_on"),
        produces: checked("produces"),
      });
    });
    dlg.addEventListener("close", () => resolve(undefined));
  });
}

// ---------- model calls ----------

export interface LlmChoice {
  ids: string[];
  model?: string; // undefined: configured default
  instructions: string;
  prompt: string;
  argv: string[];
}

const commandLine = (argv: string[]) => argv.map((a) => (/^[\w./:=@+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

function modelField(defaultModel: string) {
  return `<label>Model <input name="model" placeholder="${esc(defaultModel ? `default: ${defaultModel}` : "default of the CLI")}" /></label>`;
}

/** "Generate with LLM": choose the article content, review the model call and the prompt, then send. */
export function llmDialog(opts: {
  title: string;
  model: DocModel;
  floats: boolean;
  presets: Preset[];
  initial: string[];
  intro: string;
  buildPrompt(ids: string[], instructions: string): string;
  command(model: string | undefined): Promise<LlmCommand>;
}): Promise<LlmChoice | undefined> {
  return new Promise(async (resolve) => {
    const first = await opts.command(undefined);
    const dlg = modal("rp-llm", `<form method="dialog">
      <h3>${esc(opts.title)}</h3>
      <p class="hint">${opts.intro}</p>
      <div class="rp-llm-grid">
        <section class="rp-llm-pick"><h4>Article content to scan</h4><div class="rp-pick"></div></section>
        <section class="rp-llm-call">
          <h4>Model call</h4>
          ${modelField(first.defaultModel)}
          <div class="rp-call-meta"><span class="muted">Command</span><code class="rp-cmdline"></code><span class="muted">Runs in</span><code>${esc(first.cwd)}</code><span class="muted">Input</span><span>the prompt below, on stdin</span></div>
          <label>Additional instructions <textarea name="instructions" rows="2" placeholder="Optional, appended to the prompt"></textarea></label>
          <h4>Prompt <span class="muted rp-prompt-size"></span></h4>
          <textarea class="mono rp-prompt" readonly></textarea>
        </section>
      </div>
      <menu><span class="muted rp-llm-summary"></span><button value="cancel">Cancel</button><button value="ok" class="primary">Send to LLM</button></menu>
    </form>`);
    const form = dlg.querySelector("form")!;
    const modelInp = form.elements.namedItem("model") as HTMLInputElement;
    const instr = form.elements.namedItem("instructions") as HTMLTextAreaElement;
    const promptEl = dlg.querySelector<HTMLTextAreaElement>(".rp-prompt")!;
    const sendBtn = dlg.querySelector<HTMLButtonElement>('button[value="ok"]')!;
    let ids = opts.initial;
    let argv = first.argv;
    const refreshPrompt = () => {
      const c = scannedCounts(opts.model, ids);
      const prompt = ids.length ? opts.buildPrompt(ids, instr.value.trim()) : "";
      promptEl.value = prompt || "(select article content first)";
      dlg.querySelector(".rp-prompt-size")!.textContent = prompt ? `${prompt.length.toLocaleString()} characters` : "";
      dlg.querySelector(".rp-llm-summary")!.textContent = `Scans ${c.sentences} sentences${opts.floats ? `, ${c.tables} tables, ${c.figures} figures` : ""}`;
      sendBtn.disabled = !ids.length;
    };
    const refreshCommand = async () => {
      argv = (await opts.command(modelInp.value.trim() || undefined)).argv;
      dlg.querySelector(".rp-cmdline")!.textContent = commandLine(argv);
    };
    referencePicker(dlg.querySelector(".rp-pick")!, opts.model, { floats: opts.floats, presets: opts.presets, initial: ids, onChange: (x) => ((ids = x), refreshPrompt()) });
    instr.addEventListener("input", refreshPrompt);
    modelInp.addEventListener("change", refreshCommand);
    dlg.querySelector(".rp-cmdline")!.textContent = commandLine(argv);
    refreshPrompt();
    form.addEventListener("submit", (e) => {
      if (((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value !== "ok") return;
      resolve({ ids, model: modelInp.value.trim() || undefined, instructions: instr.value.trim(), prompt: opts.buildPrompt(ids, instr.value.trim()), argv });
    });
    dlg.addEventListener("close", () => resolve(undefined));
  });
}

/** Confirmation for the headless agent run: model, permissions, command and prompt. */
export function agentDialog(opts: {
  prompt: string;
  allowExec: boolean;
  command(model: string | undefined, allowExec: boolean): Promise<LlmCommand>;
}): Promise<{ model?: string; allowExec: boolean } | undefined> {
  return new Promise(async (resolve) => {
    const first = await opts.command(undefined, opts.allowExec);
    const dlg = modal("rp-llm rp-agent", `<form method="dialog">
      <h3>Run headless LLM agent</h3>
      <p class="hint">The agent works in the package folder with permission to read and edit files, following the prompt below (also saved as AGENT_PROMPT.md).</p>
      ${modelField(first.defaultModel)}
      <label class="inline"><input type="checkbox" name="exec" ${opts.allowExec ? "checked" : ""}/> allow it to run R / Python / Snakemake to test the code</label>
      <div class="rp-call-meta"><span class="muted">Command</span><code class="rp-cmdline"></code><span class="muted">Runs in</span><code>${esc(first.cwd)}</code><span class="muted">Input</span><span>the prompt below, on stdin</span></div>
      <h4>Prompt</h4>
      <textarea class="mono rp-prompt" readonly>${esc(opts.prompt)}</textarea>
      <menu><button value="cancel">Cancel</button><button value="ok" class="primary">Start agent</button></menu>
    </form>`);
    const form = dlg.querySelector("form")!;
    const modelInp = form.elements.namedItem("model") as HTMLInputElement;
    const exec = form.elements.namedItem("exec") as HTMLInputElement;
    const refresh = async () => {
      const c = await opts.command(modelInp.value.trim() || undefined, exec.checked);
      dlg.querySelector(".rp-cmdline")!.textContent = commandLine(c.argv);
    };
    modelInp.addEventListener("change", refresh);
    exec.addEventListener("change", refresh);
    dlg.querySelector(".rp-cmdline")!.textContent = commandLine(first.argv);
    form.addEventListener("submit", (e) => {
      if (((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value !== "ok") return;
      resolve({ model: modelInp.value.trim() || undefined, allowExec: exec.checked });
    });
    dlg.addEventListener("close", () => resolve(undefined));
  });
}

/** Read-only view of a past LLM call. */
export function callDetailsDialog(title: string, call: { at: string; argv: string[]; instructions: string; prompt: string; output: string; duration_ms: number }) {
  const dlg = modal("rp-llm", `<h3>${esc(title)}</h3>
    <div class="rp-call-meta"><span class="muted">When</span><span>${esc(new Date(call.at).toLocaleString())} · ${(call.duration_ms / 1000).toFixed(0)} s</span><span class="muted">Command</span><code>${esc(commandLine(call.argv))}</code>${call.instructions ? `<span class="muted">Instructions</span><span>${esc(call.instructions)}</span>` : ""}</div>
    <h4>Prompt</h4><textarea class="mono rp-prompt" readonly>${esc(call.prompt)}</textarea>
    <h4>Raw output</h4><textarea class="mono rp-prompt" readonly>${esc(call.output)}</textarea>
    <form method="dialog"><menu><button class="primary">Close</button></menu></form>`);
  return dlg;
}
