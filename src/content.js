(function () {
  "use strict";

  const SOURCE = "telegram-media-downloader";
  const STREAM_PATH = /^\/k\/stream\//;
  const attached = new WeakSet();

  function isStreamUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "web.telegram.org" && STREAM_PATH.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function injectBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/page-bridge.js");
    script.onload = () => script.remove();
    script.onerror = () => {
      console.error("[TG CONTENT] Could not load page bridge");
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  function getStreamUrl(video) {
    const url = video.currentSrc || video.src;
    return isStreamUrl(url) ? url : "";
  }

  function attachButton(video) {
    if (attached.has(video)) return;
    attached.add(video);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Download";
    button.setAttribute("aria-label", "Download this Telegram video");
    button.style.cssText = "position:absolute;z-index:2147483647;top:8px;right:8px;padding:6px 10px;border:0;border-radius:6px;background:#2481cc;color:#fff;font:13px sans-serif;cursor:pointer";

    const wrapper = video.parentElement;
    if (wrapper) {
      if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";
      wrapper.appendChild(button);
    } else {
      video.insertAdjacentElement("afterend", button);
    }

    button.addEventListener("click", async () => {
      const url = getStreamUrl(video);
      if (!url) {
        button.textContent = "No stream";
        console.warn("[TG CONTENT] No supported stream URL on this video");
        setTimeout(() => { button.textContent = "Download"; }, 2500);
        return;
      }
      button.disabled = true;
      button.textContent = "Downloading 0%";
      try {
        await window.TelegramMediaDownloader.downloadVideo(url, (percent) => {
          button.textContent = `Downloading ${percent}%`;
        });
        button.textContent = "Complete";
      } catch (error) {
        button.textContent = "Error";
        console.error("[TG CONTENT] Download failed:", error.message);
        setTimeout(() => { button.textContent = "Download"; button.disabled = false; }, 3000);
        return;
      }
      setTimeout(() => { button.textContent = "Download"; button.disabled = false; }, 3000);
    });
  }

  function scan(root) {
    if (root instanceof HTMLVideoElement) attachButton(root);
    if (root.querySelectorAll) root.querySelectorAll("video").forEach(attachButton);
  }

  injectBridge();
  scan(document);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) scan(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  console.info("[TG CONTENT] Video detection active");
})();
