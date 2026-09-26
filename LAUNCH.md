# Publication review — 19 September 2026

_Updated 23 September 2026: the licence file is added, fonts are served with the site, the production page carries a
Content Security Policy, and CI runs the typecheck, the tests and a fixture web build. Later that day: a second score
import brought the catalogue to 13,929 entries (3,285 scores), songs moved from `/#id` links to their own addresses, and the build
writes a page per song and per artist for search engines (see the hosting notes). On 26 September 2026 the catalogue
became one entry per song (LMD's match scores choose which of a song's transcriptions plays; a merged song's old
address sends visitors on) and the code writer began reading a performer's small timing wobbles as the riff they
play. The rights questions below are unchanged, and apply to the imported scores as much as to the first ones._

The app is a working local beta. The full music catalogue is **not cleared for public publication** by this review. Passing software tests does not establish music or artwork rights, and transcription quality is not uniformly verified against recordings. No website was deployed during this review.

## Performance changes

- Search uses 96px CDN images and landing cards use 160px images instead of 600–1000px covers. The hero retains full-size art.
- Cached artwork bypasses the network queue. Four thumbnail lookups can progress, with each provider's existing rate limits retained.
- Browser requests time out after 1.8 seconds and move to another provider without retry backoff. Individual thumbnail searches have a four-second budget and skip artist-portrait fallback. Recently missing thumbnails wait 30 seconds before another automatic attempt; opening a song can still perform a full lookup.
- The editor/audio engine loads when a song opens, instead of competing with homepage images. Artwork lookup starts alongside song loading.

A live three-song check of Nirvana, Queen and The Beatles returned metadata in 401–509 ms. Search thumbnail transfers were 3,941–7,330 bytes, versus 62,562–140,237 bytes for the corresponding full images (94–96% smaller). These are a small network sample, not a site-wide latency guarantee. Provider outages, rate limits and first-time searches can still delay or prevent covers.

## Rights to settle before launch

1. **Software.** The project's own code is MIT ([LICENSE](LICENSE)). The browser bundles Strudel, which is AGPL-3.0. Treat the distributed combined application as requiring AGPL-compliant distribution, including complete corresponding source and build instructions, dependency notices and the licence text. A private GitHub link or minified JavaScript alone is insufficient. Confirm the intended distribution with appropriate licensing advice; this review does not relicense the project. [GNU FAQ](https://www.gnu.org/licenses/gpl-faq.en.html), [AGPL text](https://www.gnu.org/licenses/agpl-3.0.html).

