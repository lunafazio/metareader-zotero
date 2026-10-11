import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Box } from "./model";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PageSlot {
  num: number;
  wrap: HTMLDivElement;
  overlay: HTMLDivElement;
  page?: PDFPageProxy;
  rendered: number; // scale it was rendered at, 0 = not rendered
  view: number[]; // [x0, y0, x1, y1] in PDF units
}

/** One normalized char in the document-wide search string, mapped back to its text item. */
interface CharRef { page: number; item: number; char: number }

export interface TextIndex {
  norm: string;
  refs: CharRef[];
  items: TextItem[][]; // per page (0-based)
}

export function normalizeForSearch(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    for (const c of s[i].normalize("NFKD").toLowerCase()) {
      if (/[\p{L}\p{N}]/u.test(c)) {
        norm += c;
        map.push(i);
      }
    }
  }
  return { norm, map };
}

export class PdfView {
  private doc?: PDFDocumentProxy;
  private slots: PageSlot[] = [];
  private scale = 1.3;
  private observer: IntersectionObserver;
  private index?: Promise<TextIndex>;
  private findCache = new Map<string, Box[] | null>();

  constructor(private root: HTMLElement) {
    this.observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && this.renderSlot(Number((e.target as HTMLElement).dataset.page))),
      { root, rootMargin: "800px 0px" },
    );
  }

  get loaded() {
    return !!this.doc;
  }

  clear(message = "No PDF loaded.") {
    this.observer.disconnect();
    this.doc?.destroy();
    this.doc = undefined;
    this.slots = [];
    this.index = undefined;
    this.findCache.clear();
    this.root.innerHTML = `<div class="empty">${message}</div>`;
  }

  async load(data: ArrayBuffer) {
    this.clear();
    this.root.innerHTML = "";
    this.doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    for (let i = 1; i <= this.doc.numPages; i++) {
      const page = await this.doc.getPage(i);
      const wrap = document.createElement("div");
      wrap.className = "pdf-page";
      wrap.dataset.page = String(i);
      const overlay = document.createElement("div");
      overlay.className = "pdf-overlay";
      wrap.append(document.createElement("canvas"), overlay);
      this.root.append(wrap);
      const slot: PageSlot = { num: i, wrap, overlay, page, rendered: 0, view: page.view };
      this.slots.push(slot);
      this.sizeSlot(slot);
      this.observer.observe(wrap);
    }
  }

  setScale(scale: number) {
    this.scale = Math.min(4, Math.max(0.4, scale));
    for (const s of this.slots) {
      this.sizeSlot(s);
      s.rendered = 0;
    }
    // Re-trigger rendering for visible pages.
    for (const s of this.slots) {
      this.observer.unobserve(s.wrap);
      this.observer.observe(s.wrap);
    }
    this.lastHighlight && this.highlight(this.lastHighlight, false);
  }

  zoom(f: number) {
    this.setScale(this.scale * f);
  }

  fitWidth() {
    const s = this.slots[0];
    if (!s) return;
    const w = s.view[2] - s.view[0];
    if (this.root.clientWidth < 100) return; // hidden
    this.setScale((this.root.clientWidth - 40) / w);
  }

  private sizeSlot(s: PageSlot) {
    const vp = s.page!.getViewport({ scale: this.scale });
    s.wrap.style.width = `${vp.width}px`;
    s.wrap.style.height = `${vp.height}px`;
  }

  private async renderSlot(num: number) {
    const s = this.slots[num - 1];
    if (!s?.page || s.rendered === this.scale) return;
    const scale = this.scale;
    s.rendered = scale;
    const vp = s.page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const canvas = s.wrap.querySelector("canvas")!;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    try {
      await s.page.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch {
      s.rendered = 0;
    }
  }

  // ---------- highlighting ----------

  private lastHighlight?: Box[];

  highlight(boxes: Box[] | null | undefined, scroll = true, cls = "hl") {
    for (const s of this.slots) s.overlay.innerHTML = "";
    this.lastHighlight = boxes ?? undefined;
    if (!boxes?.length) return;
    let first: HTMLElement | undefined;
    for (const b of boxes) {
      const s = this.slots[b.page - 1];
      if (!s?.page) continue;
      const [ax, ay, bx, by] = this.toViewport(s, b, this.scale);
      const el = document.createElement("div");
      el.className = cls;
      Object.assign(el.style, {
        left: `${Math.min(ax, bx) - 1}px`,
        top: `${Math.min(ay, by) - 1}px`,
        width: `${Math.abs(bx - ax) + 2}px`,
        height: `${Math.abs(by - ay) + 2}px`,
      });
      s.overlay.append(el);
      first ??= el;
    }
    if (scroll && first) {
      const r = first.getBoundingClientRect();
      const root = this.root.getBoundingClientRect();
      if (r.top < root.top + 20 || r.bottom > root.bottom - 20) {
        this.root.scrollBy({ top: r.top - root.top - root.height / 3, behavior: "smooth" });
      }
    }
  }

  private toViewport(s: PageSlot, b: Box, scale: number): number[] {
    const vp = s.page!.getViewport({ scale });
    const top = s.view[3] + s.view[1];
    const [y0, y1] = b.origin === "top" ? [top - b.y1, top - b.y0] : [b.y0, b.y1];
    return vp.convertToViewportRectangle([b.x0, y0, b.x1, y1]);
  }

  /** Render the union of `boxes` on their first page (or the whole page) to a PNG blob. */
  async renderRegion(boxes: Box[] | undefined, pageNum?: number, scale = 2): Promise<Blob | null> {
    const page = boxes?.[0]?.page ?? pageNum;
    const s = page ? this.slots[page - 1] : undefined;
    if (!s?.page) return null;
    const vp = s.page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await s.page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    let crop = canvas;
    const onPage = boxes?.filter((b) => b.page === page) ?? [];
    if (onPage.length) {
      const rects = onPage.map((b) => this.toViewport(s, b, scale));
      const pad = 8 * scale;
      const x0 = Math.max(0, Math.min(...rects.map((r) => Math.min(r[0], r[2]))) - pad);
      const y0 = Math.max(0, Math.min(...rects.map((r) => Math.min(r[1], r[3]))) - pad);
      const x1 = Math.min(vp.width, Math.max(...rects.map((r) => Math.max(r[0], r[2]))) + pad);
      const y1 = Math.min(vp.height, Math.max(...rects.map((r) => Math.max(r[1], r[3]))) + pad);
      if (x1 - x0 > 20 && y1 - y0 > 20) {
        crop = document.createElement("canvas");
        crop.width = Math.floor(x1 - x0);
        crop.height = Math.floor(y1 - y0);
        crop.getContext("2d")!.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
      }
    }
    return new Promise((res) => crop.toBlob((b) => res(b), "image/png"));
  }

  // ---------- text search fallback ----------

  private buildIndex(): Promise<TextIndex> {
    this.index ??= buildTextIndex(this.slots.map((s) => s.page!));
    return this.index;
  }

  /** Locate text in the PDF; prefers matches on `hintPages`. Returns per-item boxes. */
  async findText(text: string, hintPages?: number[]): Promise<Box[] | null> {
    if (!this.doc) return null;
    const key = text + "|" + (hintPages ?? []).join(",");
    if (this.findCache.has(key)) return this.findCache.get(key)!;
    const idx = await this.buildIndex();
    const needle = normalizeForSearch(text).norm;
    let result: Box[] | null = null;
    if (needle.length >= 4) {
      const range = locate(idx, needle, hintPages);
      if (range) result = this.rangeToBoxes(idx, range[0], range[1]);
    }
    this.findCache.set(key, result);
    return result;
  }

  private rangeToBoxes(idx: TextIndex, start: number, end: number): Box[] {
    const boxes: Box[] = [];
    let i = start;
    while (i < end) {
      const { page, item } = idx.refs[i];
      let j = i;
      while (j + 1 < end && idx.refs[j + 1].page === page && idx.refs[j + 1].item === item) j++;
      const it = idx.items[page - 1][item];
      const [a, b, c, d, e, f] = it.transform;
      const h = it.height || Math.hypot(c, d) || Math.hypot(a, b);
      const len = Math.max(1, it.str.length);
      const c0 = idx.refs[i].char;
      const c1 = idx.refs[j].char + 1;
      boxes.push({ page, x0: e + (it.width * c0) / len, x1: e + (it.width * c1) / len, y0: f - h * 0.22, y1: f + h * 0.9, origin: "bottom" });
      i = j + 1;
    }
    return mergeBoxes(boxes);
  }
}

