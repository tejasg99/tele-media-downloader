(function (global) {
  "use strict";
  const enabled = () => global.TelegramMediaDebug === true;
  global.TelegramMediaLogger = {
    debug: (...args) => { if (enabled()) console.debug("[TG DL]", ...args); },
    info: (...args) => { if (enabled()) console.info("[TG DL]", ...args); },
    warn: (...args) => console.warn("[TG DL]", ...args),
    error: (...args) => console.error("[TG DL]", ...args)
  };
})(window);
