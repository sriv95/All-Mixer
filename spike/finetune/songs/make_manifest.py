#!/usr/bin/env python3
"""Build manifest.tsv of extra CC full-length songs with vocals (no audio is downloaded here).

Sources: Song Describer Dataset (Zenodo 10072001, CC BY-SA 4.0 dataset; per-track CC licences in
audio_licenses.txt) + ccMixter API (per-upload license_url). Only BY, BY-SA, BY-NC, BY-NC-SA kept
(ND and other licences dropped); NC rows are flagged in column `nc` so the final call stays open.

Usage (stdlib only, run with python -I):
  make_manifest.py                  # fetch metadata into the cache, write manifest.tsv, print totals
  make_manifest.py --selftest       # validate manifest.tsv
  make_manifest.py --download N DIR # fetch N Song Describer tracks via HTTP Range from audio.zip into DIR
"""
import csv, json, os, re, struct, subprocess, sys, time, unicodedata, urllib.request, zipfile
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest.tsv")
# main checkout holds .cache (the worktree does not)
_common = subprocess.run(["git", "-C", HERE, "rev-parse", "--git-common-dir"], capture_output=True, text=True).stdout.strip()
MAIN = os.path.dirname(os.path.abspath(os.path.join(HERE, _common))) if _common else HERE
CACHE = os.environ.get("SONGS_CACHE", os.path.join(MAIN, ".cache/songs-test/meta"))
MUSDB_TEST = os.environ.get("MUSDB_TEST", os.path.join(MAIN, ".cache/musdb18hq/test"))
ALLOWED = ["BY", "BY-SA", "BY-NC", "BY-NC-SA"]
COLS = "id source title artist genre vocal_tag licence licence_url download_url est_bytes seconds nc allowed dl_ok".split()
ZEN = "https://zenodo.org/api/records/10072001/files/%s/content"
MTG = "https://raw.githubusercontent.com/MTG/mtg-jamendo-dataset/master/data/%s"
CC_API = "https://ccmixter.org/api/query?f=json&tags=remix,%s&limit=10&offset=%d&sort=rank"
CC_PAGES = 40  # per vocal tag; server returns nothing above ~60 KB, so 10 per page
CC_GENRES = {"rock", "pop", "electronic", "hip_hop", "jazz", "folk", "ambient", "blues", "classical", "country",
             "funky", "reggae", "dance", "metal", "punk", "soul", "r_b", "trip_hop", "house", "downtempo", "acoustic",
             "indie", "latin", "world", "techno", "drum_n_bass", "experimental", "lofi", "chill"}
CC_PER_GENRE = 80
VOCAL_RE = re.compile(r"\b(vocal|vocals|sing|singing|singer|voice|choir|rap|rapping|lyrics)\b", re.I)
NOVOC_RE = re.compile(r"\b(no|without|instrumental)\b[^.,]{0,15}\b(vocal|vocals|voice|singing|lyrics)\b|\binstrumental\b", re.I)


def get(url, name=None, retries=3):
    p = os.path.join(CACHE, name) if name else None
    if p and os.path.exists(p) and os.path.getsize(p):
        return open(p, encoding="utf-8").read()
    for i in range(retries):
        try:
            s = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "songs-manifest/1"}), timeout=60).read().decode("utf-8")
            if s.strip():
                break
        except Exception as e:
            s = ""
        time.sleep(2)
    if not s.strip():
        raise SystemExit("fetch failed: " + url)
    if p:
        os.makedirs(CACHE, exist_ok=True)
        open(p, "w", encoding="utf-8").write(s)
    return s


def lic_code(url):
    m = re.search(r"/licenses/([a-z-]+)/", url or "")
    return m.group(1).upper() if m else ""


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def musdb_overlap(artist, title, names):
    k = norm(artist + title)
    t = norm(title)
    for n in names:
        a, _, b = n.partition(" - ")
        na, nb = norm(a), norm(b)
        if k == na + nb or (len(nb) > 4 and nb == t and (na in norm(artist) or norm(artist) in na)):
            return True
    return False


