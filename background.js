/* Session Referer / Origin / CORS so hotlink-protected and Cloudflare CDNs
 * accept fetches from the converter tab and in-page scripts.
 */

const RULE_ID = 1;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "set-referer") {
    const pageUrl = String(msg.pageUrl || "");
    if (!pageUrl) {
      sendResponse({ ok: false, error: "missing pageUrl" });
      return;
    }
    const origin = originOf(pageUrl);
    const pageHost = hostOf(pageUrl);
    const extraHosts = Array.isArray(msg.hosts) ? msg.hosts.filter(Boolean) : [];
    const initiator = [chrome.runtime.id];
    if (pageHost) {
      initiator.push(pageHost.replace(/^www\./, ""), pageHost);
    }

    const action = {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: pageUrl },
        ...(origin ? [{ header: "Origin", operation: "set", value: origin }] : []),
      ],
      responseHeaders: [
        { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
        { header: "Access-Control-Allow-Headers", operation: "set", value: "*" },
      ],
    };

    const rule = {
      id: RULE_ID,
      priority: 1,
      action,
      condition: {
        initiatorDomains: initiator.filter(Boolean),
        resourceTypes: ["xmlhttprequest", "other", "image"],
      },
    };

    const extraRules = extraHosts.slice(0, 40).map((h, i) => ({
      id: RULE_ID + 1 + i,
      priority: 1,
      action,
      condition: {
        requestDomains: [h],
        resourceTypes: ["xmlhttprequest", "other", "image"],
      },
    }));

    const removeIds = Array.from({ length: 42 }, (_, i) => RULE_ID + i);
    chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: removeIds, addRules: [rule, ...extraRules] })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg && msg.type === "clear-referer") {
    const removeIds = Array.from({ length: 42 }, (_, i) => RULE_ID + i);
    chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: removeIds, addRules: [] })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg && msg.type === "fetch-image") {
    const url = String(msg.url || "");
    if (!url) {
      sendResponse({ ok: false, error: "missing url" });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    // DNR session rules should already inject Referer for these hosts.
    fetch(url, {
      credentials: "omit",
      cache: "no-store",
      signal: ctrl.signal,
      headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    })
      .then(async (res) => {
        clearTimeout(timer);
        if (!res.ok) return { ok: false, status: res.status };
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 32) return { ok: false, status: res.status, small: true };
        const bytes = new Uint8Array(buf);
        // Reject HTML (Cloudflare challenge pages)
        if (bytes[0] === 0x3c || (bytes[0] === 0x20 && bytes[1] === 0x3c)) {
          return { ok: false, status: res.status, html: true };
        }
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return {
          ok: true,
          b64: btoa(binary),
          mime: res.headers.get("content-type") || "",
          size: bytes.length,
        };
      })
      .then(sendResponse)
      .catch((err) => {
        clearTimeout(timer);
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true;
  }
});
