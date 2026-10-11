import { DocModel, IdGen, Section, sentencesFrom } from "../model";
import { parseDocling } from "./docling";
import { parseJats } from "./jats";
import { parseTei } from "./tei";
import { rootName } from "./xml";

export type SourceKind = "pdf" | "tei" | "jats" | "docling" | "text" | "openalex" | "other";

export function detectKind(name: string, head?: string): SourceKind {
  const n = name.toLowerCase();
  if (n === "openalex.json") return "openalex";
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".md") || n.endsWith(".txt")) return "text";
  if (head !== undefined) {
    if (n.endsWith(".json")) return /"schema_name"\s*:\s*"DoclingDocument"|"body"\s*:/.test(head) ? "docling" : "other";
    const root = rootName(head);
    if (root === "TEI" || root === "teiCorpus") return "tei";
    if (root === "article") return "jats";
    return "other";
  }
  if (n.includes("tei")) return "tei";
  if (n.includes("jats") || n.endsWith(".nxml")) return "jats";
  if (n.includes("docling") && n.endsWith(".json")) return "docling";
  if (n.endsWith(".xml")) return "other";
  return "other";
}

/** Markdown / plain text: '#' headings start sections, blank lines separate paragraphs. */
function parseText(text: string, source: string): DocModel {
  const ids = new IdGen();
  const sections: Section[] = [];
  let cur: Section = { id: ids.next("sec"), title: "(Start)", level: 1, blocks: [] };
  sections.push(cur);
  for (const chunk of text.split(/\n\s*\n/)) {
    const h = chunk.trim().match(/^(#{1,6})\s+(.*)$/);
    if (h && !chunk.trim().includes("\n")) {
      cur = { id: ids.next("sec"), title: h[2], level: h[1].length, blocks: [] };
      sections.push(cur);
    } else if (chunk.trim()) {
      cur.blocks.push({ kind: "p", id: ids.next("p"), sentences: sentencesFrom(chunk, ids) });
    }
  }
  return { source, sections: sections.filter((s) => s.blocks.length || s.title !== "(Start)") };
}

export function parseSource(name: string, text: string): DocModel {
  const kind = detectKind(name, text.slice(0, 4000));
  switch (kind) {
    case "tei": return parseTei(text, name);
    case "jats": return parseJats(text, name);
    case "docling": return parseDocling(text, name);
    case "text": return parseText(text, name);
    default:
      // Unknown XML/HTML: strip markup and treat as plain text.
      if (text.trimStart().startsWith("<")) {
        const body = new DOMParser().parseFromString(text, "text/html").body;
        const plain = body.innerText ?? body.textContent ?? "";
        return parseText(plain, name);
      }
      return parseText(text, name);
  }
}
