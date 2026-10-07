// SRI-235 V1: overlay canvas never covers the video (capture + draw still run).
;(() => { const add = () => { const s = document.createElement('style'); s.textContent = 'canvas.all-mixer-delayed-video{visibility:hidden !important}'; (document.head || document.documentElement).appendChild(s); }; if (document.head) add(); else new MutationObserver((_, o) => { if (document.head) { o.disconnect(); add(); } }).observe(document.documentElement, { childList: true }); })();
// SRI-235 V2: createImageBitmap (content-script world) -> cheap 2x2 bitmap, no GPU readback from the video.
;(() => { const orig = self.createImageBitmap.bind(self); self.createImageBitmap = () => orig(new ImageData(2, 2)); })();
