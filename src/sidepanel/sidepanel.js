"use strict";
// Sends queue actions and state requests to the service worker.
const send = (type, fields = {}, callback) => chrome.runtime.sendMessage({ type, ...fields }, callback);
// Formats byte counts for the queue's human-readable status text.
const formatBytes = n => n == null ? "Size unknown" : `${(n / 1048576).toFixed(1)} MB`;
// Formats a transfer rate for active downloads.
const formatRate = n => n ? `${(n / 1048576).toFixed(1)} MB/s` : "";
// Builds a labeled action control for a queue job.
function actionButton(label, icon, onClick) {
  const button=document.createElement("button");button.className="action-button";button.type="button";
  const image=document.createElement("img");image.src=chrome.runtime.getURL(icon);image.alt="";image.setAttribute("aria-hidden","true");button.append(image,document.createTextNode(label));
  button.setAttribute("aria-label",label);button.addEventListener("click",onClick);return button;
}
// Rebuilds the Side Panel from the latest queue snapshot.
function render(state) {
  const host = document.getElementById("jobs"); host.replaceChildren();
  document.getElementById("summary").textContent = `${state.activeCount} active · ${state.queuedCount} queued`;
  if (!state.jobs.length) { host.innerHTML = '<div class="empty">Your downloads will appear here.</div>'; return; }
  for (const job of [...state.jobs].reverse()) {
    const card = document.createElement("section"); card.className="job";
    const title=document.createElement("div"); title.className="title"; title.textContent=job.filename || job.mediaType || "Download"; card.append(title);
    const status=document.createElement("div"); status.className=`status${job.error?" error":""}`;
    const rate=formatRate(job.speed),remaining=job.totalBytes==null?null:Math.max(0,job.totalBytes-(job.bytesDownloaded||0));
    const eta=job.speed&&remaining!=null?` · ETA ${Math.max(1,Math.ceil(remaining/job.speed))} sec`:"";
    if(job.status==="downloading") status.textContent=`Downloading${job.progress==null?"":` · ${job.progress}%`} · ${formatBytes(job.bytesDownloaded)} / ${formatBytes(job.totalBytes)}${rate?` · ${rate}${eta}`:""}`;
    else status.textContent=job.error||job.status[0].toUpperCase()+job.status.slice(1);
    card.append(status);
    if(job.status==="queued"||job.status==="downloading") {
      const bar=document.createElement("div");bar.className="bar";bar.setAttribute("role","progressbar");bar.setAttribute("aria-label",`Download progress for ${job.filename||"media"}`);
      const fill=document.createElement("i");if(job.progress==null){fill.className="indeterminate";bar.setAttribute("aria-valuetext","Progress unknown");}else{fill.style.width=`${job.progress}%`;bar.setAttribute("aria-valuenow",String(job.progress));bar.setAttribute("aria-valuemin","0");bar.setAttribute("aria-valuemax","100");}bar.append(fill);card.append(bar);
    }
    const actions=document.createElement("div");actions.className="actions";
    if(["failed","cancelled"].includes(job.status)) actions.append(actionButton("Retry","rotate-right.png",()=>send("DOWNLOAD_RETRY",{id:job.id})));
    if(["queued","downloading"].includes(job.status)) actions.append(actionButton("Cancel","cross.png",()=>send("DOWNLOAD_CANCEL",{id:job.id})));
    if(actions.childElementCount)card.append(actions);host.append(card);
  }
}
document.getElementById("clear").addEventListener("click",()=>send("DOWNLOAD_CLEAR_COMPLETED"));
chrome.runtime.onMessage.addListener(message=>{if(message?.type==="QUEUE_STATE_UPDATED")render(message.state);});
send("QUEUE_GET_STATE",{},render);
