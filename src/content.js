(function () {
  "use strict";

  const VIEWER_SELECTOR = ".media-viewer-whole";
  const MAX_VIEWER_WAIT_MS = 9000;
  const buttons = new WeakMap();
  const keysByElement = new WeakMap();
  const trackedMedia = new Set();
  const runtimeMedia = new Map();
  const runningJobs = new Map();
  const buttonByKey = new Map();
  const albumButtons = new WeakMap();
  const groupIds = new WeakMap();
  const albumButtonById = new Map();
  const contentInstanceId=crypto.randomUUID();
  let viewerLockTail = Promise.resolve();
  let activeRoot = null;
  const M = { ADD:"DOWNLOAD_ADD", ADD_MANY:"DOWNLOAD_ADD_MANY", CANCEL:"DOWNLOAD_CANCEL", RETRY:"DOWNLOAD_RETRY", CLEAR:"DOWNLOAD_CLEAR_COMPLETED", GET:"QUEUE_GET_STATE", UPDATED:"QUEUE_STATE_UPDATED", EXECUTE:"DOWNLOAD_EXECUTE", PROGRESS:"DOWNLOAD_PROGRESS", COMPLETE:"DOWNLOAD_COMPLETE", FAIL:"DOWNLOAD_FAIL", CANCELLED:"DOWNLOAD_CANCELLED" };

  function getGroupId(message) {
    if(!message)return null;
    const stable=message.getAttribute("data-message-id")||message.getAttribute("data-mid");if(stable)return `${contentInstanceId}:message:${stable}`;
    let id=groupIds.get(message);if(!id){id=crypto.randomUUID();groupIds.set(message,id);}return id;
  }
  function groupedItemId(media) {
    const item=media.containerElement;if(!item)return null;
    const stable=item.getAttribute("data-mid")||item.getAttribute("data-message-id")||item.getAttribute("data-media-id")||"item";
    return `${stable}:${[...media.message.querySelectorAll(GROUP_SELECTOR)].indexOf(item)}`;
  }
  function shortHash(value) { let hash=2166136261;for(let i=0;i<value.length;i++)hash=Math.imul(hash^value.charCodeAt(i),16777619);return (hash>>>0).toString(16); }
  function mediaKey(media) {
    if(media.grouped&&media.message)return `album:${getGroupId(media.message)}:${groupedItemId(media)}`;
    const mediaId=media.element?.getAttribute("data-media-id");if(mediaId)return `media:${mediaId}`;
    const messageId=media.message?.getAttribute("data-message-id")||media.message?.getAttribute("data-mid");
    if(messageId&&media.url)return `message:${messageId}:${shortHash(media.url)}`;
    let key=keysByElement.get(media.element); if(!key){key=crypto.randomUUID();keysByElement.set(media.element,key);} return key;
  }
  function send(type, fields = {}, callback) { chrome.runtime.sendMessage({ type, ...fields }, response => { void chrome.runtime.lastError; callback?.(response); }); }
  function serialMedia(media) {
    let groupId=null,itemId=null;
    if(media.grouped&&media.message){groupId=getGroupId(media.message);itemId=groupedItemId(media);}
    const videoLike=media.type==="video"||media.type==="animation";
    const requiresViewer=videoLike&&(!!media.lazyVideo||!sourceFromVideo(media.element,media.type));
    return { type:media.type, filename:media.filename, mimeType:media.mimeType, sourceType:media.sourceType, url:media.url, size:media.size, requiresViewer, groupId, itemId, mediaId:media.element?.getAttribute("data-media-id") || media.containerElement?.getAttribute("data-media-id") || null, messageId:media.message?.getAttribute("data-message-id") || media.message?.getAttribute("data-mid") || null };
  }
  function setButtonState(key, status, progress = null) {
    const entry = buttonByKey.get(key); if (!entry?.button.isConnected) return;
    const symbols = { queued:"◌", downloading:"◌", completed:"✓", failed:"!", cancelled:"↓" };
    entry.button.textContent = symbols[status] || "↓"; entry.button.dataset.status=status; entry.state.active=status==="downloading"; entry.button.disabled=false;
    entry.button.title = status === "failed" ? "Download failed; activate to retry" : status === "downloading" ? "Cancel download" : status === "completed" ? "Download again" : status === "queued" ? "Queued" : "Download";
    entry.button.setAttribute("aria-label", entry.button.title);
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === M.EXECUTE) { sendResponse({ accepted:true }); void executeJob(message); return false; }
    if (message?.type === M.CANCEL) { const entry=runningJobs.get(message.id); entry?.controller.abort(); if(entry?.downloadId)window.TelegramMediaDownloader.cancelDownload(entry.downloadId); }
    if (message?.type === M.UPDATED) {
      const jobs=message.state?.jobs||[]; for(const job of jobs) if(job.mediaKey) { const entry=buttonByKey.get(job.mediaKey); if(entry){entry.state.jobId=job.id;entry.button.dataset.jobId=job.id;if(entry.state.cancelRequested){entry.state.cancelRequested=false;send(M.CANCEL,{id:job.id});}} setButtonState(job.mediaKey,job.status,job.progress); }
      for(const key of new Set(jobs.map(job=>job.mediaKey).filter(Boolean))){const same=jobs.filter(job=>job.mediaKey===key);if(same.every(job=>["completed","cancelled"].includes(job.status)))runtimeMedia.delete(key);}
      for(const [groupId,button] of albumButtonById){const grouped=jobs.filter(j=>j.groupId===groupId);if(!grouped.length)continue;const statuses=grouped.map(j=>j.status);button.textContent=statuses.some(s=>s==="queued"||s==="downloading")?"◌":statuses.every(s=>s==="completed")?"✓":statuses.some(s=>s==="failed")?"!":"↓";button.title=button.textContent==="✓"?"Album completed":button.textContent==="!"?"Some downloads failed":"Download album";}
      for(const [key,entry] of buttonByKey){ const related=jobs.filter(j=>j.mediaKey===key); if(related.length>1 && related.some(j=>["queued","downloading"].includes(j.status))) setButtonState(key,"queued"); }
    }
  });

  function injectBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/page-bridge.js");
    script.onload = () => script.remove();
    script.onerror = () => { window.TelegramMediaLogger?.error("Could not load page bridge"); script.remove(); };
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

  function acquireViewerLock(signal) {
    const previous=viewerLockTail;let unlock;const slot=new Promise(resolve=>{unlock=resolve;});
    viewerLockTail=previous.then(()=>slot);
    return new Promise((resolve,reject)=>{
      let settled=false;
      const onAbort=()=>{if(settled)return;settled=true;signal.removeEventListener("abort",onAbort);previous.then(()=>unlock());reject(new Error("Cancelled"));};
      if(signal.aborted){onAbort();return;}
      signal.addEventListener("abort",onAbort,{once:true});
      previous.then(()=>{if(settled)return;settled=true;signal.removeEventListener("abort",onAbort);if(signal.aborted){unlock();reject(new Error("Cancelled"));}else resolve(unlock);});
    });
  }

  function viewerVideos(viewer) {
    const aspecter = viewer.querySelector(".media-viewer-aspecter");
    if (aspecter) {
      const videos = [...aspecter.querySelectorAll("video")].filter(isVisible);
      if (videos.length) return videos;
    }
    const movers = viewer.querySelector(".media-viewer-movers");
    if (movers) {
      const videos = [...movers.querySelectorAll("video")].filter(isVisible);
      if (videos.length) return videos;
    }
    return [...viewer.querySelectorAll("video")].filter(isVisible);
  }

  function videoSignature(video) { return video.currentSrc || video.src || video.querySelector("source[src]")?.src || ""; }
  function mediaAssociations(media) {
    const values=new Set();
    for(const element of [media.element,media.containerElement]) if(element) for(const attr of ["data-mid","data-message-id","data-media-id"]) {const value=element.getAttribute(attr);if(value)values.add(value);}
    if(!values.size&&!media.grouped&&media.message)for(const attr of ["data-mid","data-message-id"]){const value=media.message.getAttribute(attr);if(value)values.add(value);}
    return values;
  }
  function viewerAssociations(video, viewer) {
    const values=new Set();for(let node=video;node&&node!==viewer;node=node.parentElement)for(const attr of ["data-mid","data-message-id","data-media-id"]){const value=node.getAttribute?.(attr);if(value)values.add(value);}return values;
  }
  function viewerVideoRank(video,viewer) {
    const active=video.closest("[aria-current='true'],[data-active='true'],.active,.current")?100000:0;
    const playing=!video.paused&&!video.ended?10000:0;
    const r=video.getBoundingClientRect(),v=viewer.getBoundingClientRect();
    const distance=Math.hypot((r.left+r.width/2)-(v.left+v.width/2),(r.top+r.height/2)-(v.top+v.height/2));
    return active+playing-distance;
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

  function waitForViewerVideo(mediaType, timeoutMs, signal, viewerBefore = null, media = null) {
    const previousSources=new Set(viewerBefore?viewerVideos(viewerBefore).map(videoSignature).filter(Boolean):[]);
    const expectedIds=media?mediaAssociations(media):new Set();
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
            window.TelegramMediaLogger?.debug("Media viewer detected");
            if (!viewerBefore) window.TelegramMediaLogger?.debug("Viewer opened by downloader");
          }
          const videos = viewerVideos(viewer).sort((a,b)=>viewerVideoRank(b,viewer)-viewerVideoRank(a,viewer));
          if (videos.length && !loggedVideo) {
            loggedVideo = true;
            window.TelegramMediaLogger?.debug("Viewer video detected");
          }
          for (const video of videos) {
            const actualIds=viewerAssociations(video,viewer);
            const associationMatches=expectedIds.size>0&&[...expectedIds].some(id=>actualIds.has(id));
            if(expectedIds.size>0&&actualIds.size>0&&!associationMatches)continue;
            if(previousSources.has(videoSignature(video))&&!associationMatches)continue;
            const source = sourceFromVideo(video, mediaType);
            if (source) {
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

  async function resolveVideoSource(media, signal, onViewerActivated = () => {}) {
    if (media.lazyVideo) {
      const activationTarget = media.activationTarget;
      if (!(activationTarget instanceof HTMLImageElement) || !activationTarget.isConnected || !media.mediaContainer?.contains(activationTarget)) {
        throw new Error("Could not find Telegram's video thumbnail activation target.");
      }
      const viewerBefore = findViewer();
      window.TelegramMediaLogger?.debug("Opening Telegram media viewer from thumbnail");
      if (media.grouped) window.TelegramMediaLogger?.debug("Activating grouped video thumbnail");
      // Telegram's lazy video placeholder opens the viewer on this image click.
      // Its Blob URL is strictly an activation target and is never read here.
      if(signal?.aborted)throw new Error("Cancelled");
      if(!viewerBefore)onViewerActivated();
      activationTarget.click();
      const resolved = await waitForViewerVideo("video", MAX_VIEWER_WAIT_MS, signal, viewerBefore,media);
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
    window.TelegramMediaLogger?.debug(`Video source unavailable; opening message media viewer; mediaType: ${media.type}`);
    if(signal?.aborted)throw new Error("Cancelled");
    if(!viewerBefore)onViewerActivated();
    clickable.click();
    const resolved = await waitForViewerVideo(media.type, MAX_VIEWER_WAIT_MS, signal, viewerBefore,media);
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
    window.TelegramMediaLogger?.debug("Closing downloader-owned viewer");
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
    if (closed) window.TelegramMediaLogger?.debug("Viewer closed");
    else window.TelegramMediaLogger?.warn("Downloader-owned viewer did not close before timeout");
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
    const parent = descriptor.grouped ? descriptor.containerElement : element.parentElement;
    if (!parent) return;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "↓";
    button.title = "Download";
    button.setAttribute("aria-label", "Download");
    button.setAttribute("data-tg-downloader-button", "true");
    button.className="tg-media-download-button";
    button.style.cssText = "position:absolute;z-index:2147483647;top:8px;right:8px;width:30px;height:30px;padding:0;border:0;border-radius:50%;background:#2481cc;color:#fff;font:18px sans-serif;cursor:pointer;box-shadow:0 1px 4px #0005";
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.appendChild(button);
    element.setAttribute("data-tg-downloader-attached", "true");
    const state = { active: false, downloadId: null };
    const entry = { button, state };
    buttons.set(element, entry);
    trackedMedia.add(element);
    const key=mediaKey(descriptor); runtimeMedia.set(key,descriptor); buttonByKey.set(key,entry);

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const jobId=button.dataset.jobId;
      if (state.active || button.dataset.status === "queued" || button.dataset.status === "downloading") { if(jobId)send(M.CANCEL,{id:jobId});else state.cancelRequested=true; return; }
      if(button.dataset.status==="failed") { if(jobId)send(M.RETRY,{id:jobId}); return; }
      let media = window.TelegramMediaDetector.detect(element);
      if (!media) {
        button.textContent = "!";
        button.disabled = true;
        setTimeout(() => detachButton(element), 1800);
        return;
      }
      runtimeMedia.set(key,media); const serial=serialMedia(media); send(M.ADD,{media:serial,key},response=>{state.jobId=response?.ids?.[0]||state.jobId;if(state.jobId)button.dataset.jobId=state.jobId;if(state.cancelRequested&&state.jobId){state.cancelRequested=false;send(M.CANCEL,{id:state.jobId});}});
      setButtonState(key,"queued");
    });
    if (descriptor.grouped) attachAlbumButton(descriptor.message);
  }

  function attachAlbumButton(message) {
    if(!message || albumButtons.has(message)) return;
    const button=document.createElement("button"); button.type="button"; button.textContent="↓"; button.title="Download album"; button.setAttribute("aria-label","Download album"); button.setAttribute("data-tg-downloader-button","true"); button.className="tg-media-download-button";
    button.style.cssText="display:block;margin:5px auto 0;width:32px;height:32px;border:0;border-radius:50%;background:#2481cc;color:white;font:18px sans-serif;cursor:pointer";
    if(!message.querySelector(GROUP_SELECTOR))return;
    message.appendChild(button); albumButtons.set(message,button);const groupId=getGroupId(message);albumButtonById.set(groupId,button);
    button.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();const items=[],seen=new Set(),names=new Map();
      for(const item of message.querySelectorAll(GROUP_SELECTOR)){
        const candidate=[...item.querySelectorAll("video,img,a[href]")].find(el=>buttons.has(el)&&el.closest(GROUP_SELECTOR)===item);
        if(!candidate||seen.has(candidate))continue;seen.add(candidate);
        const descriptor=window.TelegramMediaDetector.detect(candidate);if(!descriptor||descriptor.containerElement!==item)continue;
        const key=mediaKey(descriptor),media=serialMedia(descriptor);runtimeMedia.set(key,descriptor);
        const count=(names.get(media.filename)||0)+1;names.set(media.filename,count);
        if(count>1){const dot=media.filename.lastIndexOf("."),stem=dot>0?media.filename.slice(0,dot):media.filename,ext=dot>0?media.filename.slice(dot):"";media.filename=`${stem} (${count})${ext}`;}
        items.push({key,media});
        window.TelegramMediaLogger?.debug("Album item collected",{mediaKey:key,mediaId:media.mediaId,groupId:media.groupId,itemId:media.itemId,type:media.type,sourceType:media.sourceType});
      }
      if(!items.length)return;window.TelegramMediaLogger?.debug("Album batch submitted",{groupId:items[0].media.groupId,itemCount:items.length});send(M.ADD_MANY,{items},()=>{button.textContent="◌";});
    });
  }

  const GROUP_SELECTOR=".album-item.grouped-item";
  async function executeJob(message) {
    const descriptor=runtimeMedia.get(message.mediaKey); if(!descriptor){send(M.FAIL,{id:message.id,error:"Media no longer available"});return;}
    const controller=new AbortController(), running={controller,downloadId:null}; runningJobs.set(message.id,running);
    let viewerBeforeJob=null,ownedViewer=null,releaseViewer=null,outcome="completed",failure=null;
    try{
      let media=descriptor;
      const viewerDependent=(media.type==="video"||media.type==="animation")&&(media.lazyVideo||!sourceFromVideo(media.element,media.type));
      if(viewerDependent)releaseViewer=await acquireViewerLock(controller.signal);
      viewerBeforeJob=findViewer();
      window.TelegramMediaLogger?.debug("Starting download job",{jobId:message.id,mediaId:descriptor.element?.getAttribute("data-media-id")||null,groupId:serialMedia(descriptor).groupId,sourceType:descriptor.sourceType,viewerDependent,viewerLock:viewerDependent?"acquired":"not-required"});
      if(media.type==="video"||media.type==="animation"){const resolved=await resolveVideoSource(media,controller.signal,()=>{running.viewerActivationStarted=true;});media=resolved.media;if(resolved.viewerOpenedByDownloader)ownedViewer=resolved.viewer;}
      if(!media.url||!["stream","blob","direct"].includes(media.sourceType))throw new Error("No downloadable source");
      let lastUpdate=-Infinity,lastSampleAt=null,lastSampleBytes=0,lastDone=0,lastTotal=media.size||null,lastSpeed=null;
      const result=await window.TelegramMediaDownloader.downloadMedia(media,(percent,done,total,downloadId)=>{
        if(downloadId)running.downloadId=downloadId;if(done==null)return;
        const now=performance.now(),dt=lastSampleAt==null?0:(now-lastSampleAt)/1000,db=done-lastSampleBytes;
        let speed=null;if(lastSampleAt==null){lastSampleAt=now;lastSampleBytes=done;}else if(dt>=0.25){if(db>0)speed=db/dt;lastSampleAt=now;lastSampleBytes=done;}
        lastDone=done;lastTotal=Number.isFinite(total)?total:lastTotal;if(speed)lastSpeed=speed;
        if(now-lastUpdate<120)return;lastUpdate=now;
        send(M.PROGRESS,{id:message.id,done:Number.isFinite(done)?done:0,total:Number.isFinite(total)?total:null,speed:Number.isFinite(speed||lastSpeed)?(speed||lastSpeed):null});
      },controller.signal);
      const completedSize=Number.isFinite(result?.size)?result.size:lastDone;
      send(M.PROGRESS,{id:message.id,done:completedSize,total:lastTotal||completedSize,speed:lastSpeed});
    }catch(error){outcome=error?.message==="Cancelled"?"cancelled":"failed";failure=error;if(outcome==="failed"){const detail=String(error?.message||"Unknown error").replace(/(?:https?|blob):\/\/\S+/gi,"[URL]");window.TelegramMediaLogger?.error(`Download failed: ${detail}`);}}
    finally{
      if(ownedViewer)await closeDownloaderOwnedViewer(ownedViewer);
      else if(outcome!=="completed"&&running.viewerActivationStarted&&!viewerBeforeJob){const opened=findViewer();if(opened)await closeDownloaderOwnedViewer(opened);}
      releaseViewer?.();runningJobs.delete(message.id);
    }
    send(outcome==="completed"?M.COMPLETE:outcome==="cancelled"?M.CANCELLED:M.FAIL,{id:message.id,error:failure?.message||null});
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
  const style=document.createElement("style");style.textContent=".tg-media-download-button:hover{filter:brightness(1.12)}.tg-media-download-button:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px #2481cc}.tg-media-download-button[data-status='downloading']{animation:tg-media-spin 1.2s linear infinite}@keyframes tg-media-spin{to{transform:rotate(360deg)}}";(document.head||document.documentElement).appendChild(style);
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
  window.TelegramMediaLogger?.debug("Active conversation media detection enabled");
})();
