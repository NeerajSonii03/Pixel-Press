let allImages = [];
let selected = new Set();
let pageMeta = { tabId: null, pageUrl: "", title: "" };
let previewBusy = 0;

const els = {
  scanBtn: document.getElementById("scanBtn"),
  deepScanBtn: document.getElementById("deepScanBtn"),
  controls: document.getElementById("controls"),
  selectAll: document.getElementById("selectAll"),
  minSize: document.getElementById("minSize"),
  count: document.getElementById("count"),
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  footer: document.getElementById("footer"),
  selectedCount: document.getElementById("selectedCount"),
  convertBtn: document.getElementById("convertBtn"),
};

function setStatus(msg) {
  els.status.textContent = msg || "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function visibleImages() {
  const min = parseInt(els.minSize.value, 10) || 0;
  return allImages.filter((i) => {
    if (i.upgraded) return true;
    return Math.max(i.width || 0, i.height || 0) >= min;
  });
}

function layoutChoice() {
  const el = document.querySelector('input[name="layout"]:checked');
  return el ? el.value : "original";
}

function unique(list) {
  const out = [];
  const seen = new Set();
  for (const u of list) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// --- Persistence helpers (added) ---
const STORAGE_KEY = "pixelpressPopupState";

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    // Drop hash / trailing slash noise so chapter pages match
    x.hash = "";
    let path = x.pathname.replace(/\/+$/, "") || "/";
    return x.origin + path + (x.search || "");
  } catch {
    return String(u || "");
  }
}

async function saveState() {
  if (!pageMeta.pageUrl || !allImages.length) return;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        pageUrl: pageMeta.pageUrl,
        pageUrlNorm: normalizeUrl(pageMeta.pageUrl),
        tabId: pageMeta.tabId,
        title: pageMeta.title,
        images: allImages.map((i) => ({
          src: i.src,
          original: i.original,
          thumb: i.thumb,
          candidates: i.candidates,
          width: i.width,
          height: i.height,
          alt: i.alt,
          upgraded: i.upgraded,
          preview: i.preview || "",
        })),
        selected: [...selected],
        minSize: els.minSize.value,
        layout: layoutChoice(),
        savedAt: Date.now(),
      },
    });
  } catch (err) {
    console.warn("saveState failed", err);
  }
}

async function clearState() {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch { /* */ }
}

async function tryRestoreState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url) return false;
    if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url)) return false;

    const data = await chrome.storage.local.get(STORAGE_KEY);
    const st = data[STORAGE_KEY];
    if (!st || !Array.isArray(st.images) || !st.images.length) return false;

    const curNorm = normalizeUrl(tab.url);
    const savedNorm = st.pageUrlNorm || normalizeUrl(st.pageUrl || "");
    // Only restore when we are still on the same page/chapter URL
    if (!savedNorm || curNorm !== savedNorm) {
      // Different chapter/page → drop stale state
      await clearState();
      return false;
    }

    pageMeta = {
      tabId: tab.id,
      pageUrl: st.pageUrl || tab.url,
      title: st.title || tab.title || "",
    };
    allImages = st.images.map((i) => ({ ...i, preview: i.preview || "" }));
    selected = new Set(Array.isArray(st.selected) ? st.selected : allImages.map((i) => i.src));
    if (st.minSize != null) els.minSize.value = String(st.minSize);
    if (st.layout) {
      const radio = document.querySelector(`input[name="layout"][value="${st.layout}"]`);
      if (radio) radio.checked = true;
    }

    els.controls.classList.remove("hidden");
    els.footer.classList.remove("hidden");
    renderGrid();
    const havePreview = allImages.filter((i) => i.preview).length;
    setStatus(
      `Restored ${allImages.length} image(s) from this page` +
        (havePreview < allImages.length ? ` · ${havePreview} previews cached` : "") +
        ". Scan again only if the page changed."
    );

    // Refresh missing previews in background
    if (havePreview < allImages.length) {
      snapshotPreviews(tab.id).then(() => fetchMissingPreviews(tab.id)).catch(() => {});
    }
    return true;
  } catch (err) {
    console.warn("tryRestoreState failed", err);
    return false;
  }
}

