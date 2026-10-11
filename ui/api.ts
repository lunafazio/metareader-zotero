// The UI runs unprivileged inside a Zotero tab, so every call is posted to the plugin
// (plugin/bridge.ts) as a DOM event and answered the same way. The plugin binds each tab to one Zotero item;
// the `doi` arguments are kept for compatibility with the MetaReader UI code but are not used for lookup.

export interface Config {
  openalex_api_key: string;
  mailto: string;
  grobid_url: string;
  docling_cmd: string;
  claude_cmd: string;
  claude_model: string;
  editor_cmd: string;
}
export interface FileInfo { name: string; size: number; attachment?: boolean }
export interface PaperInfo { doi: string; title: string }

export interface ReproFile { path: string; size: number; modified: number; sha256: string | null }
export interface RunResult { code: number | null; duration_ms: number; log: string }
/** Per-call LLM options; model undefined = configured default, "" = the CLI's own default. */
export interface LlmOptions { model?: string }
export interface LlmCommand { argv: string[]; cwd: string; defaultModel: string }

const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let seq = 0;

window.addEventListener("metareader-reply", (e) => {
  const { id, ok, err } = (e as CustomEvent).detail;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (err !== undefined) p.reject(new Error(err));
  else p.resolve(ok);
});

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    window.dispatchEvent(new CustomEvent("metareader-call", { detail: { id, method, args } }));
  });
}

const raw = (data: Uint8Array | string) => (typeof data === "string" ? new TextEncoder().encode(data) : data);

export const api = {
  getConfig: () => call<Config>("getConfig"),
  setConfig: (config: Config) => call<void>("setConfig", config),
  listFiles: (doi: string) => call<FileInfo[]>("listFiles", doi),
  listPapers: () => call<PaperInfo[]>("listPapers"),
  readFile: (doi: string, name: string) => call<ArrayBuffer>("readFile", doi, name),
  readText: (doi: string, name: string) => call<string>("readText", doi, name),
  deleteFile: (doi: string, name: string) => call<void>("deleteFile", doi, name),
  uploadFile: async (doi: string, file: File) =>
    call<string>("uploadFile", doi, { name: file.name, data: new Uint8Array(await file.arrayBuffer()) }),
  fetchOpenAlex: (doi: string) => call<any>("fetchOpenAlex", doi),
  fetchFormats: (doi: string) => call<string[]>("fetchFormats", doi),
  runGrobid: (doi: string, pdf: string) => call<string>("runGrobid", doi, pdf),
  runDocling: (doi: string, pdf: string) => call<string>("runDocling", doi, pdf),
  runClaude: (doi: string, sources: string[], instructions: string) => call<string>("runClaude", doi, sources, instructions),

  reproPath: (doi: string) => call<string>("reproPath", doi),
  reproWrite: (doi: string, path: string, data: Uint8Array | string) => call<void>("reproWrite", doi, path, raw(data)),
  reproRead: (doi: string, path: string) => call<ArrayBuffer>("reproRead", doi, path),
  reproReadText: (doi: string, path: string) => call<string>("reproReadText", doi, path),
  reproDelete: (doi: string, path: string) => call<void>("reproDelete", doi, path),
  reproList: (doi: string, hash = false) => call<ReproFile[]>("reproList", doi, hash),
  reproRun: (doi: string, command: string) => call<RunResult>("reproRun", doi, command),
  stopTask: (key: string) => call<boolean>("stopTask", key),
  runningTasks: () => call<string[]>("runningTasks"),
  claudePrompt: (doi: string, prompt: string, opts?: LlmOptions) => call<string>("claudePrompt", doi, prompt, opts),
  claudeCodegen: (doi: string, prompt: string, allowExec: boolean, opts?: LlmOptions) => call<RunResult>("claudeCodegen", doi, prompt, allowExec, opts),
  llmCommand: (doi: string, kind: "prompt" | "codegen", opts?: LlmOptions & { allowExec?: boolean }) => call<LlmCommand>("llmCommand", doi, kind, opts),
  reproUnzip: async (doi: string, file: File, parentDir: string) =>
    call<{ dir: string; files: string[] }>("reproUnzip", doi, file.name, new Uint8Array(await file.arrayBuffer()), parentDir),
  reproGit: (doi: string, message: string) => call<{ committed: boolean; head: string }>("reproGit", doi, message),
  openInEditor: (doi: string) => call<string>("openInEditor", doi),
  reproZip: (doi: string) => call<string>("reproZip", doi),
  loadSession: () => call<any>("loadSession"),
  saveSession: (session: unknown) => call<void>("saveSession", session),
};

/** OpenAlex stores abstracts as an inverted index { word: [positions] }. */
export function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string {
  if (!inv) return "";
  const words: string[] = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) words[p] = w;
  return words.filter((w) => w !== undefined).join(" ");
}
