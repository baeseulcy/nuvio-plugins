# AlooyTV Nuvio Addon

This version is designed as a Stremio/Nuvio addon, not a local provider.

It searches AlooyTV directly using its site search (`/?s=...`), returns matching AlooyTV pages as series results, reads episode links from the AlooyTV page, and resolves direct MP4/M3U8 links or follows the iframe/embed player.

## Run

npm install
npm start

The addon is served from `/manifest.json` on port 7000.

Important: Nuvio needs the addon to be hosted at a public HTTPS URL. GitHub Pages alone cannot run this Node server.
