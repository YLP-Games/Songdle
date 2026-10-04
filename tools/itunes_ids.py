#!/usr/bin/env python3
"""Add iTunes track IDs (and original release years) to playlists.json.

Songdle can then fetch each song's preview with one exact lookup by ID instead of a fuzzy
search, and doesn't need extra searches to correct years while you play.

    python3 tools/itunes_ids.py                      # songs without an "i" yet
    python3 tools/itunes_ids.py --retry-missing      # also retry songs marked "i":0 (not found before)
    python3 tools/itunes_ids.py --hints albums.json  # [[title, artist, album, seconds], ...] to pick the exact recording

Fields written per song: "i" = iTunes track ID (0 if not found), "c" = "GB" when it was only in the UK store,
"y" = earliest release year of that recording (only ever lowered or filled in, never raised).

Songs are looked up through each artist's own catalogue (an artist search, then one lookup for up to 200 of
their songs), which is far more reliable than song search: that buries real tracks under covers and type beats.
Anything not found that way (e.g. a song filed under a featured artist) falls back to song search.
"""
import argparse, json, re, sys, time, threading, unicodedata, urllib.parse, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

ROOT = __file__.rsplit("/tools/", 1)[0]
PLAYLISTS = ROOT + "/playlists.json"

# Same matching rules as songKey / mainArtist in index.html (copied from Yahyadle)
VARIANT = re.compile(r"\b(remix|edit|mix|version|slowed|sped|nightcore|live|acoustic|instrumental|cover|karaoke|rework|bootleg|vip|flip|mashup)\b", re.I)
SPLIT = r"\s*(?:&|,|;|\bx\b|\bfeat\.?|\bft\.?|\bwith\b|\band\b)\s*"

def norm(x):
    x = unicodedata.normalize("NFKD", str(x or ""))
    return "".join(c for c in x if not unicodedata.combining(c)).lower()

def squash(x):
    return re.sub(r"[\W_]+", " ", x).strip()

def title_key(t):
    t = norm(t)
    t = re.sub(r"\s*[(\[][^)\]]*\b(feat|ft|with|remaster(ed)?|explicit|clean|radio edit|single version|album version)\b[^)\]]*[)\]]", "", t)
    t = re.sub(r"\s+-\s+.*\b(remaster(ed)?|radio edit|single version|album version|explicit)\b.*$", "", t)
    t = re.sub(r"\s+(feat|ft)\.?\s.*$", "", t)
    return squash(t)

def loose_title(t):
    """Title with every bracketed part and " - …" tail removed, for when the exact title differs between
    services (e.g. "California Love - Original Version", "Pull Up N Wreck (& Metro Boomin)")."""
    t = re.sub(r"\s*[(\[][^)\]]*[)\]]", "", norm(t))
    return squash(re.sub(r"\s+-\s+.*$", "", t))

def artists(a):
    return [k for k in (squash(re.sub(r"^the\s+", "", p.strip())) for p in re.split(SPLIT, norm(a))) if k]

def main_artist(a):
    s = artists(a)
    return s[0] if s else squash(norm(a))

def main_artist_raw(a):
    return re.split(SPLIT, str(a or ""))[0].strip()

def search_title(t):
    # Drop "(feat. …)" and "- Remastered" style tails; they only confuse the search
    t = re.sub(r"\s*[(\[][^)\]]*\b(feat|ft|with)\b[^)\]]*[)\]]", "", t, flags=re.I)
    return re.sub(r"\s+-\s+.*\bremaster(ed)?\b.*$", "", t, flags=re.I).strip()

_lock = threading.Lock()
_pause_until = [0.0]
_next_slot = [0.0]
_interval = [1.0]   # seconds between requests; Apple throttles bursts, so keep a steady pace and slow down if told to

def _wait_turn():
    with _lock:
        now = time.time()
        slot = max(now, _next_slot[0], _pause_until[0])
        _next_slot[0] = slot + _interval[0]
    if slot > now:
        time.sleep(slot - now)

def itunes(params, endpoint="search"):
    url = f"https://itunes.apple.com/{endpoint}?" + urllib.parse.urlencode(params)
    for attempt in range(8):
        _wait_turn()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Songdle playlist tool"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r).get("results", [])
        except urllib.error.HTTPError as e:
            if e.code in (403, 429, 500, 502, 503):
                with _lock:  # throttled: everyone pauses, and the pace slows for the rest of the run
                    _pause_until[0] = max(_pause_until[0], time.time() + 60)
                    _interval[0] = min(_interval[0] + 0.5, 5)
                print(f"  iTunes said {e.code}; pausing a minute, now one request every {_interval[0]:.1f}s", flush=True)
                continue
            raise
        except Exception:
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("iTunes kept refusing: " + url)

def candidates(results, t, a, loose=False):
    """Results that are this song: same title (ignoring feat./remaster tags) by an artist credited on it.
    With loose=True, titles only have to match once brackets and " - …" tails are dropped."""
    key = loose_title if loose else title_key
    tk, ma = key(t), main_artist(a)
    own_variant = bool(VARIANT.search(t))
    out = []
    for r in results:
        if r.get("kind") != "song" or not tk or key(r.get("trackName", "")) != tk:
            continue
        if ma and ma not in artists(r.get("artistName", "")):
            continue
        r["_variant"] = bool(VARIANT.search(r.get("trackName", ""))) and not own_variant
        out.append(r)
    return out

def strip_release(x):
    return norm(re.sub(r"\s+-\s+(single|ep)$", "", x or "", flags=re.I))

