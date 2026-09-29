# Telegram Media Downloader (v1)

A local Chrome Manifest V3 extension for saving media that the currently signed-in Telegram Web page already exposes. It supports accessible stream URLs, page-owned Blob URLs, same-origin direct resources, common images, videos/animations, and common document formats. It does not bypass authentication or Telegram access, quota, subscription, or payment controls.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this `telegram-media-downloader` folder.
3. Open or reload `https://web.telegram.org/` and sign in normally.
4. Load a supported media item and choose **Download** on it. Click the same button during a download to cancel.

The extension handles `video/mp4`, `video/webm`, JPEG, PNG, WebP, GIF, PDF, ZIP, TXT, DOC, and DOCX when Telegram Web exposes a recognized URL and MIME/extension. Unsupported or unidentified media gets no Download button. It does not transcode media.

## Implementation

- `src/media-detector.js` finds supported DOM resources and returns normalized `{ type, sourceType, url, mimeType, filename, size }` descriptors.
- `src/page-bridge.js` runs in Telegram's page world. It accepts only Telegram Web stream paths, Telegram-origin Blob URLs, or HTTPS same-origin direct resources. It validates message types and ranges and never logs resource URLs.
- `src/downloader.js` routes stream and direct resources through sequential 512 KiB ranges, reads Blob resources in slices, retries transient failures up to three attempts with backoff, supports cancellation, validates lengths, and saves chunks incrementally through OPFS when available. It falls back to in-memory chunks if OPFS is unavailable.
- `src/content.js` adds buttons only after a supported media descriptor is found and displays progress, completion, failure, and cancellation states.

For OPFS-backed downloads, data is written incrementally and the resulting file is passed to the browser as a download. OPFS availability/quota varies by Chrome profile; if OPFS cannot be opened the extension falls back to memory, which can use substantial memory for large media. Blob URLs are read through a page-world fetch and browser Blob, then sliced for transfer; very large Blob sources may still require substantial browser-managed memory. If a direct resource ignores Range and returns the whole file, the page bridge has to buffer that response before writing it.

Logs use `[TG CONTENT]`, `[TG BRIDGE]`, and `[TG DL]` prefixes. Complete Telegram resource URLs are never logged.

## Verification status

The source and manifest can be checked locally, but live Telegram media verification requires a signed-in Telegram Web session. The extension has not been measured against real 10–500 MB samples in this workspace. Verify media types, larger downloads, cancel/retry behavior, and playback in your account before relying on it for large files.
