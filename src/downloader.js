(function (global) {
  "use strict";

  const SOURCE = "telegram-media-downloader";
  const CHUNK_SIZE = 524288;
  const pending = new Map();
  const downloads = new Map();
  const RESPONSE_TYPES = new Set(["RANGE_RESPONSE", "RANGE_ERROR", "BLOB_RESPONSE", "BLOB_ERROR", "DIRECT_RESOURCE_RESPONSE", "DIRECT_RESOURCE_ERROR"]);

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || !message || message.source !== SOURCE || !RESPONSE_TYPES.has(message.type)) return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timeout);
    if (message.type.endsWith("_ERROR")) entry.reject(new Error(message.error || "Media request failed"));
    else entry.resolve(message);
  });

  function bridgeRequest(type, fields, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Cancelled"));
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error("Page bridge did not respond")); }, 45000);
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", onAbort); };
      const onAbort = () => {
        pending.delete(requestId);
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.set(requestId, { timeout, resolve: (value) => { cleanup(); resolve(value); }, reject: (error) => { cleanup(); reject(error); } });
      window.postMessage({ source: SOURCE, type, requestId, ...fields }, "*");
    });
  }

  function isTransient(error) {
    if (/HTTP (429|5\d\d)/i.test(error.message)) return true;
    return !/Cancelled|Invalid|Unsupported|Content-Range|incomplete|expected 206|HTTP 4\d\d/i.test(error.message);
  }

  async function withRetry(operation, signal, label) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw new Error("Cancelled");
      try { return await operation(); }
      catch (error) {
        lastError = error;
        if (signal.aborted || !isTransient(error) || attempt === 2) throw error;
        const delay = 400 * (2 ** attempt);
        console.warn(`[TG DL] ${label} failed; retry ${attempt + 1}/2`);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Cancelled")); }, { once: true });
        });
      }
    }
    throw lastError;
  }

  function parseContentRange(value, expectedStart, expectedEnd) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || "");
    if (!match || Number(match[1]) !== expectedStart || Number(match[2]) !== expectedEnd) throw new Error("Missing or invalid Content-Range");
    const total = Number(match[3]);
    if (!Number.isSafeInteger(total) || total <= expectedEnd) throw new Error("Invalid total file size");
    return total;
  }

  function safeFilename(value, mimeType) {
    const fallbackExt = ({ "video/mp4": "mp4", "video/webm": "webm", "image/jpeg": "jpg", "image/png": "png",
      "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "application/zip": "zip", "text/plain": "txt",
      "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx" })[mimeType] || "bin";
    let name = String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\.+$/g, "").trim();
    name = name.split(/[\\/]/).pop().slice(0, 160);
    if (!name) name = `${Date.now()}.${fallbackExt}`;
    if (/^\d{13}\.[a-z0-9]{1,8}$/i.test(name)) name = name.replace(/\.[a-z0-9]{1,8}$/i, `.${fallbackExt}`);
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += `.${fallbackExt}`;
    return name;
  }

  async function createSink(downloadId) {
    try {
      const root = await navigator.storage.getDirectory();
      const tempName = `.telegram-media-${downloadId}.tmp`;
      const handle = await root.getFileHandle(tempName, { create: true });
      const writable = await handle.createWritable();
      return {
        write: (chunk) => writable.write(chunk),
        finish: async () => { await writable.close(); return await handle.getFile(); },
        cleanup: async () => { try { await writable.abort(); } catch (_) { /* already closed */ }
          try { await root.removeEntry(tempName); } catch (_) { /* already removed */ } }
      };
    } catch (error) {
      console.info("[TG DL] OPFS unavailable; using memory chunks");
      const chunks = [];
      return { write: async (chunk) => { chunks.push(chunk); },
        finish: async (mimeType) => new Blob(chunks, { type: mimeType }), cleanup: async () => { chunks.length = 0; } };
    }
  }

  function startDownload(blob, filename, sink) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      sink.cleanup();
    }, 60000);
  }

  async function downloadByRanges(media, downloadId, controller, onProgress) {
    const signal = controller.signal;
    const sink = await createSink(downloadId);
    let totalSize = media.size;
    let downloadedBytes = 0;
    let actualMime = media.mimeType;
    const getChunk = (start, end) => withRetry(async () => {
      const response = await bridgeRequest(media.sourceType === "stream" ? "RANGE_REQUEST" : "DIRECT_RESOURCE_REQUEST",
        { url: media.url, start, end, downloadId }, signal);
      const allowFullResponse = media.sourceType === "direct" && start === 0 && response.status === 200;
      if (response.status !== 206 && !allowFullResponse) throw new Error(`Range request returned HTTP ${response.status}, expected 206`);
      return response;
    }, signal, "Chunk");
    try {
      let response = await getChunk(0, CHUNK_SIZE - 1);
      if (response.contentType && response.contentType !== "application/octet-stream") actualMime = response.contentType.split(";")[0].toLowerCase();
      if (response.status === 200 && response.data?.byteLength) {
        totalSize = response.data.byteLength;
        await sink.write(response.data);
        downloadedBytes = totalSize;
        onProgress(downloadedBytes, totalSize);
      } else {
        if (response.status !== 206) throw new Error(`Range request returned HTTP ${response.status}, expected 206`);
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.contentRange || "");
        if (!range || Number(range[1]) !== 0) throw new Error("Missing or invalid first Content-Range");
        totalSize = Number(range[3]);
        const firstEnd = Math.min(CHUNK_SIZE - 1, totalSize - 1);
        if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || Number(range[2]) !== firstEnd || response.data.byteLength !== firstEnd + 1) {
          throw new Error("First chunk is incomplete");
        }
        await sink.write(response.data);
        downloadedBytes = response.data.byteLength;
        onProgress(downloadedBytes, totalSize);
        while (downloadedBytes < totalSize) {
          if (signal.aborted) throw new Error("Cancelled");
          const start = downloadedBytes;
          const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
          response = await getChunk(start, end);
          if (response.status !== 206) throw new Error(`Range request returned HTTP ${response.status}, expected 206`);
          parseContentRange(response.contentRange, start, end);
          const expected = end - start + 1;
          if (response.data.byteLength !== expected || response.contentLength !== expected) throw new Error("Downloaded chunk is incomplete");
          await sink.write(response.data);
          downloadedBytes += response.data.byteLength;
          onProgress(downloadedBytes, totalSize);
        }
      }
      if (signal.aborted) throw new Error("Cancelled");
      if (downloadedBytes !== totalSize) throw new Error("Downloaded file size does not match expected size");
      if (actualMime.startsWith("text/html")) throw new Error("Resource returned an HTML page instead of media");
      const file = await sink.finish(actualMime);
      if (!file || file.size !== totalSize) throw new Error("Temporary file size does not match download");
      if (signal.aborted) throw new Error("Cancelled");
      const blob = file instanceof Blob ? file : new Blob([file], { type: actualMime });
      startDownload(blob, safeFilename(media.filename, actualMime), sink);
      return totalSize;
    } catch (error) { await sink.cleanup(); throw error; }
  }

  async function downloadBlob(media, downloadId, controller, onProgress) {
    const signal = controller.signal;
    const info = await withRetry(() => bridgeRequest("BLOB_INFO", { url: media.url, start: 0, downloadId }, signal), signal, "Blob read");
    const totalSize = info.size;
    if (!Number.isSafeInteger(totalSize) || totalSize <= 0) throw new Error("Invalid Blob size");
    const sink = await createSink(downloadId);
    try {
      for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
        if (signal.aborted) throw new Error("Cancelled");
        const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
        const response = await withRetry(() => bridgeRequest("BLOB_CHUNK", { url: media.url, start, end, downloadId }, signal), signal, "Blob chunk");
        const expected = end - start + 1;
        if (!(response.data instanceof ArrayBuffer) || response.data.byteLength !== expected) throw new Error("Blob chunk is incomplete");
        await sink.write(response.data);
        onProgress(end + 1, totalSize);
      }
      if (signal.aborted) throw new Error("Cancelled");
      const file = await sink.finish(info.contentType || media.mimeType);
      if (!file || file.size !== totalSize) throw new Error("Temporary file size does not match Blob");
      if (signal.aborted) throw new Error("Cancelled");
      startDownload(file instanceof Blob ? file : new Blob([file], { type: info.contentType || media.mimeType }),
        safeFilename(media.filename, info.contentType || media.mimeType), sink);
      return totalSize;
    } catch (error) { await sink.cleanup(); throw error; }
  }

  async function downloadMedia(media, onProgress) {
    if (!media || !["stream", "blob", "direct"].includes(media.sourceType)) throw new Error("Unsupported media source");
    const downloadId = crypto.randomUUID();
    const controller = new AbortController();
    downloads.set(downloadId, controller);
    onProgress?.(null, 0, media.size, downloadId);
    const report = (done, total) => {
      const percent = total ? Math.min(100, Math.floor(done / total * 100)) : null;
      console.info(`[TG DL] Progress: ${percent === null ? "Downloading..." : `${percent}%`}`);
      onProgress?.(percent, done, total);
    };
    try {
      const size = media.sourceType === "blob" ? await downloadBlob(media, downloadId, controller, report) :
        await downloadByRanges(media, downloadId, controller, report);
      if (controller.signal.aborted) throw new Error("Cancelled");
      return { downloadId, size };
    } finally {
      downloads.delete(downloadId);
      window.postMessage({ source: SOURCE, type: "RELEASE", downloadId }, "*");
    }
  }

  function cancelDownload(downloadId) {
    const controller = downloads.get(downloadId);
    if (!controller) return false;
    controller.abort();
    window.postMessage({ source: SOURCE, type: "CANCEL", downloadId }, "*");
    return true;
  }

  global.TelegramMediaDownloader = { downloadMedia, cancelDownload };
})(window);
