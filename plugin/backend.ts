// The privileged backend behind one MetaReader tab: the api the UI calls (ui/api.ts), bound to one Zotero item.
// PDFs are the item's own PDF attachments; everything MetaReader generates goes into the item's
// MetaReader Package (package.ts). The UI passes a DOI as first argument to most calls; it is ignored here
// because the tab is already bound to its item.
import { Config, loadConfig, saveConfig } from "./config";
import { PACKAGE_FILE, listPackage, packageDir, updateOverview } from "./package";
import { RunResult, runLogged, runningTasks, spawnDetached, stopTask, which } from "./processes";

export interface Paper {
  parent: any; // regular Zotero item
  pkg: any; // MetaReader Package attachment
  doi: string; // normalized, may be ""
}

interface FileInfo {
  name: string;
  size: number;
  attachment?: boolean; // a Zotero attachment of the item (read-only here)
}

// ---------- helpers ----------

export function normalizeDoi(doi: string): string {
  const d = doi.trim();
  const lower = d.toLowerCase();
  for (const prefix of ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"]) {
    if (lower.startsWith(prefix)) return d.slice(prefix.length).trim().toLowerCase();
  }
  return lower;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9.-]/g, "_");

function safeName(name: string): string {
  const n = name.split(/[\\/]/).pop() ?? "";
  if (!n || n.startsWith(".") || n === PACKAGE_FILE) throw new Error(`invalid file name ${name}`);
  return n;
}

/** Resolve a relative path inside the repro folder, rejecting traversal. */
function relPath(root: string, rel: string): string {
  const parts = rel.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === ".." || p.includes("\\"))) throw new Error(`invalid path ${rel}`);
  if (!parts.length) throw new Error("empty path");
  return PathUtils.join(root, ...parts);
}

const mkdir = async (p: string) => {
  await IOUtils.makeDirectory(p, { ignoreExisting: true, createAncestors: true });
  return p;
};
const toBuffer = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
const bytes = (data: Uint8Array | string) => (typeof data === "string" ? new TextEncoder().encode(data) : data);
const readText = async (p: string) => ((await IOUtils.exists(p)) ? IOUtils.readUTF8(p) : "");
const errMsg = (e: unknown) => (e as Error)?.message ?? String(e);

/** The item's PDF attachments that have a file, with collision-free display names. */
async function pdfAttachments(parent: any): Promise<{ name: string; path: string; item: any }[]> {
  const out: { name: string; path: string; item: any }[] = [];
  for (const id of parent.getAttachments()) {
    const att = Zotero.Items.get(id);
    if (!att.isPDFAttachment()) continue;
    const path = await att.getFilePathAsync();
    if (!path) continue;
    let name = att.attachmentFilename || `${att.key}.pdf`;
    if (out.some((o) => o.name === name)) name = `${att.key}-${name}`;
    out.push({ name, path, item: att });
  }
  return out;
}

async function importPdf(parent: any, name: string, data: Uint8Array, title = "Full Text PDF") {
  const tmpDir = await mkdir(PathUtils.join(PathUtils.tempDir, `metareader-${Zotero.Utilities.randomString()}`));
  const tmp = PathUtils.join(tmpDir, safeName(name));
  try {
    await IOUtils.write(tmp, data);
    return await Zotero.Attachments.importFromFile({ file: tmp, parentItemID: parent.id, title, contentType: "application/pdf" });
  } finally {
    await IOUtils.remove(tmpDir, { recursive: true, ignoreAbsent: true });
  }
}

// ---------- online sources ----------

function withAuth(url: string, cfg: Config): string {
  const u = new URL(url);
  if (cfg.openalex_api_key) u.searchParams.set("api_key", cfg.openalex_api_key);
  if (cfg.mailto) u.searchParams.set("mailto", cfg.mailto);
  return u.toString();
}

const redact = (url: string) => url.replace(/api_key=[^&]*/, "api_key=***");

