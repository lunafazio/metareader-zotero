// Wizard state: input files with roles, and targets / plan steps as editable entries.
// Entries produced by an LLM call are grouped under that call; the user's changes are stored as an edit on top
// of the LLM's extraction so they can be restored. The results schema and analysis plan written into the package
// are derived from the enabled entries (buildSchema / buildPlan).
import type { CompareSettings } from "./compare";
import type { AnalysisPlan, PlanStep, ResultsSchema, TargetResult } from "./schemas";
import type { TemplateId } from "./templates";

export type Role = "data" | "code" | "other";
export const ROLES: Role[] = ["data", "code", "other"];

export interface InputMeta {
  path: string; // repro-relative, below inputs/
  role: Role;
  note: string;
  excluded?: boolean; // archive members only: kept on disk but not used
}

export interface ArchiveMeta {
  name: string; // uploaded file name
  dir: string; // repro-relative folder it was unpacked into
}

export interface LlmCall {
  at: string;
  argv: string[];
  model: string; // "" = CLI default
  instructions: string;
  prompt: string;
  output: string;
  duration_ms: number;
  scanned: { sentences: number; tables: number; figures: number };
}

export interface Entry<T> {
  t: "row";
  uid: string;
  base: T;
  edit?: Partial<T>; // user changes on top of an LLM extraction
  disabled?: boolean;
  manual?: boolean; // added by hand: edits go straight into base
}

export interface LlmGroup<T> {
  t: "llm";
  uid: string;
  call: LlmCall;
  entries: Entry<T>[];
  collapsed?: boolean;
}

export type Item<T> = Entry<T> | LlmGroup<T>;

export type StepDraft = Omit<PlanStep, "kind"> & { kind: "transform" | "analysis" };

export interface ReproState {
  version: 2;
  step: number;
  source: string; // reference document the article references point into
  targetSel: string[]; // last selection in the LLM dialog
  planSel: string[];
  inputs: InputMeta[];
  archives: ArchiveMeta[];
  targets: Item<TargetResult>[];
  steps: Item<StepDraft>[];
  figureFiles: Record<string, string>; // result id → crop of the original figure
  template: TemplateId;
  script: string;
  scriptDirty: boolean;
  packaged?: { template: TemplateId; at: string; commit?: string };
  command: string;
  allowExec: boolean;
  lastRun?: { code: number | null; duration_ms: number; at: string };
  lastCodegen?: { code: number | null; duration_ms: number; at: string; commit?: string };
  compare: CompareSettings;
  reportPath?: string;
  zipPath?: string;
}

export const freshState = (): ReproState => ({
  version: 2, step: 0, source: "", targetSel: [], planSel: [], inputs: [], archives: [], targets: [], steps: [],
  figureFiles: {}, template: "r", script: "", scriptDirty: false, command: "", allowExec: true,
  compare: { rounding: "reported", threshold: 5 },
});

/** Load saved state; states from the earlier wizard layout (version 1) start fresh. */
export function loadState(raw: any): ReproState {
  if (raw?.version !== 2) return freshState();
  return { ...freshState(), ...raw };
}

export const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- input roles ----------

const DATA_EXT = new Set(["csv", "tsv", "tab", "txt", "dat", "json", "jsonl", "ndjson", "xml", "xlsx", "xls", "ods", "sav", "zsav", "por", "dta", "sas7bdat", "xpt", "rds", "rdata", "rda", "feather", "parquet", "arrow", "h5", "hdf5", "nc", "mat", "sqlite", "db", "gpkg", "shp", "geojson", "npy", "npz", "pkl", "pickle"]);
const CODE_EXT = new Set(["r", "rmd", "qmd", "py", "ipynb", "do", "ado", "sas", "sps", "m", "jl", "stan", "sh", "bash", "sql", "c", "cpp", "h", "js", "ts", "java", "scala", "go", "rs", "f90", "pl", "rb", "smk", "nf", "wdl", "mk"]);
const CODE_NAMES = new Set(["snakefile", "makefile", "dockerfile", "_targets.r", "description", "requirements.txt", "environment.yml", "renv.lock"]);

export function roleFor(path: string): Role {
  const name = path.split("/").pop()!.toLowerCase();
  if (CODE_NAMES.has(name)) return "code";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  if (CODE_EXT.has(ext)) return "code";
  if (DATA_EXT.has(ext)) return "data";
  return "other";
}

export const usedInputs = (st: ReproState, role?: Role) => st.inputs.filter((i) => !i.excluded && (!role || i.role === role));

// ---------- entries ----------

