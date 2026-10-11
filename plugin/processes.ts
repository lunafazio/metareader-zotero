// Child processes: each runs in its own process group (setsid) with output redirected to files, so a Stop
// kills the whole tree (e.g. bash → Rscript).
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

export interface RunResult {
  code: number | null;
  duration_ms: number;
  log: string;
}

/** Running tasks by key ("<package key>:run", …) → process group id. */
const running = new Map<string, number>();

const env = (name: string): string => Services.env.get(name) ?? "";

/** Desktop launchers often start Zotero with a minimal PATH; add the usual user bin dirs. */
export function searchPath(): string {
  const home = env("HOME");
  const dirs = env("PATH").split(":").filter(Boolean);
  for (const d of [`${home}/.local/bin`, `${home}/bin`, "/usr/local/bin", "/usr/bin", "/bin"]) if (!dirs.includes(d)) dirs.push(d);
  return dirs.join(":");
}

async function which(cmd: string): Promise<string> {
  if (cmd.includes("/")) return cmd;
  try {
    return await Subprocess.pathSearch(cmd, { PATH: searchPath() });
  } catch {
    throw new Error(`command not found: ${cmd} (searched ${searchPath()})`);
  }
}

export interface Spawn {
  argv: string[];
  cwd: string;
  log: string; // stdout (and stderr, unless errLog is set) go here
  errLog?: string;
  stdin?: string;
}

export async function runLogged(key: string, s: Spawn): Promise<RunResult> {
  if (running.has(key)) throw new Error(`a '${key.split(":").pop()}' task is already running`);
  await IOUtils.makeDirectory(PathUtils.parent(s.log), { ignoreExisting: true, createAncestors: true });
  const exe = await which(s.argv[0]);
  const redirect = s.errLog ? `>"$MR_LOG" 2>"$MR_ERR"` : `>"$MR_LOG" 2>&1`;
  const environment: Record<string, string> = { PATH: searchPath(), MR_LOG: s.log };
  if (s.errLog) environment.MR_ERR = s.errLog;
  const start = Date.now();
  const proc = await Subprocess.call({
    command: await which("setsid"),
    arguments: ["bash", "-c", `exec "$@" ${redirect}`, "metareader", exe, ...s.argv.slice(1)],
    workdir: s.cwd,
    environment,
    environmentAppend: true,
    stderr: "pipe",
  });
  running.set(key, proc.pid);
  try {
    if (s.stdin) await proc.stdin.write(s.stdin);
    await proc.stdin.close();
    const { exitCode } = await proc.wait();
    return { code: exitCode, duration_ms: Date.now() - start, log: PathUtils.filename(s.log) };
  } finally {
    running.delete(key);
  }
}

export async function stopTask(key: string): Promise<boolean> {
  const pid = running.get(key);
  if (pid === undefined) return false;
  const p = await Subprocess.call({ command: await which("kill"), arguments: ["-TERM", "--", `-${pid}`] });
  await p.wait();
  return true;
}

export const runningTasks = (prefix: string) => [...running.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));

export async function stopAll(prefix = "") {
  for (const k of [...running.keys()]) if (k.startsWith(prefix)) await stopTask(k);
}
