/** Data contracts for the reproduction package, plus hand-written validators and JSON Schemas. */

export type ResultType = "number" | "categorical" | "table" | "figure";
export type Comparator = "=" | "<" | "<=" | ">" | ">=" | "~";
export const COMPARATORS: Comparator[] = ["=", "<", "<=", ">", ">=", "~"];

export interface TargetResult {
  id: string;
  type: ResultType;
  description: string;
  quote: string; // verbatim text from the paper
  source_ids: string[]; // sentence / block ids in the reference document
  source_label?: string; // e.g. section title or "Table 2"
  expected?: number | string | string[][];
  comparator?: Comparator;
  unit?: string;
  decimals?: number; // decimals as reported in the paper
  figure_file?: string; // crop of the original figure inside the package
}

export interface ResultsSchema {
  schema_version: "1.0";
  paper: { doi: string; title?: string };
  source_document: string;
  results: TargetResult[];
}

export type StepKind = "load" | "transform" | "analysis" | "results";
export interface PlanStep {
  id: string;
  kind: StepKind;
  summary: string;
  quote: string;
  source_ids: string[];
  inputs: string[]; // package-relative data paths
  depends_on: string[]; // step ids
  produces: string[]; // result ids
}
export interface AnalysisPlan {
  schema_version: "1.0";
  steps: PlanStep[];
}

export interface OutputResult {
  id: string;
  value?: number | string | null;
  table?: (string | number | null)[][];
  file?: string;
  step?: string;
  note?: string;
}
export interface ReproducedOutput {
  results: OutputResult[];
}

const isObj = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStrArr = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");

export function validateResultsSchema(x: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(x)) return ["root must be an object"];
  if (x.schema_version !== "1.0") errs.push('schema_version must be "1.0"');
  if (!isObj(x.paper) || typeof x.paper.doi !== "string") errs.push("paper.doi must be a string");
  if (!Array.isArray(x.results)) return [...errs, "results must be an array"];
  const seen = new Set<string>();
  x.results.forEach((r: any, i: number) => {
    const at = `results[${i}]${r?.id ? ` (${r.id})` : ""}`;
    if (!isObj(r)) return errs.push(`${at} must be an object`);
    if (typeof r.id !== "string" || !r.id) errs.push(`${at}: id must be a non-empty string`);
    else if (seen.has(r.id)) errs.push(`${at}: duplicate id`);
    else seen.add(r.id);
    if (!["number", "categorical", "table", "figure"].includes(r.type)) errs.push(`${at}: invalid type "${r.type}"`);
    if (typeof r.description !== "string" || !r.description) errs.push(`${at}: description required`);
    if (typeof r.quote !== "string") errs.push(`${at}: quote must be a string`);
    if (!isStrArr(r.source_ids)) errs.push(`${at}: source_ids must be a string array`);
    if (r.comparator !== undefined && !COMPARATORS.includes(r.comparator)) errs.push(`${at}: invalid comparator`);
    if (r.decimals !== undefined && !(Number.isInteger(r.decimals) && r.decimals >= 0)) errs.push(`${at}: decimals must be a non-negative integer`);
    if (r.type === "number" && typeof r.expected !== "number") errs.push(`${at}: numeric result needs a numeric expected value`);
    if (r.type === "categorical" && typeof r.expected !== "string") errs.push(`${at}: categorical result needs a string expected value`);
    if (r.type === "table" && !(Array.isArray(r.expected) && r.expected.every((row: unknown) => isStrArr(row)))) errs.push(`${at}: table result needs expected as array of string rows`);
  });
  return errs;
}

export function validatePlan(x: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(x) || !Array.isArray(x.steps)) return ["plan must be an object with a steps array"];
  const ids = new Set<string>();
  x.steps.forEach((s: any, i: number) => {
    const at = `steps[${i}]${s?.id ? ` (${s.id})` : ""}`;
    if (typeof s.id !== "string" || ids.has(s.id)) errs.push(`${at}: missing or duplicate id`);
    for (const d of s.depends_on ?? []) if (!ids.has(d)) errs.push(`${at}: depends on ${d}, which is not an earlier step`);
    ids.add(s.id);
    if (!["load", "transform", "analysis", "results"].includes(s.kind)) errs.push(`${at}: invalid kind`);
  });
  const kinds = x.steps.map((s: any) => s.kind);
  const firstNonLoad = kinds.findIndex((k: string) => k !== "load");
  if (firstNonLoad >= 0 && kinds.slice(firstNonLoad).includes("load")) errs.push("all load steps must come first");
  if (kinds[kinds.length - 1] !== "results") errs.push("the last step must be the results step");
  return errs;
}

