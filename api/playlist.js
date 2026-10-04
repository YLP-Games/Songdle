// Playlist reader for Songdle (a Vercel function): turns a public Spotify or Apple Music playlist or album link into songs.
// Browsers can't read those pages themselves (no CORS), so the game asks this instead.
//   GET /api/playlist?url=<link>  ->  {id, name, source, songs:[{t,a,i,c}]}   (songs have the same fields as playlists.json)
// Spotify pages list up to 100 songs. Apple Music songs come with their catalogue ID, which is also their iTunes ID,
// so the game can fetch their clips with an exact lookup (the only iTunes call that works on iPhones).

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const SPOTIFY = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?|spotify:)(playlist|album)[/:]([A-Za-z0-9]{22})/;
const APPLE = /music\.apple\.com\/([a-z]{2})\/(playlist|album)\/(?:([^/?#\s]+)\/)?((?:pl\.)?[\w.-]+)/;
const SHORT = /https?:\/\/(?:spotify\.link|spoti\.fi|apple\.co)\/[^\s"'<>]+/;

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
  const songs = e.trackList.filter(x => x.title && x.subtitle && x.entityType !== "episode").map(x => ({ t: x.title, a: x.subtitle }));
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

async function read(text) {
  let link = String(text || "").trim(), m;
  // Share sheets sometimes give a short link (or the link inside a sentence): follow it to the real page
  if (!SPOTIFY.test(link) && !APPLE.test(link) && (m = link.match(SHORT))) {
    const { url, html } = await page(m[0]);
    link = SPOTIFY.test(url) || APPLE.test(url) ? url : html;
  }
  if ((m = link.match(SPOTIFY))) return spotify(m[1], m[2]);
  if ((m = link.match(APPLE))) return apple(m[1], m[2], m[3], m[4]);
  throw new Shown(400, "That doesn't look like a Spotify or Apple Music playlist link.");
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
