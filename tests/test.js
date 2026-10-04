// Playwright checks for Songdle. Run: node tests/test.js  (serves the repo on :8123)
// Headless Chromium can't play AAC, so iTunes is stubbed with page.route and every preview is a WAV tone.
const { chromium, devices } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), WAV = fs.readFileSync(path.join(__dirname, "tone.wav"));
const SONGS = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "playlists.json")))).flat();
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

async function stub(page, opts = {}) {
  await page.route("https://itunes.apple.com/**", route => {
    const u = new URL(route.request().url()), cb = u.searchParams.get("callback");
    // Like the real thing: iPhones and iPads get sent to the Music app instead of search results
    if (u.pathname === "/search" && /iPhone|iPad|iPod/.test(route.request().headers()["user-agent"]))
      return route.fulfill({ status: 301, headers: { location: "musics://mzstoreservices-st.itunes.apple.com" + u.pathname + u.search } });
    const id = u.searchParams.get("id"), term = u.searchParams.get("term") || "";
    let results = [];
    const noPreview = opts.noPreview && opts.noPreview(id, term);
    if (!noPreview) {
      if (id && opts.lookup) results = opts.lookup(id.split(","));
      else if (id) results = [{ trackName: "X", artistName: "X", previewUrl: "https://audio.test/" + id + ".wav", artworkUrl100: "" }];
      else if (opts.search) results = opts.search(term);
      else { const r = SONGS.find(x => x.a + " " + x.t === term); if (r) results = [{ trackName: r.t, artistName: r.a, previewUrl: "https://audio.test/s.wav", releaseDate: r.y + "-01-01" }]; }
    }
    route.fulfill({ contentType: "text/javascript", body: `${cb}(${JSON.stringify({ results })})` });
  });
  // Deezer: search answers with the song asked for (or opts.deezer), albums with opts.albumYear
  await page.route("https://api.deezer.com/**", route => {
    const u = new URL(route.request().url()), cb = u.searchParams.get("callback"), q = u.searchParams.get("q") || "";
    let body = { data: [] };
    if (u.pathname.startsWith("/album/")) body = { id: +u.pathname.split("/")[2], release_date: (opts.albumYear || 2001) + "-05-01" };
    else if (opts.noPreview && opts.noPreview(null, q)) body = { data: [] };
    else if (opts.deezer) body = { data: opts.deezer(q) };
    else { const r = [...SONGS, ...(opts.extra || [])].find(x => x.a + " " + x.t === q);
      if (r) body = { data: [{ id: 1, title: r.t, artist: { name: r.a }, album: { id: 7, title: "Album", cover_medium: "" }, preview: "https://audio.test/dz.wav", link: "https://www.deezer.com/track/1", readable: true }] }; }
    route.fulfill({ contentType: "text/javascript", body: `${cb}(${JSON.stringify(body)})` });
  });
  // The playlist reader (api/playlist.js)
  await page.route(/\/api\/playlist\?/, route => {
    const link = new URL(route.request().url()).searchParams.get("url");
    const r = opts.playlist ? opts.playlist(link) : { status: 400, body: { error: "That doesn't look like a Spotify or Apple Music playlist link." } };
    route.fulfill({ status: r.status || 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(r.body || r) });
  });
  // Answer byte ranges like a real CDN, so the player can seek
  await page.route("https://audio.test/**", r => {
    const m = /bytes=(\d+)-(\d*)/.exec(r.request().headers()["range"] || "");
    if (!m) return r.fulfill({ contentType: "audio/wav", headers: { "accept-ranges": "bytes" }, body: WAV });
    const s = +m[1], e = m[2] ? +m[2] : WAV.length - 1;
    r.fulfill({ status: 206, contentType: "audio/wav", headers: { "accept-ranges": "bytes", "content-range": `bytes ${s}-${e}/${WAV.length}` }, body: WAV.subarray(s, e + 1) });
  });
}