/** Prefer sequential page order (filename numbers) then visual position. */
function sortImagesNaturally(list) {
  if (!Array.isArray(list) || list.length < 2) return list;

  function pageNum(u) {
    const s = String(u || "");
    // Common patterns: /12.jpg, /012.webp, page-12, p12, 12t.jpg
    const m =
      s.match(/\/(\d{1,4})(?:t)?\.(?:jpe?g|png|webp|gif|avif)(?:\?|$)/i) ||
      s.match(/(?:page|p|img)[-_]?(\d{1,4})(?:\D|$)/i) ||
      s.match(/[_\-](\d{1,4})(?:\.(?:jpe?g|png|webp|gif|avif))?(?:\?|$)/i);
    return m ? parseInt(m[1], 10) : NaN;
  }

  const withNum = list.map((item, idx) => ({
    item,
    idx,
    n: pageNum(item.src) || pageNum(item.original) || pageNum(item.thumb),
  }));
  const numbered = withNum.filter((x) => Number.isFinite(x.n) && x.n > 0);
  // Only sort by number when a clear majority look sequential
  if (numbered.length >= Math.max(3, list.length * 0.55)) {
    withNum.sort((a, b) => {
      const an = Number.isFinite(a.n) ? a.n : 1e9;
      const bn = Number.isFinite(b.n) ? b.n : 1e9;
      if (an !== bn) return an - bn;
      return a.idx - b.idx;
    });
    return withNum.map((x) => x.item);
  }
  return list;
}


function previewCandidates(item) {
  const list = [];
  if (item.thumb) list.push(item.thumb);
  if (item.original && item.original !== item.src) list.push(item.original);
  try {
    const u = new URL(item.src);
    if (/^i\d*\.nhentai\.net$/i.test(u.hostname)) {
      const t = new URL(item.src);
      t.hostname = t.hostname.replace(/^i/i, "t");
      t.pathname = t.pathname.replace(/(\d+)(\.[a-z0-9]+)$/i, "$1t$2");
      list.push(t.href);
    }
  } catch { /* */ }
  return unique(list);
}

function renderGrid() {
  const items = visibleImages();
  els.count.textContent = items.length;
  els.grid.innerHTML = "";

  items.forEach((item, idx) => {
    const cell = document.createElement("div");
    cell.className = "thumb" + (selected.has(item.src) ? " selected" : "");

    const img = document.createElement("img");
    img.alt = item.alt || "";
    img.dataset.key = item.src;
    img.decoding = "async";
    if (item.preview) {
      img.src = item.preview;
    } else {
      img.classList.add("blank");
    }
    cell.appendChild(img);

    const badge = document.createElement("div");
    badge.className = "badge";
    cell.appendChild(badge);

    if (item.upgraded) {
      const upg = document.createElement("div");
      upg.className = "upg";
      upg.textContent = "full";
      cell.appendChild(upg);
    }

    if (item.width && item.height && !item.upgraded) {
      const dims = document.createElement("div");
      dims.className = "dims";
      dims.textContent = `${Math.round(item.width)}×${Math.round(item.height)}`;
      cell.appendChild(dims);
    }

    cell.addEventListener("click", () => {
      if (selected.has(item.src)) selected.delete(item.src);
      else selected.add(item.src);
      cell.classList.toggle("selected");
      updateFooter();
      saveState();
    });

    els.grid.appendChild(cell);
    cell.dataset.idx = String(idx);
  });

  updateFooter();
}

function applyPreview(key, dataUrl) {
  if (!dataUrl) return;
  const item = allImages.find((i) => i.src === key);
  if (item) item.preview = dataUrl;
  // Match by dataset, not CSS.escape — URLs break attribute selectors.
  for (const img of els.grid.querySelectorAll("img")) {
    if (img.dataset.key === key) {
      img.src = dataUrl;
      img.classList.remove("blank");
    }
  }
}

