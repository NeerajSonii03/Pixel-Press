/* Shared high-quality PDF builder for Pixel Press.
 * One image per page, page size matches native pixels.
 * Original JPEG/PNG bytes embedded as-is. WebP/AVIF/GIF decoded and
 * stored as JPEG (high quality) or PNG when small enough.
 *
 * Avoids "Invalid string length" on large galleries by:
 *  - never building one giant binary/base64 string for the whole book
 *  - feeding jsPDF Uint8Array (or short data-URLs) per page
 *  - enabling PDF stream compression
 *  - saving via Blob instead of a single output string
 */
(function (root) {
  const MAX_PAGE_PT = 14400;
  const PNG_BYTE_CAP = 4 * 1024 * 1024; // prefer JPEG above this to keep PDF smaller
  const DATA_URL_SAFE = 6 * 1024 * 1024; // avoid data-URL path for huge single images

  function detectFormat(bytes) {
    if (!bytes || bytes.length < 12) return "unknown";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "JPEG";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "PNG";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "GIF";
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45
    ) {
      return "WEBP";
    }
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (/avif|avis|mif1|miaf/i.test(brand)) return "AVIF";
    }
    return "unknown";
  }

  function looksLikeHtml(bytes) {
    if (!bytes || bytes.length < 16) return false;
    let i = 0;
    while (i < 8 && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++;
    const a = bytes[i];
    if (a === 0x3c) {
      const s = String.fromCharCode(a, bytes[i + 1] || 32, bytes[i + 2] || 32, bytes[i + 3] || 32).toLowerCase();
      if (s.indexOf("<!") === 0 || s.indexOf("<h") === 0 || s.indexOf("<html") === 0 || s.indexOf("<?") === 0) return true;
    }
    return false;
  }

  /** Chunked base64 — never build one giant intermediate string. */
  function bytesToBase64(bytes) {
    const chunk = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, i + chunk);
      parts.push(String.fromCharCode.apply(null, slice));
    }
    // Join in batches to stay under max string length for very large images
    if (parts.length === 1) return btoa(parts[0]);
    let binary = "";
    const batch = 64;
    for (let i = 0; i < parts.length; i += batch) {
      binary += parts.slice(i, i + batch).join("");
      if (i + batch < parts.length && binary.length > 50 * 1024 * 1024) {
        // Extremely large — fall back to pure btoa on smaller chunks is already done;
        // if still too big, caller should use raw Uint8Array path instead.
        throw new Error("image too large for data-URL");
      }
    }
    return btoa(binary);
  }

  function bytesToDataUrl(bytes, mime) {
    return "data:" + (mime || "application/octet-stream") + ";base64," + bytesToBase64(bytes);
  }

  function blobToBytes(blob) {
    return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
  }

  async function measureBlob(blob) {
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }).catch(() =>
      createImageBitmap(blob)
    );
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  }

  async function drawToCanvas(blob, alpha) {
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }).catch(() =>
      createImageBitmap(blob)
    );
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d", { alpha: Boolean(alpha), colorSpace: "srgb" });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return canvas;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas encode failed"))), type, quality);
    });
  }

  async function reencodeLossless(blob) {
    const canvas = await drawToCanvas(blob, true);
    const out = await canvasToBlob(canvas, "image/png");
    return { blob: out, width: canvas.width, height: canvas.height, format: "PNG" };
  }

  async function reencodeJpeg(blob, quality) {
    const canvas = await drawToCanvas(blob, false);
    const out = await canvasToBlob(canvas, "image/jpeg", quality == null ? 0.95 : quality);
    return { blob: out, width: canvas.width, height: canvas.height, format: "JPEG" };
  }

  function pageSize(width, height) {
    let w = width;
    let h = height;
    if (w > MAX_PAGE_PT || h > MAX_PAGE_PT) {
      const s = MAX_PAGE_PT / Math.max(w, h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    return { w, h, orientation: w >= h ? "l" : "p" };
  }

  /**
   * Feed jsPDF an image without building a multi-hundred-MB string when possible.
   * jsPDF accepts Uint8Array for JPEG/PNG in modern builds.
   */
  function addImageSafe(doc, bytes, format, x, y, w, h, alias) {
    const fmt = format === "PNG" ? "PNG" : "JPEG";
    // Prefer raw bytes — avoids data-URL string bloat
    try {
      doc.addImage(bytes, fmt, x, y, w, h, alias, "FAST");
      return;
    } catch (e1) {
      // Some builds want ArrayBuffer
      try {
        doc.addImage(bytes.buffer, fmt, x, y, w, h, alias, "FAST");
        return;
      } catch (e2) {
        /* fall through to data-URL */
      }
    }
    if (bytes.length > DATA_URL_SAFE) {
      throw new Error("image too large to embed (" + Math.round(bytes.length / 1024 / 1024) + " MB)");
    }
    const mime = fmt === "PNG" ? "image/png" : "image/jpeg";
    const dataUrl = bytesToDataUrl(bytes, mime);
    doc.addImage(dataUrl, fmt, x, y, w, h, alias, "FAST");
  }

  async function prepareOne(item, index, total, onProgress) {
    onProgress(index, total, "Reading " + (index + 1) + " of " + total);
    let bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item.bytes);
    let mime = item.mime || "";
    if (looksLikeHtml(bytes)) {
      throw new Error("Image " + (index + 1) + " was an HTML page, not a picture (hotlink/Cloudflare blocked).");
    }
    let format = detectFormat(bytes);
    let blob = new Blob([bytes], { type: mime || "application/octet-stream" });
    let width = 0;
    let height = 0;

    try {
      const size = await measureBlob(blob);
      width = size.width;
      height = size.height;
    } catch {
      /* re-encode below */
    }

    const canEmbedRaw = (format === "JPEG" || format === "PNG") && width && height;

    if (!canEmbedRaw) {
      // WebP/AVIF/GIF → prefer high-quality JPEG to keep the PDF tractable
      try {
        const jpg = await reencodeJpeg(blob, 0.95);
        bytes = await blobToBytes(jpg.blob);
        format = "JPEG";
        mime = "image/jpeg";
        width = jpg.width;
        height = jpg.height;
      } catch (err) {
        try {
          const rec = await reencodeLossless(blob);
          if (rec.blob.size > PNG_BYTE_CAP) {
            const jpg = await reencodeJpeg(blob, 0.92);
            bytes = await blobToBytes(jpg.blob);
            format = "JPEG";
            mime = "image/jpeg";
            width = jpg.width;
            height = jpg.height;
          } else {
            bytes = await blobToBytes(rec.blob);
            format = "PNG";
            mime = "image/png";
            width = rec.width;
            height = rec.height;
          }
        } catch (err2) {
          throw new Error("Could not decode image " + (index + 1) + ": " + (err2.message || err.message));
        }
      }
    } else if (format === "PNG" && bytes.length > PNG_BYTE_CAP) {
      // Huge PNG → recompress as JPEG so the final PDF stays under string limits
      try {
        const jpg = await reencodeJpeg(blob, 0.95);
        bytes = await blobToBytes(jpg.blob);
        format = "JPEG";
        mime = "image/jpeg";
        width = jpg.width;
        height = jpg.height;
      } catch {
        /* keep PNG */
      }
    }

    return { bytes, format, mime, width, height };
  }

  async function buildHighQualityPdf(opts) {
    const { jsPDF } = root.jspdf || window.jspdf;
    const images = opts.images || [];
    const layout = opts.layout || "original";
    const onProgress = opts.onProgress || function () {};
    if (!images.length) throw new Error("No images to convert");

    // Prepare first page to size the document
    const firstPrep = await prepareOne(images[0], 0, images.length, onProgress);
    const first = pageSize(firstPrep.width, firstPrep.height);

    let doc;
    if (layout === "a4") {
      doc = new jsPDF({
        unit: "pt",
        format: "a4",
        compress: true,
        orientation: first.orientation,
      });
    } else {
      doc = new jsPDF({
        unit: "pt",
        format: [first.w, first.h],
        orientation: first.orientation,
        compress: true,
      });
    }

    // Embed page by page; release each image's bytes after embedding
    for (let i = 0; i < images.length; i++) {
      const img = i === 0 ? firstPrep : await prepareOne(images[i], i, images.length, onProgress);
      onProgress(
        i,
        images.length,
        "Embedding " + (i + 1) + " of " + images.length + " at " + img.width + "×" + img.height
      );

      if (layout === "a4") {
        if (i > 0) doc.addPage("a4", img.width >= img.height ? "l" : "p");
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const scale = Math.min(pageW / img.width, pageH / img.height) || 1;
        const w = img.width * scale;
        const h = img.height * scale;
        const x = (pageW - w) / 2;
        const y = (pageH - h) / 2;
        addImageSafe(doc, img.bytes, img.format, x, y, w, h, "p" + i);
      } else {
        const pg = pageSize(img.width, img.height);
        if (i > 0) doc.addPage([pg.w, pg.h], pg.orientation);
        addImageSafe(doc, img.bytes, img.format, 0, 0, pg.w, pg.h, "p" + i);
      }

      // Help GC between pages on large books
      img.bytes = null;
      if (i > 0 && images[i] && images[i].bytes) {
        try {
          images[i].bytes = null;
        } catch {
          /* */
        }
      }
    }

    return doc;
  }

  /** Save without building one giant string when possible. */
  function savePdf(doc, filename) {
    try {
      const blob = doc.output("blob");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "page-images.pdf";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
          a.remove();
        } catch {
          /* */
        }
      }, 4000);
      return;
    } catch (err) {
      console.warn("blob save failed, falling back to doc.save", err);
    }
    doc.save(filename || "page-images.pdf");
  }

  root.PixelPressPdf = {
    detectFormat,
    looksLikeHtml,
    bytesToDataUrl,
    buildHighQualityPdf,
    savePdf,
    measureBlob,
    reencodeJpeg,
    reencodeLossless,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
