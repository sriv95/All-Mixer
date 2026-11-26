import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Btn } from './ui';

/** The host patterns the manifest asks for. Firefox MV3 treats them as optional: the user grants them. */
const hostOrigins = () => ({ origins: chrome.runtime.getManifest().host_permissions ?? [] });

/**
 * Firefox only (popup.tsx mounts it behind `__FIREFOX__`): until the user grants site access, content scripts and
 * background fetches fail. Shows a notice with a button; `permissions.request` must run inside the click handler.
 * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions/request
 */
export function FirefoxAccess() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const check = () => void chrome.permissions.contains(hostOrigins()).then((ok) => setMissing(!ok), () => {});
    check();
    chrome.permissions.onAdded?.addListener(check);
    return () => chrome.permissions.onAdded?.removeListener(check);
  }, []);
  if (!missing) return null;
  return (
    <div id="firefox-access" role="status" className="flex items-start gap-3 rounded-[20px] bg-brand-tint p-3.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand text-white"><ShieldCheck size={20} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-sm font-extrabold">Site access needed</h2>
        <p className="m-0 mt-0.5 text-[12.5px] leading-snug text-banner">All Mixer needs access to websites to change their audio.</p>
        <Btn id="grant-access" tone="primary" style={{ marginTop: 10, width: '100%' }}
          onClick={() => void chrome.permissions.request(hostOrigins()).then((ok) => { if (ok) setMissing(false); }, () => {})}>
          Grant access
        </Btn>
      </div>
    </div>
  );
}