export async function buildTextIndex(pages: PDFPageProxy[]): Promise<TextIndex> {
  let norm = "";
  const refs: CharRef[] = [];
  const items: TextItem[][] = [];
  for (const page of pages) {
    const tc = await page.getTextContent();
    const pageItems = tc.items.filter((i): i is TextItem => "str" in i);
    items.push(pageItems);
    pageItems.forEach((it, idx) => {
      const { norm: n, map } = normalizeForSearch(it.str);
      norm += n;
      for (const c of map) refs.push({ page: page.pageNumber, item: idx, char: c });
    });
  }
  return { norm, refs, items };
}

function occurrences(hay: string, needle: string, max = 50): number[] {
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i >= 0 && out.length < max) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

export function locate(idx: TextIndex, needle: string, hint?: number[]): [number, number] | null {
  const pick = (cands: number[]) => {
    if (!cands.length) return undefined;
    if (!hint?.length) return cands[0];
    return cands.find((c) => hint.includes(idx.refs[c].page)) ?? cands[0];
  };
  const exact = pick(occurrences(idx.norm, needle));
  if (exact !== undefined) return [exact, exact + needle.length];

  // Fuzzy: anchor on a prefix and a suffix (handles mid-sentence extraction differences).
  const k = Math.min(30, Math.floor(needle.length / 2));
  if (k < 8) return null;
  const pre = needle.slice(0, k);
  const suf = needle.slice(-k);
  for (const p of hint?.length ? [...occurrences(idx.norm, pre)].sort((a, b) => Number(!hint.includes(idx.refs[a].page)) - Number(!hint.includes(idx.refs[b].page))) : occurrences(idx.norm, pre)) {
    const window = idx.norm.slice(p, p + Math.ceil(needle.length * 1.5) + k);
    const s = window.indexOf(suf, Math.max(0, needle.length / 2 - k));
    if (s >= 0) return [p, p + s + k];
  }
  const p = pick(occurrences(idx.norm, pre));
  if (p !== undefined) return [p, Math.min(idx.norm.length, p + needle.length)];
  const s = pick(occurrences(idx.norm, suf));
  if (s !== undefined) return [Math.max(0, s + k - needle.length), s + k];
  return null;
}

/** Merge horizontally adjacent boxes on the same line. */
function mergeBoxes(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    const last = out[out.length - 1];
    if (last && last.page === b.page && Math.abs(last.y0 - b.y0) < 2 && b.x0 - last.x1 < 15 && b.x0 >= last.x0) {
      last.x1 = Math.max(last.x1, b.x1);
      last.y1 = Math.max(last.y1, b.y1);
      last.y0 = Math.min(last.y0, b.y0);
    } else out.push({ ...b });
  }
  return out;
}
