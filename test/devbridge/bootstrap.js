/* Dev-only: POST JS to http://127.0.0.1:23119/metareader-dev/eval; it runs as an async function body in
   chrome scope and the JSON of its return value is sent back. Only installed into zotero/dev-profile by dev.sh. */
/* global Zotero */
function install() {}
function uninstall() {}
async function startup() {
  await Zotero.initializationPromise;
  const Endpoint = function () {};
  Endpoint.prototype = {
    supportedMethods: ["POST"],
    supportedDataTypes: "*",
    permitBookmarklet: false,
    async init(req) {
      try {
        const AsyncFunction = (async () => {}).constructor;
        const win = Zotero.getMainWindow();
        const v = await new AsyncFunction("Zotero", "win", req.data)(Zotero, win);
        return [200, "application/json", JSON.stringify({ ok: v ?? null })];
      } catch (e) {
        return [200, "application/json", JSON.stringify({ err: String(e) + "\n" + (e?.stack ?? "") })];
      }
    },
  };
  Zotero.Server.Endpoints["/metareader-dev/eval"] = Endpoint;
}
function shutdown() {
  delete Zotero.Server.Endpoints["/metareader-dev/eval"];
}
