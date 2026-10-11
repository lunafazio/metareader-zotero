export interface Config {
  openalex_api_key: string;
  mailto: string;
  grobid_url: string;
  docling_cmd: string;
  claude_cmd: string;
  claude_model: string;
}

const PREF = "extensions.metareader.";
export const CONFIG_KEYS = ["openalex_api_key", "mailto", "grobid_url", "docling_cmd", "claude_cmd", "claude_model"] as const;
const DEFAULTS: Partial<Config> = { grobid_url: "http://localhost:8070", docling_cmd: "docling", claude_cmd: "claude" };

export function loadConfig(): Config {
  const c = {} as Config;
  for (const k of CONFIG_KEYS) c[k] = String(Zotero.Prefs.get(PREF + k, true) ?? "") || DEFAULTS[k] || "";
  return c;
}

export function saveConfig(config: Config) {
  for (const k of CONFIG_KEYS) Zotero.Prefs.set(PREF + k, String(config[k] ?? ""), true);
}
