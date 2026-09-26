function setFill(pct) {
  document.getElementById("fill").style.width = Math.max(0, Math.min(100, pct)) + "%";
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg || "";
}

function setDetail(msg) {
  document.getElementById("detail").textContent = msg || "";
}

function looksLikeImage(bytes) {
  if (!bytes || bytes.length < 12) return false;
  if (PixelPressPdf.looksLikeHtml(bytes)) return false;
  return PixelPressPdf.detectFormat(bytes) !== "unknown";
}

function safeFilename(title) {
  const raw = (title || "page-images").replace(/\s+/g, " ").trim();
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").slice(0, 80);
  return (cleaned || "page-images") + ".pdf";
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rewriteHost(url, host) {
  if (!url || !host) return url;
  try {
    const u = new URL(url);
    if (/^[it]\d*\.nhentai\.net$/i.test(u.hostname)) {
      u.hostname = host;
      return u.href;
    }
  } catch { /* */ }
  return url;
}

function isNhentaiJob(job) {
  const u = String(job.pageUrl || "");
  if (/nhentai\.net/i.test(u)) return true;
  for (const img of job.images || []) {
    for (const s of [img.src, img.original].concat(img.candidates || [])) {
      if (s && /nhentai\.net/i.test(s)) return true;
    }
  }
  return false;
}

function allUrls(item, learnedHost, generous) {
  const list = [];
  const add = (u) => {
    if (!u) return;
    const rewritten = rewriteHost(u, learnedHost);
    if (!list.includes(rewritten)) list.push(rewritten);
    if (!list.includes(u)) list.push(u);
  };
  add(item.src);
  if (Array.isArray(item.candidates)) item.candidates.forEach(add);
  add(item.original);

  // Alternate extensions — mixed galleries often have wrong guessed ext
  const more = [];
  for (const u of list.slice()) {
    try {
      const m = String(u).match(/^(.*\/)(\d+)(\.)(jpe?g|png|webp|gif|avif)(\?.*)?$/i);
      if (!m) continue;
      for (const ext of ["jpg", "webp", "png", "jpeg"]) {
        if (ext.toLowerCase() === m[4].toLowerCase()) continue;
        more.push(m[1] + m[2] + m[3] + ext + (m[5] || ""));
      }
    } catch { /* */ }
  }
  more.forEach(add);

  try {
    const sample = list[0];
    if (sample) {
      const u = new URL(sample);
      if (/^[it]\d*\.nhentai\.net$/i.test(u.hostname)) {
        const path = u.pathname.replace(/^\//, "");
        // same path on every CDN host
        for (let i = 1; i <= 4; i++) add("https://i" + i + ".nhentai.net/" + path);
        add("https://i.nhentai.net/" + path);
        // and alternate extensions on the preferred / learned host
        const basePath = path.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "");
        const host = learnedHost
          ? "https://" + learnedHost
          : u.origin.replace(/\/\/t(\d*)\./i, "//i$1.");
        for (const ext of ["jpg", "webp", "png"]) {
          add(host + "/" + basePath + "." + ext);
          for (let i = 1; i <= 4; i++) add("https://i" + i + ".nhentai.net/" + basePath + "." + ext);
        }
      }
    }
  } catch { /* */ }

  const cap = generous ? 12 : learnedHost ? 5 : 8;
  return list.slice(0, cap);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchDirect(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 4000);
  try {
    const res = await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      signal: ctrl.signal,
      headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.length < 32 || !looksLikeImage(bytes)) throw new Error("not an image");
    return { bytes, mime: res.headers.get("content-type") || "", url };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBackground(url) {
  const result = await Promise.race([
    chrome.runtime.sendMessage({ type: "fetch-image", url }),
    sleep(6000).then(() => ({ ok: false, error: "bg timeout" })),
  ]);
  if (!result || !result.ok || !result.b64) {
    throw new Error((result && (result.error || result.status)) || "bg fetch failed");
  }
  const bytes = b64ToBytes(result.b64);
  if (!looksLikeImage(bytes)) throw new Error("bg not an image");
  return { bytes, mime: result.mime || "", url };
}

let pageWorld = null;
let pageInjectTried = false;

async function injectCollector(tabId) {
  if (pageWorld) return pageWorld;
  if (pageInjectTried) return null;
  pageInjectTried = true;
  for (const world of ["MAIN", "ISOLATED"]) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world,
        files: ["collect.js"],
      });
      pageWorld = world;
      return world;
    } catch { /* */ }
  }
  return null;
}

