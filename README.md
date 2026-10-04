# Songdle

A simple song-guessing game. Hear a tiny clip, guess the song; each skip or wrong guess plays a longer clip (0.1s, 0.5s, 2s, 8s, 15s).
Based on the Songdle game in [Yahyadle](https://github.com/layla310803/Yahyadle), with bigger text and simpler wording.

- `index.html`: the whole game (no build step)
- `playlists.json`: built-in song lists, `{"List name": [{"t":title,"a":artist,"y":year,"g":genre,"i":iTunesId,"c":"GB"}]}`. "Charts" comes from Yahyadle.
- `tools/itunes_ids.py`: adds iTunes track IDs and original years to `playlists.json`
- `api/playlist.js`: reads a public Spotify or Apple Music playlist/album link for Settings → "Add your own songs" (browsers can't read those pages themselves). Runs on Vercel at `songdle-dusky.vercel.app`; redeploy with `vercel deploy --prod` (`.vercelignore` uploads only `api/`)
- `tests/test.js`: Playwright checks (`node tests/test.js`, iTunes stubbed, WAV audio)

To add a playlist permanently, convert its CSV into a new key in `playlists.json`, then run `python3 tools/itunes_ids.py`.

Every song in `playlists.json` should have an iTunes ID: on iPhones and iPads Apple redirects iTunes *search* to the Music app, so only lookups by ID work there. Songs without one (e.g. from a Spotify link) get their clip from Deezer instead.
