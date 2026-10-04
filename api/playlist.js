// Playlist reader for Songdle (a Vercel function): turns a public Spotify, Apple Music or YouTube Music playlist or album
// link into songs. Browsers can't read those pages themselves (no CORS), so the game asks this instead.
//   GET /api/playlist?url=<link>  ->  {id, name, source, songs:[{t,a,i,c}]}   (songs have the same fields as playlists.json)
// Spotify pages list up to 100 songs. Apple Music songs come with their catalogue ID, which is also their iTunes ID,
// so the game can fetch their clips with an exact lookup (the only iTunes call that works on iPhones).
// YouTube sends page requests from servers to a bot check, so YouTube Music uses the YouTube Data API instead
// (env YOUTUBE_API_KEY; 1 unit of the 10,000/day free quota per 50 songs), up to 200 songs.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const SPOTIFY = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?|spotify:)(playlist|album)[/:]([A-Za-z0-9]{22})/;
const APPLE = /music\.apple\.com\/([a-z]{2})\/(playlist|album)\/(?:([^/?#\s]+)\/)?((?:pl\.)?[\w.-]+)/;
const SHORT = /https?:\/\/(?:spotify\.link|spoti\.fi|apple\.co)\/[^\s"'<>]+/;
// youtube.com / music.youtube.com / youtu.be links with ?list=…, or music.youtube.com/browse/VL…
const YOUTUBE = /(?:youtube\.com|youtu\.be)(?:\/[^\s]*?[?&]list=|\/browse\/VL)([\w-]+)/;

class Shown extends Error { constructor(status, msg) { super(msg); this.status = status } }

async function page(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" });
  if (r.status === 404) throw new Shown(404, "That playlist wasn't found. Check the link is complete and the playlist is public.");
  if (!r.ok) throw new Error(url + " answered " + r.status);
  return { url: r.url, html: await r.text() };
}

const script = (html, attrs) => {
  const m = html.match(new RegExp("<script " + attrs + ">([\\s\\S]*?)</script>"));
  return m ? JSON.parse(m[1]) : null;
};

async function spotify(type, id) {
  const { html } = await page(`https://open.spotify.com/embed/${type}/${id}`);
  const data = script(html, 'id="__NEXT_DATA__" type="application/json"');
  const e = data && data.props && data.props.pageProps && data.props.pageProps.state && data.props.pageProps.state.data && data.props.pageProps.state.data.entity;
  if (!e) throw new Shown(404, "That playlist wasn't found. Check the playlist is public (in Spotify: ••• → Add to profile).");
  if (!Array.isArray(e.trackList)) throw new Error("Spotify page has no trackList");
  const songs = e.trackList.filter(x => x.title && x.subtitle && x.entityType !== "episode").map(x => ({ t: x.title, a: x.subtitle.replace(/\u00a0/g, " ") }));
  return { id: `spotify:${type}:${id}`, name: e.name || e.title || "Spotify playlist", source: "Spotify", songs };
}

async function apple(cc, type, slug, id) {
  const { html } = await page(`https://music.apple.com/${cc}/${type}/${slug ? slug + "/" : ""}${id}`);
  const data = script(html, 'type="application/json" id="serialized-server-data"');
  const sections = data && data.data && data.data[0] && data.data[0].data && data.data[0].data.sections;
  if (!Array.isArray(sections)) throw new Error("Apple Music page has no sections");
  const head = (sections.find(s => /HeaderLockup$/.test(s.itemKind || "")) || { items: [] }).items[0] || {};
  const list = sections.find(s => s.itemKind === "trackLockup");
  if (!list) throw new Shown(404, "No songs found on that page. Check it's a playlist or album link.");
  // Album tracks only name the artist when it differs from the album's
  const albumArtist = (head.subtitleLinks || []).map(x => x.title).join(", ");
  const c = cc.toUpperCase() === "US" ? undefined : cc.toUpperCase();
  const songs = list.items.map(x => {
    const ids = x.contentDescriptor && x.contentDescriptor.identifiers;
    const a = (x.subtitleLinks || []).map(l => l.title).filter(Boolean).join(", ") || albumArtist;
    const song = { t: x.title, a };
    if (ids && +ids.storeAdamID) { song.i = +ids.storeAdamID; if (c) song.c = c }
    return song;
  }).filter(x => x.t && x.a);
  return { id: `apple:${type}:${id}`, name: head.title || "Apple Music playlist", source: "Apple Music", songs };
}

// Words in brackets that only describe the video: "(Official Video)", "[Lyrics]", "(Visualizer)", "(4K Remaster)"…
const TAGS = /\s*[(\[][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(ed)?|m\/?v)\b[^)\]]*[)\]]|\s+\|.*$/gi;

// A playlist item as {t, a}. Songs added in YouTube Music are mostly "Artist - Topic" uploads named just after the song;
// music videos are usually called "Artist - Song (Official Video)".
function youtubeSong(sn) {
  const owner = sn.videoOwnerChannelTitle || "";
  if (!owner) return null;                                           // deleted or private video
  if (/ - Topic$/.test(owner)) return { t: sn.title, a: owner.replace(/ - Topic$/, "") };
  let t = sn.title.replace(TAGS, "").trim();
  let a = /VEVO$/.test(owner) ? owner.replace(/VEVO$/, "").replace(/([a-z])([A-Z])/g, "$1 $2") : owner.replace(/\s*-?\s*(official|music)$/i, "");
  // "Artist - Song", or "Song - Artist" when the channel's own name is in the second half
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/), squash = x => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""), o = squash(a);
  if (m) [a, t] = o && squash(m[2]).includes(o) && !squash(m[1]).includes(o) ? [m[2], m[1]] : [m[1], m[2]];
  t = t.replace(/^["“]|["”]$/g, "").trim();
  // "Song ft. Singer" (no brackets): the game matches titles without it, so the singer joins the artist instead
  const ft = t.match(/^(.+?)\s+(?:ft|feat)\.?\s+(.+)$/i);
  if (ft) { t = ft[1]; a = a.trim() + ", " + ft[2] }
  return t && a ? { t, a: a.trim() } : null;
}

