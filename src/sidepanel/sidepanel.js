"use strict";
const send = (type, fields = {}, callback) => chrome.runtime.sendMessage({ type, ...fields }, callback);
const formatBytes = n => n == null ? "Size unknown" : `${(n / 1048576).toFixed(1)} MB`;
function render(state) {
  const host = document.getElementById("jobs"); host.replaceChildren();
  document.getElementById("summary").textContent = `${state.activeCount} active · ${state.queuedCount} queued`;
  if (!state.jobs.length) { host.innerHTML = '<div class="empty">Your downloads will appear here.</div>'; return; }
  for (const job of [...state.jobs].reverse()) {
    const card = document.createElement("section"); card.className="job";
    const title=document.createElement("div"); title.className="title"; title.textContent=job.filename || job.mediaType || "Download"; card.append(title);
    const status=document.createElement("div"); status.className=`status${job.error?" error":""}`;
    const rate=job.speed?`${(job.speed/1048576).toFixed(1)} MB/s`:"";const eta=job.speed&&job.totalBytes?` · ETA ${Math.max(1,Math.ceil((job.totalBytes-job.bytesDownloaded)/job.speed))} sec`:"";
    status.textContent=job.error || (job.status === "downloading" ? `Downloading${job.progress == null ? "" : ` · ${job.progress}%`} · ${formatBytes(job.bytesDownloaded)} / ${formatBytes(job.totalBytes)}${rate?` · ${rate}${eta}`:""}` : job.status[0].toUpperCase()+job.status.slice(1)); card.append(status);
    if (job.status === "queued" || job.status === "downloading") { const bar=document.createElement("div"); bar.className="bar"; const fill=document.createElement("i"); fill.style.width=job.progress==null?"35%":`${job.progress}%`; if(job.progress==null)fill.className="indeterminate"; bar.append(fill); card.append(bar); }
    const actions=document.createElement("div"); actions.className="actions";
    if(job.status === "failed"){const retry=document.createElement("button");retry.textContent="Retry";retry.setAttribute("aria-label",`Retry ${job.filename}`);retry.onclick=()=>send("DOWNLOAD_RETRY",{id:job.id});actions.append(retry);}
    if(["queued","downloading"].includes(job.status)){const cancel=document.createElement("button");cancel.textContent="Cancel";cancel.setAttribute("aria-label",`Cancel ${job.filename}`);cancel.onclick=()=>send("DOWNLOAD_CANCEL",{id:job.id});actions.append(cancel);}
    if(actions.childElementCount)card.append(actions); host.append(card);
  }
}
document.getElementById("clear").addEventListener("click",()=>send("DOWNLOAD_CLEAR_COMPLETED"));
chrome.runtime.onMessage.addListener(message=>{if(message?.type==="QUEUE_STATE_UPDATED")render(message.state);});
send("QUEUE_GET_STATE",{},render);
