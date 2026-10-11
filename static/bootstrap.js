/* global Services */
// Thin loader: the plugin itself is content/plugin.js (built from plugin/*.ts), which defines `MetaReader`.
var MetaReader;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "content/plugin.js");
  MetaReader.startup({ id, version, rootURI });
}

function onMainWindowLoad(params) {
  MetaReader?.onMainWindowLoad(params);
}

function onMainWindowUnload(params) {
  MetaReader?.onMainWindowUnload(params);
}

function shutdown() {
  MetaReader?.shutdown();
  MetaReader = undefined;
}
