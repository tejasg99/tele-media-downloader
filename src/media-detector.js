(function (global) {
  "use strict";

  // Telegram's class names vary between builds. These selectors describe roles
  // from most specific to broadest; message media is only considered below a
  // recognized conversation root and inside a recognized message container.
  const ACTIVE_ROOT_SELECTORS = [
    ".bubbles", ".messages-container", ".messages-layout", ".chat-content", ".chat-container",
  ];
  const MESSAGE_SELECTORS = [
    ".message", ".message-bubble", ".bubble", "[data-message-id]", "[data-mid]", ".Message"
  ];
  const EXCLUDED_UI_SELECTOR = [
    ".chatlist", ".chat-list", ".left-column", ".sidebar", ".profile", ".avatar",
    ".story", ".stories", ".media-viewer-whole", "#MediaViewer", "[role='navigation']",
    "[class*='avatar']", "[class*='userpic']", "[class*='profile-photo']", "[class*='story-preview']"
  ].join(",");
  const EXTENSIONS = {
    "video/mp4": "mp4", "video/webm": "webm", "image/jpeg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "application/zip": "zip",
    "text/plain": "txt", "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
  };
  const SUPPORTED = new Set(Object.keys(EXTENSIONS));
  const MESSAGE_SELECTOR = MESSAGE_SELECTORS.join(",");

  function isVisible(element) {
    return !!element && element.isConnected && element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden" && element.getAttribute("aria-hidden") !== "true";
  }

  function isExcluded(element, root) {
    const excluded = element.closest(EXCLUDED_UI_SELECTOR);
    return !!excluded && excluded !== root;
  }

  function findActiveConversationRoot() {
    for (const selector of ACTIVE_ROOT_SELECTORS) {
      const candidates = document.querySelectorAll(selector);
      for (const candidate of candidates) {
        if (!isVisible(candidate) || candidate.closest(EXCLUDED_UI_SELECTOR)) continue;
        // Ignore a structural wrapper that contains the sidebar and the chat.
        if (candidate.querySelector(".chatlist, .chat-list, .left-column")) continue;
        if (candidate.querySelector(MESSAGE_SELECTOR) || candidate.matches(MESSAGE_SELECTOR)) return candidate;
      }
    }
    return null;
  }

  function findMessageContainer(element, root) {
    if (!element || !root || !root.contains(element) || isExcluded(element, root)) return null;
    const message = element.closest(MESSAGE_SELECTOR);
    if (!message || !root.contains(message) || isExcluded(message, root)) return null;
    // The media must be a descendant of a message-like node, not merely nearby
    // in the chat layout (for example, a composer attachment or empty-state art).
    return message;
  }

  function resourceKind(value) {
    try {
      const url = new URL(value, location.href);
      if (url.protocol === "blob:") return url.origin === "https://web.telegram.org" ? "blob" : "unknown";
      if (url.protocol !== "https:" || url.hostname !== "web.telegram.org") return "unknown";
      return url.pathname.startsWith("/k/stream/") ? "stream" : "direct";
    } catch (_) { return "unknown"; }
  }

  function mimeFromUrl(value) {
    try {
      const extension = new URL(value, location.href).pathname.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
      return Object.entries(EXTENSIONS).find(([, ext]) => ext === extension)?.[0] || "";
    } catch (_) { return ""; }
  }

  function getVideoCandidates(video) {
    const candidates = [];
    if (video.currentSrc) candidates.push({ url: video.currentSrc, mimeType: video.getAttribute("type") || "" });
    if (video.src) candidates.push({ url: video.src, mimeType: video.getAttribute("type") || "" });
    video.querySelectorAll("source[src]").forEach((source) => {
      candidates.push({ url: source.src || source.getAttribute("src"), mimeType: source.type || "" });
    });
    return candidates;
  }

  function validSource(value, element, intendedType, declaredMime = "") {
    if (!value || !element) return null;
    let url;
    try { url = new URL(value, location.href).href; } catch (_) { return null; }
    // Poster is display-only metadata. It is never a download fallback/source.
    if (element.tagName === "VIDEO" && element.poster) {
      try { if (url === new URL(element.poster, location.href).href) return null; } catch (_) { /* invalid poster */ }
    }
    const sourceType = resourceKind(url);
    if (sourceType === "unknown") return null;
    const mimeType = (declaredMime || mimeFromUrl(url) || (intendedType === "video" || intendedType === "animation" ? "video/mp4" : ""))
      .split(";")[0].trim().toLowerCase();
    if (intendedType === "video" || intendedType === "animation") {
      if (mimeType && !mimeType.startsWith("video/")) return null;
      if (mimeType && !["video/mp4", "video/webm"].includes(mimeType)) return null;
    } else if (!SUPPORTED.has(mimeType) && !(mimeType === "application/octet-stream" && element.tagName === "A" && element.hasAttribute("download"))) return null;
    return { url, sourceType, mimeType: mimeType || "application/octet-stream" };
  }

  function classifyVideo(video, message) {
    const animationHint = message.matches("[data-entity-type='Animation'],[data-media-type='animation'],[class*='animation'],[class*='gif']") ||
      !!message.querySelector("[data-entity-type='Animation'],[data-media-type='animation'],[class*='animation'],[class*='gif']");
    return animationHint ? "animation" : "video";
  }

  function isLazyVideoPlaceholder(element) {
    if (!(element instanceof HTMLImageElement) || !element.classList.contains("media-photo")) return false;
    const container = element.closest(".attachment.media-container");
    if (!container) return false;
    const hasPlayControl = !!container.querySelector(".video-play");
    const hasDuration = !!container.querySelector(".video-time");
    const hasVideo = !!container.querySelector("video");
    return hasPlayControl && hasDuration && !hasVideo ? container : null;
  }

  function filenameFromElement(element, mimeType) {
    const candidates = [element.getAttribute("download"), element.getAttribute("data-filename"), element.getAttribute("title")];
    for (const candidate of candidates) {
      if (candidate && /\.[a-z0-9]{1,8}$/i.test(candidate.trim())) return candidate.trim();
    }
    return `${Date.now()}.${EXTENSIONS[mimeType] || "bin"}`;
  }

  function makeDescriptor(element, message, mediaType, resolved = null, extra = {}) {
    const source = resolved || null;
    const type = mediaType;
    const mimeType = source?.mimeType || (type === "video" || type === "animation" ? "video/mp4" : "");
    const sourceType = source?.sourceType || (type === "video" || type === "animation" ? "pending" : "unknown");
    return Object.freeze({
      type, sourceType, url: source?.url || "", mimeType,
      filename: filenameFromElement(element, mimeType),
      size: Number(element.getAttribute("data-size")) || null,
      element, message, ...extra
    });
  }

  function detect(element, root = findActiveConversationRoot()) {
    if (!element || !root) return null;
    const message = findMessageContainer(element, root);
    if (!message) return null;
    const tag = element.tagName;
    if (tag === "VIDEO") {
      const type = classifyVideo(element, message);
      for (const candidate of getVideoCandidates(element)) {
        const source = validSource(candidate.url, element, type, candidate.mimeType);
        if (source) return makeDescriptor(element, message, type, source);
      }
      // A message video may be lazy-loaded. Keep its button target, but mark
      // the source pending so click handling must resolve it through the viewer.
      return makeDescriptor(element, message, type);
    }
    if (tag === "IMG") {
      const lazyVideoContainer = isLazyVideoPlaceholder(element);
      if (lazyVideoContainer) {
        return makeDescriptor(element, message, "video", null, {
          activationTarget: element,
          mediaContainer: lazyVideoContainer,
          lazyVideo: true
        });
      }
      if (element.closest("video, picture source,[class*='video-thumbnail'],[class*='video-poster'],[class*='video-preview']")) return null;
      const mediaItem = element.closest(".media-container,.media-item,[class*='media-item'],.attachment");
      if (mediaItem?.querySelector("video")) return null;
      const value = element.currentSrc || element.src || "";
      const source = validSource(value, element, "image", element.getAttribute("type") || mimeFromUrl(value) || "image/jpeg");
      return source ? makeDescriptor(element, message, "image", source) : null;
    }
    if (tag === "A") {
      const explicitDownload = element.hasAttribute("download");
      const mimeType = element.getAttribute("type") || mimeFromUrl(element.href) || (explicitDownload ? "application/octet-stream" : "");
      if (!mimeType || (!SUPPORTED.has(mimeType.toLowerCase()) && !(explicitDownload && mimeType.toLowerCase() === "application/octet-stream"))) return null;
      const source = validSource(element.href, element, "document", mimeType);
      return source ? makeDescriptor(element, message, "document", source) : null;
    }
    return null;
  }

  function messageContainersWithin(root) {
    if (!root) return [];
    const messages = [];
    if (root.matches?.(MESSAGE_SELECTOR)) messages.push(root);
    root.querySelectorAll?.(MESSAGE_SELECTOR).forEach((message) => messages.push(message));
    return [...new Set(messages)];
  }

  function scanMessage(message, root, callback) {
    if (!message || isExcluded(message, root)) return;
    message.querySelectorAll("video,img,a[href]").forEach((element) => {
      const descriptor = detect(element, root);
      if (descriptor) callback(element, descriptor);
    });
  }

  function scan(changedNode, callback) {
    const root = findActiveConversationRoot();
    if (!root) return root;
    if (changedNode && changedNode !== document && changedNode !== root && !root.contains(changedNode)) return root;
    if (!changedNode || changedNode === document || changedNode === root) {
      messageContainersWithin(root).forEach((message) => scanMessage(message, root, callback));
      return root;
    }
    const affected = new Set();
    const containing = findMessageContainer(changedNode, root);
    if (containing) affected.add(containing);
    messageContainersWithin(changedNode).forEach((message) => affected.add(message));
    affected.forEach((message) => scanMessage(message, root, callback));
    return root;
  }

  global.TelegramMediaDetector = {
    findActiveConversationRoot,
    findMessageContainers: messageContainersWithin,
    findMessageContainer,
    getVideoCandidates,
    isLazyVideoPlaceholder,
    validSource,
    detect,
    scan
  };
})(window);
