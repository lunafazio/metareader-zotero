import { Block, Box, DocModel, IdGen, Section, Sentence, cleanText, sentencesFrom } from "../model";
import { kids, firstDesc, parseXml, textOf } from "./xml";

/** GROBID coords: "page,x,y,w,h;page,x,y,w,h" with top-left origin. */
export function parseCoords(attr: string | null): Box[] | undefined {
  if (!attr) return undefined;
  const boxes: Box[] = [];
  for (const part of attr.split(";")) {
    const [p, x, y, w, h] = part.split(",").map(Number);
    if ([p, x, y, w, h].some((n) => Number.isNaN(n))) continue;
    boxes.push({ page: p, x0: x, y0: y, x1: x + w, y1: y + h, origin: "top" });
  }
  return boxes.length ? boxes : undefined;
}

export function parseTei(xml: string, source: string): DocModel {
  const doc = parseXml(xml);
  const ids = new IdGen();
  const sections: Section[] = [];

  const titleEl = firstDesc(doc.documentElement, "titleStmt");
  const title = titleEl ? cleanText(textOf(firstDesc(titleEl, "title"))) : undefined;

  const paragraph = (p: Element): Block => {
    const pBoxes = parseCoords(p.getAttribute("coords"));
    const sEls = kids(p, "s");
    const sentences: Sentence[] = sEls.length
      ? sEls
          .map((s) => ({ id: ids.next("s"), text: cleanText(textOf(s)), boxes: parseCoords(s.getAttribute("coords")), fallbackBoxes: pBoxes }))
          .filter((s) => s.text)
      : sentencesFrom(textOf(p), ids, pBoxes);
    return { kind: "p", id: ids.next("p"), sentences, boxes: pBoxes };
  };

  const captionSentences = (fig: Element, boxes?: Box[]): Sentence[] => {
    const desc = firstDesc(fig, "figDesc");
    const head = kids(fig, "head")[0];
    const text = [textOf(head), textOf(desc)].filter(Boolean).join(" ");
    if (desc && kids(desc, "s").length) {
      return kids(desc, "s").map((s) => ({ id: ids.next("s"), text: cleanText(textOf(s)), boxes: parseCoords(s.getAttribute("coords")), fallbackBoxes: boxes }));
    }
    return sentencesFrom(text, ids, boxes);
  };

  const figure = (fig: Element): Block => {
    const boxes = parseCoords(fig.getAttribute("coords"));
    const label = cleanText([textOf(kids(fig, "head")[0]), textOf(kids(fig, "label")[0])].filter(Boolean).join(" "));
    if (fig.getAttribute("type") === "table") {
      const rows = firstDesc(fig, "table")
        ? kids(firstDesc(fig, "table")!, "row").map((r) => kids(r, "cell").map((c) => cleanText(textOf(c))))
        : [];
      return { kind: "table", id: ids.next("t"), label: label || "Table", caption: captionSentences(fig, boxes), rows, boxes };
    }
    return { kind: "figure", id: ids.next("f"), label: label || "Figure", caption: captionSentences(fig, boxes), boxes };
  };

  const walkDiv = (div: Element, level: number, fallbackTitle: string) => {
    const head = kids(div, "head")[0];
    const sec: Section = {
      id: ids.next("sec"),
      title: head ? cleanText(textOf(head)) : fallbackTitle,
      level,
      titleBoxes: head ? parseCoords(head.getAttribute("coords")) : undefined,
      blocks: [],
    };
    sections.push(sec);
    for (const c of Array.from(div.children)) {
      if (c.localName === "p") sec.blocks.push(paragraph(c));
      else if (c.localName === "figure") sec.blocks.push(figure(c));
      else if (c.localName === "formula") sec.blocks.push({ kind: "p", id: ids.next("p"), sentences: [{ id: ids.next("s"), text: cleanText(textOf(c)), boxes: parseCoords(c.getAttribute("coords")) }] });
      else if (c.localName === "div") walkDiv(c, level + 1, "");
    }
  };

  const abstract = firstDesc(doc.documentElement, "abstract");
  if (abstract) {
    const divs = kids(abstract, "div");
    if (divs.length) divs.forEach((d, i) => walkDiv(d, 1, i === 0 ? "Abstract" : ""));
    else walkDiv(abstract, 1, "Abstract");
    if (sections.length && !sections[0].title) sections[0].title = "Abstract";
  }

  const body = firstDesc(doc.documentElement, "body");
  if (body) {
    const loose: Section = { id: ids.next("sec"), title: "(Body)", level: 1, blocks: [] };
    for (const c of Array.from(body.children)) {
      if (c.localName === "div") walkDiv(c, 1, "(Untitled section)");
      else if (c.localName === "figure") (sections.length ? sections[sections.length - 1] : loose).blocks.push(figure(c));
      else if (c.localName === "p") loose.blocks.push(paragraph(c));
    }
    if (loose.blocks.length) sections.push(loose);
  }

  const back = firstDesc(doc.documentElement, "back");
  if (back) {
    for (const d of kids(back, "div")) {
      const type = d.getAttribute("type") ?? "";
      if (type === "references") continue;
      const inner = kids(d, "div");
      if (inner.length && !kids(d, "p").length) inner.forEach((x) => walkDiv(x, 1, type));
      else walkDiv(d, 1, type || "(Back matter)");
    }
  }

  return { source, title, sections: sections.filter((s) => s.blocks.length || s.title) };
}
