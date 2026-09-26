/* Pixel Press collector — injected into the page (MAIN or ISOLATED world).
 * Finds gallery images, upgrades thumbnail URLs to full-size originals, and
 * can fetch bytes from the page context (cookies + Cloudflare clearance).
 */
(() => {
  const API = "__PIXELPRESS_IMG2PDF__";

  const FULL_ATTRS = [
    "data-full-url", "data-full", "data-original", "data-orig-file",
    "data-large-file", "data-large", "data-zoom-image", "data-zoom-src",
    "data-zoom", "data-src-large", "data-hi-res-src", "data-hires",
    "data-original-src", "data-lazy-src", "data-src", "data-url",
    "data-image", "data-bg", "data-actualsrc", "data-original-image-url",
    "data-raw-src",
  ];

  const EXT_RE = "(?:jpe?g|png|webp|gif|avif|bmp)";
  const SKIP_URL =
    /favicon|sprite\.|\/sprites\/|emoji|wp-includes\/images|gravatar|doubleclick|adserver|adservice|analytics|tracking|1x1|pixel\.gif|blank\.gif|spacer\.(gif|png)|transparent\.(gif|png)|facebook\.com\/tr|google-analytics|loading\.gif|placeholder\.(gif|png|jpg|webp)/i;

  const THUMB_MARK =
    /(?:_thumb|-thumb|_small|-small|\/thumbs?\/|\/thumbnails?\/|\/tn\/|\/small\/)|(?:\d+)t\.(?:jpe?g|png|webp|gif|avif)|\/\/t\d*\./i;

  function isPlaceholder(u) {
    if (!u) return true;
    const s = String(u).trim();
    if (!s || s === "about:blank") return true;
    if (s.startsWith("data:image/svg")) return true;
    if (s.startsWith("data:image/gif") && s.length < 400) return true;
    if (s.startsWith("data:image/png") && s.length < 400) return true;
    if (/spacer|pixel|blank\.gif|placeholder|transparent|loading\.gif|1x1/i.test(s)) return true;
    return false;
  }

  function resolveUrl(input, base) {
    if (!input) return "";
    try {
      return new URL(String(input).trim().replace(/^['"]|['"]$/g, ""), base || document.baseURI).href;
    } catch {
      return "";
    }
  }

  function largestSrcset(srcset, base) {
    if (!srcset) return "";
    let best = "";
    let bestScore = -1;
    for (const part of String(srcset).split(",")) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      let score = 1;
      const desc = bits[1] || "";
      if (desc.endsWith("w")) score = parseInt(desc, 10) || 1;
      else if (desc.endsWith("x")) score = (parseFloat(desc) || 1) * 10000;
      if (score >= bestScore) {
        bestScore = score;
        best = bits[0];
      }
    }
    return resolveUrl(best, base);
  }

  function stripResizeParams(href) {
    try {
      const u = new URL(href);
      // "type" covers Webtoons ?type=q90 quality params
      ["w", "h", "width", "height", "resize", "quality", "q", "ssl", "strip", "fit", "crop", "auto", "dpr", "fm", "thumb", "thumbnail", "size", "s", "type"]
        .forEach((k) => u.searchParams.delete(k));
      return u.href;
    } catch {
      return href;
    }
  }

  function upgradeImageUrl(input, base) {
    const resolved = resolveUrl(input, base);
    if (!resolved || resolved.startsWith("data:") || resolved.startsWith("blob:")) return resolved || input;

    let href = resolved;
    const cf = href.match(/\/cdn-cgi\/image\/[^/]+\/(https?:\/\/.+)$/i);
    if (cf) href = cf[1];

    try {
      const u = new URL(href);
      if (/(^|\.)wsrv\.nl$|(^|\.)weserv\.nl$/i.test(u.hostname) && u.searchParams.get("url")) {
        let inner = u.searchParams.get("url") || "";
        if (inner && !/^https?:/i.test(inner)) inner = "https://" + inner;
        if (inner) href = inner;
      }
    } catch { /* ignore */ }

    try {
      const u = new URL(href);
      if (/\.wp\.com$/i.test(u.hostname) || /wordpress\.com$/i.test(u.hostname)) {
        href = stripResizeParams(u.href);
      }
    } catch { /* ignore */ }

    let next = stripResizeParams(href);
    next = next.replace(/\/(?:w|h|q|fit|crop|auto)=[^/]+/gi, "");
    next = next.replace(new RegExp("_thumb(?=\\." + EXT_RE + "(?:\\?|$))", "i"), "");
    next = next.replace(new RegExp("-thumb(?=\\." + EXT_RE + "(?:\\?|$))", "i"), "");
    next = next.replace(new RegExp("_small(?=\\." + EXT_RE + "(?:\\?|$))", "i"), "");
    next = next.replace(new RegExp("-small(?=\\." + EXT_RE + "(?:\\?|$))", "i"), "");
    next = next.replace(new RegExp("(?:_t|\\-t)(?=\\." + EXT_RE + "(?:\\?|$))", "i"), "");
    next = next.replace(/\/thumbs?\//i, "/");
    next = next.replace(/\/thumbnails?\//i, "/");
    next = next.replace(/\/tn\//i, "/");
    // nhentai-style: 12t.jpg → 12.jpg ; 12t.jpg.webp → 12.jpg
    next = next.replace(new RegExp("(\\d+)t(\\." + EXT_RE + ")(?:\\.webp)?(?=\\?|$)", "i"), "$1$2");
    next = next.replace(/\/\/t(\d*)\./i, "//i$1.");
    next = next.replace(new RegExp("-\\d{2,4}x\\d{2,4}(?=\\." + EXT_RE + ")", "i"), "");
    next = next.replace("/data/sample/", "/data/");
    next = next.replace("/data/preview/", "/data/");
    next = next.replace("/sample/", "/");
    next = next.replace("/preview/", "/");
    return next;
  }

  function uniqueUrls(list) {
    const out = [];
    const seen = new Set();
    for (const u of list) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
    return out;
  }

  function isThumbUrl(url) {
    return THUMB_MARK.test(String(url || ""));
  }

  function thumbFromFull(url) {
    try {
      const u = new URL(String(url || ""), document.baseURI);
      if (/^i\d*\.nhentai\.net$/i.test(u.hostname)) {
        u.hostname = u.hostname.replace(/^i/i, "t");
        u.pathname = u.pathname.replace(/(\d+)(\.[a-z0-9]+)$/i, "$1t$2");
        return u.href;
      }
    } catch { /* ignore */ }
    return "";
  }

  function candidatesFor(url, original) {
    const list = [];
    const upgraded = upgradeImageUrl(url);
    if (upgraded) list.push(upgraded);
    if (url && url !== upgraded) list.push(url);
    if (original && original !== url && original !== upgraded) list.push(original);

    const m = String(upgraded || url || "").match(/^(.*)(\.)(jpe?g|png|webp|gif|avif)(\?.*)?$/i);
    if (m) {
      const order = ["png", "jpg", "jpeg", "webp", "avif"];
      const srcExt = m[3].toLowerCase();
      const sorted = [srcExt, ...order.filter((e) => e !== srcExt)];
      for (const ext of sorted) {
        list.push(m[1] + m[2] + ext + (m[4] || ""));
      }
    }
    const ranked = uniqueUrls(list);
    ranked.sort((a, b) => Number(isThumbUrl(a)) - Number(isThumbUrl(b)));
    const expanded = [];
    for (const u of ranked) {
      expanded.push(u);
      try {
        const parsed = new URL(u);
        if (/^[it]\d*\.nhentai\.net$/i.test(parsed.hostname)) {
          const path = parsed.pathname.replace(/^\//, "");
          const preferred = parsed.origin.replace(/\/\/t(\d*)\./i, "//i$1.");
          for (const alt of nhentaiImageUrls(path, preferred)) expanded.push(alt);
        }
      } catch { /* ignore */ }
    }
    return uniqueUrls(expanded).slice(0, 8);
  }

  function rawFromImg(img) {
    if (!img) return "";
    for (const a of FULL_ATTRS) {
      const v = img.getAttribute && img.getAttribute(a);
      if (v && !isPlaceholder(v)) return v.trim();
    }
    const srcset = (img.getAttribute && (img.getAttribute("data-srcset") || img.getAttribute("srcset"))) || img.srcset || "";
    if (srcset) {
      const u = largestSrcset(srcset);
      if (u && !isPlaceholder(u)) return u;
    }
    const picture = img.closest && img.closest("picture");
    if (picture) {
      for (const source of picture.querySelectorAll("source[srcset], source[data-srcset]")) {
        const u = largestSrcset(source.getAttribute("data-srcset") || source.getAttribute("srcset"));
        if (u && !isPlaceholder(u)) return u;
      }
    }
    const current = img.currentSrc || (img.getAttribute && img.getAttribute("src")) || img.src;
    if (current && !isPlaceholder(current)) return current;
    return "";
  }

  function rawFromElement(el) {
    if (!el) return "";
    if (el.tagName === "IMG" || el.tagName === "SOURCE") return rawFromImg(el);
    for (const a of FULL_ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && !isPlaceholder(v)) return v.trim();
    }
    return "";
  }

  function anchorHref(el) {
    const a = el.closest && el.closest("a[href]");
    if (!a) return "";
    const href = a.href || "";
    if (new RegExp("\\." + EXT_RE + "(?:\\?|$)", "i").test(href)) return href;
    return "";
  }

  function makeItem(src, extra) {
    const original = extra.original || src;
    const upgraded = upgradeImageUrl(src);
    const finalSrc = upgraded || src;
    const extraCandidates = Array.isArray(extra.candidates) ? extra.candidates : [];
    return {
      src: finalSrc,
      original,
      thumb: extra.thumb || (isThumbUrl(original) ? original : "") || thumbFromFull(finalSrc),
      candidates: uniqueUrls(extraCandidates.concat(candidatesFor(finalSrc, original))).slice(0, 8),
      width: Number(extra.width) || 0,
      height: Number(extra.height) || 0,
      alt: extra.alt || "",
      upgraded: Boolean(upgraded && upgraded !== original) || extraCandidates.length > 0,
    };
  }

  function push(results, seen, src, extra) {
    if (!src) return;
    let resolved;
    try {
      resolved = new URL(src, document.baseURI).href;
    } catch {
      return;
    }
    if (!/^https?:|^blob:/i.test(resolved)) return;
    if (SKIP_URL.test(resolved)) return;
    const upgraded = upgradeImageUrl(resolved);
    const key = upgraded || resolved;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(makeItem(resolved, { ...extra, original: extra && extra.original ? extra.original : resolved }));
  }

  function extMap(t) {
    return { j: "jpg", p: "png", g: "gif", w: "webp", a: "avif", jpg: "jpg", png: "png", webp: "webp", gif: "gif", avif: "avif" }[t] || "jpg";
  }

  function nhentaiImageUrls(path, preferredHost) {
    const p = String(path || "").replace(/^\//, "");
    if (!p) return [];
    const hosts = [];
    if (preferredHost) hosts.push(String(preferredHost).replace(/\/$/, ""));
    for (let i = 1; i <= 4; i++) hosts.push("https://i" + i + ".nhentai.net");
    hosts.push("https://i.nhentai.net");
    const out = [];
    const seen = new Set();
    for (const h of hosts) {
      const url = h.replace(/\/$/, "") + "/" + p;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }

  function preferredCdnHost() {
    const sample = document.querySelector(
      ".gallerythumb img, .thumb-container img, #thumbnail-container img, #image-container img, a.gallerythumb img"
    );
    const sampleUrl = sample ? rawFromImg(sample) : "";
    if (!sampleUrl) return "";
    try {
      const u = new URL(upgradeImageUrl(sampleUrl), document.baseURI);
      u.hostname = u.hostname.replace(/^t(\d*)\./i, "i$1.");
      return u.origin;
    } catch {
      return "";
    }
  }

  function galleryPages(data) {
    if (!data) return [];
    if (Array.isArray(data.pages) && data.pages.length && data.pages[0] && (data.pages[0].path || data.pages[0].t || data.pages[0].type)) {
      return data.pages;
    }
    if (data.images && Array.isArray(data.images.pages)) return data.images.pages;
    return [];
  }

  function collectFromNhentaiJson(data, results, seen) {
    const pages = galleryPages(data);
    if (!pages.length) return false;
    const mediaId = data.media_id || data.mediaId || "";
    const preferred = preferredCdnHost();

    pages.forEach((p, i) => {
      const n = p.number || i + 1;
      let path = p.path ? String(p.path).replace(/^\//, "") : "";
      if (!path) {
        const ext = extMap(p.t || p.type);
        if (!mediaId) return;
        path = "galleries/" + mediaId + "/" + n + "." + ext;
      }
      const urls = nhentaiImageUrls(path, preferred);
      if (!urls.length) return;
      push(results, seen, urls[0], {
        width: p.width || p.w || 0,
        height: p.height || p.h || 0,
        alt: "Page " + n,
        candidates: urls,
        original: urls[0],
      });
    });
    return results.length > 0;
  }

  async function fetchGalleryApi(galleryId) {
    const paths = [
      "/api/v2/galleries/" + galleryId,
      "/api/gallery/" + galleryId,
    ];
    for (const path of paths) {
      try {
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
        const res = await fetch(path, {
          credentials: "include",
          cache: "no-cache",
          signal: ctrl ? ctrl.signal : undefined,
          headers: { Accept: "application/json,text/plain,*/*" },
        });
        if (timer) clearTimeout(timer);
        if (!res.ok) continue;
        const data = await res.json();
        if (galleryPages(data).length) return data;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  function embeddedGalleryJson() {
    try {
      const g = globalThis._gallery || globalThis.gallery || globalThis.GALLERY;
      if (g && galleryPages(g).length) return g;
    } catch { /* ignore */ }

    const scripts = document.getElementsByTagName("script");
    for (const s of scripts) {
      const t = s.textContent || "";
      if (t.length < 40 || t.length > 2500000) continue;
      if (!/media_id/.test(t)) continue;
      const tryParse = (raw) => {
        try {
          const data = JSON.parse(raw);
          if (galleryPages(data).length) return data;
        } catch { /* ignore */ }
        return null;
      };
      let m = t.match(/JSON\.parse\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)/);
      if (m) {
        try {
          const unquoted = JSON.parse('"' + m[1] + '"');
          const data = tryParse(unquoted);
          if (data) return data;
        } catch { /* ignore */ }
      }
      m = t.match(/new\s+N\.gallery\s*\(\s*(\{[\s\S]*?\})\s*\)/);
      if (m && tryParse(m[1])) return tryParse(m[1]);
      m = t.match(/_(?:gallery|n_gallery)\s*=\s*(\{[\s\S]*?"media_id"[\s\S]*?\})\s*;/);
      if (m && tryParse(m[1])) return tryParse(m[1]);
    }
    return null;
  }


  function isCloudflareChallenge() {
    const t = document.title || "";
    if (/just a moment/i.test(t)) return true;
    if (document.querySelector("#challenge-running, #cf-wrapper, .cf-browser-verification")) return true;
    return false;
  }

  function pageCountFromDoc(root) {
    if (!root) return 0;
    const numEl = root.querySelector && root.querySelector(".num-pages, #num-pages, span.num-pages, .total-pages, #page-count");
    if (numEl) {
      const n = parseInt(String(numEl.textContent).replace(/[^\d]/g, ""), 10);
      if (n > 1) return n;
    }
    const text = (root.body && root.body.innerText) || (root.documentElement && root.documentElement.innerText) || "";
    const pages = text.match(/\bPages?:\s*(\d{1,4})\b/i);
    if (pages) {
      const n = parseInt(pages[1], 10);
      if (n > 1) return n;
    }
    const slash = text.match(/\b1\s*\/\s*(\d{1,4})\b/);
    if (slash) {
      const n = parseInt(slash[1], 10);
      if (n > 1) return n;
    }
    return 0;
  }

  function clickShowAll() {
    const btn = document.querySelector(
      "#show-all-images-button, button.show-all, .show-all-images, a.show-all, [data-show-all], button[onclick*='show-all']"
    );
    if (btn && typeof btn.click === "function") {
      try { btn.click(); } catch { /* ignore */ }
    }
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
      try { img.loading = "eager"; } catch { /* ignore */ }
    });
    const box = document.querySelector("#thumbnail-container, .thumbs, #thumbs, .gallery, .thumb-container");
    if (box) {
      try {
        const old = box.scrollTop;
        box.scrollTop = box.scrollHeight;
        box.scrollTop = old;
      } catch { /* ignore */ }
    }
  }

  function sequenceFromUrl(src, max, results, seen) {
    const resolved = resolveUrl(upgradeImageUrl(src));
    const m = resolved && resolved.match(/(.+\/)(\d+)(\.(?:jpe?g|png|webp|gif|avif))(?:\?.*)?$/i);
    if (!m || max < 1) return false;
    const [, dir, cur, ext] = m;
    const pad = cur.length;
    const padded = cur.length > 1 && cur.startsWith("0");
    const exts = uniqueUrls([ext.replace(".", ""), "jpg", "png", "webp"].map((e) => e.replace(/^\./, "")));
    for (let i = 1; i <= max; i++) {
      const num = padded ? String(i).padStart(pad, "0") : String(i);
      const urls = exts.map((e) => dir + num + "." + e);
      push(results, seen, urls[0], { alt: "Page " + i, candidates: urls, original: urls[0] });
    }
    return results.length > 0;
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) { settled = true; resolve(null); }
      }, ms);
      Promise.resolve(promise)
        .then((v) => {
          if (!settled) { settled = true; clearTimeout(t); resolve(v); }
        })
        .catch(() => {
          if (!settled) { settled = true; clearTimeout(t); resolve(null); }
        });
    });
  }

  async function fetchReaderHtml(url) {
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
      const res = await fetch(url, {
        credentials: "include",
        cache: "no-cache",
        signal: ctrl ? ctrl.signal : undefined,
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) return null;
      const html = await res.text();
      if (!html || html.length < 80) return null;
      if (/just a moment|cf-browser-verification|challenge-platform/i.test(html) && html.length < 20000) return null;
      return html;
    } catch {
      return null;
    }
  }

  function parseReaderDoc(doc) {
    if (!doc) return { src: "", max: 0 };
    const img = doc.querySelector(
      "#image-container img, #img, img.fit-horizontal, img.fit-vertical, #page-container img, .reader-image img, .current-image img, #page img"
    );
    const src = img ? rawFromImg(img) || img.getAttribute("src") || "" : "";
    const max = pageCountFromDoc(doc);
    return { src, max };
  }

  function loadReaderIframe(url) {
    return new Promise((resolve) => {
      try {
        const iframe = document.createElement("iframe");
        iframe.setAttribute("aria-hidden", "true");
        iframe.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;border:0";
        const done = (value) => {
          clearTimeout(t);
          try { iframe.remove(); } catch { /* ignore */ }
          resolve(value);
        };
        const t = setTimeout(() => done(null), 4000);
        iframe.onload = () => {
          try {
            const doc = iframe.contentDocument;
            if (!doc) return done(null);
            done(parseReaderDoc(doc));
          } catch {
            done(null);
          }
        };
        iframe.onerror = () => done(null);
        document.documentElement.appendChild(iframe);
        iframe.src = url;
      } catch {
        resolve(null);
      }
    });
  }

  async function discoverFromReader(galleryId) {
    const readerUrl = new URL("/g/" + galleryId + "/1/", location.href).href;
    let src = "";
    let max = 0;

    const html = await fetchReaderHtml(readerUrl);
    if (html) {
      try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const parsed = parseReaderDoc(doc);
        src = parsed.src;
        max = parsed.max;
      } catch { /* ignore */ }
    }

    if (!src) {
      const framed = await withTimeout(loadReaderIframe(readerUrl), 4500);
      if (framed) {
        src = framed.src || src;
        max = framed.max || max;
      }
    }

    if (!src) {
      const pageImg = document.querySelector(
        "#image-container img, #img, img.fit-horizontal, img.fit-vertical, #page-container img, .reader-image img"
      );
      if (pageImg) src = rawFromImg(pageImg);
    }

    if (!max) max = pageCountFromDoc(document);
    if (!max) {
      const thumbs = document.querySelectorAll(
        ".thumb-container, a.gallerythumb, #thumbnail-container a, .gallery .thumb, .thumbs a"
      );
      if (thumbs.length >= 2) max = thumbs.length;
    }

    if (!src) {
      const thumb = document.querySelector(
        ".thumb-container img, a.gallerythumb img, #thumbnail-container img, .thumbs img"
      );
      if (thumb) src = upgradeImageUrl(rawFromImg(thumb) || thumb.src);
    }

    if (!src || max < 1) return null;
    const results = [];
    const seen = new Set();
    if (!sequenceFromUrl(src, max, results, seen)) return null;
    return results;
  }

  async function collectGallerySite() {
    const results = [];
    const seen = new Set();
    const path = location.pathname;

    if (isCloudflareChallenge()) {
      return { images: [], source: "cloudflare-challenge" };
    }

    clickShowAll();

    // Webtoons / LINE Webtoon vertical viewers: panels live in img._images[data-url]
    // or .viewer_lst / #_imageList. Prefer data-url over the (often placeholder) src.
    if (/webtoons\.com/i.test(location.hostname)) {
      const webtoonImgs = document.querySelectorAll(
        "img._images, .viewer_lst img, #_imageList img, #_viewerBox img, .viewer_img img"
      );
      webtoonImgs.forEach((img, i) => {
        const raw =
          (img.getAttribute && (img.getAttribute("data-url") || img.getAttribute("data-src"))) ||
          rawFromImg(img);
        if (!raw) return;
        const r = img.getBoundingClientRect();
        push(results, seen, raw, {
          width: Number(img.naturalWidth) || r.width || 0,
          height: Number(img.naturalHeight) || r.height || 0,
          alt: img.alt || "Page " + (i + 1),
          _y: r.top + (window.scrollY || 0),
        });
      });
      if (results.length >= 2) {
        results.sort((a, b) => (a._y || 0) - (b._y || 0));
        results.forEach((it) => { delete it._y; });
        return { images: results, source: "webtoons-viewer" };
      }
    }

    const jsonEl = document.querySelector("#json, script#json, script[type='application/json']#json");
    if (jsonEl && jsonEl.textContent) {
      try {
        collectFromNhentaiJson(JSON.parse(jsonEl.textContent), results, seen);
      } catch { /* ignore */ }
    }
    try {
      const embedded = embeddedGalleryJson();
      if (embedded) collectFromNhentaiJson(embedded, results, seen);
    } catch { /* ignore */ }

    const galleryPath = path.match(/^\/g\/(\d+)(?:\/(\d+))?\/?$/);

    if (results.length < 2 && galleryPath) {
      const apiData = await fetchGalleryApi(galleryPath[1]);
      if (apiData) collectFromNhentaiJson(apiData, results, seen);
    }

    if (results.length >= 2) return { images: results, source: "page-json" };

    if (galleryPath) {
      const discovered = await discoverFromReader(galleryPath[1]);
      if (discovered && discovered.length >= 1) {
        return { images: discovered, source: "reader-html" };
      }
    }

    const thumbImgs = document.querySelectorAll(
      [
        ".thumb-container img", "a.gallerythumb img", ".gallerythumb img",
        "#thumbnail-container img", ".thumbs img", ".gallery .thumb img",
        ".outer_thumbs img", "#thumbs img", ".gallery-thumb img", "a.gallery-thumb img",
      ].join(",")
    );

    if (thumbImgs.length >= 2) {
      thumbImgs.forEach((img, i) => {
        const raw = rawFromImg(img) || rawFromElement(img.parentElement) || anchorHref(img);
        if (!raw) return;
        const r = img.getBoundingClientRect();
        push(results, seen, raw, {
          width: Number(img.naturalWidth) || r.width || 0,
          height: Number(img.naturalHeight) || r.height || 0,
          alt: img.alt || "Page " + (i + 1),
        });
      });
      if (results.length >= 2) {
        const max = pageCountFromDoc(document);
        if (max > results.length) {
          const seq = [];
          const seqSeen = new Set();
          if (sequenceFromUrl(results[0].src, max, seq, seqSeen) && seq.length > results.length) {
            return { images: seq, source: "gallery-sequence" };
          }
        }
        return { images: results, source: "gallery-thumbs" };
      }
    }

    if (galleryPath) {
      const pageImg = document.querySelector(
        "#image-container img, #img, .fit-horizontal, #page-container img, .reader-image img, .current-image img"
      );
      const src = pageImg ? rawFromImg(pageImg) : "";
      const max = pageCountFromDoc(document);
      if (src && max > 1) {
        if (sequenceFromUrl(src, max, results, seen)) {
          return { images: results, source: "reader-sequence" };
        }
      }
    }

    return results.length ? { images: results, source: "gallery-partial" } : null;
  }

  function collectGeneric() {
    const results = [];
    const seen = new Set();
    const semantic = /thumbnail|gallery|image|images|photo|photos|picture|pictures|media|viewer|lightbox|content|chapter|pages|thumb/i;
    const candidates = [];
    const allEls = [...document.querySelectorAll("body *")].slice(0, 16000);

    for (const el of allEls) {
      const id = (el.id || "").toLowerCase();
      const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
      const name = `${id} ${cls}`;
      const images = el.querySelectorAll ? el.querySelectorAll(":scope img") : [];
      if (images.length < 2 || images.length > 4000) continue;

      const r = el.getBoundingClientRect();
      const w = Math.max(0, r.width);
      const h = Math.max(0, r.height);
      if (w < 80 || h < 60) continue;

      let usable = 0;
      for (const img of images) {
        if (usable > 40) break;
        const ir = img.getBoundingClientRect();
        const iw = Number(img.naturalWidth) || ir.width || 0;
        const ih = Number(img.naturalHeight) || ir.height || 0;
        if (Math.max(iw, ih) >= 24 || rawFromImg(img)) usable++;
      }
      if (usable < 2) continue;

      const semanticScore = semantic.test(name) ? 22 : 0;
      const thumbId = /thumbnail|thumb/.test(id + " " + cls) ? 28 : 0;
      const galleryId = /gallery|viewer|lightbox/.test(name) ? 22 : 0;
      const imageCountScore = Math.min(36, usable * 2.5);
      const score = semanticScore + thumbId + galleryId + imageCountScore;
      candidates.push({ el, score, count: images.length });
    }

    candidates.sort((a, b) => b.score - a.score);
    const named = document.getElementById("thumbnail-container");
    let chosen = candidates.find((c) => c.el.id === "thumbnail-container") || null;
    if (!chosen && named) {
      chosen = candidates.find((c) => c.el.contains(named) || named.contains(c.el)) || {
        el: named.parentElement || named,
        score: 99,
        count: 0,
      };
    }
    if (!chosen) chosen = candidates.find((c) => c.score >= 30) || candidates[0] || null;

    const scope = chosen ? chosen.el : document;

    const scopeRect = scope.getBoundingClientRect ? scope.getBoundingClientRect() : null;
    const scopeBottom = scopeRect ? (scopeRect.bottom + (window.scrollY || 0)) : 0;
    const pageH = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body ? document.body.scrollHeight : 0,
      1
    );
    scope.querySelectorAll("img").forEach((img) => {
      // Skip obvious chrome / footer / related widgets outside the main gallery block
      try {
        const closestFooter = img.closest(
          "footer, [role='contentinfo'], .footer, #footer, .site-footer, .related, .related-series, .recommendations, .sidebar, aside, .ad, .ads, .advertisement, .banner"
        );
        if (closestFooter && scope !== document && !scope.contains(closestFooter)) return;
        if (closestFooter && scope === document) {
          // On whole-page fallback, still drop pure footer/ad images
          const fr = closestFooter.getBoundingClientRect();
          if (fr.top > window.innerHeight * 0.85) return;
        }
      } catch { /* ignore */ }
      const raw = rawFromImg(img) || anchorHref(img);
      if (!raw) return;
      const r = img.getBoundingClientRect();
      const absTop = r.top + (window.scrollY || 0);
      // If we locked onto a gallery container, drop images that sit far below it
      if (scope !== document && scopeBottom > 0 && absTop > scopeBottom + 400) return;
      push(results, seen, raw, {
        width: Number(img.naturalWidth) || r.width || 0,
        height: Number(img.naturalHeight) || r.height || 0,
        alt: img.alt || "",
        _y: absTop,
      });
    });

    scope.querySelectorAll("a[href]").forEach((a) => {
      const href = a.href || "";
      if (new RegExp("\\." + EXT_RE + "(?:\\?|$)", "i").test(href)) {
        push(results, seen, href, { alt: a.getAttribute("title") || "" });
      }
    });

    const bgList = chosen ? chosen.el.querySelectorAll("*") : document.querySelectorAll("body *");
    let bgCount = 0;
    for (const el of bgList) {
      if (bgCount > 400) break;
      bgCount++;
      let bg = "";
      try { bg = getComputedStyle(el).backgroundImage; } catch { continue; }
      if (!bg || bg === "none") continue;
      const matches = bg.matchAll(/url\((['"]?)(.*?)\1\)/g);
      for (const m of matches) {
        if (m[2] && !isPlaceholder(m[2])) {
          push(results, seen, m[2], { width: el.clientWidth, height: el.clientHeight, alt: "" });
        }
      }
    }

    // Prefer document order (top → bottom) so footer junk is not mixed into the middle
    results.sort((a, b) => (a._y || 0) - (b._y || 0));
    results.forEach((it) => { delete it._y; });
    return {
      images: results,
      source: chosen ? (chosen.el.id ? "#" + chosen.el.id : "detected-gallery") : "whole-page",
    };
  }

  async function collect() {
    try {
      const specialized = await collectGallerySite();
      if (specialized && specialized.source === "cloudflare-challenge") {
        return {
          images: [],
          container: { found: false, id: "cloudflare-challenge", reason: "cloudflare-challenge" },
          pageUrl: location.href,
          title: document.title || "",
          error: "cloudflare",
        };
      }
      if (specialized && specialized.images && specialized.images.length) {
        return {
          images: specialized.images,
          container: { found: true, id: specialized.source, reason: specialized.source },
          pageUrl: location.href,
          title: document.title || "",
        };
      }
    } catch (err) {
      console.warn("Pixel Press gallery collector failed, using generic", err);
    }

    const generic = collectGeneric();
    return {
      images: generic.images,
      container: { found: generic.source !== "whole-page", id: generic.source, reason: generic.source },
      pageUrl: location.href,
      title: document.title || "",
    };
  }

  function bytesToBase64(bytes) {
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function fetchAsBase64(url) {
    // Prefer credentials:omit first — many CDNs only check Referer and reject
    // credentialed CORS. Fall back to include for cookie-gated galleries.
    const modes = ["omit", "include"];
    let lastErr = null;
    for (const cred of modes) {
      try {
        const res = await fetch(url, {
          credentials: cred,
          cache: "force-cache",
          referrer: location.href,
          referrerPolicy: "origin-when-cross-origin",
          headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
        });
        if (!res.ok) {
          lastErr = { ok: false, status: res.status };
          continue;
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 32) {
          lastErr = { ok: false, status: res.status, small: true };
          continue;
        }
        const bytes = new Uint8Array(buf);
        const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
        if (/^\s*<[!?h]/i.test(head) || head.indexOf("<ht") !== -1) {
          lastErr = { ok: false, status: res.status, html: true };
          continue;
        }
        return {
          ok: true,
          b64: bytesToBase64(bytes),
          mime: res.headers.get("content-type") || "",
          size: bytes.length,
        };
      } catch (err) {
        lastErr = { ok: false, error: String(err && err.message ? err.message : err) };
      }
    }
    return lastErr || { ok: false, error: "fetch failed" };
  }

  function fileKey(url) {
    try {
      const u = new URL(String(url || ""), document.baseURI);
      let name = (u.pathname.split("/").pop() || "").toLowerCase();
      name = name.replace(/t(\.[a-z0-9]+)$/i, "$1");
      name = name.replace(/\.(jpe?g|png|webp|gif|avif)$/i, "");
      return u.pathname.replace(/\/[^/]+$/, "/") + name;
    } catch {
      return String(url || "");
    }
  }

  function imgCandidateUrls(img) {
    const out = [];
    if (!img) return out;
    [
      img.currentSrc,
      img.src,
      img.getAttribute && img.getAttribute("src"),
      img.getAttribute && img.getAttribute("data-src"),
      img.getAttribute && img.getAttribute("data-lazy-src"),
      img.getAttribute && img.getAttribute("data-original"),
    ].forEach((v) => {
      if (v && !isPlaceholder(v)) out.push(resolveUrl(v));
    });
    const srcset = (img.getAttribute && (img.getAttribute("data-srcset") || img.getAttribute("srcset"))) || img.srcset;
    if (srcset) {
      const u = largestSrcset(srcset);
      if (u) out.push(u);
    }
    return uniqueUrls(out);
  }

  function snapshotImg(img, maxSide) {
    if (!img || !img.naturalWidth || img.naturalWidth < 4) return "";
    const max = maxSide || 180;
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * s));
    const h = Math.max(1, Math.round(img.naturalHeight * s));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.72);
    } catch {
      return "";
    }
  }

  function findMatchingImg(urls) {
    const keys = new Set((urls || []).map(fileKey).filter(Boolean));
    const exact = new Set((urls || []).map((u) => resolveUrl(u)).filter(Boolean));
    let fallback = null;
    for (const img of document.images) {
      const cands = imgCandidateUrls(img);
      if (cands.some((c) => exact.has(c))) {
        if (img.naturalWidth > 8) return img;
        fallback = fallback || img;
      }
      if (cands.some((c) => keys.has(fileKey(c)))) {
        if (img.naturalWidth > 8) return img;
        fallback = fallback || img;
      }
    }
    return fallback;
  }

  function galleryThumbImgs() {
    const nodes = document.querySelectorAll(
      [
        "#thumbnail-container img",
        "a.gallerythumb img",
        ".thumb-container img",
        ".gallerythumb img",
        ".thumbs img",
        ".gallery .thumb img",
        "#thumbs img",
        // Webtoons vertical viewer panels
        "img._images",
        ".viewer_lst img",
        "#_imageList img",
        "#_viewerBox img",
      ].join(",")
    );
    return [...nodes];
  }

  /** Snapshot already-decoded page images as small JPEG data URLs (same origin as the gallery). */
  function capturePreviews(items) {
    const map = {};
    const thumbs = galleryThumbImgs();
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      const key = item.key || item.src || "";
      if (!key) continue;
      const urls = item.urls && item.urls.length ? item.urls : [item.thumb, item.original, item.src, key];
      let img = findMatchingImg(urls.filter(Boolean));
      if ((!img || img.naturalWidth < 4) && thumbs[i]) img = thumbs[i];
      const data = snapshotImg(img);
      if (data) map[key] = data;
    }
    return map;
  }

  async function fetchPreview(url) {
    const got = await fetchAsBase64(url);
    if (!got.ok || !got.b64) return got;
    try {
      const bin = atob(got.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: got.mime || "image/*" });
      const bmp = await createImageBitmap(blob);
      const max = 180;
      const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * s));
      const h = Math.max(1, Math.round(bmp.height * s));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      bmp.close();
      return { ok: true, dataUrl: canvas.toDataURL("image/jpeg", 0.72), width: w, height: h };
    } catch (err) {
      return { ok: true, b64: got.b64, mime: got.mime, error: String(err && err.message ? err.message : err) };
    }
  }

  async function fetchPreviewMap(items) {
    const map = {};
    const list = Array.isArray(items) ? items : [];
    let i = 0;
    async function worker() {
      while (i < list.length) {
        const item = list[i++];
        if (!item || !item.key || map[item.key]) continue;
        const urls = (item.urls || []).filter(Boolean);
        for (const url of urls.slice(0, 3)) {
          try {
            const got = await fetchPreview(url);
            if (got && got.dataUrl) {
              map[item.key] = got.dataUrl;
              break;
            }
          } catch { /* next */ }
        }
      }
    }
    const n = Math.min(4, list.length || 1);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return map;
  }

  function deepScanPrepare() {
    clickShowAll();
    forceLazySources();
    globalThis.__PIXELPRESS_SCROLL__ = { x: window.scrollX, y: window.scrollY };
    const se = document.scrollingElement || document.documentElement;
    return {
      height: se ? se.scrollHeight : document.documentElement.scrollHeight,
      images: document.images.length,
    };
  }

  function forceLazySources() {
    let n = 0;
    const imgs = document.querySelectorAll("img");
    imgs.forEach((img) => {
      try {
        img.loading = "eager";
      } catch { /* ignore */ }
      for (const a of ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-url", "data-actualsrc", "data-hi-res-src"]) {
        const v = img.getAttribute(a);
        if (!v || isPlaceholder(v)) continue;
        const cur = img.getAttribute("src") || "";
        if (!cur || isPlaceholder(cur)) {
          try {
            img.src = v;
            n++;
          } catch { /* ignore */ }
        }
      }
      const ss = img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset");
      if (ss && !img.getAttribute("srcset")) {
        try {
          img.setAttribute("srcset", ss);
          n++;
        } catch { /* ignore */ }
      }
    });
    document.querySelectorAll("source[data-srcset]").forEach((s) => {
      if (!s.getAttribute("srcset")) {
        try {
          s.setAttribute("srcset", s.getAttribute("data-srcset"));
          n++;
        } catch { /* ignore */ }
      }
    });
    return n;
  }

  function clickLoadMore() {
    clickShowAll();
    const named = document.querySelector(
      [
        "button.load-more", "a.load-more", ".load-more",
        "button.show-more", ".show-more-button", ".show-more",
        "#show-all-images-button", "[data-load-more]", "[data-show-all]",
        "button[aria-label='Load more']", "button[aria-label='Show more']",
      ].join(",")
    );
    if (named && typeof named.click === "function") {
      try { named.click(); } catch { /* ignore */ }
    }
    const re = /^(load more|show more|see more|show all|view more|more posts|more images|more photos)$/i;
    const nodes = document.querySelectorAll("button, a, [role='button']");
    for (const el of nodes) {
      const t = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 28 && re.test(t)) {
        try { el.click(); } catch { /* ignore */ }
        break;
      }
    }
  }

  function findScrollRoots() {
    const roots = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      roots.push(el);
    };
    add(window);
    add(document.scrollingElement || document.documentElement);
    [
      "#thumbnail-container", ".thumbs", "#thumbs", ".gallery",
      ".thumb-container", ".infinite-scroll", "[data-infinite]",
      "main", "#content", ".content", ".page-container",
      "#app", "#root", "#__next", "#__nuxt", ".App",
      "[role='main']", ".overflow-y-auto", ".overflow-auto",
    ].forEach((sel) => {
      try { document.querySelectorAll(sel).forEach(add); } catch { /* ignore */ }
    });

    const scored = [];
    const all = document.querySelectorAll("body *");
    const limit = Math.min(all.length, 8000);
    for (let i = 0; i < limit; i++) {
      const el = all[i];
      let st;
      try { st = getComputedStyle(el); } catch { continue; }
      if (!st) continue;
      const oy = st.overflowY || st.overflow;
      if (!/(auto|scroll)/i.test(oy)) continue;
      const extra = (el.scrollHeight || 0) - (el.clientHeight || 0);
      if (extra < 120) continue;
      const imgs = el.querySelectorAll ? el.querySelectorAll("img").length : 0;
      scored.push({ el, score: extra + imgs * 50 });
    }
    scored.sort((a, b) => b.score - a.score);
    scored.slice(0, 8).forEach((s) => add(s.el));
    return roots;
  }

  function remainingScroll(el) {
    try {
      if (!el || el === window || el === document || el === document.documentElement || el === document.body) {
        const se = document.scrollingElement || document.documentElement;
        const height = se ? se.scrollHeight : document.documentElement.scrollHeight;
        const y = window.scrollY || window.pageYOffset || 0;
        const view = window.innerHeight || 0;
        return Math.max(0, height - (y + view));
      }
      return Math.max(0, (el.scrollHeight || 0) - ((el.scrollTop || 0) + (el.clientHeight || 0)));
    } catch {
      return 0;
    }
  }

  function scrollStepOn(el) {
    try {
      const remain = remainingScroll(el);
      if (remain < 8) return; // already at end — don't force anything
      const isWin = !el || el === window || el === document || el === document.documentElement || el === document.body;
      const view = isWin ? (window.innerHeight || 600) : (el.clientHeight || 300);
      // Gradual steps only — never jump to absolute bottom in one go
      const step = Math.max(Math.floor(view * 0.55), 200);
      if (isWin) {
        window.scrollBy(0, step);
        try {
          window.dispatchEvent(new Event("scroll"));
          document.dispatchEvent(new Event("scroll"));
          window.dispatchEvent(new WheelEvent("wheel", { deltaY: step, bubbles: true, cancelable: true }));
        } catch { /* ignore */ }
        return;
      }
      el.scrollTop = Math.min(el.scrollHeight, (el.scrollTop || 0) + step);
      try {
        el.dispatchEvent(new Event("scroll"));
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: step, bubbles: true, cancelable: true }));
      } catch { /* ignore */ }
      // If a container ignored the step (virtualized / overflow locked), nudge once more
      // by a fraction of remaining height — still not a full jump-to-end.
      if (remain > 0 && remainingScroll(el) === remain) {
        const nudge = Math.min(Math.floor(remain * 0.4), view);
        if (nudge > 0) el.scrollTop = Math.min(el.scrollHeight, (el.scrollTop || 0) + nudge);
      }
    } catch { /* ignore */ }
  }

  function atDocumentBottom() {
    const roots = findScrollRoots();
    let remain = 0;
    for (const r of roots) remain = Math.max(remain, remainingScroll(r));
    return remain < 48;
  }

  function deepScanTick() {
    clickLoadMore();
    const forced = forceLazySources();
    const roots = findScrollRoots();
    // Scroll every discovered root gradually. Do NOT scroll the last <img>
    // into view — that jumps long vertical pages (webtoons, infinite feeds)
    // straight to the bottom and then wastes passes at the end.
    roots.forEach(scrollStepOn);

    let remain = 0;
    for (const r of roots) remain = Math.max(remain, remainingScroll(r));

    const se = document.scrollingElement || document.documentElement;
    const height = se ? se.scrollHeight : document.documentElement.scrollHeight;
    const y = window.scrollY || window.pageYOffset || 0;
    return {
      y,
      height,
      remain,
      images: document.images.length,
      forced,
      atBottom: remain < 48,
    };
  }

  function deepScanRestore() {
    const s = globalThis.__PIXELPRESS_SCROLL__;
    if (s) {
      try { window.scrollTo(s.x, s.y); } catch { /* ignore */ }
    }
  }

  /**
   * Full deep collect in-page: scroll incrementally, wait for lazy DOM, merge
   * image lists each pass so virtualized pages cannot drop already-seen URLs.
   */
  async function deepCollect(opts) {
    const maxMs = (opts && opts.maxMs) || 35000;
    const maxPasses = (opts && opts.maxPasses) || 40;
    const start = Date.now();
    const orig = { x: window.scrollX, y: window.scrollY };

    clickLoadMore();
    forceLazySources();

    const merged = [];
    const seen = new Set();
    let lastMeta = null;

    async function merge() {
      const result = await collect();
      lastMeta = result;
      const list = (result && result.images) || [];
      for (const item of list) {
        const key = item && (item.src || item.original);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
      return result;
    }

    await merge();
    const complete = new Set(["page-json", "reader-html", "gallery-sequence", "reader-sequence"]);
    const reason = lastMeta && lastMeta.container && (lastMeta.container.reason || lastMeta.container.id);
    if (complete.has(reason) && merged.length >= 2) {
      try { window.scrollTo(orig.x, orig.y); } catch { /* ignore */ }
      return {
        images: merged,
        container: { found: true, id: "deep-scan:" + reason, reason: reason },
        pageUrl: location.href,
        title: document.title || "",
      };
    }

    let lastCount = merged.length;
    let lastHeight = (document.scrollingElement || document.documentElement).scrollHeight;
    let stable = 0;

    for (let i = 0; i < maxPasses && Date.now() - start < maxMs; i++) {
      deepScanTick();
      // Give IntersectionObserver / infinite-scroll fetchers time to append nodes
      await new Promise((r) => setTimeout(r, i === 0 ? 500 : 700));
      await merge();

      const se = document.scrollingElement || document.documentElement;
      const height = se ? se.scrollHeight : document.documentElement.scrollHeight;
      const grew = merged.length > lastCount || height > lastHeight + 8;
      if (grew) {
        stable = 0;
      } else {
        stable++;
      }
      lastCount = merged.length;
      lastHeight = height;

      if (atDocumentBottom() && stable >= 4) {
        await new Promise((r) => setTimeout(r, 1100));
        await merge();
        if (merged.length <= lastCount) break;
        lastCount = merged.length;
        stable = 0;
      }
    }

    await merge();
    try { window.scrollTo(orig.x, orig.y); } catch { /* ignore */ }

    return {
      images: merged,
      container: {
        found: true,
        id: "deep-scan",
        reason: lastMeta && lastMeta.container ? lastMeta.container.reason : "deep-scan",
      },
      pageUrl: location.href,
      title: document.title || "",
    };
  }

  globalThis[API] = {
    collect,
    deepCollect,
    fetchAsBase64,
    fetchPreview,
    fetchPreviewMap,
    capturePreviews,
    deepScanPrepare,
    deepScanTick,
    deepScanRestore,
    upgradeImageUrl,
    candidatesFor,
    isThumbUrl,
  };
})();
