importScripts("messages.js", "download-manager.js");
const manager = new DownloadManager();
manager.subscribe(state => chrome.runtime.sendMessage({ type: DownloadMessages.UPDATED, state }, () => void chrome.runtime.lastError));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  switch (message?.type) {
    case DownloadMessages.ADD: sendResponse({ ids: [manager.add(message.media, message.key, tabId)].filter(Boolean) }); break;
    case DownloadMessages.ADD_MANY: sendResponse({ ids: manager.addMany(message.items || [], tabId) }); break;
    case DownloadMessages.PROGRESS: manager.update(message.id, { progress: message.total ? Math.floor(message.done / message.total * 100) : null, bytesDownloaded: message.done, totalBytes: message.total || null, speed: message.speed || null }); break;
    case DownloadMessages.COMPLETE: manager.finish(message.id, "completed"); break;
    case DownloadMessages.FAIL: manager.finish(message.id, "failed", message.error); break;
    case DownloadMessages.CANCELLED: manager.finish(message.id, "cancelled"); break;
    case DownloadMessages.CANCEL: manager.cancel(message.id); break;
    case DownloadMessages.RETRY: manager.retry(message.id); break;
    case DownloadMessages.CLEAR_COMPLETED: manager.clearCompleted(); break;
    case DownloadMessages.GET_STATE: sendResponse(manager.snapshot()); break;
  }
  return message?.type === DownloadMessages.GET_STATE || message?.type === DownloadMessages.ADD || message?.type === DownloadMessages.ADD_MANY;
});
chrome.action.onClicked.addListener(() => chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }));
