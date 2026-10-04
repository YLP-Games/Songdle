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
    const id = u.searchParams.get("id"), term = u.searchParams.get("term") || "";
    let results = [];
    const noPreview = opts.noPreview && opts.noPreview(id, term);
    if (!noPreview) {
      if (id) results = [{ trackName: "X", artistName: "X", previewUrl: "https://audio.test/" + id + ".wav", artworkUrl100: "" }];
      else if (opts.search) results = opts.search(term);
      else { const r = SONGS.find(x => x.a + " " + x.t === term); if (r) results = [{ trackName: r.t, artistName: r.a, previewUrl: "https://audio.test/s.wav", releaseDate: r.y + "-01-01" }]; }
    }
    route.fulfill({ contentType: "text/javascript", body: `${cb}(${JSON.stringify({ results })})` });
  });
  await page.route("https://audio.test/**", r => r.fulfill({ contentType: "audio/wav", body: WAV }));
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
    await page.click("#skip");
    ok((await page.textContent(".left")).includes("4 tries"), "Skip uses a try");
    ok(await page.isVisible(".row .skipped"), "Skipped row shown");
    // Wrong guess: pick a song by a different artist
    const wrong = await page.evaluate(k => songSource().find(x => x.k !== k && mainArtist(x.a) !== mainArtist(round.target.a) && x.y && x.y !== round.target.y), t.k);
    await page.fill("#guess", wrong.t);
    await page.waitForSelector("#sugg li[data-i]");
    const idx = await page.$$eval("#sugg li[data-i]", (ls, w) => ls.findIndex(l => l.textContent === w.t + w.a), wrong);
    await page.click(`#sugg li[data-i="${Math.max(0, idx)}"]`);
    const cells = await page.$$eval(".row:first-child span", s => s.map(x => x.className + ":" + x.textContent));
    ok(cells[0].startsWith("miss") && cells.length === 3, "Wrong guess shows Song/Artist/Year boxes: " + cells.join(" | "));
    ok(/▲ newer|▼ older/.test(cells[2]) && ((t.y > wrong.y) === cells[2].includes("▲")), "Year arrow points the right way");
    // Correct guess
    await page.fill("#guess", t.t);
    await page.waitForSelector("#sugg li[data-i]");
    const ci = await page.$$eval("#sugg li[data-i]", (ls, w) => ls.findIndex(l => l.textContent === w.t + w.a), t);
    ok(ci >= 0, "Answer appears in the dropdown");
    await page.click(`#sugg li[data-i="${ci}"]`);
    await page.waitForSelector(".result");
    ok((await page.textContent(".result h2")).includes("Well done"), "Win screen shows");
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => audio && !audio.paused), "Full preview autoplays after a win");
    ok((await page.textContent(".chips")).includes("Streak 1"), "Streak counts the win");
    await page.click("#next");
    await page.waitForSelector("#play:not([disabled])");
    ok((await page.textContent(".prev")).includes(t.t), "Next song deals a new round");
    await page.click("#giveup");
    ok((await page.textContent(".result h2")).includes("answer was") && (await page.textContent(".chips")).includes("Streak 0") && (await page.textContent(".chips")).includes("Best 1"), "Give up shows answer and resets streak");
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
    ok(await page.isDisabled('#lists input[data-id="b:Charts"]'), "Only list can't be switched off");
    const csv = 'Track Name,Artist Name(s),Release Date,Genres\n"Running Up That Hill (A Deal with God)",Kate Bush,1985-09-16,"art pop,rock"\n"Under Pressure","Queen;David Bowie",1981,rock\n';
    await page.fill("#imp-name", "Mum's songs");
    await page.setInputFiles("#imp-file", { name: "mum.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await page.waitForFunction(() => document.querySelector("#imp-msg").textContent.includes("Added"));
    ok((await page.textContent("#imp-msg")).includes("2 songs"), "CSV import adds 2 songs");
    ok(await page.evaluate(() => songSource().some(x => x.a === "Queen & David Bowie")), "Every credited artist kept");
    await page.uncheck('#lists input[data-id="b:Charts"]');
    ok(await page.isDisabled('#lists input[data-id^="u:"]'), "Imported list now the one that stays on");
    await page.click("#set-ok");
    await page.selectOption("#era", "All"); await page.selectOption("#genre", "All");
    const imported = await page.evaluate(() => songSource().length);
    ok(imported === 2, "Only the imported list is used (" + imported + ")");
    await page.reload();
    ok(!(await page.isVisible("#how")), "How to play not shown again");
    ok(await page.evaluate(() => songSource().length === 2 && vol === 0.35), "Import, switches and volume survive a reload");

    // ---------- Song list ----------
    await page.click('nav [data-tab="list"]');
    ok((await page.textContent("#lcount")) === "2 songs", "Song list shows switched-on songs");
    await page.click("#gear"); await page.check('#lists input[data-id="b:Charts"]'); await page.click("#set-ok");
    await page.click('nav [data-tab="list"]');
    await page.fill("#lq", "billie jean");
    ok((await page.textContent("#lcount")) === "1 song", "Song list search works");

    // ---------- Daily ----------
    await page.click('nav [data-tab="daily"]');
    await page.waitForSelector("#play:not([disabled])");
    const d1 = await page.evaluate(() => dailySong(today()).k);
    await page.click("#skip"); await page.click("#giveup");
    ok(await page.isVisible("#share"), "Daily round ends with Copy my score");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.click("#share");
    await page.waitForTimeout(200);
    ok(/⬛/.test(await page.evaluate(() => shareText(dailyState(), dailySong(today())))), "Score text has squares");
    await page.reload(); await page.click('nav [data-tab="daily"]');
    ok(await page.isVisible("#share"), "Daily result kept after reload");
    const page2 = await browser.newPage(); await stub(page2); await page2.goto("http://localhost:8123/");
    await page2.waitForFunction(() => Object.keys(BUILTIN).length);
    ok(await page2.evaluate(() => dailySong(today()).k) === d1, "Daily song is the same for a different player");

    // ---------- No preview: quietly deal another ----------
    const p3 = await browser.newPage(); let misses = 0;
    await stub(p3, { noPreview: () => misses++ < 2 });
    await p3.goto("http://localhost:8123/"); await p3.click("#how-ok");
    await p3.waitForSelector("#play:not([disabled])", { timeout: 15000 });
    ok(misses >= 2 && await p3.evaluate(() => round.auto >= 1), "Songs without a preview are skipped quietly");

    // ---------- Search accepts only the real artist's original ----------
    const p5 = await browser.newPage(); await stub(p5, { search: () => [{ trackName: "Hello", artistName: "Karaoke Hits", previewUrl: "kar", releaseDate: "2010" }] });
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
