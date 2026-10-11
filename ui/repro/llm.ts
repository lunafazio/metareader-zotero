import type { Block, DocModel, Sentence } from "../model";
import type { ResultsSchema, TargetResult } from "./schemas";
import type { StepDraft } from "./state";
import { decimalsOf, parseNum } from "./compare";

/** Extract the first JSON object/array from LLM output (tolerates prose and code fences). */
export function extractJson(text: string): any {
  const t = text.replace(/```(?:json)?/g, "");
  const starts = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) throw new Error("No JSON found in model output:\n" + text.slice(0, 1000));
  const start = Math.min(...starts);
  const close = t[start] === "{" ? "}" : "]";
  for (let end = t.lastIndexOf(close); end > start; end = t.lastIndexOf(close, end - 1)) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch { /* try a shorter span */ }
  }
  throw new Error("Could not parse JSON from model output:\n" + text.slice(0, 1000));
}

interface Located { sentence?: Sentence; block: Block; section: string }

/** Index every sentence and float of a document by id, with its section title. */
export function indexDoc(model: DocModel) {
  const sentences = new Map<string, Located>();
  const blocks = new Map<string, { block: Block; section: string }>();
  for (const sec of model.sections)
    for (const b of sec.blocks) {
      blocks.set(b.id, { block: b, section: sec.title });
      for (const s of b.kind === "p" ? b.sentences : b.caption) sentences.set(s.id, { sentence: s, block: b, section: sec.title });
    }
  return { sentences, blocks };
}

function sentenceListing(model: DocModel, ids: string[]): string {
  const { sentences } = indexDoc(model);
  let lastSection = "";
  const lines: string[] = [];
  for (const id of ids) {
    const loc = sentences.get(id);
    if (!loc?.sentence) continue;
    if (loc.section !== lastSection) lines.push(`\n## ${(lastSection = loc.section)}`);
    lines.push(`[${id}] ${loc.sentence.text}`);
  }
  return lines.join("\n");
}

export function resultsPrompt(model: DocModel, sentenceIds: string[], tableIds: string[]): string {
  const { blocks } = indexDoc(model);
  const tables = tableIds
    .map((id) => blocks.get(id)?.block)
    .filter((b): b is Extract<Block, { kind: "table" }> => b?.kind === "table")
    .map((b) => `[${b.id}] ${b.label}: ${b.caption.map((s) => s.text).join(" ")}\n${b.rows.map((r) => r.join("\t")).join("\n")}`);
  return `Extract quantitative and categorical RESULTS from the following excerpts of a scholarly paper, as reproduction targets for a computational reproducibility check.

Return ONLY JSON of the form {"results": [ ... ]} where each item is:
{
  "source_ids": ["<id(s) in brackets the result comes from>"],
  "type": "number" | "categorical" | "table",
  "description": "<self-contained description of what is measured, incl. variable, model/test, subgroup>",
  "quote": "<verbatim substring of the source text containing the result>",
  "expected": <number for type number; string for categorical; for tables: array of rows of cell strings exactly as printed, header row included>,
  "comparator": "=" | "<" | "<=" | ">" | ">=" | "~",   // e.g. "p < .001" -> "<" with expected 0.001; "approximately" -> "~"
  "unit": "<unit or empty>",
  "decimals": <number of decimals as printed>
}

Guidelines:
- One item per distinct reported number (estimates, CIs bounds as separate items, test statistics, p-values, percentages, sample sizes, means, SDs). Skip numbers that are not results (years, citations, section numbers, parameter settings).
- Categorical: qualitative findings that can be checked (e.g. "significant", direction of effect).
- Each table excerpt becomes exactly ONE item of type "table".
- Percentages: expected is the number as printed (e.g. 76 with unit "%").

SENTENCES:${sentenceListing(model, sentenceIds) || "\n(none)"}

TABLES:
${tables.join("\n\n") || "(none)"}
`;
}

