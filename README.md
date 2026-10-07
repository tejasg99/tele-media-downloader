# Telegram Media Downloader (v2.1)

A local Chrome Manifest V3 extension that saves media exposed by the currently open Telegram Web page. It supports recognized images, videos and animations, and documents when Telegram Web provides an accessible stream, page-owned Blob URL, or same-origin direct resource. The extension does not transcode media or scan historical messages.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this `telegram-media-downloader` folder.
3. Open or reload `https://web.telegram.org/` and sign in normally.
4. Click **Download** on a supported media item. While it is queued or downloading, the chat button changes to **Cancel**; after completion it returns to **Download** so the item can be downloaded again.

The extension recognizes `video/mp4`, `video/webm`, JPEG, PNG, WebP, GIF, PDF, ZIP, TXT, DOC, and DOCX when Telegram Web exposes a recognized URL and MIME type or extension. Unsupported or unidentified resources do not receive a Download button.

## Features

- Individual media and grouped-album download buttons in the chat. The same button cancels an active download; album cancellation stops the active and queued items in that album.
- A Chrome Side Panel queue showing status, progress, transfer rate, and estimated time remaining. It provides **Cancel** for queued or active jobs, **Retry** for failed or cancelled jobs, and **Clear completed**.
- A queue managed by the extension service worker, with tab-scoped status updates so each Telegram tab renders its own chat button states.
- Lazy video and animation handling through Telegram's media viewer, including serialized viewer access for jobs that need it and cleanup of a viewer opened by the downloader.
- Sequential 512 KiB range transfers for stream and direct resources, sliced page-world reads for Blob resources, transient-failure retries, and per-job cancellation.
- Incremental file writing through OPFS when available, with an in-memory fallback.

## Architecture

- `src/media-detector.js` finds supported resources in the active conversation, rejects excluded contexts, and creates normalized media descriptors.
- `src/content.js` adds chat controls, tracks queue state, resolves viewer-only video sources, and runs downloads in their originating Telegram tab.
- `src/page-bridge.js` accesses Telegram page-world resources. It restricts accepted URLs to supported Telegram stream paths, Telegram-origin Blob URLs, and same-origin HTTPS resources.
- `src/downloader.js` transfers, validates, retries, and saves media, then reports progress and completion to the content script.
- `src/background/download-manager.js` owns queue state, duplicate suppression, concurrency, cancellation, retry, and completed-job cleanup.
- `src/background/service-worker.js` routes requests and sends queue snapshots to the Side Panel and the relevant Telegram tabs.
- `src/sidepanel/` contains the queue interface and its styles.
- `src/utils/logger.js` provides diagnostics; debug output is disabled unless explicitly enabled, while warnings and errors remain visible.

## Directory structure

```text
tele-media-downloader/
├── manifest.json                 # Chrome extension permissions and entry points
├── README.md                     # Setup, feature, and architecture guide
└── src/
    ├── background/
    │   ├── download-manager.js   # Queue and job lifecycle
    │   ├── messages.js           # Shared message type constants
    │   └── service-worker.js     # Background routing and tab updates
    ├── sidepanel/
    │   ├── sidepanel.css         # Queue panel styling
    │   ├── sidepanel.html        # Queue panel markup
    │   └── sidepanel.js          # Queue rendering and actions
    ├── content.js                # Telegram chat controls and job execution
    ├── downloader.js             # Resource transfer and file saving
    ├── media-detector.js         # Active conversation media discovery
    ├── page-bridge.js            # Telegram page-world resource access
    └── utils/
        └── logger.js             # Shared diagnostic logger
```

## Notes and limits

OPFS availability and quota depend on the Chrome profile. If OPFS cannot be opened, the downloader keeps chunks in memory, which can use substantial memory for large files. Blob URLs are read through the page-world fetch and browser Blob, then transferred in slices; very large Blob sources may still require substantial browser-managed memory. If a direct resource ignores Range requests, the page bridge must buffer its response before it can be written.

Download concurrency is fixed at two jobs. Historical message scanning and advanced bulk discovery are not included.
