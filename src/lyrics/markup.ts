/**
 * Remove HTML-ish tags (<i>, <b>, <font color=...>, <br>) and ASS overrides ({\an8}) from
 * lyric text, keeping inner text, then decode common entities. String-only; never touches the DOM.
 * A lone "<" (as in "I <3 you") is not a tag and stays.
 */
const TAG = /<\/?[a-zA-Z][^<>]*>/g;
const ASS = /\{\\[^}]*\}/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

export function stripMarkup(s: string): string {
  if (!s) return '';
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(TAG, '')
    .replace(ASS, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e]);
}
