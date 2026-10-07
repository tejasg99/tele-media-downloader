importScripts("messages.js", "download-manager.js");
const manager = new DownloadManager();
// Broadcasts safe queue snapshots to the Side Panel and each owning Telegram tab.
manager.subscribe(state => {
  // runtime.sendMessage serves extension pages such as the Side Panel. Content
  // scripts receive queue updates through tabs.sendMessage instead.
  chrome.runtime.sendMessage({ type: DownloadMessages.UPDATED, state }, () => void chrome.runtime.lastError);
  const snapshotsById=new Map(state.jobs.map(job=>[job.id,job])),jobsByTab=new Map();
  for(const job of manager.jobs.values()){
    const snapshot=snapshotsById.get(job.id);if(!snapshot||!Number.isInteger(job.tabId))continue;
    let jobs=jobsByTab.get(job.tabId);if(!jobs){jobs=[];jobsByTab.set(job.tabId,jobs);}jobs.push(snapshot);
  }
  for(const [tabId,jobs] of jobsByTab){
    const tabState={jobs,queuedCount:jobs.filter(job=>job.status==="queued").length,activeCount:jobs.filter(job=>job.status==="downloading").length};
    chrome.tabs.sendMessage(tabId,{type:DownloadMessages.UPDATED,state:tabState},()=>void chrome.runtime.lastError);
  }
});
// Routes queue actions and download lifecycle updates to the manager.
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
    case DownloadMessages.GET_STATE: {
      const state=manager.snapshot();
      if(Number.isInteger(tabId)){
        state.jobs=state.jobs.filter(job=>manager.jobs.get(job.id)?.tabId===tabId);
        state.queuedCount=state.jobs.filter(job=>job.status==="queued").length;
        state.activeCount=state.jobs.filter(job=>job.status==="downloading").length;
      }
      sendResponse(state);break;
    }
  }
  return message?.type === DownloadMessages.GET_STATE || message?.type === DownloadMessages.ADD || message?.type === DownloadMessages.ADD_MANY;
});
// Opens the download queue when the user selects the extension action.
chrome.action.onClicked.addListener(() => chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }));
