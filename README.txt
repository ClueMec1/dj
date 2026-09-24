QUAD DECK - installable DJ mixer (PWA)

To install it as an app, these files must be served over HTTPS (or http://localhost):
  - Netlify Drop: drag this whole folder onto app.netlify.com/drop
  - GitHub Pages: push the folder to a repo and enable Pages
  - Local test: run  python3 -m http.server 8000  in this folder, then open http://localhost:8000
Then open the site in Chrome, Edge or Safari and choose Install app / Add to Home Screen.
Once installed it works offline, and the Rec button's "Save mix" link downloads your recorded mix.

WHAT'S INSIDE
  index.html   the whole app (UI, audio engine, sequencer, piano roll, sample library)
  sw.js        offline cache
  manifest.webmanifest, icon-*.png, icon.svg   install metadata

Only works in the installed app (browser security rules):
  - Microphone channel
  - Headphone "Output" cue mode (sends cue to a second sound device; Chrome/Edge)
  - Saving recordings, WAV exports and pattern exports