async function youtubeApi(what, params) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${what}?` + new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY }));
  const d = await r.json().catch(() => ({}));
  if (r.status === 404) throw new Shown(404, "That playlist wasn't found. In YouTube Music, check it's set to Public or Unlisted (not Private).");
  if (!r.ok) throw new Error("YouTube API " + r.status + " " + JSON.stringify(d.error && d.error.errors && d.error.errors[0]));
  return d;
}

async function youtube(list) {
  if (!process.env.YOUTUBE_API_KEY) throw new Shown(503, "YouTube Music links aren't switched on yet.");
  if (list === "LM" || list === "LL") throw new Shown(400, "Liked songs are private. Put them in a playlist, set it to Public or Unlisted, and share that.");
  if (/^RD/.test(list)) throw new Shown(400, "That's a mix made up on the spot, which can't be read. Save the songs to a playlist and share that.");
  const meta = await youtubeApi("playlists", { part: "snippet", id: list });
  if (!(meta.items || []).length) throw new Shown(404, "That playlist wasn't found. In YouTube Music, check it's set to Public or Unlisted (not Private).");
  const songs = [];
  for (let page = "", n = 0; n < 4; n++) {
    const d = await youtubeApi("playlistItems", { part: "snippet", playlistId: list, maxResults: 50, ...(page && { pageToken: page }) });
    for (const it of d.items || []) { const s = youtubeSong(it.snippet); if (s) songs.push(s) }
    if (!(page = d.nextPageToken)) break;
  }
  const name = meta.items[0].snippet.title.replace(/^Album - /, "") || "YouTube Music playlist";
  return { id: `youtube:${list}`, name, source: "YouTube Music", songs };
}

async function read(text) {
  let link = String(text || "").trim(), m;
  // Share sheets sometimes give a short link (or the link inside a sentence): follow it to the real page
  if (!SPOTIFY.test(link) && !APPLE.test(link) && (m = link.match(SHORT))) {
    const { url, html } = await page(m[0]);
    link = SPOTIFY.test(url) || APPLE.test(url) ? url : html;
  }
  if ((m = link.match(SPOTIFY))) return spotify(m[1], m[2]);
  if ((m = link.match(APPLE))) return apple(m[1], m[2], m[3], m[4]);
  if ((m = link.match(YOUTUBE))) return youtube(m[1]);
  if (/music\.youtube\.com\/browse\/MPRE/.test(link)) throw new Shown(400, "For an album, open it and use ⋮ → Share → Copy link, then paste that.");
  throw new Shown(400, "That doesn't look like a Spotify, Apple Music or YouTube Music playlist link.");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const out = await read(req.query.url);
    if (!out.songs.length) throw new Shown(404, "No songs found. Check the playlist is public and has songs in it.");
    res.setHeader("Cache-Control", "public, s-maxage=600");
    res.status(200).send(JSON.stringify(out));
  } catch (e) {
    if (!e.status) console.error(req.query.url, e);
    res.status(e.status || 502).send(JSON.stringify({ error: e.status ? e.message : "Couldn't read that playlist just now. Please try again in a minute." }));
  }
};
module.exports.read = read;
module.exports.youtubeSong = youtubeSong;
