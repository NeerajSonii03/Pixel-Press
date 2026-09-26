# Pixel Press — Page Images to PDF

A Chromium browser extension that scans webpages for images, finds higher-quality originals, and converts selected images into a PDF while preserving their native resolution.

Built for image-heavy webpages, galleries, and webtoons where manually downloading images one by one is inconvenient.

## Features

* **Image Discovery** — Scans images already present on the page.
* **Deep Scan** — Automatically scrolls pages, triggers lazy-loaded content, and detects additional images.
* **Original Image Detection** — Attempts to replace thumbnails with higher-resolution originals.
* **Native Resolution PDF** — Generates PDF pages using the images' original pixel dimensions instead of forcing them into A4.
* **Image Quality Preservation** — Keeps original JPEG/PNG data where possible; other formats are converted when required by PDF generation.
* **Persistent Scan State** — Closing and reopening the popup does not lose the current scan.
* **Smart Ordering** — Removes common page junk and attempts to maintain the correct image order.
* **Page-Context Fetching** — Uses the original webpage context when fetching protected images, improving compatibility with CDN and hotlink restrictions.
* **Gallery Support** — Includes additional handling for lazy-loaded galleries, webtoons, and mixed image formats.
* **Preview Grid** — Preview discovered images before generating the PDF.

## How It Works

```text
Webpage
   ↓
Image Discovery
   ↓
Thumbnail → Original Detection
   ↓
Image Validation & Ordering
   ↓
User Selection
   ↓
High-Resolution Image Fetch
   ↓
Native-Resolution PDF
```

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the Pixel Press project folder.
6. Pin the extension for easy access.

## Usage

1. Open the webpage containing the images.
2. Open Pixel Press.
3. Choose **Scan** to process images currently available on the page.
4. Use **Deep Scan** for pages with lazy-loaded or dynamically loaded images.
5. Review and select the images you want.
6. Keep **Original pixels** selected for native-resolution output.
7. Click **Convert to PDF**.
8. Keep the original webpage open until the PDF has finished generating.

## Important Notes

* Some websites require the original page to remain open while images are being fetched.
* Deep Scan may need to scroll through long or dynamically loaded pages to discover all images.
* Website-specific restrictions such as CORS, authentication, or CDN protection may prevent certain images from being fetched.
* SVGs and tracking pixels are ignored.
* Very large images or galleries may require significant browser memory.
* **Fit A4** changes page framing only; it does not reduce the source image resolution.

## Current Limitations

Because websites implement image galleries differently, some pages may still have:

* Images that cannot be upgraded from thumbnails.
* Preview images that fail to render even though the PDF fetch succeeds.
* Images that require scrolling or interaction before they become discoverable.
* Protected images that cannot be accessed due to browser or website restrictions.

## Tech Stack

* JavaScript
* Chrome/Edge Extension APIs
* Manifest V3
* jsPDF
* Browser DOM & Fetch APIs
* Chrome Storage API

## Project Status

**Active personal project**

Pixel Press is being developed as a practical browser tool for collecting webpage images and converting them into high-quality, offline PDFs.

