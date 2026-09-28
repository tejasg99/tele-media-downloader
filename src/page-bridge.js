(function () {
  "use strict";

  const SOURCE = "telegram-media-downloader";
  const STREAM_PATH = /^\/k\/stream\//;

  function validStreamUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "web.telegram.org" && STREAM_PATH.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== window || !message || message.source !== SOURCE || message.type !== "RANGE_REQUEST") return;

    const { requestId, url, start, end } = message;
    if (typeof requestId !== "string" || requestId.length > 100 || !validStreamUrl(url) ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start ||
        end - start + 1 > 524288) {
      window.postMessage({ source: SOURCE, type: "RANGE_ERROR", requestId, error: "Invalid range request" }, "*");
      return;
    }

    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      const data = await response.arrayBuffer();
      const result = {
        source: SOURCE,
        type: "RANGE_RESPONSE",
        requestId,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        contentLength: Number(response.headers.get("content-length")) || data.byteLength,
        contentRange: response.headers.get("content-range") || "",
        data
      };
      window.postMessage(result, "*", [data]);
    } catch (error) {
      console.error("[TG BRIDGE] Range request failed", error && error.message ? error.message : "unknown error");
      window.postMessage({ source: SOURCE, type: "RANGE_ERROR", requestId, error: "Range request failed" }, "*");
    }
  });
  console.info("[TG BRIDGE] Ready");
})();
