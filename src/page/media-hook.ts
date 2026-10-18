/**
 * Main-world script (manifest `world: "MAIN"`, document_start, all frames) for sites other than YouTube.
 * A player made with `new Audio()` never enters the DOM, so the content script cannot find it.
 * When such an element starts playing, park it in a hidden node: the DOM is the only thing the two worlds share.
 */
const proto = HTMLMediaElement.prototype;
const play = proto.play;
let holder: HTMLElement | null = null;

proto.play = function (this: HTMLMediaElement, ...args: []) {
  if (!this.isConnected) {
    try {
      if (!holder) {
        holder = document.createElement('div');
        holder.hidden = true;
        holder.style.display = 'none';
      }
      if (!holder.isConnected) document.documentElement.append(holder);
      holder.append(this);
    } catch {
      /* page without a document element yet: the element stays out of reach */
    }
  }
  return play.apply(this, args);
};
