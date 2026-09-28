(function (global) {
  "use strict";

  const SOURCE = "telegram-media-downloader";
  const CHUNK_SIZE = 524288;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || !message || message.source !== SOURCE ||
        (message.type !== "RANGE_RESPONSE" && message.type !== "RANGE_ERROR")) return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.type === "RANGE_ERROR") request.reject(new Error(message.error || "Bridge request failed"));
    else request.resolve(message);
  });

  function requestRange(url, start, end) {
    return new Promise((resolve, reject) => {
      if (typeof crypto.randomUUID !== "function") {
        reject(new Error("This browser does not support request IDs"));
        return;
      }
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Page bridge did not respond"));
      }, 30000);
      pending.set(requestId, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      window.postMessage({ source: SOURCE, type: "RANGE_REQUEST", requestId, url, start, end }, "*");
    });
  }

  function parseTotal(contentRange, start, end) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!match || Number(match[1]) !== start || Number(match[2]) !== end) {
      throw new Error("Missing or invalid Content-Range");
    }
    const total = Number(match[3]);
    if (!Number.isSafeInteger(total) || total <= end) throw new Error("Invalid total file size");
    return total;
  }

  async function downloadVideo(url, onProgress) {
    if (typeof url !== "string" || !/^https:\/\/web\.telegram\.org\/k\/stream\//.test(url)) {
      throw new Error("No supported Telegram stream URL is available");
    }

    const firstEnd = CHUNK_SIZE - 1;
    const first = await requestRange(url, 0, firstEnd);
    if (first.status !== 206) throw new Error(`Range request returned HTTP ${first.status}, expected 206`);
    const rangeMatch = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(first.contentRange);
    if (!rangeMatch) throw new Error("Missing or invalid Content-Range");
    const totalSize = Number(rangeMatch[3]);
    const actualEnd = Math.min(firstEnd, totalSize - 1);
    if (Number(rangeMatch[1]) !== 0 || Number(rangeMatch[2]) !== actualEnd || !Number.isSafeInteger(totalSize) || totalSize <= 0) {
      throw new Error("Invalid first Content-Range");
    }
    if (!(first.data instanceof ArrayBuffer) || first.data.byteLength !== actualEnd + 1) {
      throw new Error("First chunk is incomplete");
    }

    const chunks = [first.data];
    let downloadedBytes = first.data.byteLength;
    const report = () => {
      const percent = Math.min(100, Math.floor(downloadedBytes / totalSize * 100));
      console.info(`[TG DL] Progress: ${percent}%`);
      if (onProgress) onProgress(percent);
    };
    report();

    for (let start = downloadedBytes; start < totalSize; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
      const response = await requestRange(url, start, end);
      if (response.status !== 206) throw new Error(`Range request returned HTTP ${response.status}, expected 206`);
      parseTotal(response.contentRange, start, end);
      const expectedLength = end - start + 1;
      if (!(response.data instanceof ArrayBuffer) || response.data.byteLength !== expectedLength ||
          response.contentLength !== expectedLength) throw new Error("Downloaded chunk is incomplete");
      chunks.push(response.data);
      downloadedBytes += response.data.byteLength;
      report();
    }

    if (downloadedBytes !== totalSize) throw new Error("Downloaded file size does not match Content-Range");
    const blob = new Blob(chunks, { type: "video/mp4" });
    if (!blob.size) throw new Error("Could not assemble video Blob");
    const objectUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `telegram-video-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`;
      anchor.style.display = "none";
      document.documentElement.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw new Error(`Blob download failed: ${error.message}`);
    }
    return blob.size;
  }

  global.TelegramMediaDownloader = { downloadVideo };
})(window);