async function tryDownload(url: string, check: (b: Uint8Array) => boolean): Promise<Uint8Array> {
  const resp = await fetch(url, { headers: { Accept: "application/pdf,application/xml,text/xml;q=0.9,*/*;q=0.5" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const b = new Uint8Array(await resp.arrayBuffer());
  if (!check(b)) throw new Error("response is not the expected format (probably a landing page)");
  return b;
}

const isPdf = (b: Uint8Array) => b.length > 4 && new TextDecoder("latin1").decode(b.subarray(0, 1024)).includes("%PDF-");
function isXml(b: Uint8Array) {
  const head = new TextDecoder().decode(b.subarray(0, 2048)).toLowerCase();
  return head.trimStart().startsWith("<") && !head.includes("<html");
}

/** OpenAlex often lacks PMCIDs; ask Europe PMC directly. */
async function europepmcPmcid(doi: string): Promise<string | undefined> {
  try {
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(doi)}%22&format=json&resultType=lite`;
    const v = await (await fetch(url)).json();
    return v.resultList?.result?.find((r: any) => r.pmcid)?.pmcid;
  } catch {
    return undefined;
  }
}

const RECONCILE_PROMPT = `You are reconciling several machine-extracted versions of the same scholarly article into one clean, faithful version.

Source files (read them with the Read tool):
{FILES}

Rules:
- Treat the PDF (if listed) as ground truth for wording; other formats are extraction attempts that may have errors (broken hyphenation, merged/split paragraphs, missing sections, OCR noise, misplaced figure captions, mangled tables).
- Keep the article's actual wording. Do not summarize, paraphrase, or invent content.
- Preserve section hierarchy, paragraph boundaries, figures (with captions), and tables (as proper rows/cells).
- Output a single TEI XML document in the same style as GROBID output: <TEI xmlns="http://www.tei-c.org/ns/1.0"> with <teiHeader> (title, authors, abstract) and <text><body> containing <div><head>…</head><p><s>sentence</s>…</p></div>, <figure><head/><figDesc/></figure> and <figure type="table"><head/><figDesc/><table><row><cell/></row></table></figure>.
- Wrap every sentence in <s>. If a source has coords="…" attributes on matching sentences/paragraphs, copy them onto your elements.
- Output ONLY the XML, starting with <?xml or <TEI and ending with </TEI>. No commentary, no code fences.
{EXTRA}`;

/** Per-call options chosen in the UI's confirmation dialogs. */
export interface LlmOptions {
  model?: string; // undefined: use the configured default; "": the CLI's own default
}

function claudeArgs(cfg: Config, opts: LlmOptions | undefined, ...args: string[]): string[] {
  const argv = [cfg.claude_cmd, "-p", ...args];
  const model = (opts?.model ?? cfg.claude_model).trim();
  if (model) argv.push("--model", model);
  return argv;
}

const promptArgs = (cfg: Config, opts?: LlmOptions) => claudeArgs(cfg, opts, "--output-format", "text");

function codegenArgs(cfg: Config, allowExec: boolean, opts?: LlmOptions) {
  const tools = ["Read", "Write", "Edit", "Glob", "Grep"];
  if (allowExec) tools.push("Bash(Rscript:*)", "Bash(R:*)", "Bash(python:*)", "Bash(python3:*)", "Bash(snakemake:*)", "Bash(pip:*)", "Bash(ls:*)");
  return claudeArgs(cfg, opts, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", tools.join(","));
}

/** Editors tried, in order, when no editor command is configured. */
const EDITORS = ["code", "codium", "cursor", "zed", "subl", "xdg-open"];

// ---------- api ----------

export function makeApi(paper: Paper) {
  const { parent, pkg, doi } = paper;
  const dir = packageDir(pkg);
  const reproRoot = () => mkdir(PathUtils.join(dir, "repro"));
  const task = (key: string) => `${pkg.key}:${key}`;
  const sessionPath = PathUtils.join(dir, ".metareader-session.json");

  // Regenerate the package overview shortly after the last change.
  let overviewTimer: ReturnType<typeof setTimeout> | undefined;
  const touched = () => {
    clearTimeout(overviewTimer);
    overviewTimer = setTimeout(() => updateOverview(parent, pkg).catch((e: unknown) => Zotero.logError(e)), 1000);
  };
  const changes = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } finally {
      touched();
    }
  };

  async function resolveFile(name: string): Promise<string> {
    const att = (await pdfAttachments(parent)).find((a) => a.name === name);
    return att ? att.path : PathUtils.join(dir, safeName(name));
  }

  async function listFiles(): Promise<FileInfo[]> {
    const out: FileInfo[] = [];
    for (const p of await IOUtils.getChildren(dir)) {
      const name = PathUtils.filename(p);
      if (name.startsWith(".") || name === PACKAGE_FILE) continue;
      const st = await IOUtils.stat(p);
      if (st.type === "regular") out.push({ name, size: st.size });
    }
    for (const a of await pdfAttachments(parent)) {
      out.push({ name: a.name, size: (await IOUtils.stat(a.path)).size, attachment: true });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function fetchOpenAlex(): Promise<any> {
    if (!doi) throw new Error("This item has no DOI; OpenAlex metadata is unavailable.");
    const resp = await fetch(withAuth(`https://api.openalex.org/works/doi:${doi}`, loadConfig()));
    if (!resp.ok) throw new Error(`OpenAlex returned ${resp.status} ${resp.statusText}`);
    const v = await resp.json();
    await IOUtils.writeUTF8(PathUtils.join(dir, "openalex.json"), JSON.stringify(v, null, 2));
    return v;
  }

  /** Try every known source for PDF / JATS / TEI; returns a human-readable log. */
  async function fetchFormats(): Promise<string[]> {
    if (!doi) return ["No DOI on this item; skipping online sources."];
    const cfg = loadConfig();
    let meta: any;
    try {
      meta = await IOUtils.readJSON(PathUtils.join(dir, "openalex.json"));
    } catch {
      meta = await fetchOpenAlex();
    }
    const log: string[] = [];
    const workId = String(meta.id ?? "").split("/").pop() ?? "";
    const hasKey = !!cfg.openalex_api_key;

    // --- PDF: becomes a regular Zotero attachment of the item ---
    if ((await pdfAttachments(parent)).length) {
      log.push("PDF: the item already has a PDF attachment, skipping download.");
    } else {
      const candidates: [string, string][] = [];
      const push = (label: string, u?: string | null) => {
        if (u && !candidates.some(([, x]) => x === u)) candidates.push([label, u]);
      };
      if (workId && meta.has_content?.pdf) {
        if (hasKey) push("OpenAlex content", withAuth(`https://content.openalex.org/works/${workId}.pdf`, cfg));
        else log.push("OpenAlex has a cached PDF, but no API key is configured to access it.");
      }
      push("best OA location", meta.best_oa_location?.pdf_url);
      push("primary location", meta.primary_location?.pdf_url);
      for (const l of meta.locations ?? []) push("location", l?.pdf_url);
      const oaUrl: string | undefined = meta.open_access?.oa_url;
      if (oaUrl?.toLowerCase().includes("pdf")) push("oa_url", oaUrl);
      if (!candidates.length) log.push("PDF: no candidate URLs found.");
      for (const [label, url] of candidates) {
        try {
          await importPdf(parent, `${slug(doi)}.pdf`, await tryDownload(url, isPdf));
          log.push(`PDF: downloaded from ${label} and added as a Zotero attachment.`);
          break;
        } catch (e) {
          log.push(`PDF: ${label} failed (${errMsg(e)}): ${redact(url)}`);
        }
      }
    }

    // --- TEI (OpenAlex Grobid output) ---
    if (workId && meta.has_content?.grobid_xml) {
      if (hasKey) {
        try {
          const b = await tryDownload(withAuth(`https://content.openalex.org/works/${workId}.grobid-xml`, cfg), isXml);
          await IOUtils.write(PathUtils.join(dir, "openalex.tei.xml"), b);
          log.push("TEI: downloaded OpenAlex Grobid XML.");
        } catch (e) {
          log.push(`TEI: OpenAlex Grobid XML failed (${errMsg(e)}).`);
        }
      } else log.push("TEI: OpenAlex has Grobid XML, but no API key is configured.");
    } else log.push("TEI: OpenAlex has no Grobid XML for this work.");

    // --- JATS (Europe PMC / PMC) ---
    let pmcid: string | undefined = meta.ids?.pmcid?.split("/").pop();
    if (!pmcid) pmcid = await europepmcPmcid(doi);
    if (pmcid) {
      const id = pmcid.toUpperCase().startsWith("PMC") ? pmcid : `PMC${pmcid}`;
      try {
        const b = await tryDownload(`https://www.ebi.ac.uk/europepmc/webservices/rest/${id}/fullTextXML`, isXml);
        await IOUtils.write(PathUtils.join(dir, "europepmc.jats.xml"), b);
        log.push(`JATS: downloaded from Europe PMC (${id}).`);
      } catch (e) {
        log.push(`JATS: Europe PMC failed for ${id} (${errMsg(e)}).`);
      }
    } else log.push("JATS: no PMC ID, no open JATS source known.");
    return log;
  }

  async function runGrobid(_doi: string, pdf: string): Promise<string> {
    const cfg = loadConfig();
    const data = await IOUtils.read(await resolveFile(pdf));
    // The plugin sandbox has no FormData/AbortSignal; borrow them from the main window.
    const win = Zotero.getMainWindow();
    const form = new win.FormData();
    form.append("input", new win.Blob([data], { type: "application/pdf" }), "input.pdf");
    form.append("segmentSentences", "1");
    form.append("consolidateHeader", "0");
    form.append("includeRawCitations", "1");
    for (const c of ["s", "p", "head", "figure", "formula", "biblStruct", "title", "persName"]) form.append("teiCoordinates", c);
    const url = `${cfg.grobid_url.replace(/\/+$/, "")}/api/processFulltextDocument`;
    let resp: Response;
    try {
      resp = await win.fetch(url, { method: "POST", body: form, signal: win.AbortSignal.timeout(600_000) });
    } catch (e) {
      throw new Error(`Could not reach Grobid at ${url}: ${errMsg(e)}`);
    }
    if (!resp.ok) throw new Error(`Grobid returned ${resp.status}`);
    const name = "grobid.tei.xml";
    await IOUtils.writeUTF8(PathUtils.join(dir, name), await resp.text());
    return name;
  }

  async function runDocling(_doi: string, pdf: string): Promise<string> {
    const cfg = loadConfig();
    const input = await resolveFile(pdf);
    const tmp = PathUtils.join(dir, ".docling-out");
    await IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true });
    await mkdir(tmp);
    const log = PathUtils.join(dir, ".docling.log");
    const r = await runLogged(task("docling"), { argv: [cfg.docling_cmd, "--to", "json", "--output", tmp, input], cwd: dir, log });
    if (r.code !== 0) throw new Error(`docling failed:\n${await readText(log)}`);
    const json = (await IOUtils.getChildren(tmp)).find((p: string) => p.endsWith(".json"));
    if (!json) throw new Error("docling produced no JSON");
    const name = "docling.json";
    await IOUtils.move(json, PathUtils.join(dir, name));
    await IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true });
    return name;
  }

  async function runClaude(_doi: string, sources: string[], instructions: string): Promise<string> {
    const cfg = loadConfig();
    if (!sources.length) throw new Error("select at least one source");
    let files = "";
    const addDirs = new Set<string>();
    for (const s of sources) {
      const p = await resolveFile(s);
      if (!(await IOUtils.exists(p))) throw new Error(`missing source ${s}`);
      if (PathUtils.parent(p) === dir) files += `- ${PathUtils.filename(p)} (in the current working directory)\n`;
      else {
        files += `- ${p}\n`;
        addDirs.add(PathUtils.parent(p));
      }
    }
    const extra = instructions.trim() ? `\nAdditional instructions from the user:\n${instructions.trim()}\n` : "";
    const prompt = RECONCILE_PROMPT.replace("{FILES}", files).replace("{EXTRA}", extra);
    const log = PathUtils.join(dir, ".claude.out");
    const errLog = PathUtils.join(dir, ".claude.err");
    const argv = claudeArgs(cfg, undefined, "--output-format", "text", "--allowedTools", "Read", ...[...addDirs].flatMap((d) => ["--add-dir", d]));
    const r = await runLogged(task("reconcile"), { argv, cwd: dir, log, errLog, stdin: prompt });
    const stdout = await readText(log);
    if (r.code !== 0) throw new Error(`claude failed:\n${await readText(errLog)}\n${stdout}`);
    let start = stdout.indexOf("<?xml");
    if (start < 0) start = stdout.indexOf("<TEI");
    if (start < 0) throw new Error(`Claude output contained no TEI XML:\n${stdout.slice(0, 2000)}`);
    const endIdx = stdout.lastIndexOf("</TEI>");
    const name = "claude.tei.xml";
    await IOUtils.writeUTF8(PathUtils.join(dir, name), stdout.slice(start, endIdx >= 0 ? endIdx + 6 : undefined));
    return name;
  }

  async function reproRun(_doi: string, command: string): Promise<RunResult> {
    const root = await reproRoot();
    const log = PathUtils.join(root, "outputs", "run.log");
    const r = await runLogged(task("run"), { argv: ["bash", "-lc", command], cwd: root, log });
    r.log = "outputs/run.log";
    // Append a footer so the log is self-describing.
    await IOUtils.writeUTF8(log, `\n[metareader] command: ${command}\n[metareader] exit code: ${r.code}, ${r.duration_ms} ms\n`, { mode: "append" });
    return r;
  }

  /** One-shot Claude call returning the final text (used for JSON extraction tasks). */
  async function claudePrompt(_doi: string, prompt: string, opts?: LlmOptions): Promise<string> {
    const root = await reproRoot();
    const log = PathUtils.join(root, ".metareader", "claude-prompt.log");
    const r = await runLogged(task("prompt"), { argv: promptArgs(loadConfig(), opts), cwd: root, log, stdin: prompt });
    const out = await readText(log);
    if (r.code !== 0) throw new Error(`claude exited with ${r.code}:\n${out.slice(0, 3000)}`);
    return out;
  }

  /** Headless agentic code generation inside the repro folder; progress is streamed as JSONL to .metareader/codegen.jsonl. */
  async function claudeCodegen(_doi: string, prompt: string, allowExec: boolean, opts?: LlmOptions): Promise<RunResult> {
    const root = await reproRoot();
    const argv = codegenArgs(loadConfig(), allowExec, opts);
    const r = await runLogged(task("codegen"), { argv, cwd: root, log: PathUtils.join(root, ".metareader", "codegen.jsonl"), stdin: prompt });
    r.log = ".metareader/codegen.jsonl";
    return r;
  }

  async function reproZip(): Promise<string> {
    const root = await reproRoot();
    const files = await listPackage(dir, false, "repro");
    const prefix = `${slug(doi || parent.key)}-reproduction`;
    const zipPath = PathUtils.join(dir, `${prefix}.zip`);
    const Ci = Components.interfaces;
    const zw = Components.classes["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
    const PR_RDWR = 0x04, PR_CREATE_FILE = 0x08, PR_TRUNCATE = 0x20;
    zw.open(Zotero.File.pathToFile(zipPath), PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE);
    try {
      for (const f of files) {
        const rel = f.path.slice("repro/".length);
        zw.addEntryFile(`${prefix}/${rel}`, Ci.nsIZipWriter.COMPRESSION_DEFAULT, Zotero.File.pathToFile(PathUtils.join(root, ...rel.split("/"))), false);
      }
    } finally {
      zw.close();
    }
    return zipPath;
  }

  /** The exact command line and folder an LLM call would use (shown before sending). */
  async function llmCommand(_doi: string, kind: "prompt" | "codegen", opts?: LlmOptions & { allowExec?: boolean }) {
    const cfg = loadConfig();
    const argv = kind === "prompt" ? promptArgs(cfg, opts) : codegenArgs(cfg, !!opts?.allowExec, opts);
    return { argv, cwd: await reproRoot(), defaultModel: cfg.claude_model };
  }

  /** Unpack an uploaded zip into a new folder below the repro root; returns the folder and the extracted files. */
  async function reproUnzip(_doi: string, name: string, data: Uint8Array, parentDir: string) {
    const root = await reproRoot();
    const stem = safeName(name).replace(/\.zip$/i, "") || "archive";
    let rel = `${parentDir}/${stem}`;
    for (let i = 2; await IOUtils.exists(relPath(root, rel)); i++) rel = `${parentDir}/${stem}-${i}`;
    const dest = await mkdir(relPath(root, rel));
    const tmpDir = await mkdir(PathUtils.join(PathUtils.tempDir, `metareader-${Zotero.Utilities.randomString()}`));
    const tmp = PathUtils.join(tmpDir, "upload.zip");
    const Ci = Components.interfaces;
    const zr = Components.classes["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    const files: string[] = [];
    try {
      await IOUtils.write(tmp, data);
      zr.open(Zotero.File.pathToFile(tmp));
      const entries = zr.findEntries(null);
      while (entries.hasMore()) {
        const entry: string = entries.getNext();
        if (entry.endsWith("/")) continue;
        const parts = entry.split("/").filter((p) => p && p !== ".");
        // Skip macOS metadata; reject anything that would escape the destination (zip slip).
        if (parts[0] === "__MACOSX" || parts[parts.length - 1] === ".DS_Store") continue;
        if (!parts.length || parts.some((p) => p === ".." || p.includes("\\"))) throw new Error(`unsafe path in zip: ${entry}`);
        const out = PathUtils.join(dest, ...parts);
        await mkdir(PathUtils.parent(out));
        zr.extract(entry, Zotero.File.pathToFile(out));
        files.push(`${rel}/${parts.join("/")}`);
      }
    } catch (e) {
      await IOUtils.remove(dest, { recursive: true, ignoreAbsent: true });
      throw e;
    } finally {
      try {
        zr.close();
      } catch { /* not opened */ }
      await IOUtils.remove(tmpDir, { recursive: true, ignoreAbsent: true });
    }
    return { dir: rel, files: files.sort() };
  }

  /** Initialize the repro folder as a git repository (once) and commit its current state, if anything changed. */
  async function reproGit(_doi: string, message: string) {
    const root = await reproRoot();
    const ignore = PathUtils.join(root, ".gitignore");
    if (!(await IOUtils.exists(ignore))) {
      await IOUtils.writeUTF8(ignore, ".metareader/\n.snakemake/\n_targets/\n__pycache__/\n.Rhistory\noutputs/.steps/\n");
    }
    const script = [
      "set -e",
      "[ -d .git ] || git init -q",
      // Use a local identity only if none is configured globally.
      'git config user.name >/dev/null || git config user.name "MetaReader"',
      'git config user.email >/dev/null || git config user.email "metareader@localhost"',
      "git add -A",
      'if git diff --cached --quiet; then echo "nothing to commit"; else git commit -q -m "$MR_MSG"; fi',
      "git log --oneline -1",
    ].join("\n");
    const log = PathUtils.join(root, ".metareader", "git.log");
    const r = await runLogged(task("git"), { argv: ["bash", "-c", script], cwd: root, log, env: { MR_MSG: message } });
    const out = (await readText(log)).trim();
    if (r.code !== 0) throw new Error(`git failed:\n${out}`);
    return { committed: !out.includes("nothing to commit"), head: out.split("\n").pop() ?? "" };
  }

  /** Open the repro folder in the configured (or first available) code editor. */
  async function openInEditor() {
    const root = await reproRoot();
    const cfg = loadConfig();
    let cmd = cfg.editor_cmd.trim();
    if (!cmd) {
      for (const c of EDITORS) {
        try {
          await which(c);
          cmd = c;
          break;
        } catch { /* try next */ }
      }
    }
    if (!cmd) throw new Error("No code editor found; set one in Settings.");
    const argv = cmd.split(/\s+/);
    await spawnDetached([...argv, root], root);
    return argv[0];
  }

  async function reproList(_doi: string, hash = false) {
    await reproRoot();
    return (await listPackage(dir, hash, "repro")).map((f) => ({ ...f, path: f.path.slice("repro/".length) }));
  }

  return {
    getConfig: async () => loadConfig(),
    setConfig: async (config: Config) => saveConfig(config),
    listFiles,
    listPapers: async () => [],
    readFile: async (_doi: string, name: string) => toBuffer(await IOUtils.read(await resolveFile(name))),
    readText: async (_doi: string, name: string) => IOUtils.readUTF8(await resolveFile(name)) as Promise<string>,
    deleteFile: changes(async (_doi: string, name: string) => {
      if ((await pdfAttachments(parent)).some((a) => a.name === name)) throw new Error("This PDF is a Zotero attachment; delete it in Zotero.");
      await IOUtils.remove(PathUtils.join(dir, safeName(name)));
    }),
    uploadFile: changes(async (_doi: string, file: { name: string; data: Uint8Array }) => {
      if (/\.pdf$/i.test(file.name)) {
        const att = await importPdf(parent, file.name, file.data, file.name);
        return att.attachmentFilename as string;
      }
      const name = safeName(file.name);
      await IOUtils.write(PathUtils.join(dir, name), file.data);
      return name;
    }),
    fetchOpenAlex: changes(fetchOpenAlex),
    fetchFormats: changes(fetchFormats),
    runGrobid: changes(runGrobid),
    runDocling: changes(runDocling),
    runClaude: changes(runClaude),

    reproPath: async () => reproRoot(),
    reproWrite: async (_doi: string, path: string, data: Uint8Array | string) => {
      const p = relPath(await reproRoot(), path);
      await mkdir(PathUtils.parent(p));
      await IOUtils.write(p, bytes(data));
      // Wizard state autosaves (.metareader/…) shouldn't mark the package as changed every few hundred ms.
      if (!path.split("/").some((part) => part.startsWith("."))) touched();
    },
    reproRead: async (_doi: string, path: string) => toBuffer(await IOUtils.read(relPath(await reproRoot(), path))),
    reproReadText: async (_doi: string, path: string) => IOUtils.readUTF8(relPath(await reproRoot(), path)) as Promise<string>,
    reproDelete: changes(async (_doi: string, path: string) => IOUtils.remove(relPath(await reproRoot(), path), { recursive: true }) as Promise<void>),
    reproList,
    reproRun: changes(reproRun),
    stopTask: async (key: string) => stopTask(task(key)),
    runningTasks: async () => runningTasks(task("")),
    claudePrompt,
    claudeCodegen: changes(claudeCodegen),
    llmCommand,
    reproUnzip: changes(reproUnzip),
    reproGit,
    openInEditor,
    reproZip: changes(reproZip),
    loadSession: async () => {
      try {
        return await IOUtils.readJSON(sessionPath);
      } catch {
        return null;
      }
    },
    saveSession: async (session: unknown) => IOUtils.writeUTF8(sessionPath, JSON.stringify(session, null, 2)) as Promise<void>,
  };
}

export type Api = ReturnType<typeof makeApi>;
