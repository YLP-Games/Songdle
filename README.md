# Songdle

**Play it: https://layla310803.github.io/Songdle/**

A simple song-guessing game. Hear a tiny clip, guess the song; each skip or wrong guess plays a longer clip (0.1s, 0.5s, 2s, 8s, 15s).
Based on the Songdle game in [Yahyadle](https://github.com/layla310803/Yahyadle), with bigger text and simpler wording.

Works on phones, tablets and computers. To play with your own music, open Settings → "Add your own songs" and paste a
Spotify or Apple Music playlist or album link (in the app: ••• → Share → Copy link). The playlist has to be public; Spotify
links bring in up to 100 songs. Added lists are saved on that device only.

## How it's built

- `index.html`: the whole game (no build step), published by GitHub Pages from `main`
- `playlists.json`: built-in song lists, `{"List name": [{"t":title,"a":artist,"y":year,"g":genre,"i":iTunesId,"c":"GB"}]}`. "Charts" comes from Yahyadle.
- `tools/itunes_ids.py`: adds iTunes track IDs and original years to `playlists.json`
- `api/playlist.js`: reads a public Spotify or Apple Music playlist/album link for "Add your own songs" (browsers can't read those pages themselves). Runs on Vercel at `songdle-dusky.vercel.app`; redeploy with `vercel deploy --prod` (`.vercelignore` uploads only `api/`)
- `tests/test.js`: Playwright checks (`node tests/test.js`, iTunes and Deezer stubbed, WAV audio)

Clips come from iTunes previews. On iPhones and iPads Apple redirects iTunes *search* to the Music app, so only lookups by
ID work there: every song in `playlists.json` should have an iTunes ID. Songs without one (e.g. from a Spotify link) get
their clip from Deezer instead.

To add a playlist permanently, convert its CSV into a new key in `playlists.json`, then run `python3 tools/itunes_ids.py`.
