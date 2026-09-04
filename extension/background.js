import { tabsList, tabsCreate, tabsClose, navigate, groupsSummary, focusGroup, adoptWindow } from "./tools/tabs.js";
import { computer } from "./tools/computer.js";
import { setViewport } from "./tools/responsive.js";
import { readPage, find, getPageText, formInput, fileUpload, uploadImage } from "./tools/page.js";
import { javascriptExecute } from "./tools/javascript.js";
import { readConsoleMessages, readNetworkRequests } from "./tools/console-net.js";
import { gifRecord } from "./tools/gif.js";
import { shortcutsList, shortcutsExecute } from "./tools/shortcuts.js";
import { connectWs, isConnected } from "./tools/connection.js";
import { initGroupReaper } from "./tools/tabs.js";

const VERSION = chrome.runtime.getManifest().version;

const HANDLERS = {
  tabs_list: tabsList,
  tabs_create: tabsCreate,
  tabs_close: tabsClose,
  navigate: navigate,
  computer: computer,
  set_viewport: setViewport,
  read_page: readPage,
  find: find,
  get_page_text: getPageText,
  form_input: formInput,
  file_upload: fileUpload,
  upload_image: uploadImage,
  javascript_execute: javascriptExecute,
  read_console_messages: readConsoleMessages,
  read_network_requests: readNetworkRequests,
  gif_record: gifRecord,
  shortcuts_list: shortcutsList,
  shortcuts_execute: (params) => shortcutsExecute(params, dispatchTool),
};

async function dispatchTool(tool, params) {
  const handler = HANDLERS[tool];
  if (!handler) throw new Error(`Unknown tool "${tool}"`);
  return handler(params || {});
}

connectWs({ version: VERSION, dispatchTool });
initGroupReaper();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "taskwindow:getStatus") {
    sendResponse({ connected: isConnected(), version: VERSION });
    return;
  }
  if (msg?.type === "taskwindow:adoptWindow") {
    (async () => {
      try {
        const moved = await adoptWindow(msg.windowId);
        sendResponse({ ok: true, moved });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true; // async response
  }
  if (msg?.type === "taskwindow:focusGroup") {
    focusGroup(msg.name, msg.token).then((ok) => sendResponse({ ok }));
    return true; // async response
  }
  if (msg?.type === "taskwindow:getSummary") {
    (async () => {
      try {
        sendResponse({ connected: isConnected(), version: VERSION, groups: await groupsSummary() });
      } catch {
        sendResponse({ connected: isConnected(), version: VERSION, groups: [] });
      }
    })();
    return true; // async response
  }
});
