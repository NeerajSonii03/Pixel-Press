# Pixel Press — Page Images to PDF

Chrome/Edge extension that scans the current tab, upgrades gallery thumbnails to full-size originals, and writes a PDF at **native pixel size** (no A4 downscale, no JPEG recompress of already-valid JPEGs).

## Install (unpacked)

1. Unzip this folder somewhere permanent (do not delete it after loading).
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Pin the extension for quick access.

## Use

1. Open the page whose images you want. For gallery sites, wait until the page fully loads (including any Cloudflare check).
2. Click the extension → **Scan** for what’s already in the DOM, or **Deep scan** to auto-scroll and trigger lazy-loaded images.
3. Thumbnails marked **full** were upgraded from a thumbnail URL to the original.
4. Leave **Original pixels** selected (default) and click **Convert to PDF**.
5. A converter tab fetches each image (with the gallery page as Referer, so hotlink-protected CDNs work) and downloads the PDF. **Keep the original gallery tab open** until it finishes.

## What this version fixes

- **Popup state survives close:** closing the popup (clicking the page) no longer wipes the scan. Results are restored when you reopen the popup on the **same URL/chapter**. State resets only when you navigate to a different page or start a new scan.
- **Less footer/junk interleaving:** generic collection skips common footer/related/ad blocks and orders images top→bottom; after Deep scan, images are sorted by page-number in the URL when possible so stray bottom images don’t sit in the middle of the chapter.
- **Popup previews:** the grid no longer hotlinks CDN URLs (those fail with `no-referrer` / CORS). Previews come from the same page-context pipeline as the PDF: snapshot already-decoded `<img>`s, then fetch leftover thumbs through the gallery tab.
- **Deep scan:** auto-scrolls the page and overflow galleries, promotes `loading="lazy"` images, clicks common “load more” controls, and stops when height/image count stabilize. Restores your scroll position.
- **nhentai / mixed formats:** reads the gallery API (`pages[].path`) so each page keeps its real `.webp` / `.jpg` / `.png` URL.
- **Speed / CDN:** converter fetches with timeouts, races `i1`–`i4.nhentai.net`, retries misses.
- **Quality:** native pixel PDF pages; original JPEG/PNG bytes; WebP/AVIF/GIF stored as JPEG/PNG.
- **Hotlink / Cloudflare:** Referer is set to the gallery page. Keep that tab open until the PDF downloads.
- **Gallery-tab preference:** when the original gallery tab is still open, the converter now always tries page-context fetches first (cookies + natural Referer). This helps any protected site, not only nhentai.
- **Webtoons:** detects `img._images[data-url]` / `.viewer_lst` panels, strips `?type=q90` quality params for full-size images, and includes those nodes in the preview snapshot list.
- **Deep scan no longer jumps to the end:** removed the “scroll last image into view” step that sent long pages straight to the bottom and then spun until the pass limit. Scrolling is gradual only; stop threshold is tighter when already at the bottom.
- **Preview fetches:** page-context image fetches try `credentials: omit` first (most CDNs only care about Referer), then fall back to `include` for cookie-gated galleries.

## Notes

- Keep the original gallery tab open while converting.
- SVGs and tracking pixels are skipped.
- “Fit A4” still embeds full-resolution data; it only changes how pages are framed.
- Infinite-scroll feeds stop after a stability check so Deep scan cannot run forever.
