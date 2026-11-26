#!/usr/bin/env python3
"""Drive real Firefox with the All Mixer add-on (temporary install, fresh profile) and print PASS/FAIL for checks a to g.

Usage: python3 -I drive.py --addon <dist-firefox dir> --out <evidence dir> [--headed] [--video ID] [--model compat|none]
Needs `selenium` 4.x and Firefox.app. Launch path (macOS): `open -n -a Firefox.app --args -marionette -profile <dir>`, then
`geckodriver --connect-existing`; exec'ing the firefox binary directly fails with "Could not find profile folder.".
"""
import argparse, glob, json, os, signal, socket, subprocess, sys, tempfile, time, urllib.request
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.webdriver import WebDriver as FFDriver
from selenium.webdriver.common.by import By

UUID = '7a1b2c3d-0000-4000-8000-a11b17e50001'  # fixed, so the popup URL is known
ADDON_ID = 'all-mixer@sriv95'
ap = argparse.ArgumentParser()
ap.add_argument('--addon', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--video', default='jNQXAC9IVRw'); ap.add_argument('--model', default='compat')
ap.add_argument('--ytm-video', default='dQw4w9WgXcQ'); ap.add_argument('--headed', action='store_true'); ap.add_argument('--netlog', action='store_true', help='also check f from an nsHttp log; the log slows Firefox so the ML checks fail with it: run once without for a-e, once with for f')
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
res = {}
def check(k, ok, info=''):
    res[k] = bool(ok); print('PASS' if ok else 'FAIL', k, '-', str(info)[:400], flush=True)

PROFILE = tempfile.mkdtemp(prefix='am-ff-profile-')
STDOUT = os.path.join(a.out, 'firefox-stdout.log')
PREFS = {
  'extensions.webextensions.uuids': json.dumps({ADDON_ID: UUID}),
  'extensions.webextOptionalPermissionPrompts': False,  # permissions.request from a click is accepted without the doorhanger
  'devtools.console.stdout.content': True, 'devtools.console.stdout.chrome': True,
  'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0,
  'media.volume_scale': '0.0',  # silent; the Web Audio graph still runs
  'dom.webgpu.enabled': True,
  'browser.shell.checkDefaultBrowser': False, 'datareporting.policy.dataSubmissionEnabled': False,
  'browser.startup.homepage_override.mstone': 'ignore', 'startup.homepage_welcome_url': '', 'browser.aboutwelcome.enabled': False,
}
with open(os.path.join(PROFILE, 'user.js'), 'w') as f:
    for k, v in PREFS.items(): f.write(f'user_pref("{k}", {json.dumps(v) if not isinstance(v, str) else json.dumps(v)});\n')

def ff_pids():
    r = subprocess.run(['pgrep', '-f', PROFILE], capture_output=True, text=True)
    return [int(x) for x in r.stdout.split() if int(x) != os.getpid()]

gd = None; d = None
def cleanup():
    if d:
        try: d.quit()
        except Exception: pass
    if gd and gd.poll() is None: gd.terminate()
    for p in ff_pids():
        try: os.kill(p, signal.SIGTERM)
        except ProcessLookupError: pass
    time.sleep(2)
    for p in ff_pids():
        try: os.kill(p, signal.SIGKILL)
        except ProcessLookupError: pass

try:
    NETLOG = os.path.join(a.out, 'nshttp.log')
    args = ['open', '-n', '--env', 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1', *(['--env', 'MOZ_LOG=timestamp,rotate:300,nsHttp:5', '--env', 'MOZ_LOG_FILE=' + NETLOG] if a.netlog else []), '--stdout', STDOUT, '--stderr', STDOUT, '-a', '/Applications/Firefox.app', '--args']
    if not a.headed: args.append('-headless')
    args += ['-marionette', '-no-remote', '-profile', PROFILE]
    subprocess.run(args, check=True)
    for _ in range(60):
        try: socket.create_connection(('127.0.0.1', 2828), 1).close(); break
        except OSError: time.sleep(1)
    gdbin = (glob.glob(os.path.expanduser('~/.cache/selenium/geckodriver/*/*/geckodriver')) or ['geckodriver'])[0]
    gd = subprocess.Popen([gdbin, '--connect-existing', '--marionette-port', '2828', '--port', '4455'],
                          stdout=open(os.path.join(a.out, 'geckodriver.log'), 'w'), stderr=subprocess.STDOUT)
    time.sleep(2)
    d = webdriver.Remote('http://127.0.0.1:4455', options=Options())
    print('firefox', d.capabilities['browserVersion'], 'headless' if not a.headed else 'windowed', flush=True)
    d.set_script_timeout(120)
    def js(s, *x): return d.execute_script(s, *x)
    def jsa(s, *x): return d.execute_async_script(s, *x)
    def shot(n): d.save_screenshot(os.path.join(a.out, n + '.png'))
    def ext(code, *x):
        """Run an async body in the extension popup tab: `return await ...` allowed; `browser` is the WebExtension API."""
        r = jsa("const [args,cb]=[Array.prototype.slice.call(arguments,0,-1),arguments[arguments.length-1]];"
                "(async()=>{" + code + "})().then(v=>cb({v}),e=>cb({e:String(e)}))", *x)
        if 'e' in r: raise RuntimeError(r['e'])
        return r.get('v')

    d.command_executor._commands['SET_CONTEXT'] = ('POST', '/session/$sessionId/moz/context')
    def open_ext(url):
        """WebDriver refuses navigation to moz-extension://; open the tab from chrome context, like the browser does."""
        before = set(d.window_handles)
        d.execute('SET_CONTEXT', {'context': 'chrome'})
        js("gBrowser.selectedTab = gBrowser.addTab(arguments[0], {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()})", url)
        d.execute('SET_CONTEXT', {'context': 'content'})
        for _ in range(20):
            new = set(d.window_handles) - before
            if new: break
            time.sleep(0.5)
        d.switch_to.window(new.pop()); time.sleep(2)
        return d.current_window_handle

    # (a) install
    addon_id = FFDriver.install_addon(d, os.path.abspath(a.addon), temporary=True)
    time.sleep(3)
    out = open(STDOUT, errors='replace').read()
    bad = [l for l in out.splitlines() if ('moz-extension' in l or 'All Mixer' in l) and ('error' in l.lower() or 'Error' in l)]
    check('a install, no console errors', addon_id == ADDON_ID and not bad, f'id={addon_id} errors={bad[:2]}')

    # (g1) popup notice before grant
    popup = f'moz-extension://{UUID}/popup/popup.html'
    HOSTS = "{origins: browser.runtime.getManifest().host_permissions}"
    popup_tab = open_ext(popup)
    at_install = ext(f"return await browser.permissions.contains({HOSTS})")
    print('host access right after install (Firefox >= 127 grants MV3 host permissions at install):', at_install)
    # Revoke it (what a user does with "Only when clicked" in the extension menu) so the notice path can be exercised.
    ext(f"await browser.permissions.remove({HOSTS})")
    d.close(); popup_tab = open_ext(popup)
    check('b0 host access revoked', ext(f"return await browser.permissions.contains({HOSTS})") is False)
    check('g1 notice shown before grant', len(d.find_elements(By.CSS_SELECTOR, '#firefox-access')) == 1)
    shot('popup-before')
    # (b) grant by clicking the real button
    d.find_element(By.CSS_SELECTOR, '#grant-access').click(); time.sleep(3)
    check('g2 notice hidden after grant', len(d.find_elements(By.CSS_SELECTOR, '#firefox-access')) == 0)
    shot('popup-after')
    granted = ext("return await browser.permissions.contains({origins: browser.runtime.getManifest().host_permissions})")
    # (c) WebGPU in the ml page (same document type the content script iframes)
    open_ext(f'moz-extension://{UUID}/ml/ml.html')
    gpu = jsa("const cb=arguments[arguments.length-1];(async()=>{const o={gpu:!!navigator.gpu};"
              "if(o.gpu){const ad=await navigator.gpu.requestAdapter();o.adapter=!!ad;if(ad){o.f16=ad.features.has('shader-f16');o.info=ad.info?[ad.info.vendor,ad.info.architecture].join('/'):''}}"
              "const w=new Worker('ml-worker.js');o.worker=await new Promise(r=>{w.onmessage=()=>r('msg');w.onerror=e=>r('err '+e.message);setTimeout(()=>r('quiet'),3000)});"
              "o.opfs=!!(navigator.storage&&navigator.storage.getDirectory);return o})().then(cb,e=>cb({err:String(e)}))")
    print('webgpu', gpu)
    d.switch_to.window(popup_tab)

    # (d) model download into OPFS
    if a.model != 'none':
        ext(f"await browser.runtime.sendMessage({{type:'model-install', id:'{a.model}'}})")
        t0 = time.time(); prog = None
        while time.time() - t0 < 600:
            time.sleep(3)
            st = ext(f"const k=await browser.storage.local.get(['modelInstalled.{a.model}','modelProgress.{a.model}']);return k")
            if st.get(f'modelInstalled.{a.model}'): break
            prog = st.get(f'modelProgress.{a.model}')
            if prog and prog.get('phase') == 'error': break
            if prog and time.time() * 1000 - prog.get('at', 0) > 90_000: break  # stalled: nobody is downloading any more
        opfs = jsa("const cb=arguments[arguments.length-1];(async()=>{const r=await navigator.storage.getDirectory();const o=[];const walk=async(dir,pre)=>{for await(const [n,h] of dir.entries()){if(h.kind==='file'){o.push([pre+n,(await h.getFile()).size])}else await walk(h,pre+n+'/')}};await walk(r,'');return o})().then(cb,e=>cb(String(e)))")
        installed = st.get(f'modelInstalled.{a.model}')
        total = sum(s for _, s in opfs) if isinstance(opfs, list) else 0
        check('d model in OPFS', bool(installed) and total > 50e6, f'files={len(opfs) if isinstance(opfs, list) else opfs} bytes={total} secs={time.time()-t0:.0f} progress={prog}')
    check('b1 host access granted (popup click)', granted)

    # (b) YouTube, content script injected; (e) separation
    # Own window beside the control tab: a background tab is throttled and the ML probe then misses its deadline.
    d.set_window_rect(0, 30, 650, 800)
    d.switch_to.new_window('window'); yt = d.current_window_handle; d.set_window_rect(700, 30, 800, 800)
    d.get(f'https://www.youtube.com/watch?v={a.video}'); time.sleep(6)
    js("const v=document.querySelector('video');if(v){v.muted=false;v.loop=true;v.play()}")
    d.switch_to.window(popup_tab)
    tab = ext("const [t]=await browser.tabs.query({url:'*://www.youtube.com/*'});return t&&t.id")
    st = ext(f"return await browser.tabs.sendMessage({tab}, {{type:'get-status'}})")
    check('b2 content script answers on youtube.com', bool(st) and st.get('site') == 'youtube' and st.get('videoFound'), json.dumps(st)[:200])
    s = ext(f"return await browser.runtime.sendMessage({{type:'get-tab-settings', tabId:{tab}}})")
    s.update(mode='separate', mlModel='mdx' if a.model == 'none' else a.model, vocalPct=100, instrumentalPct=100)
    ext(f"return await browser.runtime.sendMessage({{type:'set-tab-settings', tabId:{tab}, settings:{json.dumps(s)}}})")
    for _ in range(90):
        time.sleep(2)
        st = ext(f"return await browser.tabs.sendMessage({tab}, {{type:'get-status'}})")
        sep = st.get('separation') or {}
        if (sep.get('choice') or {}).get('state') in ('on', 'unavailable') or sep.get('state') == 'error': break
    print('separation', json.dumps(sep)[:300])
    check('c2 ml engine chosen in the page', (sep.get('choice') or {}).get('state') in ('on', 'warming'), json.dumps(sep.get('choice')))
    check('e1 ML separation running (engine ml)', sep.get('state') == 'on' and (sep.get('latency') or {}).get('engine') == 'ml', json.dumps(sep)[:200])
    d.switch_to.window(yt); shot('youtube-separate'); d.switch_to.window(popup_tab)
    # (e2) mix control: Preload Audio keeps the separated stems in memory and reports the peak of what plays (status.preload.playing.level)
    def status(): return ext(f"return await browser.tabs.sendMessage({tab}, {{type:'get-status'}})")
    def setmix(**kw):
        s.update(kw); ext(f"return await browser.runtime.sendMessage({{type:'set-tab-settings', tabId:{tab}, settings:{json.dumps(s)}}})")
    setmix(preload=True, vocalPct=100, instrumentalPct=100)
    ext(f"return await browser.tabs.sendMessage({tab}, {{type:'preload-start'}})")
    for _ in range(150):
        time.sleep(2); pre = status().get('preload') or {}
        if pre.get('state') in ('ready', 'error', 'cancelled'): break
    print('preload', json.dumps(pre)[:200])
    d.switch_to.window(yt); js("const v=document.querySelector('video');v.currentTime=1;v.play()"); d.switch_to.window(popup_tab)
    def level(**kw):
        setmix(**kw); time.sleep(1.5); m = 0
        for _ in range(6):
            time.sleep(0.5); m = max(m, ((status().get('preload') or {}).get('playing') or {}).get('level', 0))
        return m
    both, vonly, ionly, none = level(vocalPct=100, instrumentalPct=100), level(vocalPct=100, instrumentalPct=0), level(vocalPct=0, instrumentalPct=100), level(vocalPct=0, instrumentalPct=0)
    print('levels both/vocal-only/instr-only/none', both, vonly, ionly, none)
    check('e2 mix control changes output level', pre.get('state') == 'ready' and both > 0.02 and none < both * 0.2 and (vonly < both * 0.9 or ionly < both * 0.9), f'preload={pre.get("state")} levels={both:.3f}/{vonly:.3f}/{ionly:.3f}/{none:.3f}')

    if a.netlog:
        # (f) YouTube Music lyrics: source "YouTube Music", then read the Origin of the youtubei/v1/next request from the network log
        ext("await browser.storage.local.set({lyricsPrefs: {lyricsSource: 'ytm'}})")
        d.switch_to.new_window('window'); d.get(f'https://music.youtube.com/watch?v={a.ytm_video}'); time.sleep(8)
        js("const v=document.querySelector('video');if(v){v.play()}"); time.sleep(25); shot('ytm')
        log = ''.join(open(f, errors='replace').read() for f in sorted(glob.glob(NETLOG + '*')))
        import re
        reqs = [m.start() for m in re.finditer(r'youtubei/v1/next', log)]
        origins = set(); codes = set()
        for st0 in reqs:
            chunk = log[st0: st0 + 60000]
            origins.update(re.findall(r'\n[^\n]*Origin: (\S+)', chunk)[:2]); codes.update(re.findall(r'HTTP/[0-9.]+ (\d{3})', chunk)[:1])
        print('youtubei/v1/next requests', len(reqs), 'origins', origins, 'codes', codes)
        check('f YTM lyrics request: Origin is a web origin, not moz-extension, and answered 200', bool(reqs) and not any('moz-extension' in o for o in origins) and '200' in codes, f'n={len(reqs)} origins={origins} codes={codes}')
finally:
    json.dump(res, open(os.path.join(a.out, 'results.json'), 'w'))
    cleanup()
    print('leftover firefox pids', ff_pids())
sys.exit(0 if res and all(res.values()) else 1)
