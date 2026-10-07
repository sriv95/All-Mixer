// SRI-235 V2: createImageBitmap (content-script world) -> cheap 2x2 bitmap, no GPU readback from the video.
;(() => { const orig = self.createImageBitmap.bind(self); self.createImageBitmap = () => orig(new ImageData(2, 2)); })();