async function fetchViaPage(tabId, url, timeoutMs) {
  const world = await injectCollector(tabId);
  if (!world) throw new Error("no page world");
  const wait = timeoutMs || 15000;
  const [{ result }] = await Promise.race([
    chrome.scripting.executeScript({
      target: { tabId },
      world,
      func: async (targetUrl) => {
        const api = globalThis.__PIXELPRESS_IMG2PDF__;
        if (!api || typeof api.fetchAsBase64 !== "function") {
          return { ok: false, error: "collector missing" };
        }
        return api.fetchAsBase64(targetUrl);
      },
      args: [url],
    }),
    sleep(wait).then(() => [{ result: { ok: false, error: "page timeout" } }]),
  ]);
  if (result && result.ok && result.b64) {
    const bytes = b64ToBytes(result.b64);
    if (looksLikeImage(bytes)) return { bytes, mime: result.mime || "", url };
  }
  throw new Error((result && result.error) || "page fetch failed");
}

/**
 * Strategy:
 * - When a gallery tab is still open (preferPage): try page-context fetch first
 *   (cookies + natural Referer — works for Cloudflare / hotlink-protected CDNs).
 * - Otherwise: race a few direct hosts, then background service-worker fetch,
 *   then fall back to page-world if a tabId is available.
 */
async function fetchItem(item, tabId, learnedHost, preferPage, generous) {
  const urls = allUrls(item, learnedHost, generous);
  let lastErr = new Error("no urls");
  const directTimeout = generous ? 7000 : 4000;
  const pageSlice = generous ? urls.length : Math.min(4, urls.length);

  if (preferPage && tabId) {
    for (const url of urls.slice(0, pageSlice)) {
      try {
        return await fetchViaPage(tabId, url, generous ? 20000 : 15000);
      } catch (err) {
        lastErr = err;
      }
    }
  }

  // Race a few direct hosts
  const directBatch = urls.slice(0, Math.min(generous ? 5 : 3, urls.length));
  if (directBatch.length) {
    try {
      return await Promise.any(
        directBatch.map((url) => fetchDirect(url, directTimeout))
      );
    } catch (agg) {
      lastErr = agg && agg.errors && agg.errors[0] ? agg.errors[0] : lastErr;
    }
  }

  // Background service-worker fetch
  for (const url of urls.slice(0, generous ? 4 : 2)) {
    try {
      return await fetchBackground(url);
    } catch (err) {
      lastErr = err;
    }
  }

  // Page world if not already preferred
  if (!preferPage && tabId) {
    for (const url of urls.slice(0, pageSlice)) {
      try {
        return await fetchViaPage(tabId, url, generous ? 20000 : 15000);
      } catch (err) {
        lastErr = err;
      }
    }
  }

  throw lastErr;
}

async function mapPool(count, concurrency, worker) {
  let next = 0;
  async function runner() {
    while (next < count) {
      const i = next++;
      await worker(i);
    }
  }
  const n = Math.min(concurrency, count) || 1;
  await Promise.all(Array.from({ length: n }, () => runner()));
}

