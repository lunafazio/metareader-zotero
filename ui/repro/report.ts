import { CompareRow, CompareSettings, STATUS_LABEL, Status } from "./compare";
import type { AnalysisPlan, ResultsSchema } from "./schemas";
import type { InputMeta } from "./state";
import { TEMPLATES, TemplateId } from "./templates";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export interface ReportFile { path: string; size: number; sha256?: string | null }

export interface ReportInput {
  title: string;
  doi: string;
  authors: string;
  schema: ResultsSchema;
  plan: AnalysisPlan;
  rows: CompareRow[];
  settings: CompareSettings;
  files: ReportFile[];
  inputs: InputMeta[];
  template: TemplateId;
  command: string;
  run?: { code: number | null; duration_ms: number; at: string };
  validation: { errors: string[]; warnings: string[] };
  figures: Map<string, { original?: string; reproduced?: string }>; // data URLs
  generatedAt: string;
}

const STATUS_COLOR: Record<Status | "data" | "step", string> = {
  match: "#2e7d32", within: "#b58900", deviation: "#c62828", missing: "#757575", figure: "#1565c0", unparsable: "#6a1b9a",
  data: "#455a64", step: "#2a5aa0",
};

/** Layered DAG: data files → steps (by dependency depth) → results. Returns an SVG string. */
export function provenanceSvg(plan: AnalysisPlan, rows: CompareRow[]): string {
  type N = { id: string; label: string; title: string; layer: number; color: string; y?: number; x?: number };
  const nodes = new Map<string, N>();
  const edges: [string, string][] = [];
  const files = [...new Set(plan.steps.flatMap((s) => s.inputs))];
  files.forEach((f) => nodes.set("f:" + f, { id: "f:" + f, label: f.replace(/^inputs\//, ""), title: f, layer: 0, color: STATUS_COLOR.data }));
  const layerOf = new Map<string, number>();
  for (const s of plan.steps) {
    const l = Math.max(0, ...s.depends_on.map((d) => layerOf.get(d) ?? 0), ...(s.inputs.length ? [0] : [])) + 1;
    layerOf.set(s.id, l);
    nodes.set("s:" + s.id, { id: "s:" + s.id, label: `${s.id} ${s.summary}`, title: `${s.id} [${s.kind}] ${s.summary}`, layer: l, color: STATUS_COLOR.step });
    s.inputs.forEach((f) => edges.push(["f:" + f, "s:" + s.id]));
    s.depends_on.forEach((d) => edges.push(["s:" + d, "s:" + s.id]));
  }
  const maxStep = Math.max(1, ...layerOf.values());
  const producedBy = new Map<string, string>();
  for (const s of plan.steps) for (const r of s.produces) if (s.kind !== "results" || !producedBy.has(r)) producedBy.set(r, s.id);
  for (const row of rows) {
    // Reproduced output may declare the producing step; fall back to the plan's mapping.
    const step = row.out?.step && layerOf.has(row.out.step) ? row.out.step : producedBy.get(row.target.id);
    nodes.set("r:" + row.target.id, { id: "r:" + row.target.id, label: `${row.target.id} ${row.target.description}`, title: `${row.target.id}: ${row.target.description} — ${STATUS_LABEL[row.status]}`, layer: maxStep + 1, color: STATUS_COLOR[row.status] });
    if (step) edges.push(["s:" + step, "r:" + row.target.id]);
  }
  const W = 190, H = 30, GX = 70, GY = 10;
  const layers: N[][] = [];
  for (const n of nodes.values()) (layers[n.layer] ??= []).push(n);
  layers.forEach((col, i) => col?.forEach((n, j) => { n.x = 10 + i * (W + GX); n.y = 10 + j * (H + GY); }));
  const width = 20 + layers.length * (W + GX) - GX;
  const height = 20 + Math.max(...layers.map((c) => c?.length ?? 0)) * (H + GY);
  const paths = edges
    .filter(([a, b]) => nodes.has(a) && nodes.has(b))
    .map(([a, b]) => {
      const p = nodes.get(a)!, q = nodes.get(b)!;
      const x1 = p.x! + W, y1 = p.y! + H / 2, x2 = q.x!, y2 = q.y! + H / 2, mx = (x1 + x2) / 2;
      return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" />`;
    })
    .join("");
  const boxes = [...nodes.values()]
    .map((n) => `<g><title>${esc(n.title)}</title><rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="5" fill="${n.color}" /><text x="${n.x! + 7}" y="${n.y! + H / 2 + 4}">${esc(trunc(n.label, 30))}</text></g>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="dag"><style>.dag path{fill:none;stroke:#9aa;stroke-width:1.2}.dag text{fill:#fff;font:11px system-ui,sans-serif}</style>${paths}${boxes}</svg>`;
}

function tree(files: ReportFile[]): string {
  const lines: string[] = [];
  const seenDirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join("/");
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        lines.push(`${"  ".repeat(i)}${parts[i]}/`);
      }
    }
    lines.push(`${"  ".repeat(parts.length - 1)}${parts[parts.length - 1]}  (${(f.size / 1024).toFixed(1)} KB)`);
  }
  return lines.join("\n");
}

function expectedCell(v: unknown) {
  return Array.isArray(v) ? `${v.length}×${(v[0] as unknown[])?.length ?? 0} table` : esc(v);
}

export function buildReport(r: ReportInput): string {
  const counts = r.rows.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {});
  const numeric = r.rows.filter((x) => x.target.type !== "figure");
  const reproduced = numeric.filter((x) => x.status === "match" || x.status === "within").length;
  const byPath = new Map(r.files.map((f) => [f.path, f]));
  const inputRows = (xs: InputMeta[]) =>
    xs.map((i) => {
      const f = byPath.get(i.path);
      return `<tr><td><code>${esc(i.path)}</code></td><td>${i.role}</td><td>${esc(i.note)}</td><td>${f ? (f.size / 1024).toFixed(1) + " KB" : ""}</td><td><code class="hash">${esc(f?.sha256 ?? "")}</code></td></tr>`;
    }).join("") || `<tr><td colspan="5">none</td></tr>`;
  const usedInputs = r.inputs.filter((i) => !i.excluded);
  const excluded = r.inputs.filter((i) => i.excluded);

  const resultRows = r.rows
    .map((x) => {
      const fig = r.figures.get(x.target.id);
      const figHtml = x.target.type === "figure"
        ? `<tr class="figrow"><td colspan="6"><div class="figs"><figure><figcaption>Original</figcaption>${fig?.original ? `<img src="${fig.original}">` : "<em>not available</em>"}</figure><figure><figcaption>Reproduced</figcaption>${fig?.reproduced ? `<img src="${fig.reproduced}">` : "<em>not produced</em>"}</figure></div></td></tr>`
        : "";
      const cells = x.cells
        ? `<tr class="figrow"><td colspan="6"><details><summary>Cell comparison</summary><table class="cells">${x.cells.map((row) => `<tr>${row.map((c) => `<td class="st-${c.status}" title="expected ${esc(c.expected)}${c.deviation !== undefined ? `, deviation ${c.deviation.toFixed(2)}%` : ""}">${esc(c.reproduced)}<br><small>${esc(c.expected)}</small></td>`).join("")}</tr>`).join("")}</table></details></td></tr>`
        : "";
      return `<tr><td><b>${x.target.id}</b></td><td>${esc(x.target.description)}<div class="quote">“${esc(trunc(x.target.quote, 300))}”</div></td><td>${esc(x.expectedText)}</td><td>${esc(x.reproducedText)}</td><td>${x.deviation !== undefined && Number.isFinite(x.deviation) ? x.deviation.toFixed(2) + "%" : ""}</td><td class="st st-${x.status}">${STATUS_LABEL[x.status]}</td></tr>${cells}${figHtml}`;
    })
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Reproduction report — ${esc(r.title)}</title>
<style>
body{font:15px/1.5 Georgia,serif;max-width:1100px;margin:2em auto;padding:0 1.5em;color:#1d1d1b}
h1{font-size:1.6em;line-height:1.25}h2{font-family:system-ui,sans-serif;border-bottom:1px solid #ddd;padding-bottom:.2em;margin-top:2em}
table{border-collapse:collapse;width:100%;font:13px system-ui,sans-serif;margin:.5em 0}th,td{border:1px solid #ddd;padding:4px 6px;vertical-align:top;text-align:left}th{background:#f3f3ef}
code{font-size:12px}.hash{font-size:10px;color:#777;word-break:break-all}.quote{color:#666;font-style:italic;font-size:12px;margin-top:2px}
.summary{display:flex;gap:10px;flex-wrap:wrap;font:14px system-ui,sans-serif}.summary div{padding:8px 12px;border-radius:6px;background:#f3f3ef}
.st{white-space:nowrap;font-weight:600}.st-match{color:#2e7d32}.st-within{color:#b58900}.st-deviation{color:#c62828}.st-missing{color:#757575}.st-figure{color:#1565c0}.st-unparsable{color:#6a1b9a}
.cells td{font-size:11px;text-align:right}.cells td.st-match{background:#e8f5e9}.cells td.st-within{background:#fff8e1}.cells td.st-deviation,.cells td.st-missing,.cells td.st-unparsable{background:#ffebee}
.figs{display:grid;grid-template-columns:1fr 1fr;gap:12px}.figs img{max-width:100%;border:1px solid #ddd}.figs figure{margin:0}
pre{background:#f7f7f3;padding:10px;overflow:auto;font-size:12px}.dagwrap{overflow:auto;border:1px solid #ddd;padding:6px}
.warn{color:#b3261e}.legend span{display:inline-block;padding:1px 6px;border-radius:3px;color:#fff;font:11px system-ui;margin-right:4px}
</style></head><body>
<h1>Computational reproduction report<br><small>${esc(r.title)}</small></h1>
<p>${esc(r.authors)}<br>DOI: <a href="https://doi.org/${esc(r.doi)}">${esc(r.doi)}</a><br>Report generated ${esc(r.generatedAt)} by MetaReader.</p>

<h2>Summary</h2>
<div class="summary">
<div><b>${reproduced}/${numeric.length}</b> non-figure results reproduced (match or within ${r.settings.threshold}%)</div>
${Object.entries(counts).map(([k, v]) => `<div class="st-${k}">${STATUS_LABEL[k as Status]}: <b>${v}</b></div>`).join("")}
</div>
<p>Comparison settings: rounding = ${r.settings.rounding === "reported" ? "as reported in the paper" : `${r.settings.rounding} decimals`}; deviations above ${r.settings.threshold}% are flagged.
Pipeline: ${esc(TEMPLATES[r.template].label)} — <code>${esc(r.command)}</code>${r.run ? `, exit code ${r.run.code}, ${(r.run.duration_ms / 1000).toFixed(1)} s (${esc(r.run.at)})` : " (not run)"}.</p>
${r.validation.errors.length ? `<p class="warn"><b>Output schema validation failed:</b><br>${r.validation.errors.map(esc).join("<br>")}</p>` : `<p>Output schema validation passed.</p>`}
${r.validation.warnings.length ? `<details><summary>${r.validation.warnings.length} validation warnings</summary><p>${r.validation.warnings.map(esc).join("<br>")}</p></details>` : ""}

<h2>Results comparison</h2>
<table><tr><th>ID</th><th>Result</th><th>Reported</th><th>Reproduced</th><th>Deviation</th><th>Status</th></tr>${resultRows}</table>

<h2>Result provenance</h2>
<p class="legend"><span style="background:${STATUS_COLOR.data}">data</span><span style="background:${STATUS_COLOR.step}">step</span>${(["match", "within", "deviation", "missing", "figure"] as Status[]).map((s) => `<span style="background:${STATUS_COLOR[s]}">${s}</span>`).join("")}</p>
<div class="dagwrap">${provenanceSvg(r.plan, r.rows)}</div>

<h2>Input files</h2>
<table><tr><th>File</th><th>Role</th><th>Note</th><th>Size</th><th>SHA-256</th></tr>${inputRows(usedInputs)}</table>
${excluded.length ? `<h3>Excluded archive members</h3><p>Unpacked from uploaded archives but not used.</p><table><tr><th>File</th><th>Role</th><th>Note</th><th>Size</th><th>SHA-256</th></tr>${inputRows(excluded)}</table>` : ""}

<h2>Analysis plan</h2>
<table><tr><th>Step</th><th>Kind</th><th>Summary &amp; source quote</th><th>Depends on</th><th>Produces</th></tr>
${r.plan.steps.map((s) => `<tr><td><b>${s.id}</b></td><td>${s.kind}</td><td>${esc(s.summary)}${s.quote ? `<div class="quote">“${esc(s.quote)}”</div>` : ""}${s.inputs.length ? `<div><code>${s.inputs.map(esc).join(", ")}</code></div>` : ""}</td><td>${s.depends_on.join(", ")}</td><td>${esc(trunc(s.produces.join(", "), 120))}</td></tr>`).join("")}</table>

<h2>Results schema</h2>
<table><tr><th>ID</th><th>Type</th><th>Description</th><th>Expected</th><th>Source</th></tr>
${r.schema.results.map((t) => `<tr><td><b>${t.id}</b></td><td>${t.type}</td><td>${esc(t.description)}<div class="quote">“${esc(trunc(t.quote, 300))}”</div></td><td>${t.comparator && t.comparator !== "=" ? esc(t.comparator) + " " : ""}${expectedCell(t.expected)}${t.unit ? " " + esc(t.unit) : ""}${t.decimals !== undefined ? ` <small>(${t.decimals} dp)</small>` : ""}</td><td>${esc(t.source_label ?? "")}</td></tr>`).join("")}</table>

<h2>Package structure</h2>
<p>The package is self-contained: <code>inputs/</code> holds the input files (described in <code>inputs.json</code>), <code>${esc(TEMPLATES[r.template].script)}</code> is the ${esc(TEMPLATES[r.template].label.toLowerCase())}, <code>analysis_plan.json</code> and <code>results_schema.json</code> describe steps and targets (JSON Schemas in <code>schemas/</code>), and <code>outputs/results.json</code> holds the reproduced values. Re-run with <code>${esc(r.command)}</code>.</p>
<pre>${esc(tree(r.files))}</pre>
</body></html>`;
}
