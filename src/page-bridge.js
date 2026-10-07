(function () {
  "use strict";

  const SOURCE = "telegram-media-downloader";
  const active = new Map();
  const blobCache = new Map();
  const STREAM_PATH = /^\/k\/stream\//;
  const DIRECT_TYPES = new Set(["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp", "image/gif",
    "application/pdf", "application/zip", "text/plain", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"]);

  // Allows only resource URLs that the extension is designed to read.
  function parseAllowedUrl(value, allowBlob) {
    try {
      const url = new URL(value);
      if (allowBlob && url.protocol === "blob:") {
        return new URL(url.pathname).origin === "https://web.telegram.org" ? url : null;
      }
      if (url.protocol !== "https:" || url.hostname !== "web.telegram.org") return null;
      return url;
    } catch (_) { return null; }
  }

  // Sends a correlated response back to the extension content script.
  function reply(type, requestId, payload = {}, transfer = []) {
    window.postMessage({ source: SOURCE, type, requestId, ...payload }, "*", transfer);
  }

  // Handles validated bridge requests for Telegram page-owned resources.
  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== window || !message || message.source !== SOURCE) return;
    if (message.type === "CANCEL") {
      active.get(message.downloadId)?.abort();
      for (const [url, entry] of blobCache) if (entry.downloadId === message.downloadId) blobCache.delete(url);
      return;
    }
    if (message.type === "RELEASE") {
      for (const [url, entry] of blobCache) if (entry.downloadId === message.downloadId) blobCache.delete(url);
      return;
    }
    if (typeof message.requestId !== "string" || message.requestId.length > 100) return;
    if ((message.type === "RANGE_REQUEST" || message.type === "BLOB_INFO" || message.type === "BLOB_CHUNK" ||
         message.type === "DIRECT_RESOURCE_REQUEST") &&
        (typeof message.downloadId !== "string" || message.downloadId.length > 100)) {
      reply("RANGE_ERROR", message.requestId, { error: "Invalid download ID" });
      return;
    }
    if (message.type === "RANGE_REQUEST") {
      const url = parseAllowedUrl(message.url, false);
      const { start, end } = message;
      if (!url || !STREAM_PATH.test(url.pathname) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || end < start || end - start + 1 > 524288) {
        reply("RANGE_ERROR", message.requestId, { error: "Invalid range request" }); return;
      }
      const controller = new AbortController();
      active.set(message.downloadId, controller);
      try {
        const response = await fetch(url.href, { headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal });
        if (response.status !== 206) {
          reply("RANGE_RESPONSE", message.requestId, { status: response.status, contentType: response.headers.get("content-type") || "",
            contentLength: Number(response.headers.get("content-length")) || 0, contentRange: response.headers.get("content-range") || "", data: new ArrayBuffer(0) });
          return;
        }
        const data = await response.arrayBuffer();
        reply("RANGE_RESPONSE", message.requestId, { status: response.status, contentType: response.headers.get("content-type") || "",
          contentLength: Number(response.headers.get("content-length")) || data.byteLength,
          contentRange: response.headers.get("content-range") || "", data }, [data]);
      } catch (error) {
        reply("RANGE_ERROR", message.requestId, { error: error.name === "AbortError" ? "Cancelled" : "Range request failed" });
      } finally { active.delete(message.downloadId); }
      return;
    }
    if (message.type === "BLOB_INFO" || message.type === "BLOB_CHUNK") {
      const url = parseAllowedUrl(message.url, true);
      if (!url || url.protocol !== "blob:" || !Number.isSafeInteger(message.start) || message.start < 0 ||
          (message.type === "BLOB_CHUNK" && (!Number.isSafeInteger(message.end) || message.end < message.start || message.end - message.start >= 524288))) {
        reply("BLOB_ERROR", message.requestId, { error: "Invalid Blob request" }); return;
      }
      const controller = new AbortController();
      active.set(message.downloadId, controller);
      try {
        let blob = blobCache.get(url.href)?.blob;
        if (!blob) {
          const response = await fetch(url.href, { signal: controller.signal });
          blob = await response.blob();
          const mimeType = (blob.type || "application/octet-stream").split(";")[0].toLowerCase();
          if (!DIRECT_TYPES.has(mimeType)) { reply("BLOB_ERROR", message.requestId, { error: "Unsupported Blob media type" }); return; }
          blobCache.set(url.href, { blob, downloadId: message.downloadId });
        }
        const mimeType = (blob.type || "application/octet-stream").split(";")[0].toLowerCase();
        if (!DIRECT_TYPES.has(mimeType)) { reply("BLOB_ERROR", message.requestId, { error: "Unsupported Blob media type" }); return; }
        if (message.type === "BLOB_INFO") {
          reply("BLOB_RESPONSE", message.requestId, { size: blob.size, contentType: mimeType });
        } else {
          const data = await blob.slice(message.start, message.end + 1).arrayBuffer();
          reply("BLOB_RESPONSE", message.requestId, { size: blob.size, contentType: mimeType, data }, [data]);
        }
      } catch (error) { reply("BLOB_ERROR", message.requestId, { error: error.name === "AbortError" ? "Cancelled" : "Blob media could not be read" }); }
      finally { active.delete(message.downloadId); }
      return;
    }
    if (message.type === "DIRECT_RESOURCE_REQUEST") {
      const url = parseAllowedUrl(message.url, false);
      if (!url || STREAM_PATH.test(url.pathname) || !Number.isSafeInteger(message.start) || message.start < 0 ||
          !Number.isSafeInteger(message.end) || message.end < message.start || message.end - message.start >= 524288) {
        reply("DIRECT_RESOURCE_ERROR", message.requestId, { error: "Invalid direct resource request" }); return;
      }
      const controller = new AbortController();
      active.set(message.downloadId, controller);
      try {
        const response = await fetch(url.href, { headers: { Range: `bytes=${message.start}-${message.end}` }, signal: controller.signal });
        if (!(response.status === 206 || (response.status === 200 && message.start === 0))) {
          reply("DIRECT_RESOURCE_ERROR", message.requestId, { error: `Resource returned HTTP ${response.status}` }); return;
        }
        const contentType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].toLowerCase();
        if (!DIRECT_TYPES.has(contentType)) { reply("DIRECT_RESOURCE_ERROR", message.requestId, { error: "Unsupported resource type" }); return; }
        const data = await response.arrayBuffer();
        reply("DIRECT_RESOURCE_RESPONSE", message.requestId, { status: response.status, contentType, contentLength: data.byteLength,
          contentRange: response.headers.get("content-range") || "", totalSize: Number(response.headers.get("content-length")) || null, data }, [data]);
      } catch (error) { reply("DIRECT_RESOURCE_ERROR", message.requestId, { error: error.name === "AbortError" ? "Cancelled" : "Resource request failed" }); }
      finally { active.delete(message.downloadId); }
    }
  });
})();