async function run() {
  const stored = await chrome.storage.local.get("pixelpressJob");
  const job = stored.pixelpressJob;
  if (!job || !Array.isArray(job.images) || !job.images.length) {
    document.querySelector("h1").textContent = "Nothing to convert";
    setStatus("The scan data expired or was empty. Open the extension on a page and scan again.");
    return;
  }

  document.getElementById("subtitle").textContent =
    job.layout === "a4"
      ? "Fitting images onto A4 pages (embedded at full resolution)."
      : "One page per image · native pixels";

  const hosts = [];
  for (const img of job.images) {
    for (const u of [img.src, img.original].concat(img.candidates || [])) {
      try {
        if (u) hosts.push(new URL(u).hostname);
      } catch { /* */ }
    }
  }
  for (let i = 1; i <= 4; i++) {
    hosts.push("i" + i + ".nhentai.net");
    hosts.push("t" + i + ".nhentai.net");
  }
  hosts.push("i.nhentai.net", "t.nhentai.net");

  try {
    await chrome.runtime.sendMessage({
      type: "set-referer",
      pageUrl: job.pageUrl,
      hosts: [...new Set(hosts)],
    });
  } catch { /* */ }

  const n = job.images.length;
  const payloads = new Array(n);
  let done = 0;
  let okCount = 0;
  let learnedHost = "";
  // Prefer the open gallery tab whenever we still have it (cookies + natural Referer).
  // This benefits any hotlink-protected / Cloudflare site, not just nhentai.
  const preferPage = Boolean(job.tabId);
  // lower concurrency for page-world to avoid hammering the gallery tab
  const concurrency = preferPage ? 3 : 6;

  function progress() {
    setFill((done / n) * 80);
    setStatus("Fetching " + done + " of " + n + " (" + okCount + " ok)");
  }

  setStatus(preferPage ? "Fetching via gallery tab…" : "Probing first image…");
  setDetail(job.images[0].src || "(no src)");

  // First image: learn working host / confirm page-tab works
  try {
    const first = await Promise.race([
      fetchItem(job.images[0], job.tabId, "", preferPage, true),
      sleep(20000).then(() => {
        throw new Error("first image timeout — keep gallery tab open");
      }),
    ]);
    payloads[0] = { bytes: first.bytes, mime: first.mime };
    okCount = 1;
    try {
      learnedHost = new URL(first.url).hostname;
    } catch { /* */ }
    setDetail(first.url + " · " + first.bytes.length + " bytes");
  } catch (err) {
    console.warn("first image failed", err);
    setDetail(
      "First image failed (" +
        (err && err.message ? err.message : "unknown") +
        "). Continuing…"
    );
  }
  done = 1;
  progress();

  await mapPool(n - 1, concurrency, async (j) => {
    const i = j + 1;
    try {
      const got = await fetchItem(job.images[i], job.tabId, learnedHost, preferPage, false);
      payloads[i] = { bytes: got.bytes, mime: got.mime };
      okCount++;
      if (!learnedHost) {
        try {
          learnedHost = new URL(got.url).hostname;
        } catch { /* */ }
      }
      setDetail(got.url);
    } catch (err) {
      console.warn("miss", i, err && err.message ? err.message : err);
    }
    done++;
    progress();
  });

  // Multi-pass retries for misses (rate-limits, wrong ext, transient CDN blips)
  for (let pass = 1; pass <= 3; pass++) {
    const misses = [];
    for (let i = 0; i < n; i++) if (!payloads[i]) misses.push(i);
    if (!misses.length) break;

    setStatus("Retry " + pass + "/3 — " + misses.length + " image(s)…");
    setDetail("Waiting a moment before retry (avoids rate limits)…");
    await sleep(800 * pass);

    // Alternate preferPage each pass; always generous on later passes
    const retryPrefer = pass === 1 ? !preferPage : true;
    const conc = pass >= 2 ? 1 : 2;
    await mapPool(misses.length, conc, async (k) => {
      const i = misses[k];
      try {
        const got = await fetchItem(job.images[i], job.tabId, learnedHost, retryPrefer, true);
        payloads[i] = { bytes: got.bytes, mime: got.mime };
        okCount++;
        if (!learnedHost) {
          try { learnedHost = new URL(got.url).hostname; } catch { /* */ }
        }
        setDetail("recovered page " + (i + 1) + " · " + got.url);
      } catch (err) {
        console.warn("retry" + pass + " miss", i, err && err.message ? err.message : err);
      }
      progress();
    });
  }

  const loaded = payloads.filter(Boolean);
  const failed = n - loaded.length;

  if (!loaded.length) {
    document.querySelector("h1").textContent = "Could not load images";
    setStatus(
      "All fetches failed. Keep the gallery tab open, finish any Cloudflare check, then scan and convert again."
    );
    setDetail(
      preferPage
        ? "Gallery-tab fetches failed — the tab may have been closed or navigated away."
        : "Direct CDN fetches were blocked. Try again with the gallery page still open."
    );
    setFill(0);
    return;
  }

  setStatus("Writing PDF…");
  setDetail(loaded.length + " of " + n + " images");

  const doc = await PixelPressPdf.buildHighQualityPdf({
    images: loaded,
    layout: job.layout || "original",
    onProgress: (i, total, msg) => {
      setFill(80 + ((i + 1) / total) * 20);
      setStatus(msg);
    },
  });

  const name = safeFilename(job.title);
  // Blob download avoids "Invalid string length" on large galleries
  if (typeof PixelPressPdf.savePdf === "function") {
    PixelPressPdf.savePdf(doc, name);
  } else {
    doc.save(name);
  }
  setFill(100);
  if (failed) {
    const skippedIdx = [];
    for (let i = 0; i < n; i++) if (!payloads[i]) skippedIdx.push(i + 1);
    setStatus(
      "Downloaded " + name + " — skipped " + failed + " image(s)."
    );
    setDetail(
      "Native pixels preserved. Skipped page(s): " +
        skippedIdx.slice(0, 30).join(", ") +
        (skippedIdx.length > 30 ? "…" : "") +
        ". Re-run convert with gallery tab open to fill gaps."
    );
  } else {
    setStatus(
      "Downloaded " + name + " (" + loaded.length + " page" + (loaded.length === 1 ? "" : "s") + ")."
    );
    setDetail("Native pixel size preserved.");
  }

  try {
    await chrome.storage.local.remove("pixelpressJob");
    await chrome.runtime.sendMessage({ type: "clear-referer" });
  } catch { /* */ }
}

run().catch((err) => {
  console.error(err);
  document.querySelector("h1").textContent = "Conversion failed";
  setStatus(err && err.message ? err.message : String(err));
});
