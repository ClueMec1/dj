QUAD DECK - installable DJ mixer (PWA)

To install it as an app, these files must be served over HTTPS (or http://localhost):
  - Netlify Drop: drag this whole folder onto app.netlify.com/drop
  - GitHub Pages: push the folder to a repo and enable Pages
  - Local test: run  python3 -m http.server 8000  in this folder, then open http://localhost:8000
Then open the site in Chrome, Edge or Safari and choose Install app / Add to Home Screen.
Once installed it works offline, and the Rec button's "Save mix" link downloads your recorded mix.

WHAT'S INSIDE
  index.html   the whole app (UI, audio engine, sequencer, piano roll, sample library)
  beatsync.js  beat analysis and sync engine (runs the heavy analysis in a background worker)
  fxengine.js  builds and drops: risers, snare builds, impacts... rendered for the playing song
  sw.js        offline cache
  manifest.webmanifest, icon-*.png, icon.svg   install metadata

Only works in the installed app (browser security rules):
  - Microphone channel
  - Headphone "Output" cue mode (sends cue to a second sound device; Chrome/Edge)
  - Saving recordings, WAV exports and pattern exports

SAVED ON YOUR DEVICE
  Songs and sounds you upload, your Sets, and your last session (songs on decks, positions,
  every knob, effects and the beat) are stored in the app's own storage on this phone or computer.
  They survive closing the app. Clearing the browser's site data for this app deletes them.

FIND MUSIC
  The Find music panel (in the Bin section) searches Audius and the Internet Archive with no account,
  and Jamendo with a free client ID from devportal.jamendo.com. It only works in the installed app
  with an internet connection. Songs belong to their artists: check each license before public use.

BEAT SYNC
  Each song is analysed once in the background (kick-drum onsets, tempo, beat grid, bar and 4-bar
  phrase starts) and the result is saved with the song. Songs analysed by an older version are
  re-analysed automatically the next time they are loaded; grids you fixed by hand are kept.
  Under each deck's readouts a status line shows how the grid is doing:
    LIVE   kicks heard right now confirm the grid (tiny corrections are made on the fly)
    GRID   the analysed grid is used        HOLD   no drums right now, the grid carries on
    TAP    detection is unsure: tap along 6+ times on the kick while the song plays
    Δ      how far a synced deck is from the beat it follows, in milliseconds
  Quantize (in the tempo sheet): Play and Sync land on the next phrase, bar or beat of the other song.

BUILDS AND DROPS (FX tab)
  The FX tab renders its build-ups and drops for the song that is playing: exactly its tempo, a whole
  number of bars long, with rhythmic parts on its grid and tonal parts in its key (the key is detected
  when a song is analysed). Tap a build and it lands on the next phrase (or bar / beat, see Lands on);
  if there is less time left than the build is long, it joins in part-way so it still lands on time.
  Tap it again before the drop to call it off. Optional: the music slowly loses its bass during a build
  and snaps back on the drop, a half-beat gap before the drop, and a short duck when an impact hits.
  One-shots are rendered the same way: horns, sirens, whistle, cowbell, lasers and booms are tuned to
  notes of the song's key, rhythms (horn triple, siren cycles, scratches, echoes) follow its tempo, and
  they start on the next beat or 1/8 note. Rewind, Tape stop and Glitch work on the playing song itself:
  they start from the exact sample the deck is playing, mute the music underneath and bring it back on
  the next bar (or phrase / beat, per Lands on). Tap them again before they finish to call them off.