(async () => {
  const srv = spawn("python3", ["-m", "http.server", "8123"], { cwd: ROOT, stdio: "ignore" });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    // ---------- Main game on desktop ----------
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errs = []; page.on("pageerror", e => errs.push(e.message));
    await stub(page);
    await page.goto("http://localhost:8123/");
    ok(await page.isVisible("#how"), "How to play shows on first visit");
    await page.click("#how-ok");
    await page.waitForSelector("#play:not([disabled])", { timeout: 8000 });
    ok(true, "Play button becomes ready");
    const t = await page.evaluate(() => round.target);
    ok(await page.evaluate(() => songSource().length) > 500, "Charts list loaded");
    await page.click("#play");
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => audio && audio.paused), "0.1s clip stops by itself");
    // Skip while playing: the music keeps going from the same spot into the longer clip
    await page.click("#skip");
    await page.waitForSelector("#play:not([disabled])");
    await page.click("#play"); await page.waitForTimeout(250);
    const before = await page.evaluate(() => audio.currentTime);
    await page.click("#skip");
    await page.waitForTimeout(150);
    const flow = await page.evaluate(() => ({ playing: !audio.paused, t: audio.currentTime, limit: ctx.limit }));
    ok(flow.playing && flow.t >= before && flow.limit === 2, "Skip while playing keeps the song going into the 2s clip (" + JSON.stringify(flow) + ")");
    await page.waitForTimeout(2200);
    const ended = await page.evaluate(() => ({ paused: audio.paused, t: audio.currentTime, lim: ctx.limit, g: round.guesses.length, timer, carry }));
    ok(ended.paused && ended.t < 2.4, "It still stops at the end of the longer clip");
    await page.click("#skip");
    const pos = await page.evaluate(() => round.pos);
    ok(pos > 1.9, "Skip while paused keeps the spot (" + pos.toFixed(2) + "s)");
    await page.click("#play"); await page.waitForTimeout(300);
    const cont = await page.evaluate(() => ({ p: !audio.paused, t: audio.currentTime, pos: round.pos, lim: ctx.limit, en: document.querySelector("#play").disabled }));
    ok(cont.p && cont.t > 2, "Play then carries on into the new part " + JSON.stringify(cont));
    await page.evaluate(() => stop());
    ok((await page.textContent(".left")).includes("2 guesses"), "Skip uses a try");
    ok((await page.textContent(".sg-row")).includes("Skipped"), "Skipped row shown");
    // Wrong guess: pick a song by a different artist
    const wrong = await page.evaluate(k => songSource().find(x => x.k !== k && mainArtist(x.a) !== mainArtist(round.target.a) && x.y && x.y !== round.target.y), t.k);
    await page.fill("#guess", wrong.t);
    await page.waitForSelector("#sugg li[data-i]");
    const idx = await page.$$eval("#sugg li[data-i]", (ls, w) => ls.findIndex(l => l.textContent === w.t + w.a), wrong);
    await page.click(`#sugg li[data-i="${Math.max(0, idx)}"]`);
    const cells = await page.$$eval(".sg-row:first-child span", s => s.map(x => x.className + ":" + x.textContent));
    ok(cells[0].startsWith("miss") && cells.length === 3, "Wrong guess shows Song/Artist/Year boxes: " + cells.join(" | "));
    ok(/▲|▼/.test(cells[2]) && ((t.y > wrong.y) === cells[2].includes("▲")), "Year arrow points the right way");
    // Correct guess
    await page.fill("#guess", t.t);
    await page.waitForSelector("#sugg li[data-i]");
    const ci = await page.$$eval("#sugg li[data-i]", (ls, w) => ls.findIndex(l => l.textContent === w.t + w.a), t);
    ok(ci >= 0, "Answer appears in the dropdown");
    await page.click(`#sugg li[data-i="${ci}"]`);
    await page.waitForSelector(".win");
    ok((await page.getAttribute(".win","class"))==="win", "Win screen shows");
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => audio && !audio.paused), "Full preview autoplays after a win");
    ok((await page.textContent(".chips")).includes("Streak 1"), "Streak counts the win");
    ok(await page.$eval("#lk-am", a => a.href.startsWith("https://audio.test") || a.href.includes("music.apple.com")) && (await page.getAttribute(".sg-links a:last-child", "href")).startsWith("https://open.spotify.com/search/"), "Win card links to Apple Music and Spotify");
    await page.click("#next");
    await page.waitForSelector("#play:not([disabled])");
    ok((await page.textContent(".prev")).includes(t.t), "Next song deals a new round");
    await page.click("#giveup");
    ok((await page.getAttribute(".win","class")).includes("lose") && (await page.textContent(".chips")).includes("Streak 0") && (await page.textContent(".chips")).includes("Best 1"), "Give up shows answer and resets streak");
    // Volume remembered
    await page.$eval("#vol", e => { e.value = 35; e.dispatchEvent(new Event("input")) });
    // Era filter
    await page.selectOption("#era", "2010s");
    await page.waitForSelector("#play:not([disabled])");
    const y = await page.evaluate(() => round.target.y);
    ok(y >= 2010 && y <= 2019, "Era filter picks a 2010s song (" + y + ")");
    // Artist colours
    const ac = await page.evaluate(() => [
      artistMatch({ t: "a", a: "Kendrick Lamar & SZA" }, { t: "b", a: "SZA" }),
      artistMatch({ t: "a", a: "Beyoncé" }, { t: "b", a: "Beyonce & Jay-Z" }),
      artistMatch({ t: "a", a: "Drake" }, { t: "b", a: "Adele" })]);
    ok(ac.join() === "near,hit,miss", "Artist box: shared credit orange, main artist green, else red (" + ac + ")");

    // ---------- Settings: import CSV, list switches ----------
    await page.click("#gear");
    ok(await page.isDisabled('#lists [data-id="b:Charts"]'), "Only list can't be switched off");
    const csv = 'Track Name,Artist Name(s),Release Date,Genres\n"Running Up That Hill (A Deal with God)",Kate Bush,1985-09-16,"art pop,rock"\n"Under Pressure","Queen;David Bowie",1981,rock\n';
    // A second list (as a playlist added to playlists.json would be), parsed with the CSV reader
    const n = await page.evaluate(c => { const songs = parseCSV(c); IMPORTS.push({ id: "t", name: "Mum's songs", songs }); save("sd_imports", IMPORTS); CFG.on["u:t"] = true; changed(); return songs.length }, csv);
    ok(n === 2, "CSV reader finds 2 songs");
    ok(await page.evaluate(() => songSource().some(x => x.a === "Queen & David Bowie")), "Every credited artist kept");
    await page.click('#lists [data-id="b:Charts"]');
    ok(await page.isDisabled('#lists .sopt[data-id^="u:"]'), "Imported list now the one that stays on");
    await page.click("#set-ok");
    await page.selectOption("#era", "All"); await page.selectOption("#genre", "All");
    const imported = await page.evaluate(() => songSource().length);
    ok(imported === 2, "Only the imported list is used (" + imported + ")");
    await page.reload();
    ok(!(await page.isVisible("#how")), "How to play not shown again");
    ok(await page.evaluate(() => songSource().length === 2 && vol === 0.35), "Import, switches and volume survive a reload");

    // ---------- Song list ----------
    await page.click('.tab[data-tab="list"]');
    ok((await page.textContent("#lcount")) === "2 songs", "Song list shows switched-on songs");
    await page.click("#gear"); await page.click('#lists [data-id="b:Charts"]'); await page.click("#set-ok");
    await page.click('.tab[data-tab="list"]');
    await page.fill("#lq", "billie jean");
    ok((await page.textContent("#lcount")) === "1 song", "Song list search works");

    // ---------- Daily ----------
    await page.click('.tab[data-tab="daily"]');
    await page.waitForSelector("#play:not([disabled])");
    const d1 = await page.evaluate(() => dailySong(today()).k);
    await page.click("#skip"); await page.click("#giveup");
    ok(await page.isVisible("#share"), "Daily round ends with Copy my score");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.click("#share");
    await page.waitForTimeout(200);
    ok(/⬛/.test(await page.evaluate(() => shareText(dailyState(), dailySong(today())))), "Score text has squares");
    await page.reload(); await page.click('.tab[data-tab="daily"]');
    ok(await page.isVisible("#share"), "Daily result kept after reload");
    const page2 = await browser.newPage(); await stub(page2); await page2.goto("http://localhost:8123/");
    await page2.waitForFunction(() => Object.keys(BUILTIN).length);
    ok(await page2.evaluate(() => dailySong(today()).k) === d1, "Daily song is the same for a different player");

    // ---------- No preview: quietly deal another ----------
    const p3 = await browser.newPage(); let misses = 0;
    await stub(p3, { noPreview: () => misses++ < 4 });   // a song with an ID asks 4 times: lookup, search US and UK, Deezer
    await p3.goto("http://localhost:8123/"); await p3.click("#how-ok");
    await p3.waitForSelector("#play:not([disabled])", { timeout: 15000 });
    ok(misses >= 3 && await p3.evaluate(() => round.auto >= 1), "Songs without a preview are skipped quietly");

    // ---------- Search accepts only the real artist's original ----------
    const p5 = await browser.newPage(); await stub(p5, { search: () => [{ trackName: "Hello", artistName: "Karaoke Hits", previewUrl: "kar", releaseDate: "2010" }], deezer: () => [] });
    await p5.goto("http://localhost:8123/");
    const pick = await p5.evaluate(async () => findPreview({ k: "zz|x", t: "Hello", a: "Adele", i: 0 }));
    ok(pick === null, "Karaoke/other-artist search results are rejected");
    const p4 = await browser.newPage(); await stub(p4, { search: () => [
      { trackName: "Hello (Live)", artistName: "Adele", previewUrl: "live", releaseDate: "2016" },
      { trackName: "Hello", artistName: "Adele", previewUrl: "new", releaseDate: "2020" },
      { trackName: "Hello", artistName: "Adele", previewUrl: "orig", releaseDate: "2015" },
      { trackName: "Hello", artistName: "Karaoke Hits", previewUrl: "kar", releaseDate: "2010" }] });
    await p4.goto("http://localhost:8123/"); await p4.waitForFunction(() => Object.keys(BUILTIN).length);
    const pr = await p4.evaluate(() => findPreview({ k: "hello|adele", t: "Hello", a: "Adele", i: 0 }));
    ok(pr && pr.url === "orig" && pr.year === 2015, "Search picks the earliest original recording");

    // ---------- Search finds words anywhere in the title ----------
    for (const [q, want] of [["shoop shoop", "Exhale (Shoop Shoop)"], ["dont stop", "Don't Stop Believin'"], ["pina colada", "Escape (The Piña Colada Song)"], ["pimp", "P.I.M.P."], ["mr brightside", "Mr. Brightside"], ["mmm bop", "MMMBop"]]) {
      await page2.goto("http://localhost:8123/"); if (await page2.isVisible("#how-ok")) await page2.click("#how-ok"); await page2.waitForSelector("#guess");
      await page2.fill("#guess", q); await page2.waitForSelector("#sugg li");
      const got = await page2.$$eval("#sugg li", ls => ls.map(l => l.firstChild.textContent));
      ok(got.includes(want), `Typing "${q}" suggests ${want}`);
    }

    // ---------- First clip length setting ----------
    const p6 = await browser.newPage(); await stub(p6); await p6.goto("http://localhost:8123/"); await p6.click("#how-ok");
    await p6.waitForSelector("#play:not([disabled])");
    await p6.click("#gear"); await p6.click('#startseg [data-start="2"]');
    ok((await p6.$$eval("#startseg button", b => b.map(x => x.textContent))).join() === "0.1s,0.5s,1s,2s,5s", "Clip length choices are in order");
    ok((await p6.textContent("#startnote")).includes("2s → 8s → 15s"), "Settings shows the clip lengths for a 2s start");
    await p6.click("#set-ok"); await p6.waitForSelector("#play:not([disabled])");
    ok(await p6.evaluate(() => ctx.limit === 2), "Game starts with a 2s clip");
    await p6.click("#skip");
    ok(await p6.evaluate(() => ctx.limit === 8) && (await p6.textContent("#skip")).includes("+15s"), "Skip moves to 8s, next 15s");
    // "Start again" setting: skip while playing stops, next clip starts from 0
    await p6.click("#gear"); await p6.click('#flowseg [data-flow="false"]'); await p6.click("#set-ok");
    await p6.waitForSelector("#play:not([disabled])"); await p6.click("#play"); await p6.waitForTimeout(300);
    await p6.click("#skip"); await p6.waitForTimeout(200);
    ok(await p6.evaluate(() => audio.paused && (round.pos || 0) === 0), "Start again: skip stops and resets to the beginning");
    await p6.click("#gear"); await p6.click('#flowseg [data-flow="true"]'); await p6.click("#set-ok");
    await p6.reload(); await p6.waitForSelector("#play:not([disabled])");
    ok(await p6.evaluate(() => ctx.limit === 2), "Start length remembered after reload");

    // ---------- iPhone: no iTunes search there, so songs without an iTunes ID get Deezer's clip ----------
    {
      const extra = [{ t: "Test Song", a: "Test Singer" }];
      const c = await browser.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined });
      const p = await c.newPage(); const perr = []; p.on("pageerror", e => perr.push(e.message));
      await stub(p, { extra, albumYear: 1994 });
      await p.goto("http://localhost:8123/"); await p.click("#how-ok"); await p.waitForFunction(() => Object.keys(BUILTIN).length);
      await p.waitForSelector("#play:not([disabled])");
      const withId = await p.evaluate(async () => { const s = songSource().find(x => x.i); return (await findPreview(s)).url.endsWith(s.i + ".wav") });
      ok(withId, "iPhone: songs with an iTunes ID still use the iTunes lookup");
      await p.evaluate(x => { IMPORTS.push({ id: "ios", name: "Mine", songs: x }); CFG.on = { "b:Charts": false, "u:ios": true }; changed() }, extra);
      await p.waitForSelector("#play:not([disabled])", { timeout: 8000 });
      ok(await p.evaluate(() => audio.src === "https://audio.test/dz.wav" && round.target.y === 1994), "iPhone: a song without an iTunes ID plays Deezer's clip and gets its year");
      await p.click("#play"); await p.waitForTimeout(400);
      ok(await p.evaluate(() => audio.src.endsWith("dz.wav") && audio.currentTime > 0 && audio.paused), "iPhone: play button plays the clip");
      await p.click("#giveup"); await p.waitForTimeout(200);
      ok((await p.getAttribute("#lk-am", "href")).startsWith("https://music.apple.com/"), "iPhone: the Apple Music button still goes to Apple Music after a Deezer clip");
      ok(perr.length === 0, "iPhone: no page errors " + perr.join("; "));
      await c.close();
    }
    // Deezer's results get the same checks as iTunes': the right singer, not a live/karaoke version
    const p8 = await browser.newPage(); await stub(p8, { search: () => [], deezer: q => /Everybody/.test(q) ? [
      { id: 4, title: "Everybody (Backstreet's Back) (Extended Version)", artist: { name: "Backstreet Boys" }, album: { id: 4, title: "X" }, preview: "ext" },
      { id: 5, title: "Everybody (Backstreet's Back) (Radio Edit)", artist: { name: "Backstreet Boys" }, album: { id: 5, title: "Y" }, preview: "radio" }] : [
      { id: 1, title: "Hello", artist: { name: "Karaoke Hits" }, album: { id: 1, title: "X" }, preview: "kar" },
      { id: 2, title: "Hello (Live)", title_version: "(Live)", artist: { name: "Adele" }, album: { id: 2, title: "Live" }, preview: "live" },
      { id: 3, title: "Hello", artist: { name: "Adele" }, album: { id: 3, title: "25" }, preview: "orig" }] });
    await p8.goto("http://localhost:8123/");
    const dz = await p8.evaluate(() => findPreview({ k: "hello|adele", t: "Hello", a: "Adele", i: 0, y: 2015 }));
    ok(dz && dz.url === "orig", "When iTunes has no clip, Deezer's original is used (" + (dz && dz.url) + ")");
    const re = await p8.evaluate(() => findPreview({ k: "everybody|bsb", t: "Everybody (Backstreet's Back)", a: "Backstreet Boys", i: 0, y: 1997 }));
    ok(re && re.url === "radio", "A radio edit counts as the song, an extended version doesn't");

    // ---------- Adding a playlist from a link ----------
    {
      const p = await browser.newPage();
      await stub(p, {
        playlist: link => /spotify/.test(link) ? { id: "spotify:playlist:abc", name: "Mum & Dad Hits", source: "Spotify", songs: [{ t: "Waterloo", a: "ABBA" }, { t: "Jolene", a: "Dolly Parton" }] }
          : /pl\.x/.test(link) ? { id: "apple:playlist:pl.x", name: "Road Trip", source: "Apple Music", songs: [{ t: "Africa", a: "Toto", i: 111 }, { t: "Roxanne", a: "The Police", i: 222, c: "GB" }] }
          : { status: 404, body: { error: "That playlist wasn't found. Check the link is complete and the playlist is public." } },
        lookup: ids => ids.map(i => ({ trackId: +i, trackName: "X", artistName: "X", previewUrl: "https://audio.test/" + i + ".wav", releaseDate: (i === "111" ? 1982 : 1978) + "-03-01T08:00:00Z", primaryGenreName: i === "111" ? "Rock" : "R&B/Soul" })),
      });
      await p.goto("http://localhost:8123/"); await p.click("#how-ok"); await p.waitForFunction(() => Object.keys(BUILTIN).length);
      await p.click("#gear");
      await p.fill("#imp-link", "Listen to this https://open.spotify.com/playlist/37i9dQZF1DXbTxeAdrVG2l?si=1");
      await p.click("#imp-go");
      await p.waitForFunction(() => /Added/.test(document.querySelector("#imp-msg").textContent));
      ok((await p.textContent("#imp-msg")).includes('"Mum & Dad Hits" (2 songs)'), "Spotify link adds the playlist under its own name");
      ok(await p.isVisible('#lists .sopt[data-id^="u:"][aria-checked="true"]'), "The new list is switched on");
      await p.fill("#imp-link", "https://open.spotify.com/playlist/37i9dQZF1DXbTxeAdrVG2l"); await p.click("#imp-go");
      await p.waitForFunction(() => /Updated/.test(document.querySelector("#imp-msg").textContent));
      ok(await p.evaluate(() => IMPORTS.length === 1), "Adding the same playlist again updates it instead of doubling up");
      await p.fill("#imp-link", "https://music.apple.com/us/playlist/road-trip/pl.x"); await p.press("#imp-link", "Enter");
      await p.waitForFunction(() => /Road Trip/.test(document.querySelector("#imp-msg").textContent));
      const rt = await p.evaluate(() => IMPORTS.find(x => x.name === "Road Trip").songs);
      ok(rt[0].y === 1982 && rt[0].g === "Rock" && rt[1].y === 1978 && rt[1].g === "R&B", "Apple Music songs get their years and genres " + JSON.stringify(rt));
      await p.click("#imp-only");
      ok(!(await p.isVisible("#settings")) && await p.evaluate(() => tab === "play" && songSource().length === 2 && songSource().every(x => x.lists[0] === "Road Trip")), "Play only these: just that list, straight to the game");
      await p.waitForSelector("#play:not([disabled])");
      await p.click("#gear");
      await p.fill("#imp-link", "https://music.apple.com/us/playlist/pl.gone"); await p.click("#imp-go");
      await p.waitForFunction(() => /wasn't found/.test(document.querySelector("#imp-msg").textContent));
      ok(true, "A missing playlist says so in plain words");
      await p.fill("#imp-link", "hello"); await p.click("#imp-go");
      ok((await p.textContent("#imp-msg")).includes("Paste a Spotify or Apple Music link"), "Text that isn't a link is caught straight away");
      await p.reload();
      ok(await p.evaluate(() => IMPORTS.length === 2 && songSource().length === 2), "Added playlists survive a reload");
    }

    // ---------- Phone and iPad ----------
    for (const [name, dev] of [["iphone", devices["iPhone 13"]], ["ipad", devices["iPad (gen 7)"]]]) {
      const c = await browser.newContext({ ...dev, defaultBrowserType: undefined });
      const p = await c.newPage(); await stub(p); await p.goto("http://localhost:8123/");
      await p.screenshot({ path: path.join(__dirname, name + "-howto.png") });
      await p.click("#how-ok"); await p.waitForSelector("#play:not([disabled])");
      await p.click("#skip"); await p.fill("#guess", "love"); await p.waitForSelector("#sugg li[data-i]");
      await p.click("#sugg li[data-i='0']");
      const sw = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      ok(sw, name + ": no sideways scrolling");
      const small = await p.$$eval("button", bs => bs.filter(b => b.offsetParent && b.getBoundingClientRect().height < 44).length);
      ok(small === 0, name + ": all buttons at least 44px tall");
      await p.screenshot({ path: path.join(__dirname, name + "-game.png"), fullPage: true });
      await c.close();
    }
    ok(errs.length === 0, "No page errors " + errs.join("; "));
  } finally { await browser.close(); srv.kill(); }
  console.log(fails ? fails + " failed" : "All passed"); process.exit(fails ? 1 : 0);
})();