class RangeFile:
    def __init__(self, url):
        self.url, self.pos = url, 0
        r = urllib.request.urlopen(urllib.request.Request(url, headers={"Range": "bytes=0-0"}))
        assert r.status == 206, "server has no Range support"
        self.size = int(r.headers["Content-Range"].split("/")[1])

    def seekable(self): return True
    def tell(self): return self.pos
    def seek(self, o, w=0):
        self.pos = o if w == 0 else self.pos + o if w == 1 else self.size + o
        return self.pos

    def read(self, n=-1):
        end = self.size if n < 0 else min(self.size, self.pos + n)
        if self.pos >= end: return b""
        r = urllib.request.urlopen(urllib.request.Request(self.url, headers={"Range": "bytes=%d-%d" % (self.pos, end - 1)}))
        d = r.read(); self.pos += len(d); return d


def sd_rows(names):
    meta = {r[0]: r for r in csv.reader(get(ZEN % "audio_metadata.tsv", "audio_metadata.tsv").splitlines(), delimiter="\t")}
    tags = {}
    for r in csv.reader(get(ZEN % "song_describer_14_04_23.mtg-jamendo.tsv", "sd_mtg.tsv").splitlines(), delimiter="\t"):
        if r[0].startswith("track_"): tags[r[0]] = r
    voice = {l.split("\t")[0] for l in get(MTG % "autotagging_instrument.tsv", "autotagging_instrument.tsv").splitlines() if "instrument---voice" in l}
    caps = {}
    for r in csv.DictReader(get(ZEN % "song_describer.csv", "song_describer.csv").splitlines()):
        caps.setdefault("track_%07d" % int(r["track_id"]), []).append(r["caption"])
    lic = {}
    for blk in get(ZEN % "audio_licenses.txt", "audio_licenses.txt").split("\n--\n"):
        ls = [l for l in blk.strip().splitlines() if l]
        if len(ls) >= 3:
            lic[ls[0].strip()] = re.search(r"https?://\S+", ls[-1]).group(0)
    # audio.zip holds 2-minute crops (<id>.2min.mp3), not full tracks; sizes come from the zip directory
    zi = {os.path.basename(i.filename).split(".")[0]: i for i in zipfile.ZipFile(RangeFile(ZEN % "audio.zip")).infolist() if not i.is_dir()}
    rows, drop, ovl = [], Counter(), 0
    for tid, m in meta.items():
        t = tags[tid]; path = t[3]
        url = lic.get(path, ""); code = lic_code(url)
        title, artist = m[3], m[4]
        genre = ",".join(x.split("---")[1] for x in t[5:] if x.startswith("genre---")) or "unknown"
        if tid in voice: vt = "mtg:voice"
        elif any(VOCAL_RE.search(c) and not NOVOC_RE.search(c) for c in caps.get(tid, [])): vt = "caption"
        else: continue
        if code not in ALLOWED: drop[code or "none"] += 1; continue
        if musdb_overlap(artist, title, names): ovl += 1; continue
        rows.append(dict(id="sd_" + tid[6:], source="songdescriber", title=title, artist=artist, genre=genre, vocal_tag=vt,
                         licence=code, licence_url=url, download_url="zip:" + zi[tid[6:].lstrip("0")].filename, est_bytes=zi[tid[6:].lstrip("0")].file_size, seconds=min(120, float(t[4])), nc=int("NC" in code), allowed=1, dl_ok="unknown"))
    return rows, drop, ovl