function updateFooter() {
  const n = selected.size;
  els.selectedCount.textContent = `${n} selected`;
  els.convertBtn.disabled = n === 0;
}

async function injectCollector(tabId, world) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world,
    files: ["collect.js"],
  });
}

async function callApi(tabId, world, name, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func: async (fn, fnArgs) => {
      const api = globalThis.__PIXELPRESS_IMG2PDF__;
      if (!api || typeof api[fn] !== "function") return { __missing: true };
      return api[fn](...(fnArgs || []));
    },
    args: [name, args || []],
  });
  return result;
}

async function collectFromWorld(tabId, world) {
  await injectCollector(tabId, world);
  const result = await callApi(tabId, world, "collect", []);
  if (result && result.__missing) return null;
  return result;
}

async function collectImages(tabId) {
  let last = null;
  for (const world of ["MAIN", "ISOLATED"]) {
    try {
      const result = await collectFromWorld(tabId, world);
      if (result && Array.isArray(result.images) && result.images.length) return result;
      if (result) last = result;
    } catch (err) {
      console.warn("collect failed in", world, err);
    }
  }
  return last;
}

async function withWorld(tabId, fn) {
  let lastErr = null;
  for (const world of ["MAIN", "ISOLATED"]) {
    try {
      await injectCollector(tabId, world);
      return await fn(world);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not reach the page");
}

async function mergeCollect(into, result) {
  if (!result || !Array.isArray(result.images)) return result;
  const seen = into._seen || (into._seen = new Set(into.images.map((i) => i.src)));
  for (const item of result.images) {
    if (!item || !item.src || seen.has(item.src)) continue;
    seen.add(item.src);
    into.images.push(item);
  }
  if (result.container) into.container = result.container;
  if (result.pageUrl) into.pageUrl = result.pageUrl;
  if (result.title) into.title = result.title;
  return into;
}

async function deepScanPage(tabId) {
  const bag = { images: [], _seen: new Set(), container: { found: true, id: "deep-scan", reason: "deep-scan" } };

  return withWorld(tabId, async (world) => {
    await callApi(tabId, world, "deepScanPrepare", []);

    const first = await callApi(tabId, world, "collect", []);
    if (first && !first.__missing) await mergeCollect(bag, first);
    setStatus("Deep scan… " + bag.images.length + " image(s)");

    const complete = new Set(["page-json", "reader-html", "gallery-sequence", "reader-sequence"]);
    const reason = first && first.container && (first.container.reason || first.container.id);
    if (complete.has(reason) && bag.images.length >= 2) {
      try { await callApi(tabId, world, "deepScanRestore", []); } catch { /* */ }
      bag.container = first.container;
      return bag;
    }

    let lastCount = bag.images.length;
    let lastHeight = 0;
    let lastRemain = 1e9;
    let stable = 0;
    const t0 = Date.now();
    const maxMs = 90000;
    const maxPasses = 80;

    for (let i = 0; i < maxPasses && Date.now() - t0 < maxMs; i++) {
      const tick = await callApi(tabId, world, "deepScanTick", []);
      if (!tick || tick.__missing) break;
      const remain = Number(tick.remain);
      const atEnd = tick.atBottom || (Number.isFinite(remain) && remain < 48);
      await sleep(atEnd ? 1200 : 700);

      const result = await callApi(tabId, world, "collect", []);
      if (result && !result.__missing) await mergeCollect(bag, result);

      const height = Number(tick.height) || 0;
      const grew =
        bag.images.length > lastCount ||
        height > lastHeight + 16 ||
        (Number.isFinite(remain) && remain < lastRemain - 40);
      setStatus(
        "Deep scan… " + bag.images.length + " image(s)  ·  pass " + (i + 1) +
          (Number.isFinite(remain) ? "  ·  " + Math.round(remain) + "px left" : "")
      );

      if (grew) stable = 0;
      else stable++;
      lastCount = bag.images.length;
      lastHeight = height;
      if (Number.isFinite(remain)) lastRemain = remain;

      // Stop once every scroller is exhausted and nothing new appeared.
      // Lower stable threshold so we don't keep spinning at the bottom.
      if (atEnd && stable >= 5) {
        await sleep(1000);
        await callApi(tabId, world, "deepScanTick", []);
        const extra = await callApi(tabId, world, "collect", []);
        if (extra && !extra.__missing) await mergeCollect(bag, extra);
        if (bag.images.length <= lastCount) break;
        lastCount = bag.images.length;
        stable = 0;
      }
    }

    const last = await callApi(tabId, world, "collect", []);
    if (last && !last.__missing) await mergeCollect(bag, last);
    try { await callApi(tabId, world, "deepScanRestore", []); } catch { /* */ }
    bag.images = sortImagesNaturally(bag.images || []);
    return bag;
  });
}

async function snapshotPreviews(tabId) {
  const payload = allImages.map((i) => ({
    key: i.src,
    urls: unique([i.thumb, i.original, i.src].concat(i.candidates || [])),
  }));
  try {
    await withWorld(tabId, async (world) => {
      const map = await callApi(tabId, world, "capturePreviews", [payload]);
      if (!map || map.__missing) return;
      Object.keys(map).forEach((key) => applyPreview(key, map[key]));
    });
  } catch (err) {
    console.warn("snapshot previews failed", err);
  }
}

async function fetchMissingPreviews(tabId) {
  const missing = allImages.filter((i) => !i.preview);
  if (!missing.length) return;
  previewBusy++;
  const token = previewBusy;

  const payload = missing.map((i) => ({
    key: i.src,
    urls: previewCandidates(i),
  }));

  try {
    await withWorld(tabId, async (world) => {
      const map = await callApi(tabId, world, "fetchPreviewMap", [payload]);
      if (!map || map.__missing) return;
      Object.keys(map).forEach((key) => applyPreview(key, map[key]));
    });
  } catch (err) {
    console.warn("page preview map failed", err);
  }
  if (token !== previewBusy) return;

  const still = allImages.filter((i) => !i.preview);
  if (!still.length) return;

  let next = 0;
  async function worker() {
    while (next < still.length && token === previewBusy) {
      const item = still[next++];
      const urls = previewCandidates(item);
      for (const url of urls) {
        try {
          const result = await Promise.race([
            chrome.runtime.sendMessage({ type: "fetch-image", url }),
            sleep(8000).then(() => null),
          ]);
          if (result && result.ok && result.b64) {
            applyPreview(item.src, "data:" + (result.mime || "image/jpeg") + ";base64," + result.b64);
            break;
          }
        } catch { /* next url */ }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, still.length) }, () => worker()));
}

function setBusy(busy) {
  els.scanBtn.disabled = busy;
  els.deepScanBtn.disabled = busy;
}

async function runScan(deep) {
  setBusy(true);
  setStatus(deep ? "Deep scan… preparing" : "Scanning page…");
  els.grid.innerHTML = "";
  selected.clear();
  previewBusy++;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab found");
    if (!tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
      throw new Error("This page cannot be scanned. Open a regular website first.");
    }

    pageMeta = { tabId: tab.id, pageUrl: tab.url, title: tab.title || "" };

    let result;
    if (deep) {
      result = await deepScanPage(tab.id);
    } else {
      result = await collectImages(tab.id);
    }
    if (!result) throw new Error("The page did not return a scan result.");
    if (result.error === "cloudflare") {
      throw new Error("Cloudflare challenge is still up. Wait until the page fully loads, then scan again.");
    }
    allImages = sortImagesNaturally((result.images || []).map((i) => ({ ...i, preview: "" })));
    pageMeta.pageUrl = result.pageUrl || pageMeta.pageUrl;
    pageMeta.title = result.title || pageMeta.title;

    try {
      const hosts = [];
      allImages.forEach((img) => {
        [img.src, img.original, img.thumb].concat(img.candidates || []).forEach((u) => {
          try { if (u) hosts.push(new URL(u).hostname); } catch { /* */ }
        });
      });
      try { hosts.push(new URL(pageMeta.pageUrl).hostname); } catch { /* */ }
      for (let i = 1; i <= 4; i++) {
        hosts.push("i" + i + ".nhentai.net", "t" + i + ".nhentai.net");
      }
      await chrome.runtime.sendMessage({
        type: "set-referer",
        pageUrl: pageMeta.pageUrl,
        hosts: [...new Set(hosts)],
      });
    } catch { /* */ }

    visibleImages().forEach((i) => selected.add(i.src));
    els.controls.classList.remove("hidden");
    els.footer.classList.remove("hidden");
    renderGrid();

    const c = result.container;
    const how = c?.id ? c.id : "page";
    const upgraded = allImages.filter((i) => i.upgraded).length;
    const extra = upgraded ? ` ${upgraded} upgraded to full size.` : "";
    setStatus(
      allImages.length
        ? `Found ${allImages.length} image(s) via ${how}.${extra} Loading previews…`
        : "No images found on this page."
    );

    if (allImages.length) {
      await snapshotPreviews(tab.id);
      const snapped = allImages.filter((i) => i.preview).length;
      setStatus(
        `Found ${allImages.length} image(s) via ${how}.${extra}` +
          (snapped < allImages.length ? ` Previews ${snapped}/${allImages.length}.` : "")
      );
      fetchMissingPreviews(tab.id).then(() => {
        const have = allImages.filter((i) => i.preview).length;
        setStatus(`Found ${allImages.length} image(s) via ${how}.${extra}`);
        if (have < allImages.length) {
          setStatus(
            `Found ${allImages.length} image(s) via ${how}.${extra} ${have} previews loaded.`
          );
        }
        saveState();
      }).catch(() => { saveState(); });
      // Persist immediately so closing the popup does not lose the scan
      saveState();
    } else {
      await clearState();
    }
  } catch (err) {
    console.error(err);
    setStatus(err && err.message ? err.message : "Could not scan this page.");
  } finally {
    setBusy(false);
  }
}

