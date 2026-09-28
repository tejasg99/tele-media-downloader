# Telegram Media Downloader (v0 - working)

A local Chrome Manifest V3 extension for downloading a Telegram Web video that the current authenticated session can already play. It reads `/k/stream/` URLs from video elements and requests sequential 512 KiB byte ranges through a page-world bridge.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this `telegram-media-downloader` folder.
3. Open or reload `https://web.telegram.org/` and sign in normally.
4. Play or load a video, then choose **Download** on that video.

The extension only handles HTTPS `web.telegram.org/k/stream/` URLs. It does not bypass authentication, Telegram access restrictions, or subscription/quota/payment controls. It does not support `blob:` URLs or other media types.

Progress and errors appear in the Telegram Web page's DevTools console with `[TG CONTENT]`, `[TG BRIDGE]`, or `[TG DL]` prefixes. Complete stream URLs are never logged.

## Currently supported:
- Telegram Web videos
- `/k/stream/` media URLs
- Sequential 512 KiB range downloads

## Not yet supported:
- GIFs
- Images
- `blob:` media URLs
- Other media types
- Concurrent downloads

## Implementation notes

The bridge is injected into the page world and validates every range request. The content script receives transferred `ArrayBuffer` chunks, validates the status and `Content-Range`, reuses the first chunk, downloads subsequent chunks sequentially, assembles an MP4 Blob, and triggers a browser download. The fallback filename is `telegram-video-<timestamp>.mp4`.
