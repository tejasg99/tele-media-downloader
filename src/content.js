(function () {
  "use strict";

  const buttons = new WeakMap();

  function injectBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/page-bridge.js");
    script.onload = () => script.remove();
    script.onerror = () => { console.error("[TG CONTENT] Could not load page bridge"); script.remove(); };
    (document.head || document.documentElement).appendChild(script);
  }

  function attachButton(element, initialDescriptor) {
    if (buttons.has(element)) return;
    const parent = element.parentElement;
    if (!parent) return;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Download";
    button.setAttribute("aria-label", `Download ${initialDescriptor.type}`);
    button.style.cssText = "position:absolute;z-index:2147483647;top:8px;right:8px;padding:6px 10px;border:0;border-radius:6px;background:#2481cc;color:#fff;font:13px sans-serif;cursor:pointer";
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.appendChild(button);
    const state = { active: false, downloadId: null };
    buttons.set(element, { button, state });

    button.addEventListener("click", async () => {
      if (state.active) {
        if (state.downloadId) window.TelegramMediaDownloader.cancelDownload(state.downloadId);
        button.textContent = "Cancelling...";
        button.disabled = true;
        return;
      }
      const media = window.TelegramMediaDetector.detect(element);
      if (!media) {
        button.textContent = "Unavailable";
        button.disabled = true;
        setTimeout(() => { button.remove(); buttons.delete(element); }, 2000);
        return;
      }
      state.active = true;
      state.downloadId = null;
      button.disabled = false;
      button.textContent = "Downloading...";
      try {
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
        button.disabled = false;
        setTimeout(() => { if (button.isConnected) button.textContent = "Download"; }, 2500);
      }
    });
  }

  function scan(root) {
    window.TelegramMediaDetector.scan(root, attachButton);
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
    for (const mutation of mutations) {
      if (mutation.type === "attributes") scan(mutation.target);
      for (const node of mutation.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) scan(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "srcset", "type", "download", "data-filename"] });
  console.info("[TG CONTENT] Supported media detection active");
})();
