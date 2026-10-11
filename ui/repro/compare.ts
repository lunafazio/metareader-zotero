import type { Comparator, OutputResult, ReproducedOutput, ResultsSchema, TargetResult } from "./schemas";

export interface CompareSettings {
  rounding: "reported" | number; // "reported" = round to the decimals shown in the paper
  threshold: number; // deviation % above which a numeric result is flagged
}

export type Status = "match" | "within" | "deviation" | "missing" | "figure" | "unparsable";

export interface Cell { expected: string; reproduced: string; status: Status; deviation?: number }

export interface CompareRow {
  target: TargetResult;
  out?: OutputResult;
  status: Status;
  expectedText: string;
  reproducedText: string;
  deviation?: number;
  cells?: Cell[][];
  matched?: number;
  total?: number;
}

/** Parse a number as printed in papers: unicode minus, thousands separators, %, leading "<" etc. */
export function parseNum(s: unknown): number | undefined {
  if (typeof s === "number") return Number.isFinite(s) ? s : undefined;
  if (typeof s !== "string") return undefined;
  const t = s.replace(/[−–—]/g, "-").replace(/(\d),(\d{3})\b/g, "$1$2").replace(/[\s%*†‡§]/g, "").replace(/^[<>≤≥=~≈]+/, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return undefined;
  return Number(t);
}

export function decimalsOf(s: string | number): number {
  const m = String(s).replace(/[−–]/g, "-").match(/\.(\d+)/);
  return m ? m[1].length : 0;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

function deviationPct(exp: number, rep: number) {
  if (exp === 0) return rep === 0 ? 0 : Infinity;
  return (Math.abs(rep - exp) / Math.abs(exp)) * 100;
}

function compareNum(exp: number, rep: number, cmp: Comparator, reportedDecimals: number, st: CompareSettings): { status: Status; deviation: number } {
  const d = st.rounding === "reported" ? reportedDecimals : st.rounding;
  const dev = deviationPct(exp, rep);
  const r = round(rep, d);
  const e = round(exp, d);
  const eps = 10 ** -(d + 6);
  let ok: boolean;
  switch (cmp) {
    case "<": ok = rep < exp; break;
    case "<=": ok = r <= e + eps; break;
    case ">": ok = rep > exp; break;
    case ">=": ok = r >= e - eps; break;
    case "~": ok = Math.abs(r - e) < eps || dev <= st.threshold; break;
    default: ok = Math.abs(r - e) < eps;
  }
  if (ok) return { status: "match", deviation: dev };
  if (cmp !== "<" && cmp !== ">" && dev <= st.threshold) return { status: "within", deviation: dev };
  return { status: "deviation", deviation: dev };
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function fmt(x: unknown): string {
  if (x === null || x === undefined) return "—";
  if (typeof x === "number") return Number.isInteger(x) ? String(x) : String(+x.toPrecision(8));
  return String(x);
}

function compareTable(exp: string[][], rep: (string | number | null)[][], st: CompareSettings) {
  // Allow a reproduced table that omits the header row / label column.
  const rowOff = rep.length === exp.length - 1 ? 1 : 0;
  const colOff = (rep[0]?.length ?? 0) === (exp[0]?.length ?? 0) - 1 ? 1 : 0;
  let matched = 0;
  let total = 0;
  const cells: Cell[][] = exp.map((row, i) =>
    row.map((e, j) => {
      const rv = i >= rowOff && j >= colOff ? rep[i - rowOff]?.[j - colOff] : e; // header/label cells taken as given
      const en = parseNum(e);
      const rn = parseNum(rv);
      let status: Status;
      let deviation: number | undefined;
      if (en !== undefined) {
        total++;
        if (rn === undefined) status = "missing";
        else {
          const c = compareNum(en, rn, /^\s*</.test(e) ? "<" : /^\s*>/.test(e) ? ">" : "=", decimalsOf(e), st);
          status = c.status;
          deviation = c.deviation;
        }
      } else status = !norm(e) || norm(e) === norm(rv) ? "match" : "unparsable";
      if (en !== undefined && status === "match") matched++;
      return { expected: e, reproduced: fmt(rv), status, deviation };
    }),
  );
  return { cells, matched, total };
}

export function compareAll(schema: ResultsSchema, output: ReproducedOutput | undefined, st: CompareSettings): CompareRow[] {
  const outs = new Map((output?.results ?? []).map((r) => [r.id, r]));
  return schema.results.map((t): CompareRow => {
    const out = outs.get(t.id);
    const expectedText = t.type === "table" ? `${(t.expected as string[][])?.length ?? 0} rows` : t.type === "figure" ? "(figure)" : `${t.comparator && t.comparator !== "=" ? t.comparator + " " : ""}${fmt(t.expected)}${t.unit ? " " + t.unit : ""}`;
    const base = { target: t, out, expectedText };
    if (t.type === "figure") return { ...base, status: out?.file ? "figure" : "missing", reproducedText: out?.file ?? "—" };
    if (!out) return { ...base, status: "missing", reproducedText: "—" };
    if (t.type === "table") {
      if (!Array.isArray(out.table)) return { ...base, status: "missing", reproducedText: "—" };
      const r = compareTable(t.expected as string[][], out.table, st);
      const anyDev = r.cells.flat().some((c) => c.status === "deviation" || c.status === "missing" || c.status === "unparsable");
      const anyWithin = r.cells.flat().some((c) => c.status === "within");
      return { ...base, ...r, status: anyDev ? "deviation" : anyWithin ? "within" : "match", reproducedText: `${r.matched}/${r.total} numeric cells match` };
    }
    if (out.value === null || out.value === undefined) return { ...base, status: "missing", reproducedText: out.note ? `— (${out.note})` : "—" };
    if (t.type === "categorical") return { ...base, status: norm(out.value) === norm(t.expected) ? "match" : "deviation", reproducedText: fmt(out.value) };
    const e = typeof t.expected === "number" ? t.expected : parseNum(t.expected);
    const r = parseNum(out.value);
    if (e === undefined || r === undefined) return { ...base, status: "unparsable", reproducedText: fmt(out.value) };
    const c = compareNum(e, r, t.comparator ?? "=", t.decimals ?? decimalsOf(e), st);
    const d = st.rounding === "reported" ? t.decimals ?? decimalsOf(e) : st.rounding;
    return { ...base, status: c.status, deviation: c.deviation, reproducedText: `${round(r, d).toFixed(d)}  (${fmt(r)})` };
  });
}

export const STATUS_LABEL: Record<Status, string> = {
  match: "✓ match",
  within: "≈ within tolerance",
  deviation: "✗ deviation",
  missing: "∅ missing",
  figure: "🖼 compare visually",
  unparsable: "? not comparable",
};