def best(cands, t, hint):
    """The version to play: same album/length as the playlist copy if known, not a remix, not a compilation."""
    def score(r):
        s = 0
        if hint:
            if strip_release(r.get("collectionName")) == strip_release(hint[0]):
                s -= 4
            if hint[1] and abs(r.get("trackTimeMillis", 0) / 1000 - hint[1]) <= 2:
                s -= 4
        if r["_variant"]:
            s += 6
        if norm(r.get("trackName", "")) == norm(t):
            s -= 2
        if (r.get("collectionArtistName") or "").lower() == "various artists":
            s += 1
        return (s, r.get("releaseDate", "9999"))
    ok = [r for r in cands if r.get("previewUrl")]
    return min(ok, key=score) if ok else None

def earliest(cands):
    years = [int(r["releaseDate"][:4]) for r in cands if r.get("releaseDate") and not r["_variant"]]
    return min(years) if years else 0

def search_song(t, a, hint):
    """Last resort: plain song search with the full credit, US then UK."""
    for country in ("US", "GB"):
        found = itunes({"term": f"{main_artist_raw(a)} {loose_title(t) or search_title(t)}", "media": "music", "entity": "song", "limit": 50, "country": country})
        res = candidates(found, t, a) or candidates(found, t, a, loose=True)
        pick = best(res, t, hint)
        if pick:
            return pick["trackId"], country, earliest(res)
    return 0, None, 0

def artist_catalogues(name, country):
    """Up to 200 songs each from up to 3 artists with exactly this name: the artist's own catalogue (artist search,
    then a lookup by artist ID) is far more reliable than song or artist-term search, which are full of covers and karaoke."""
    want = main_artist(name)
    found = [r for r in itunes({"term": main_artist_raw(name), "entity": "musicArtist", "limit": 10, "country": country})
             if main_artist(r.get("artistName", "")) == want][:3]
    for r in found:
        yield [x for x in itunes({"id": r["artistId"], "entity": "song", "limit": 200, "country": country}, "lookup")
               if x.get("wrapperType") == "track"]

def resolve_artist(name, songs, hints):
    """songs: [(key, song)] by one main artist. Returns {key: (trackId, country, year)}."""
    out, left = {}, dict(songs)
    for country in ("US", "GB"):            # UK store only for what the US one doesn't have
        for catalogue in artist_catalogues(name, country):
            for key, s in list(left.items()):
                cands = candidates(catalogue, s["t"], s["a"]) or candidates(catalogue, s["t"], s["a"], loose=True)
                pick = best(cands, s["t"], hints.get(key))
                if pick:
                    out[key] = (pick["trackId"], country, earliest(cands))
                    del left[key]
            if not left:
                return out
    for key, s in list(left.items()):
        alias = re.search(r"\(([^)]+)\)\s*$", s["a"])  # "Olly Alexander (Years & Years)": Apple files these under the alias
        if alias:
            for catalogue in artist_catalogues(alias.group(1), "US"):
                pick = best(candidates(catalogue, s["t"], alias.group(1)), s["t"], hints.get(key))
                if pick:
                    out[key] = (pick["trackId"], "US", earliest(candidates(catalogue, s["t"], alias.group(1))))
                    del left[key]
                    break
    for key, s in left.items():             # e.g. songs filed under a featured artist
        out[key] = search_song(s["t"], s["a"], hints.get(key))
    return out

def save(data):
    parts = []
    for who, songs in data.items():
        rows = ",\n".join("  " + json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in songs)
        parts.append(f'"{who}":[\n{rows}\n]')
    with open(PLAYLISTS, "w") as f:
        f.write("{" + ",\n".join(parts) + "}\n")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--retry-missing", action="store_true")
    ap.add_argument("--hints")
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    data = json.load(open(PLAYLISTS))
    hints = {}
    if args.hints:
        for t, a, album, secs in json.load(open(args.hints)):
            hints.setdefault((title_key(t), main_artist(a)), (album, secs))

    todo = {}   # (title key, main artist) -> every copy of that song (it can be on both playlists)
    for who, songs in data.items():
        for s in songs:
            if "i" in s and not (args.retry_missing and not s["i"]):
                continue
            todo.setdefault((title_key(s["t"]), main_artist(s["a"])), []).append(s)
    by_artist = {}
    for key, copies in todo.items():
        by_artist.setdefault(key[1], []).append((key, copies[0]))
    print(f"{sum(len(v) for v in todo.values())} songs to look up ({len(todo)} unique, {len(by_artist)} artists)", flush=True)

    done, found = [0], [0]

    def work(item):
        _, songs = item
        try:
            res = resolve_artist(songs[0][1]["a"], songs, hints)
        except Exception as e:
            print("  error:", songs[0][1]["a"], e, flush=True)
            return
        with _lock:
            for key, (tid, country, year) in res.items():
                for s in todo[key]:
                    s["i"] = tid
                    if country == "GB":
                        s["c"] = "GB"
                    if year >= 1950 and (not s.get("y") or (year < s["y"] and s["y"] - year <= 40)):
                        s["y"] = year
            done[0] += 1
            found[0] += sum(1 for v in res.values() if v[0])
            if done[0] % 50 == 0:
                print(f"  {done[0]}/{len(by_artist)} artists, {found[0]} songs found", flush=True)
                save(data)

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(work, by_artist.items()))
    save(data)
    total = sum(len(v) for v in data.values())
    have = sum(1 for v in data.values() for s in v if s.get("i"))
    print(f"done: {have}/{total} songs have an iTunes ID", flush=True)

if __name__ == "__main__":
    sys.exit(main())
