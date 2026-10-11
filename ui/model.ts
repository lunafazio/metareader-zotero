/** A rectangle in PDF user space. origin "top" = y measured from page top (GROBID), "bottom" = PDF native. */
export interface Box {
  page: number; // 1-based
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  origin: "top" | "bottom";
}

export interface Sentence {
  id: string;
  text: string;
  boxes?: Box[]; // exact coordinates if the source provides them
  fallbackBoxes?: Box[]; // coarser (paragraph-level) coordinates
}

export type Block =
  | { kind: "p"; id: string; sentences: Sentence[]; boxes?: Box[] }
  | { kind: "table"; id: string; label: string; caption: Sentence[]; rows: string[][]; html?: string; boxes?: Box[] }
  | { kind: "figure"; id: string; label: string; caption: Sentence[]; boxes?: Box[] };

export interface Section {
  id: string;
  title: string;
  level: number;
  titleBoxes?: Box[];
  blocks: Block[];
}

export interface DocModel {
  source: string;
  title?: string;
  sections: Section[];
}

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const ABBREV = /\b(?:e\.g|i\.e|et al|Fig|Figs|Eq|Eqs|Ref|Refs|vs|cf|approx|ca|Dr|Mr|Ms|Prof|No|Vol|pp|Tab|Sect|resp)\.$/i;

/** Split text into sentences, re-joining splits after common scholarly abbreviations. */
export function splitSentences(text: string): string[] {
  const parts: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const s = segment.trim();
    if (!s) continue;
    if (parts.length && (ABBREV.test(parts[parts.length - 1]) || /^[a-z(\[]/.test(s))) {
      parts[parts.length - 1] += " " + s;
    } else parts.push(s);
  }
  return parts;
}

export function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Helper that hands out stable sequential ids while building a document. */
export class IdGen {
  private n = 0;
  next(prefix: string) {
    return `${prefix}${this.n++}`;
  }
}

export function sentencesFrom(text: string, ids: IdGen, fallbackBoxes?: Box[]): Sentence[] {
  return splitSentences(cleanText(text)).map((t) => ({ id: ids.next("s"), text: t, fallbackBoxes }));
}