/** Validate the reproduced outputs/results.json. Errors = not compliant; warnings = coverage issues. */
export function validateOutput(x: unknown, schema: ResultsSchema): { errors: string[]; warnings: string[]; output?: ReproducedOutput } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(x)) return { errors: ["root must be an object"], warnings };
  if (!Array.isArray(x.results)) return { errors: ["results must be an array"], warnings };
  const byId = new Map(schema.results.map((r) => [r.id, r]));
  const seen = new Set<string>();
  x.results.forEach((r: any, i: number) => {
    const at = `results[${i}]${r?.id ? ` (${r.id})` : ""}`;
    if (!isObj(r) || typeof r.id !== "string") return errors.push(`${at}: must be an object with a string id`);
    if (seen.has(r.id)) errors.push(`${at}: duplicate id`);
    seen.add(r.id);
    const t = byId.get(r.id);
    if (!t) return warnings.push(`${at}: id not in results schema`);
    if (t.type === "number" && !(typeof r.value === "number" || r.value === null)) errors.push(`${at}: expected numeric "value"`);
    if (t.type === "categorical" && !(typeof r.value === "string" || r.value === null)) errors.push(`${at}: expected string "value"`);
    if (t.type === "table" && !(Array.isArray(r.table) && r.table.every(Array.isArray))) errors.push(`${at}: expected "table" as array of rows`);
    if (t.type === "figure" && typeof r.file !== "string") errors.push(`${at}: expected "file" path to the figure`);
    if (r.step !== undefined && typeof r.step !== "string") errors.push(`${at}: step must be a string`);
  });
  for (const id of byId.keys()) if (!seen.has(id)) warnings.push(`${id}: missing from output`);
  return { errors, warnings, output: x as unknown as ReproducedOutput };
}

// JSON Schemas written into the package so agents/tools can validate independently.

export const RESULTS_OUTPUT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Reproduced results (outputs/results.json)",
  type: "object",
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "Result id from results_schema.json" },
          value: { type: ["number", "string", "null"], description: "For number/categorical results; full precision, unrounded" },
          table: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } }, description: "For table results; same layout as expected, header row included" },
          file: { type: "string", description: "For figure results: package-relative path, e.g. outputs/figures/R007.png" },
          step: { type: "string", description: "Id of the plan step that produced this result" },
          note: { type: "string" },
        },
      },
    },
  },
};

export const RESULTS_SCHEMA_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Reproduction targets (results_schema.json)",
  type: "object",
  required: ["schema_version", "paper", "results"],
  properties: {
    schema_version: { const: "1.0" },
    paper: { type: "object", required: ["doi"], properties: { doi: { type: "string" }, title: { type: "string" } } },
    source_document: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "type", "description", "quote", "source_ids"],
        properties: {
          id: { type: "string" },
          type: { enum: ["number", "categorical", "table", "figure"] },
          description: { type: "string" },
          quote: { type: "string" },
          source_ids: { type: "array", items: { type: "string" } },
          source_label: { type: "string" },
          expected: {},
          comparator: { enum: COMPARATORS },
          unit: { type: "string" },
          decimals: { type: "integer", minimum: 0 },
          figure_file: { type: "string" },
        },
      },
    },
  },
};

export const PLAN_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Analysis plan (analysis_plan.json)",
  type: "object",
  required: ["schema_version", "steps"],
  properties: {
    schema_version: { const: "1.0" },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "kind", "summary", "quote", "source_ids", "inputs", "depends_on", "produces"],
        properties: {
          id: { type: "string" },
          kind: { enum: ["load", "transform", "analysis", "results"] },
          summary: { type: "string" },
          quote: { type: "string", description: "Verbatim text from the paper this step implements" },
          source_ids: { type: "array", items: { type: "string" } },
          inputs: { type: "array", items: { type: "string" } },
          depends_on: { type: "array", items: { type: "string" } },
          produces: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};
