import { Block, DocModel, IdGen, Section, cleanText, sentencesFrom } from "../model";
import { firstDesc, kids, parseXml, textOf } from "./xml";

const FLOATS = new Set(["fig", "table-wrap", "fig-group", "table-wrap-group"]);

export function parseJats(xml: string, source: string): DocModel {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  const ids = new IdGen();
  const sections: Section[] = [];

  const meta = firstDesc(root, "article-meta");
  const title = meta ? cleanText(textOf(firstDesc(meta, "article-title"))) : undefined;

  const float = (el: Element): Block[] => {
    if (el.localName.endsWith("-group")) return Array.from(el.children).filter((c) => FLOATS.has(c.localName)).flatMap(float);
    const label = cleanText(textOf(kids(el, "label")[0]));
    const caption = sentencesFrom(textOf(kids(el, "caption")[0]), ids);
    if (el.localName === "table-wrap") {
      const table = firstDesc(el, "table");
      const rows = table
        ? Array.from(table.getElementsByTagNameNS("*", "tr")).map((tr) =>
            Array.from(tr.children).filter((c) => c.localName === "td" || c.localName === "th").map((c) => cleanText(textOf(c))),
          )
        : [];
      return [{ kind: "table", id: ids.next("t"), label: label || "Table", caption, rows }];
    }
    return [{ kind: "figure", id: ids.next("f"), label: label || "Figure", caption }];
  };

  /** Paragraph text without embedded floats; floats are returned as separate blocks after it. */
  const paragraph = (p: Element): Block[] => {
    const clone = p.cloneNode(true) as Element;
    const floats: Block[] = [];
    for (const f of Array.from(clone.querySelectorAll("*")).filter((e) => FLOATS.has(e.localName))) {
      if (!f.parentElement || !clone.contains(f)) continue;
      floats.push(...float(f));
      f.remove();
    }
    const sentences = sentencesFrom(textOf(clone), ids);
    return [...(sentences.length ? [{ kind: "p" as const, id: ids.next("p"), sentences }] : []), ...floats];
  };

  const container = (el: Element, sec: Section, level: number) => {
    for (const c of Array.from(el.children)) {
      const n = c.localName;
      if (n === "p") sec.blocks.push(...paragraph(c));
      else if (FLOATS.has(n)) sec.blocks.push(...float(c));
      else if (n === "sec") walkSec(c, level + 1);
      else if (n === "list") for (const li of Array.from(c.getElementsByTagNameNS("*", "list-item"))) sec.blocks.push(...paragraph(li));
      else if (n === "disp-formula" || n === "disp-quote" || n === "boxed-text") sec.blocks.push(...paragraph(c));
    }
  };

  const walkSec = (el: Element, level: number, fallback = "(Untitled section)") => {
    const sec: Section = { id: ids.next("sec"), title: cleanText(textOf(kids(el, "title")[0])) || fallback, level, blocks: [] };
    sections.push(sec);
    container(el, sec, level);
  };

  if (meta) for (const abs of kids(meta, "abstract")) {
    if (abs.getAttribute("abstract-type") && kids(abs, "sec").length === 0 && !kids(abs, "p").length) continue;
    walkSec(abs, 1, abs.getAttribute("abstract-type") ? `Abstract (${abs.getAttribute("abstract-type")})` : "Abstract");
  }

  const body = firstDesc(root, "body");
  if (body) {
    const loose: Section = { id: ids.next("sec"), title: "(Body)", level: 1, blocks: [] };
    sections.push(loose);
    container(body, loose, 0);
  }

  const back = firstDesc(root, "back");
  if (back) for (const c of Array.from(back.children)) {
    if (c.localName === "ack" || c.localName === "sec" || c.localName === "app-group" || c.localName === "notes") {
      if (c.localName === "app-group") kids(c, "app").forEach((a) => walkSec(a, 1, "Appendix"));
      else walkSec(c, 1, c.localName === "ack" ? "Acknowledgements" : "Notes");
    }
  }

  const floatsGroup = firstDesc(root, "floats-group");
  if (floatsGroup) {
    const sec: Section = { id: ids.next("sec"), title: "Figures & tables", level: 1, blocks: [] };
    for (const c of Array.from(floatsGroup.children)) if (FLOATS.has(c.localName)) sec.blocks.push(...float(c));
    sections.push(sec);
  }

  return { source, title, sections: sections.filter((s) => s.blocks.length || s.title !== "(Body)") };
}