def cc_rows(names):
    seen, rows, drop, ovl, gcount = set(), [], Counter(), 0, Counter()
    for tag in ("female_vocals", "male_vocals"):
        for pg in range(CC_PAGES):
            try:
                d = json.loads(get(CC_API % (tag, pg * 10), "cc_%s_%d.json" % (tag, pg)))
            except SystemExit:
                break
            for u in d:
                if u["upload_id"] in seen: continue
                seen.add(u["upload_id"])
                tg = set(u["upload_tags"].strip(",").split(","))
                code = lic_code(u["license_url"])
                f = next((f for f in u["files"] if f["file_nicname"] == "mp3"), None)
                if not f or "acappella" in tg: continue
                mm, _, ss = f["file_format_info"].get("ps", "0:0").partition(":")
                sec = int(mm) * 60 + int(ss or 0) if mm.isdigit() and (ss or "0").isdigit() else 0
                if not 90 <= sec <= 720: continue
                if code not in ALLOWED: drop[code or "none"] += 1; continue
                g = sorted(tg & CC_GENRES) or ["unknown"]
                if gcount[g[0]] >= CC_PER_GENRE: continue
                if musdb_overlap(u["user_real_name"], u["upload_name"], names): ovl += 1; continue
                gcount[g[0]] += 1
                rows.append(dict(id="cc_%d" % u["upload_id"], source="ccmixter", title=u["upload_name"], artist=u["user_real_name"], genre=",".join(g),
                                 vocal_tag=tag, licence=code, licence_url=u["license_url"], download_url=f["download_url"],
                                 est_bytes=f["file_rawsize"], seconds=sec, nc=int("NC" in code), allowed=1, dl_ok="blocked"))  # ccmixter direct downloads 403 for non-browser clients
    return rows, drop, ovl


def write_and_print(rows):
    with open(MANIFEST, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, COLS, delimiter="\t", lineterminator="\n"); w.writeheader(); w.writerows(rows)
    secs = sum(float(r["seconds"] or 0) for r in rows); size = sum(int(r["est_bytes"] or 0) for r in rows)
    print("tracks", len(rows), "hours %.1f" % (secs / 3600), "est_GB(known sizes only) %.2f" % (size / 1e9))
    print("per source", dict(Counter(r["source"] for r in rows)))
    print("per licence", dict(Counter(r["licence"] for r in rows)))
    print("per genre (top)", Counter(r["genre"].split(",")[0] for r in rows).most_common(12))


def selftest():
    names = os.listdir(MUSDB_TEST)
    rows = list(csv.DictReader(open(MANIFEST, encoding="utf-8"), delimiter="\t"))
    assert rows and list(rows[0]) == COLS, "bad header"
    assert len({r["id"] for r in rows}) == len(rows), "duplicate ids"
    for r in rows:
        assert r["licence"] in ALLOWED and r["licence_url"], r["id"]
        assert r["allowed"] == "1" and r["nc"] == str(int("NC" in r["licence"])), r["id"]
        assert not musdb_overlap(r["artist"], r["title"], names), "MUSDB overlap " + r["id"]
    print("selftest ok:", len(rows), "tracks,", len(names), "musdb test names")


def download(n, out):
    os.makedirs(out, exist_ok=True)
    zf = zipfile.ZipFile(RangeFile(ZEN % "audio.zip"))
    idx = {i.filename: i for i in zf.infolist() if not i.is_dir()}
    rows = [r for r in csv.DictReader(open(MANIFEST, encoding="utf-8"), delimiter="\t") if r["source"] == "songdescriber"]
    for r in rows[:n]:
        zi = idx[r["download_url"][4:]]
        dst = os.path.join(out, r["id"] + ".mp3")
        open(dst, "wb").write(zf.read(zi)); print(dst, zi.file_size)


def main():
    if "--selftest" in sys.argv: return selftest()
    if "--download" in sys.argv:
        i = sys.argv.index("--download"); return download(int(sys.argv[i + 1]), sys.argv[i + 2])
    names = os.listdir(MUSDB_TEST)
    a, da, oa = sd_rows(names); b, db, ob = cc_rows(names)
    print("songdescriber vocal+allowed", len(a), "dropped licences", dict(da), "musdb excluded", oa)
    print("ccmixter allowed", len(b), "dropped licences", dict(db), "musdb excluded", ob)
    write_and_print(a + b)


if __name__ == "__main__":
    main()
