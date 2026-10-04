# Songdle

**Play it: https://ylp-games.github.io/Songdle/**

A simple song-guessing game. Hear a tiny clip, guess the song; each skip or wrong guess plays a longer clip (0.1s, 0.5s, 2s, 8s, 15s).
Based on the Songdle game in [Yahyadle](https://ylp-games.github.io/Yahyadle/) ([code](https://github.com/YLP-Games/Yahyadle)), with bigger text and simpler wording.

Works on phones, tablets and computers. To play with your own music, open Settings → "Add your own songs" and paste a
Spotify or Apple Music playlist or album link (in the app: ••• → Share → Copy link). The playlist has to be public; Spotify
links bring in up to 100 songs. Added lists are saved on that device only.

## How it's built

- `index.html`: the whole game (no build step)
- `playlists.json`: built-in song lists, `{"List name": [{"t":title,"a":artist,"y":year,"g":genre,"i":iTunesId,"c":"GB"}]}`. "Charts" comes from Yahyadle.
- `tools/itunes_ids.py`: adds iTunes track IDs and original years to `playlists.json`
- `api/playlist.js`: reads a public Spotify or Apple Music playlist/album link for "Add your own songs" (browsers can't read those pages themselves). Runs on Vercel at `songdle-dusky.vercel.app`; redeploy with `vercel deploy --prod` (`.vercelignore` uploads only `api/`)
- `tests/test.js`: Playwright checks (iTunes and Deezer stubbed, WAV audio)

Clips come from iTunes previews. Each preview is downloaded and decoded in full before Play lights up, then played through
Web Audio, so even a 0.1s clip starts and stops exactly, with a few ms fade instead of a click (an `<audio>` element is the
fallback, e.g. on iPhones before iOS 16.4, where Web Audio would go quiet with the silent switch on).

On iPhones and iPads Apple redirects iTunes *search* to the Music app, so only lookups by ID work there: every song in
`playlists.json` should have an iTunes ID. Songs without one (e.g. from a Spotify link) get their clip from Deezer instead.

To add a playlist permanently, convert its CSV into a new key in `playlists.json`, then run `python3 tools/itunes_ids.py`.

## Running and deploying

```
python3 -m http.server 8000      # then open http://localhost:8000
node tests/test.js               # needs Playwright: npm install playwright && npx playwright install chromium
```

Opening `index.html` straight from disk doesn't work: the browser won't load `playlists.json` that way.

Pushing to `main` deploys the site to GitHub Pages (`.github/workflows/static.yml`).
