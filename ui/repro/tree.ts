import type { DocModel } from "../model";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Tri-state checkbox tree over sections › paragraphs › sentences, with tables/figures listed
 * separately. Selection is a set of leaf ids (sentence ids and float block ids).
 */
export class SelectionTree {
  private selected = new Set<string>();
  /** node id → leaf ids beneath it */
  private leaves = new Map<string, string[]>();

  constructor(
    private root: HTMLElement,
    private model: DocModel,
    private opts: { floats: boolean; onChange: () => void },
  ) {
    this.render();
    root.addEventListener("change", (e) => {
      const cb = e.target as HTMLInputElement;
      const node = cb.dataset.node;
      if (!node) return;
      for (const id of this.leaves.get(node) ?? [node]) cb.checked ? this.selected.add(id) : this.selected.delete(id);
      this.sync();
      this.opts.onChange();
    });
  }

  get ids(): string[] {
    return this.allLeaves().filter((id) => this.selected.has(id)); // document order
  }

  set ids(ids: string[]) {
    this.selected = new Set(ids);
    this.sync();
  }

  select(pred: (id: string, text: string, kind: "sentence" | "table" | "figure") => boolean, on = true) {
    for (const sec of this.model.sections)
      for (const b of sec.blocks) {
        if (b.kind === "p") b.sentences.forEach((s) => pred(s.id, s.text, "sentence") && (on ? this.selected.add(s.id) : this.selected.delete(s.id)));
        else if (this.opts.floats && pred(b.id, b.label, b.kind)) on ? this.selected.add(b.id) : this.selected.delete(b.id);
      }
    this.sync();
    this.opts.onChange();
  }

  private allLeaves(): string[] {
    const out: string[] = [];
    for (const sec of this.model.sections)
      for (const b of sec.blocks) {
        if (b.kind === "p") out.push(...b.sentences.map((s) => s.id));
        else if (this.opts.floats) out.push(b.id);
      }
    return out;
  }

  private render() {
    const cb = (node: string) => `<input type="checkbox" data-node="${node}" />`;
    let tree = "";
    let floats = "";
    for (const sec of this.model.sections) {
      const secLeaves: string[] = [];
      let paras = "";
      let pn = 0;
      for (const b of sec.blocks) {
        if (b.kind !== "p") {
          if (this.opts.floats) floats += `<li><label>${cb(b.id)} <b>${b.kind === "table" ? "▦" : "🖼"} ${esc(b.label)}</b> <span class="muted">${esc(trunc(b.caption.map((s) => s.text).join(" "), 90))}</span></label></li>`;
          continue;
        }
        const ids = b.sentences.map((s) => s.id);
        if (!ids.length) continue;
        this.leaves.set(b.id, ids);
        secLeaves.push(...ids);
        const sents = b.sentences.map((s) => `<li><label>${cb(s.id)} ${esc(s.text)}</label></li>`).join("");
        paras += `<li><details><summary>${cb(b.id)} <b>¶${++pn}</b> <span class="muted">${esc(trunc(b.sentences[0].text, 80))}</span></summary><ul>${sents}</ul></details></li>`;
      }
      if (!secLeaves.length) continue;
      this.leaves.set(sec.id, secLeaves);
      tree += `<li style="margin-left:${(sec.level - 1) * 12}px"><details><summary>${cb(sec.id)} <b>§ ${esc(sec.title || "(untitled)")}</b> <span class="muted">(${pn} ¶)</span></summary><ul>${paras}</ul></details></li>`;
    }
    this.root.innerHTML = `<ul class="sel-tree">${tree}</ul>` + (this.opts.floats ? `<h4>Tables &amp; figures</h4><ul class="sel-floats">${floats || '<li class="muted">None in this document.</li>'}</ul>` : "");
  }

  private sync() {
    this.root.querySelectorAll<HTMLInputElement>("input[data-node]").forEach((cb) => {
      const leaves = this.leaves.get(cb.dataset.node!) ?? [cb.dataset.node!];
      const n = leaves.filter((id) => this.selected.has(id)).length;
      cb.checked = n > 0 && n === leaves.length;
      cb.indeterminate = n > 0 && n < leaves.length;
    });
  }
}