2. **Music.** Lakh declares CC-BY 4.0 and requests attribution to Colin Raffel's 2016 thesis, but also states that the MIDI files were scraped and that Raffel did not transcribe them. That is not a guarantee of permission from every composer, publisher or arranger. Removing vocals or generating new synthesized sound does not establish clearance for the underlying composition, arrangement or downloadable note transcription. Review rights per work, or publish a catalogue of works and arrangements you own, have licensed, or have verified as public domain in the relevant territories. PDMX's agreement between two licence metadata fields is not independent rights verification. [Lakh](https://colinraffel.com/projects/lmd/), [PDMX record](https://zenodo.org/records/15571083).

3. **McGill annotations.** Version 2.0 is CC0, with scholarly citation requested. The previous README description as research-only was incorrect. Cite Burgoyne, Wild and Fujinaga, “An Expert Ground Truth Set for Audio Chord Recognition and Music Analysis,” ISMIR 2011. This annotation licence does not itself clear every use of the underlying songs. [McGill source](https://ddmal.ca/research/The_McGill_Billboard_Project_(Chord_Analysis_Dataset)/).

4. **Artwork and APIs.** Apple's published Search API terms restrict artwork to promoting store content and require a nearby approved store badge linked to the content. The current cover tiles do not supply that presentation; a generic iTunes footer link does not meet that requirement. Resolve whether the proposed use is permitted, change the integration, or remove/replace that source before release. Deezer has separate developer terms. MusicBrainz metadata licensing does not include cover-art copyright. Do not assume that a keyless API grants unrestricted display or redistribution rights. [Apple terms](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html), [Deezer terms](https://cdn-content.dzcdn.net/pdf/CGU-developers.pdf), [MusicBrainz data licence](https://musicbrainz.org/doc/About/Data_License).

5. **Samples and privacy.** Local acoustic recordings have CC0 provenance under `packages/data/public/audio/acoustic/`; preserve it. Review the licences of the remaining remotely fetched banks/soundfonts. Document the external requests to artwork services, sample hosts and any hosting analytics (fonts are served with the site; no font CDN is contacted), plus local storage of search history, cover URLs and preferences (per-song rows are capped at 1,000 per kind). The applicable privacy obligations depend on the deployed service and audience.

For a Belgian launch, ask SABAM/Unisono or qualified counsel specifically about interactive synthesized playback, MIDI/Strudel transcription downloads, arrangements and the territories served. An ordinary background-music licence should not be assumed to cover all those uses. [Belgian FPS Economy copyright FAQ](https://economie.fgov.be/en/themes/intellectual-property/intellectual-property-rights/copyright-and-related-rights/copyright/control-service-copyright-and/frequently-asked-questions).

## Technical state and known limits

- Live site (25 September 2026, `db/build.json`): 13,962 entries, 3,285 of them scores, built by Vercel from `main` with the score import; covers from the catalogue. Its base catalogue is built fresh from the datasets, so it differs slightly from an older local database (a few dozen transcriptions chosen differently); ids are pinned in `catalogue-ids.tsv` either way. `STRUDELIFY_URL=https://www.arthurenard.me/strudelify node tools/ui-check.mjs` runs the browser checks against it.
- Local library: 13,613 entries, one per song as far as artist and title tell (312 songs held more than once merged on 26 September 2026; `db/moved.json` keeps their 316 old addresses). All 13,916 source-file references exist, no file is left unplayed, and every entry compiles and plays through the Strudel runtime in all three modes (`tools/library-check.mjs`, 26 September 2026).
- `npm run check` (typecheck of every package and the tests, the unit/runtime suite, the importer tests) and the production build pass. `npm audit` (development dependencies included) returned zero known advisories on 23 September 2026; this is not a complete security audit.
- Browser checks: four landing covers and eight Nirvana search covers load at the intended thumbnail sizes; the editor stays unloaded while browsing, then loads on song selection; playback and live note boxes work.
- Source fidelity remains variable. Main loop is an excerpt the song repeats; Full arrangement is a cleaned transcription on a grid; neither promises the original studio recording. This is suitable for beta expectations, not an “exact music” claim.
- Covers come from a pre-resolved catalogue (`packages/data/covers.tsv`, 25 September 2026): the site ships the image addresses the art chain chose, so visitors no longer query iTunes, Deezer or MusicBrainz for a catalogued song (images still load from those providers' CDNs). This stores provider artwork addresses in the repository: the artwork rights question above is unchanged, and the catalogue should be refreshed (`node tools/resolve-covers.mjs --retry-misses`, and for new songs) rather than kept forever. Deezer JSONP executes third-party script; a production API boundary would reduce that dependency.
- The database index is about 3.5 MB uncompressed (540 KB gzipped); the landing page no longer waits for it. The complete output is about 1.06 GB in about 32,600 files: 560 MB of song sources, 460 MB of prerendered song pages (about 33 KB each, 8 KB gzipped, with up to 200 lines of the song's code), the artist pages and local samples. Configure compression and caching at the host and verify its total-size/file-count limits (some hosts cap a site at 20,000 files).

## Deploy it yourself, after rights are resolved

This is a static site; no application server is required. Use Node 22 and the checked-in lockfile:

```sh
npm ci
# Restore your approved packages/data/public/db catalogue here.
# It is gitignored and will NOT arrive in a fresh GitHub checkout.
# See README.md for the original dataset build workflow; rebuilding is not legal clearance.
npm run check
npm run build:web   # for www.arthurenard.me/strudelify/; see below for another address
npm run preview -w @strudelify/web
```

The production site is built by Vercel from `main`: `vercel.json` names `npm run build:site` as the build command, which downloads the datasets, builds the base catalogue, imports the scores (the site is still built, with the base catalogue, if that fails), merges the songs held more than once (the site is built with every entry if that fails) and builds the site into `packages/web/dist`. Pushing to `main` deploys. `https://www.arthurenard.me/strudelify/db/build.json` says what the live build carries (songs, scores, covers, commit).

Publish **the entire `packages/web/dist` directory**. Vite already includes `db/` and `audio/`; there is no second database copy to upload. The build now fails if the database is absent, empty, or references missing source files.

The page carries its Content Security Policy as a meta tag (`CONTENT_SECURITY_POLICY` in `packages/web/vite.config.ts`). Send the same policy as a `Content-Security-Policy` header, with `frame-ancestors 'none'` added (a meta tag cannot carry it), plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.

The build is made for `https://www.arthurenard.me/strudelify/`: every address starts with `/strudelify/` (Vite's `base`), the portfolio forwards that folder to this project, and `vercel.json` maps it onto the build's root. For a domain of its own build with `STRUDELIFY_BASE=/ SITE_URL=https://your.domain`; `SITE_URL=` leaves canonical links, Open Graph addresses and the sitemap out. Songs have their own addresses (`/strudelify/song/<id>/`), each a folder with an `index.html`; after deploying, check on a preview deployment that such an address answers 200 with the song's page, not the 404 page, since only a 200 page is indexed. Serve `404.html` for unknown addresses (Vercel does by default). Crawlers read `robots.txt` only at the host's root: add `Sitemap: https://www.arthurenard.me/strudelify/sitemap.xml` to the portfolio's robots.txt, and submit that sitemap in Google Search Console and Bing Webmaster Tools. The artist pages carry their own stricter policy (no script at all); a header policy equal to the app's is compatible with them. Enable gzip/Brotli for JSON and JavaScript. Hashed `/assets/` files can be cached immutably; unversioned HTML, database and sample manifests should revalidate instead of being cached forever. Do not publish raw downloads, `.env`, `node_modules` or repository internals.

On the final HTTPS domain, test a fresh browser session and a phone: search, covers, direct song links, first playback, seek/pause, code highlighting, download, and opening code in Strudel. Repeat with an unavailable artwork provider. The current checks were local, not against your future hosting provider.
