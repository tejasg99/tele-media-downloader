(function () {
  "use strict";

  const VIEWER_SELECTOR = ".media-viewer-whole";
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
    if (!element || !element.isConnected || element.getClientRects().length === 0 || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function findViewer() {
    return [...document.querySelectorAll(VIEWER_SELECTOR)].find(isVisible) || null;
  }

  function viewerVideos(viewer) {
    const aspecter = viewer.querySelector(".media-viewer-aspecter");
    if (aspecter) {
      const videos = [...aspecter.querySelectorAll("video")];
      if (videos.length) return videos;
    }
    const movers = viewer.querySelector(".media-viewer-movers");
    if (movers) {
      const videos = [...movers.querySelectorAll("video")];
      if (videos.length) return videos;
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

  function waitForViewerVideo(mediaType, timeoutMs, signal, viewerBefore = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let loggedViewer = false;
      let loggedVideo = false;
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
          if (!loggedViewer) {
            loggedViewer = true;
            console.info("[TG CONTENT] Media viewer detected");
            if (!viewerBefore) console.info("[TG CONTENT] Viewer opened by downloader");
          }
          const videos = viewerVideos(viewer);
          if (videos.length && !loggedVideo) {
            loggedVideo = true;
            console.info("[TG CONTENT] Viewer video detected");
          }
          for (const video of videos) {
            const source = sourceFromVideo(video, mediaType);
            if (source) {
              console.info(`[TG CONTENT] Viewer video source resolved; sourceType: ${source.sourceType}; mediaType: ${mediaType}; mimeType: ${source.mimeType}`);
              finish(null, { source, viewer, viewerOpenedByDownloader: !viewerBefore });
              return;
            }
          }
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "class", "style"] });
      document.addEventListener("loadedmetadata", check, true);
      document.addEventListener("canplay", check, true);
      signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(() => {
        if (!findViewer()) finish(new Error("Could not open Telegram media viewer for this video."));
        else if (!viewerVideos(findViewer()).length) finish(new Error("Could not find the actual Telegram video in the media viewer."));
        else finish(new Error("Telegram video source did not become available."));
      }, timeoutMs);
      if (signal?.aborted) return cancel();
      check();
    });
  }

  async function resolveVideoSource(media, signal) {
    if (media.lazyVideo) {
      const activationTarget = media.activationTarget;
      if (!(activationTarget instanceof HTMLImageElement) || !activationTarget.isConnected || !media.mediaContainer?.contains(activationTarget)) {
        throw new Error("Could not find Telegram's video thumbnail activation target.");
      }
      const viewerBefore = findViewer();
      console.info("[TG CONTENT] Opening Telegram media viewer from thumbnail");
      if (media.grouped) console.info("[TG CONTENT] Activating grouped video thumbnail");
      // Telegram's lazy video placeholder opens the viewer on this image click.
      // Its Blob URL is strictly an activation target and is never read here.
      activationTarget.click();
      const resolved = await waitForViewerVideo("video", MAX_VIEWER_WAIT_MS, signal, viewerBefore);
      return {
        media: { ...media, ...resolved.source, type: "video", lazyVideo: false },
        viewer: resolved.viewer,
        viewerOpenedByDownloader: resolved.viewerOpenedByDownloader
      };
    }

    const directSource = sourceFromVideo(media.element, media.type);
    if (directSource) return { media: { ...media, ...directSource }, viewer: null, viewerOpenedByDownloader: false };

    const video = media.element;
    const clickable = (media.grouped && media.containerElement) ||
      video.closest(".media-container,[class*='video-container'],[class*='media-inner'],[class*='message-media']") ||
      video.parentElement || video;
    if (!media.message.contains(clickable)) throw new Error("Could not identify the video control in its Telegram message");
    const viewerBefore = findViewer();
    console.info(`[TG CONTENT] Video source unavailable; opening message media viewer; mediaType: ${media.type}`);
    clickable.click();
    const resolved = await waitForViewerVideo(media.type, MAX_VIEWER_WAIT_MS, signal, viewerBefore);
    return {
      media: { ...media, ...resolved.source },
      viewer: resolved.viewer,
      viewerOpenedByDownloader: resolved.viewerOpenedByDownloader
    };
  }

  function findViewerCloseControl(viewer) {
    const selectors = [
      "button[aria-label*='close' i]", "button[title*='close' i]", "[role='button'][aria-label*='close' i]",
      "[data-action='close']", ".media-viewer-close", ".media-viewer-close-button", "[class*='media-viewer'][class*='close']"
    ];
    for (const selector of selectors) {
      const control = [...viewer.querySelectorAll(selector)].find(isVisible);
      if (control) return control;
    }
    return null;
  }

  function waitForViewerClosed(viewer, timeoutMs = 2000) {
    return new Promise((resolve) => {
      if (!isVisible(viewer)) return resolve(true);
      let settled = false;
      const finish = (closed) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(closed);
      };
      const observer = new MutationObserver(() => {
        if (!isVisible(viewer)) finish(true);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "aria-hidden"] });
      const timeout = setTimeout(() => finish(!isVisible(viewer)), timeoutMs);
    });
  }

  async function closeDownloaderOwnedViewer(viewer) {
    if (!viewer || !isVisible(viewer)) return;
    console.info("[TG CONTENT] Closing downloader-owned viewer");
    const closeControl = findViewerCloseControl(viewer);
    if (closeControl) {
      closeControl.click();
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    }
    let closed = await waitForViewerClosed(viewer, 2000);
    if (!closed && closeControl) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      closed = await waitForViewerClosed(viewer, 2000);
    }
    if (closed) console.info("[TG CONTENT] Viewer closed");
    else console.warn("[TG CONTENT] Downloader-owned viewer did not close before timeout");
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
    if (descriptor.grouped) {
      console.info("[TG CONTENT] Grouped media detected");
      console.info("[TG CONTENT] Grouped media descriptor created");
    }
    if (descriptor.lazyVideo) console.info(descriptor.grouped ? "[TG CONTENT] Lazy grouped video detected" : "[TG CONTENT] Detected lazy Telegram video placeholder");
    const parent = descriptor.grouped ? descriptor.containerElement : element.parentElement;
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
      let downloaderOwnedViewer = null;
      try {
        if (media.type === "video" || media.type === "animation") {
          const resolution = await resolveVideoSource(media, state.resolutionController.signal);
          media = resolution.media;
          if (resolution.viewerOpenedByDownloader) downloaderOwnedViewer = resolution.viewer;
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
        console.info("[TG CONTENT] Download completed");
        if (downloaderOwnedViewer) await closeDownloaderOwnedViewer(downloaderOwnedViewer);
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
