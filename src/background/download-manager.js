"use strict";
class DownloadManager {
  constructor() { this.jobs = new Map(); this.queue = []; this.active = new Set(); this.viewerActiveTabs = new Set(); this.concurrency = 2; this.listeners = new Set(); }
  snapshot() { return { jobs: [...this.jobs.values()].map(({ media, tabId, ...job }) => job), queuedCount: this.queue.length, activeCount: this.active.size }; }
  emit() { const state = this.snapshot(); for (const listener of this.listeners) listener(state); }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  identity(media, key, tabId) {
    let identity;
    if (media.itemId) identity=`item:${media.groupId || "single"}:${media.itemId}`;
    else if (media.mediaId) identity=`media:${media.mediaId}`;
    else if (media.url) { let a=2166136261,b=2246822519; for(let i=0;i<media.url.length;i++){const c=media.url.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,3266489917);} identity=`url:${(a>>>0).toString(16)}${(b>>>0).toString(16)}`; }
    else identity=key || `${media.messageId || ""}:${media.filename}:${media.type}`;
    return `tab:${tabId}:${identity}`;
  }
  add(media, key, tabId) { return this.addMany([{ media, key }], tabId)[0] || null; }
  addMany(items, tabId) {
    const added = [];
    for (const { media, key } of items) {
      const identity = this.identity(media, key, tabId);
      const duplicate = [...this.jobs.values()].find(j => j.identity === identity && ["queued", "downloading"].includes(j.status));
      if (duplicate) { added.push(duplicate.id); continue; }
      const id = crypto.randomUUID();
      this.jobs.set(id, { id, identity, mediaKey: key, groupId:media.groupId || null, mediaType: media.type, filename: media.filename, status: "queued", progress: null, bytesDownloaded: 0, totalBytes: media.size || null, speed: null, error: null, createdAt: Date.now(), attempts: 0, tabId, viewerLockHeld:false, media });
      this.queue.push(id); added.push(id);
    }
    this.emit(); this.pump(); return added;
  }
  async pump() {
    while (this.active.size < this.concurrency && this.queue.length) {
      const index=this.queue.findIndex(id=>{const candidate=this.jobs.get(id);return candidate?.status==="queued"&&(!candidate.media.requiresViewer||!this.viewerActiveTabs.has(candidate.tabId));});
      if(index<0)break;
      const [id]=this.queue.splice(index,1), job = this.jobs.get(id); if (!job || job.status !== "queued") continue;
      if(job.media.requiresViewer){job.viewerLockHeld=true;this.viewerActiveTabs.add(job.tabId);}
      job.status = "downloading"; job.attempts++; this.active.add(id); this.emit();
      chrome.tabs.sendMessage(job.tabId, { type: DownloadMessages.EXECUTE, id, mediaKey: job.mediaKey }, response => {
        if (chrome.runtime.lastError || response?.accepted !== true) this.finish(id, "failed", chrome.runtime.lastError?.message || "Job was not accepted by its Telegram tab");
        else if (job.cancelRequested) chrome.tabs.sendMessage(job.tabId, { type: DownloadMessages.CANCEL, id });
      });
    }
  }
  update(id, patch) { const job = this.jobs.get(id); if (!job) return; Object.assign(job, patch); this.emit(); }
  finish(id, status, error = null) { const job = this.jobs.get(id); if (!job) return; job.status = status; job.cancelRequested=false; job.error = error ? "Download failed" : null; job.progress = status === "completed" ? 100 : job.progress; if (status === "completed") job.media = null; this.active.delete(id); if(job.viewerLockHeld){this.viewerActiveTabs.delete(job.tabId);job.viewerLockHeld=false;} this.emit(); this.pump(); }
  cancel(id) {
    const job = this.jobs.get(id); if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return;
    if (job.status === "queued") { this.queue = this.queue.filter(value => value !== id); job.status = "cancelled"; job.cancelRequested=false; this.emit(); return; }
    job.cancelRequested=true;chrome.tabs.sendMessage(job.tabId, { type: DownloadMessages.CANCEL, id });
  }
  retry(id) { const job = this.jobs.get(id); if (!job || !["failed", "cancelled"].includes(job.status) || !job.media) return; if ([...this.jobs.values()].some(other => other.id !== id && other.identity === job.identity && ["queued", "downloading"].includes(other.status))) return; job.status="queued"; job.cancelRequested=false; job.error=null; job.progress=null; job.bytesDownloaded=0; job.speed=null; job.totalBytes=job.totalBytes||job.media.size||null; job.attempts=0; this.queue.push(id); this.emit(); this.pump(); }
  clearCompleted() { for (const [id, job] of this.jobs) if (job.status === "completed") this.jobs.delete(id); this.emit(); }
}