els.scanBtn.addEventListener("click", () => runScan(false));
els.deepScanBtn.addEventListener("click", () => runScan(true));

els.selectAll.addEventListener("change", () => {
  if (els.selectAll.checked) visibleImages().forEach((i) => selected.add(i.src));
  else visibleImages().forEach((i) => selected.delete(i.src));
  renderGrid();
  saveState();
});

els.minSize.addEventListener("change", () => {
  if (els.selectAll.checked) {
    selected = new Set(visibleImages().map((i) => i.src));
  }
  renderGrid();
  saveState();
});

els.convertBtn.addEventListener("click", async () => {
  const items = allImages.filter((i) => selected.has(i.src));
  if (!items.length || !pageMeta.tabId) return;

  els.convertBtn.disabled = true;
  setStatus("Opening converter…");

  try {
    await chrome.storage.local.set({
      pixelpressJob: {
        tabId: pageMeta.tabId,
        pageUrl: pageMeta.pageUrl,
        title: pageMeta.title,
        layout: layoutChoice(),
        images: items.map((i) => ({
          src: i.src,
          original: i.original,
          candidates: i.candidates,
          thumb: i.thumb,
          alt: i.alt,
        })),
        createdAt: Date.now(),
      },
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL("converter.html") });
    setStatus("Converter opened in a new tab — keep the gallery tab open until the PDF downloads.");
  } catch (err) {
    console.error(err);
    setStatus("Could not start conversion: " + (err.message || err));
    els.convertBtn.disabled = false;
  }
});

document.querySelectorAll('input[name="layout"]').forEach((el) => {
  el.addEventListener("change", () => saveState());
});

// Restore previous scan for this URL when the popup opens
(async () => {
  const restored = await tryRestoreState();
  if (!restored) {
    setStatus("Open a gallery page, then Scan or Deep scan.");
  }
})();
