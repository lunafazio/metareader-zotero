import { Block, Box, DocModel, IdGen, Section, cleanText, sentencesFrom } from "../model";

/* Minimal typings for the DoclingDocument JSON schema. */
interface Ref { $ref?: string; cref?: string }
interface Prov { page_no: number; bbox: { l: number; t: number; r: number; b: number; coord_origin?: string } }
interface Node { self_ref: string; label?: string; text?: string; level?: number; children?: Ref[]; captions?: Ref[]; prov?: Prov[]; data?: { grid?: { text: string }[][]; table_cells?: { text: string; start_row_offset_idx: number; start_col_offset_idx: number }[]; num_rows?: number; num_cols?: number } }

const SKIP = new Set(["page_header", "page_footer", "caption"]);

function boxes(prov?: Prov[]): Box[] | undefined {
  if (!prov?.length) return undefined;
  return prov.map(({ page_no, bbox }) => {
    const top = (bbox.coord_origin ?? "BOTTOMLEFT").toUpperCase() === "TOPLEFT";
    return top
      ? { page: page_no, x0: bbox.l, y0: bbox.t, x1: bbox.r, y1: bbox.b, origin: "top" as const }
      : { page: page_no, x0: bbox.l, y0: bbox.b, x1: bbox.r, y1: bbox.t, origin: "bottom" as const };
  });
}

export function parseDocling(json: string, source: string): DocModel {
  const d = JSON.parse(json);
  const ids = new IdGen();
  const resolve = (r: Ref): Node | undefined => {
    const ref = r.$ref ?? r.cref;
    if (!ref) return undefined;
    const [, coll, idx] = ref.split("/");
    return idx === undefined ? d[coll] : d[coll]?.[Number(idx)];
  };

  const sections: Section[] = [];
  let current: Section = { id: ids.next("sec"), title: "(Front matter)", level: 1, blocks: [] };
  sections.push(current);
  let title: string | undefined;

  const captionOf = (n: Node) => {
    const caps = (n.captions ?? []).map(resolve).filter(Boolean) as Node[];
    const text = caps.map((c) => c.text ?? "").join(" ");
    const capBoxes = caps.flatMap((c) => boxes(c.prov) ?? []);
    return sentencesFrom(text, ids, capBoxes.length ? capBoxes : boxes(n.prov));
  };

  const tableRows = (n: Node): string[][] => {
    const data = n.data;
    if (data?.grid?.length) return data.grid.map((row) => row.map((c) => cleanText(c.text ?? "")));
    if (data?.table_cells && data.num_rows && data.num_cols) {
      const g = Array.from({ length: data.num_rows }, () => Array<string>(data.num_cols!).fill(""));
      for (const c of data.table_cells) g[c.start_row_offset_idx][c.start_col_offset_idx] = cleanText(c.text);
      return g;
    }
    return [];
  };

  const visit = (n: Node | undefined) => {
    if (!n) return;
    const kind = n.self_ref.split("/")[1];
    const label = n.label ?? "";
    if (kind === "texts" && !SKIP.has(label)) {
      const text = cleanText(n.text ?? "");
      if (!text) return;
      if (label === "title") {
        title ??= text;
        current.blocks.push({ kind: "p", id: ids.next("p"), sentences: sentencesFrom(text, ids, boxes(n.prov)), boxes: boxes(n.prov) });
      } else if (label === "section_header") {
        current = { id: ids.next("sec"), title: text, level: Math.max(1, n.level ?? 1), titleBoxes: boxes(n.prov), blocks: [] };
        sections.push(current);
      } else {
        const b = boxes(n.prov);
        const block: Block = { kind: "p", id: ids.next("p"), sentences: sentencesFrom(text, ids, b), boxes: b };
        current.blocks.push(block);
      }
    } else if (kind === "tables") {
      const cap = captionOf(n);
      current.blocks.push({ kind: "table", id: ids.next("t"), label: cap[0]?.text.match(/^(Table\s*\S+)/i)?.[1] ?? "Table", caption: cap, rows: tableRows(n), boxes: boxes(n.prov) });
    } else if (kind === "pictures") {
      const cap = captionOf(n);
      current.blocks.push({ kind: "figure", id: ids.next("f"), label: cap[0]?.text.match(/^(Fig(?:ure|\.)?\s*\S+)/i)?.[1] ?? "Figure", caption: cap, boxes: boxes(n.prov) });
      return; // don't descend into text inside pictures
    }
    for (const c of n.children ?? []) visit(resolve(c));
  };

  visit(d.body);
  return { source, title, sections: sections.filter((s) => s.blocks.length || s.title !== "(Front matter)") };
}
