// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
// Fallback for browsers where setPanelBehavior isn't honored.
chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (e) {}
});

// ---- Crowdin API v2 proxy --------------------------------------------------
// The panel calls Crowdin's DOCUMENTED public API (https://<org>.api.crowdin.com/api/v2)
// through here so the request runs in the extension's background (host-permitted) and isn't
// subject to page CORS. The token is the user's own personal access token, passed per-call
// and never persisted here. Only ever talks to *.api.crowdin.com.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'CROWDIN_API') return;
  (async () => {
    try {
      const org = String(msg.org || '').replace(/[^a-z0-9-]/gi, '');
      if (!org) { sendResponse({ ok: false, error: 'no org' }); return; }
      if (!/^\/[a-z0-9/_.-]*/i.test(String(msg.path || ''))) { sendResponse({ ok: false, error: 'bad path' }); return; }
      const url = `https://${org}.api.crowdin.com/api/v2${msg.path}`;
      const headers = { 'Authorization': 'Bearer ' + (msg.token || '') };
      if (msg.body != null) headers['Content-Type'] = 'application/json';
      const r = await fetch(url, {
        method: msg.method || 'GET',
        headers,
        body: msg.body != null ? JSON.stringify(msg.body) : undefined
      });
      let data = null; try { data = await r.json(); } catch (e) {}
      sendResponse({ ok: r.ok, status: r.status, data });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // async response
});
