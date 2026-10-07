(function (global) {
  "use strict";
  // Enables verbose diagnostics only when the page explicitly opts in.
  const enabled = () => global.TelegramMediaDebug === true;
  global.TelegramMediaLogger = {
    // Writes debug details only when verbose logging is enabled.
    debug: (...args) => { if (enabled()) console.debug("[TG DL]", ...args); },
    // Writes informational details only when verbose logging is enabled.
    info: (...args) => { if (enabled()) console.info("[TG DL]", ...args); },
    // Keeps warnings visible even when verbose logging is disabled.
    warn: (...args) => console.warn("[TG DL]", ...args),
    // Keeps errors visible even when verbose logging is disabled.
    error: (...args) => console.error("[TG DL]", ...args)
  };
})(window);