export const value = <T>(e: Entry<T>): T => (e.edit ? { ...e.base, ...e.edit } : e.base);
export const isModified = (e: Entry<unknown>) => !!e.edit || !!e.disabled;

export function allEntries<T>(items: Item<T>[]): Entry<T>[] {
  return items.flatMap((it) => (it.t === "llm" ? it.entries : [it]));
}

export const enabledValues = <T>(items: Item<T>[]): T[] => allEntries(items).filter((e) => !e.disabled).map(value);

export function findEntry<T>(items: Item<T>[], id: string): { entry?: Entry<T>; group?: LlmGroup<T>; list: Item<T>[] | Entry<T>[] } | undefined {
  for (const it of items) {
    if (it.t === "row" && it.uid === id) return { entry: it, list: items };
    if (it.t === "llm") {
      if (it.uid === id) return { group: it, list: items };
      const e = it.entries.find((x) => x.uid === id);
      if (e) return { entry: e, group: it, list: it.entries };
    }
  }
  return undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Change one field: manual rows are edited directly, LLM rows get an edit on top (dropped again if equal). */
export function setField<T>(e: Entry<T>, field: keyof T, v: T[keyof T]) {
  if (e.manual) {
    e.base = { ...e.base, [field]: v };
    return;
  }
  const edit: Partial<T> = { ...e.edit, [field]: v };
  if (same(e.base[field], v)) delete edit[field];
  e.edit = Object.keys(edit).length ? edit : undefined;
}

export function restore(e: Entry<unknown>) {
  e.edit = undefined;
  e.disabled = undefined;
}

/** Next free id like R012 / S07 across all entries, including disabled ones (ids are never reused). */
export function nextNumber(items: Item<{ id: string }>[], prefix: string): number {
  return Math.max(0, ...allEntries(items).map((e) => (e.base.id.startsWith(prefix) ? parseInt(e.base.id.slice(prefix.length), 10) || 0 : 0))) + 1;
}

export function move<T>(list: T[], i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

// ---------- derived package contents ----------

export function buildSchema(st: ReproState, paper: { doi: string; title?: string }): ResultsSchema | undefined {
  const results = enabledValues(st.targets).map((r) => (st.figureFiles[r.id] ? { ...r, figure_file: st.figureFiles[r.id] } : r));
  if (!allEntries(st.targets).length) return undefined;
  return { schema_version: "1.0", paper, source_document: st.source, results };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Load steps (one per used data file) first, the enabled steps in table order, the results step last. */
export function buildPlan(st: ReproState): AnalysisPlan | undefined {
  if (!allEntries(st.steps).length) return undefined;
  const data = usedInputs(st, "data").map((i) => i.path);
  const loads: PlanStep[] = data.map((f, i) => ({ id: `L${pad(i + 1)}`, kind: "load", summary: `Load ${f}`, quote: "", source_ids: [], inputs: [f], depends_on: [], produces: [] }));
  const fileToLoad = new Map(loads.map((l) => [l.inputs[0], l.id]));
  const drafts = enabledValues(st.steps);
  const ids = new Set(drafts.map((d) => d.id));
  const targetIds = new Set(enabledValues(st.targets).map((r) => r.id));
  const mid: PlanStep[] = drafts.map((d, i) => {
    const inputs = d.inputs.filter((f) => fileToLoad.has(f));
    const deps = new Set([...d.depends_on.filter((x) => ids.has(x) && x !== d.id), ...inputs.map((f) => fileToLoad.get(f)!)]);
    if (!deps.size) (i === 0 ? loads.map((l) => l.id) : [drafts[i - 1].id]).forEach((x) => deps.add(x));
    return { ...d, inputs, depends_on: [...deps], produces: d.produces.filter((r) => targetIds.has(r)) };
  });
  const used = new Set(mid.flatMap((s) => s.depends_on));
  const sinks = mid.filter((s) => !used.has(s.id)).map((s) => s.id);
  const results: PlanStep = {
    id: "OUT",
    kind: "results",
    summary: "Collect all reproduced results and write outputs/results.json (format: schemas/results_output.schema.json); save figures to outputs/figures/<result id>.png",
    quote: "",
    source_ids: [],
    inputs: [],
    depends_on: sinks.length ? sinks : loads.map((l) => l.id),
    produces: [...targetIds],
  };
  return { schema_version: "1.0", steps: [...loads, ...mid, results] };
}

/** inputs.json written into the package: what each input file is and whether it is used. */
export function inputsManifest(st: ReproState) {
  return {
    inputs: st.inputs.map((i) => ({ path: i.path, role: i.role, note: i.note || undefined, used: !i.excluded })),
    archives: st.archives.map((a) => ({ name: a.name, unpacked_to: a.dir })),
  };
}
