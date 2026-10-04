# Telegram Media Downloader (v2.1)

A local Chrome Manifest V3 extension for saving media that the currently signed-in Telegram Web page already exposes. It supports accessible stream URLs, page-owned Blob URLs, same-origin direct resources, common images, videos/animations, and common document formats.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this `telegram-media-downloader` folder.
3. Open or reload `https://web.telegram.org/` and sign in normally.
4. Load a supported media item and choose **Download** on it. Click the same button during a download to cancel.

The extension handles `video/mp4`, `video/webm`, JPEG, PNG, WebP, GIF, PDF, ZIP, TXT, DOC, and DOCX when Telegram Web exposes a recognized URL and MIME/extension. Unsupported or unidentified media gets no Download button. It does not transcode media.

## V2.0 + V2.1 implementation

- `src/media-detector.js` finds supported DOM resources and returns normalized `{ type, sourceType, url, mimeType, filename, size }` descriptors. Explicit emoji/text-rendering contexts are excluded without a size-based heuristic.
- `src/page-bridge.js` runs in Telegram's page world. It accepts only Telegram Web stream paths, Telegram-origin Blob URLs, or HTTPS same-origin direct resources. It validates message types and ranges and never logs resource URLs.
- `src/background/download-manager.js` owns queue state and schedules at most two active jobs. It handles duplicate suppression, cancellation, retry, and clearing completed jobs.
- `src/background/service-worker.js` routes serializable requests between Telegram tabs and the Side Panel. Runtime media source data is kept in memory and omitted from queue snapshots.
- `src/downloader.js` remains the low-level executor. It routes stream and direct resources through sequential 512 KiB ranges, reads Blob resources in slices, retries transient failures up to three attempts with backoff, supports per-job cancellation, validates lengths, and saves chunks incrementally through OPFS when available. It falls back to in-memory chunks if OPFS is unavailable.
- `src/sidepanel/` contains the queue UI with status, progress, speed/ETA, cancel, retry, and clear-completed controls.
- `src/content.js` keeps Telegram DOM detection and viewer lifecycle handling, adds individual icon controls plus a grouped-album action, and runs each queued job in its originating tab so the page-world bridge remains available.
- `src/utils/logger.js` keeps diagnostics quiet unless debug is enabled; warnings and errors remain visible.

For OPFS-backed downloads, data is written incrementally and the resulting file is passed to the browser as a download. OPFS availability/quota varies by Chrome profile; if OPFS cannot be opened the extension falls back to memory, which can use substantial memory for large media. Blob URLs are read through a page-world fetch and browser Blob, then sliced for transfer; very large Blob sources may still require substantial browser-managed memory. If a direct resource ignores Range and returns the whole file, the page bridge has to buffer that response before writing it.

Use the extension action button to open the Chrome Side Panel. Concurrency is currently fixed internally at two jobs. Historical message scanning and advanced bulk discovery are not included in this milestone.