/** Normalize model output into target results with fresh sequential ids (R001…). */
export function toTargets(raw: any, model: DocModel, startIndex: number): TargetResult[] {
  const { sentences, blocks } = indexDoc(model);
  const items: any[] = Array.isArray(raw) ? raw : raw?.results ?? [];
  return items.map((r, i): TargetResult => {
    const type = ["number", "categorical", "table"].includes(r.type) ? r.type : "number";
    const ids: string[] = Array.isArray(r.source_ids) ? r.source_ids.map(String) : [];
    const firstLoc = ids.map((id) => sentences.get(id) ?? blocks.get(id)).find(Boolean);
    let expected = r.expected;
    if (type === "number" && typeof expected !== "number") expected = parseNum(expected) ?? expected;
    if (type === "table" && Array.isArray(expected)) expected = expected.map((row: any[]) => (Array.isArray(row) ? row.map((c) => String(c ?? "")) : [String(row)]));
    const decimals = Number.isInteger(r.decimals) ? r.decimals : typeof expected === "number" ? decimalsOf(String(r.expected)) : undefined;
    const block = firstLoc?.block;
    return {
      id: `R${String(startIndex + i + 1).padStart(3, "0")}`,
      type,
      description: String(r.description ?? ""),
      quote: String(r.quote ?? ""),
      source_ids: ids,
      source_label: block && block.kind !== "p" ? block.label : firstLoc?.section,
      expected,
      comparator: r.comparator && r.comparator !== "=" ? r.comparator : undefined,
      unit: r.unit || undefined,
      decimals,
    };
  });
}

export function figureTargets(model: DocModel, figureIds: string[], startIndex: number): TargetResult[] {
  const { blocks } = indexDoc(model);
  return figureIds
    .map((id) => blocks.get(id)?.block)
    .filter((b): b is Extract<Block, { kind: "figure" }> => b?.kind === "figure")
    .map((b, i) => ({
      id: `R${String(startIndex + i + 1).padStart(3, "0")}`,
      type: "figure" as const,
      description: `${b.label}: ${b.caption.map((s) => s.text).join(" ")}`.slice(0, 400),
      quote: b.caption.map((s) => s.text).join(" "),
      source_ids: [b.id],
      source_label: b.label,
    }));
}

export interface PromptInput { path: string; note: string }

export function planPrompt(model: DocModel, sentenceIds: string[], data: PromptInput[], code: PromptInput[], schema?: ResultsSchema): string {
  const results = schema?.results.map((r) => `${r.id} (${r.type}): ${r.description}`).join("\n") || "(none defined yet)";
  const list = (xs: PromptInput[]) => xs.map((x) => `- ${x.path}${x.note ? ` — ${x.note}` : ""}`).join("\n");
  return `Turn the following excerpts of a scholarly paper's methods into an ordered ANALYSIS PLAN for a computational reproduction.

Available data files (package-relative):
${list(data) || "(none)"}
${code.length ? `Original code files provided:\n${list(code)}\n` : ""}
Reproduction targets:
${results}

Return ONLY JSON: {"steps": [ ... ]} with each step:
{
  "key": "A1",                       // A1, A2, … in order
  "kind": "transform" | "analysis",
  "summary": "<imperative description of exactly what to compute, specific enough to code>",
  "quote": "<verbatim text from the excerpts this step implements>",
  "source_ids": ["<sentence ids>"],
  "inputs": ["<data files used directly, if any>"],
  "depends_on": ["<keys of earlier steps>"],
  "produces": ["<result ids from the target list computed by this step>"]
}

Do NOT include steps for loading data files or for writing the final results file; those are added automatically.
Keep the paper's order where possible; split compound procedures into separate steps; do not invent procedures that the text does not describe.

EXCERPTS:${sentenceListing(model, sentenceIds)}
`;
}

/** Normalize model output into plan step drafts with fresh ids (S<start>…); load and results steps are added later. */
export function toStepDrafts(raw: any, dataFiles: string[], start: number): StepDraft[] {
  const items: any[] = Array.isArray(raw) ? raw : raw?.steps ?? [];
  const files = new Set(dataFiles);
  const keyToId = new Map<string, string>();
  const ids = items.map((s, i) => {
    const id = `S${String(start + i).padStart(2, "0")}`;
    keyToId.set(String(s.key ?? `A${i + 1}`), id);
    return id;
  });
  return items.map((s, i): StepDraft => {
    const strs = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
    const deps = strs(s.depends_on);
    return {
      id: ids[i],
      kind: s.kind === "transform" ? "transform" : "analysis",
      summary: String(s.summary ?? ""),
      quote: String(s.quote ?? ""),
      source_ids: strs(s.source_ids),
      // Data files named as dependencies are inputs; load steps are generated from the inputs.
      inputs: [...new Set([...strs(s.inputs), ...deps].filter((f) => files.has(f)))],
      depends_on: deps.map((d) => keyToId.get(d)).filter((d): d is string => !!d && d !== ids[i]),
      produces: strs(s.produces),
    };
  });
}
