(function (global) {
  "use strict";

  const EXTENSIONS = {
    "video/mp4": "mp4", "video/webm": "webm", "image/jpeg": "jpg",
    "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "application/pdf": "pdf", "application/zip": "zip", "text/plain": "txt",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
  };
  const SUPPORTED = new Set(Object.keys(EXTENSIONS));
  const STREAM_MIMES = new Set(["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp", "image/gif",
    "application/pdf", "application/zip", "text/plain", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
  const STREAM_PATH = /^\/k\/stream\//;

  function resourceKind(url) {
    try {
      if (url.startsWith("blob:")) {
        const parsed = new URL(url);
        return parsed.origin === "https://web.telegram.org" ? "blob" : "unknown";
      }
      const parsed = new URL(url, location.href);
      if (parsed.protocol !== "https:" || parsed.hostname !== "web.telegram.org") return "unknown";
      return STREAM_PATH.test(parsed.pathname) ? "stream" : "direct";
    } catch (_) { return "unknown"; }
  }

  function mimeFromUrl(url) {
    try {
      const path = new URL(url, location.href).pathname.toLowerCase();
      const extension = path.match(/\.([a-z0-9]{1,8})$/)?.[1];
      const entry = Object.entries(EXTENSIONS).find(([, ext]) => ext === extension);
      if (entry) return entry[0];
    } catch (_) { /* handled below */ }
    return "";
  }

  function filenameFromElement(element, mimeType, type) {
    const candidates = [element.getAttribute("download"), element.getAttribute("data-filename"),
      element.getAttribute("title"), element.getAttribute("aria-label"), element.textContent?.trim()];
    for (const candidate of candidates) {
      if (candidate && /\.[a-z0-9]{1,8}$/i.test(candidate.trim())) return candidate.trim();
    }
    const extension = EXTENSIONS[mimeType] || "bin";
    return `${Date.now()}.${extension}`;
  }

  function descriptor({ element, url, mimeType = "", size = null, type = "" }) {
    const sourceType = resourceKind(url);
    if (sourceType === "unknown") return null;
    const normalizedMime = (mimeType || mimeFromUrl(url)).split(";")[0].trim().toLowerCase();
    const explicitBinary = normalizedMime === "application/octet-stream" && element.tagName === "A" && element.hasAttribute("download");
    if (!(SUPPORTED.has(normalizedMime) || explicitBinary || (sourceType === "stream" && STREAM_MIMES.has(normalizedMime)))) return null;
    if (!type) {
      type = normalizedMime.startsWith("image/") ? "image" : normalizedMime.startsWith("video/") ? "video" : "document";
    }
    return Object.freeze({ type, sourceType, url, mimeType: normalizedMime,
      filename: filenameFromElement(element, normalizedMime, type), size: Number.isFinite(size) && size > 0 ? size : null });
  }

  function detect(element) {
    const tag = element.tagName;
    if (tag !== "VIDEO" && tag !== "IMG" && tag !== "A") {
      const background = getComputedStyle(element).backgroundImage;
      const match = /^url\(["']?(.*?)["']?\)$/.exec(background);
      if (match) {
        const url = match[1];
        const rect = element.getBoundingClientRect();
        if (rect.width >= 120 && rect.height >= 120) return descriptor({ element, url, mimeType: mimeFromUrl(url) || "image/jpeg", type: "image" });
      }
      return null;
    }
    if (tag === "VIDEO") {
      const url = element.currentSrc || element.src || "";
      const sourceType = resourceKind(url);
      if (sourceType === "unknown") return null;
      const animation = element.closest("[data-entity-type='Animation'], .media-container, .bubble") &&
        (element.closest("[data-entity-type='Animation']") || element.closest(".media-container")?.querySelector("[class*='gif'],[class*='animation']"));
      return descriptor({ element, url, mimeType: element.getAttribute("type") || mimeFromUrl(url) || "video/mp4",
        size: null, type: animation ? "animation" : "video" });
    }
    if (tag === "IMG") {
      if (element.naturalWidth && element.naturalWidth < 120 && element.naturalHeight < 120) return null;
      return descriptor({ element, url: element.currentSrc || element.src || "", mimeType: element.getAttribute("type") || mimeFromUrl(element.currentSrc || element.src || "") || "image/jpeg",
        size: null, type: "image" });
    }
    if (tag === "A") {
      const url = element.href || "";
      const explicitDownload = element.hasAttribute("download");
      const mimeType = element.getAttribute("type") || mimeFromUrl(url) || (explicitDownload ? "application/octet-stream" : "");
      if (!mimeType || (!mimeType.startsWith("application/") && !mimeType.startsWith("text/"))) return null;
      if (mimeType === "application/octet-stream" && !explicitDownload) return null;
      return descriptor({ element, url, mimeType, size: Number(element.getAttribute("data-size")) || null, type: "document" });
    }
    return null;
  }

  function scan(root, callback) {
    if (root.matches?.("video,img,a")) {
      const found = detect(root);
      if (found) callback(root, found);
    }
    root.querySelectorAll?.("video,img,a[href],[style*='background-image']").forEach((element) => {
      const found = detect(element);
      if (found) callback(element, found);
    });
  }

  global.TelegramMediaDetector = { detect, scan };
})(window);
