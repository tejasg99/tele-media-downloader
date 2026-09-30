(function () {
  "use strict";

  const VIEWER_SELECTORS = [".media-viewer-whole", "#MediaViewer"];
  const VIEWER_ACTIVE_SLIDE_SELECTORS = [".media-viewer-slide.active", ".MediaViewerSlide--active", "[class*='slide'][class*='active']"];
  const MAX_VIEWER_WAIT_MS = 9000;
  const buttons = new WeakMap();
  const trackedMedia = new Set();
  let activeRoot = null;

  function injectBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/page-bridge.js");
    script.onload = () => script.remove();
    script.onerror = () => { console.error("[TG CONTENT] Could not load page bridge"); script.remove(); };
    (document.head || document.documentElement).appendChild(script);
  }

  function isVisible(element) {
    return !!element && element.isConnected && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  }

  function findViewer() {
    for (const selector of VIEWER_SELECTORS) {
      const viewer = [...document.querySelectorAll(selector)].find(isVisible);
      if (viewer) return viewer;
    }
    return null;
  }

  function viewerVideos(viewer) {
    for (const selector of VIEWER_ACTIVE_SLIDE_SELECTORS) {
      const slide = [...viewer.querySelectorAll(selector)].find(isVisible);
      if (slide) {
        const videos = [...slide.querySelectorAll("video")];
        if (videos.length) return videos;
      }
    }
    return [...viewer.querySelectorAll("video")];
  }

  function sourceFromVideo(video, mediaType) {
    for (const candidate of window.TelegramMediaDetector.getVideoCandidates(video)) {
      try {
        const source = window.TelegramMediaDetector.validSource(candidate.url, video, mediaType, candidate.mimeType);
        if (source) return source;
      } catch (_) { /* malformed or stale source; try the next candidate */ }
    }
    return null;
  }

  function waitForViewerVideo(mediaType, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const startedAt = Date.now();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        document.removeEventListener("loadedmetadata", check, true);
        document.removeEventListener("canplay", check, true);
        signal?.removeEventListener("abort", cancel);
        clearTimeout(timeout);
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(new Error("Cancelled"));
      const check = () => {
        if (settled) return;
        const viewer = findViewer();
        if (viewer) {
          for (const video of viewerVideos(viewer)) {
            const source = sourceFromVideo(video, mediaType);
            if (source) {
              console.info(`[TG CONTENT] Viewer source resolved; sourceType: ${source.sourceType}; mediaType: ${mediaType}; mimeType: ${source.mimeType}`);
              finish(null, source);
              return;
            }
          }
        }
        if (Date.now() - startedAt >= timeoutMs) finish(new Error("Could not resolve the actual video source from Telegram's media viewer"));
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "class", "style"] });
      document.addEventListener("loadedmetadata", check, true);
      document.addEventListener("canplay", check, true);
      signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(() => finish(new Error("Timed out waiting for Telegram's media viewer video source")), timeoutMs);
      if (signal?.aborted) return cancel();
      check();
    });
  }

  async function resolveVideoSource(media, signal) {
    const directSource = sourceFromVideo(media.element, media.type);
    if (directSource) return { ...media, ...directSource };

    const video = media.element;
    const clickable = video.closest(".media-container,[class*='video-container'],[class*='media-inner'],[class*='message-media']") ||
      video.parentElement || video;
    if (!media.message.contains(clickable)) throw new Error("Could not identify the video control in its Telegram message");
    console.info(`[TG CONTENT] Video source unavailable; opening message media viewer; mediaType: ${media.type}`);
    clickable.click();
    const source = await waitForViewerVideo(media.type, MAX_VIEWER_WAIT_MS, signal);
    return { ...media, ...source };
  }

  function detachButton(element) {
    const entry = buttons.get(element);
    if (!entry) return;
    entry.button.remove();
    element.removeAttribute("data-tg-downloader-attached");
    buttons.delete(element);
    trackedMedia.delete(element);
  }

  function attachButton(element, descriptor) {
    if (buttons.has(element) || element.hasAttribute("data-tg-downloader-attached")) return;
    const parent = element.parentElement;
    if (!parent) return;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Download";
    button.setAttribute("aria-label", `Download ${descriptor.type}`);
    button.setAttribute("data-tg-downloader-button", "true");
    button.style.cssText = "position:absolute;z-index:2147483647;top:8px;right:8px;padding:6px 10px;border:0;border-radius:6px;background:#2481cc;color:#fff;font:13px sans-serif;cursor:pointer";
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.appendChild(button);
    element.setAttribute("data-tg-downloader-attached", "true");
    const state = { active: false, downloadId: null };
    const entry = { button, state };
    buttons.set(element, entry);
    trackedMedia.add(element);

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.active) {
        if (state.downloadId) window.TelegramMediaDownloader.cancelDownload(state.downloadId);
        else state.resolutionController?.abort();
        button.textContent = "Cancelling...";
        button.disabled = true;
        return;
      }
      let media = window.TelegramMediaDetector.detect(element);
      if (!media) {
        button.textContent = "Unavailable";
        button.disabled = true;
        setTimeout(() => detachButton(element), 1800);
        return;
      }
      state.active = true;
      state.downloadId = null;
      state.resolutionController = new AbortController();
      button.disabled = false;
      button.textContent = "Resolving...";
      try {
        if (media.type === "video" || media.type === "animation") {
          media = await resolveVideoSource(media, state.resolutionController.signal);
        }
        if (!media.url || !["stream", "blob", "direct"].includes(media.sourceType)) {
          throw new Error("No downloadable media source was found; no thumbnail was downloaded");
        }
        button.textContent = "Downloading...";
        await window.TelegramMediaDownloader.downloadMedia(media, (percent, _done, _total, downloadId) => {
          if (downloadId) state.downloadId = downloadId;
          button.textContent = percent === null ? "Downloading..." : `Downloading ${percent}%`;
        });
        button.textContent = "Completed";
      } catch (error) {
        button.textContent = error.message === "Cancelled" ? "Cancelled" : "Failed";
        console.error("[TG CONTENT] Download failed:", error.message);
      } finally {
        state.active = false;
        state.downloadId = null;
        state.resolutionController = null;
        button.disabled = false;
        setTimeout(() => { if (button.isConnected) button.textContent = "Download"; }, 2500);
      }
    });
  }

  function discardOutsideRoot(root) {
    for (const element of trackedMedia) {
      if (!element.isConnected || !root || !root.contains(element)) detachButton(element);
    }
  }

  function detachRemovedSubtree(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (buttons.has(node)) detachButton(node);
    node.querySelectorAll?.("video[data-tg-downloader-attached],img[data-tg-downloader-attached],a[data-tg-downloader-attached]")
      .forEach(detachButton);
  }

  function scan(node) {
    const newRoot = window.TelegramMediaDetector.scan(node, attachButton);
    if (newRoot !== activeRoot) {
      activeRoot = newRoot;
      discardOutsideRoot(activeRoot);
      if (activeRoot && node !== document && node !== activeRoot && !activeRoot.contains(node)) {
        window.TelegramMediaDetector.scan(activeRoot, attachButton);
      }
    }
  }

  injectBridge();
  scan(document);
  document.addEventListener("loadedmetadata", (event) => {
    if (event.target instanceof HTMLVideoElement) scan(event.target);
  }, true);
  document.addEventListener("load", (event) => {
    if (event.target instanceof HTMLImageElement) scan(event.target);
  }, true);

  const observer = new MutationObserver((mutations) => {
    const root = window.TelegramMediaDetector.findActiveConversationRoot();
    if (root !== activeRoot) {
      activeRoot = root;
      discardOutsideRoot(root);
      if (root) window.TelegramMediaDetector.scan(root, attachButton);
    }
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        if (root?.contains(mutation.target) && !mutation.target.hasAttribute("data-tg-downloader-button")) scan(mutation.target);
        continue;
      }
      for (const node of mutation.removedNodes) detachRemovedSubtree(node);
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && !node.matches("[data-tg-downloader-button]")) scan(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "srcset", "type", "download", "data-filename", "class"] });
  console.info("[TG CONTENT] Active conversation media detection enabled");
})();
