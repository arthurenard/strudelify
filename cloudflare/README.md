# Cloudflare deployment

This migrates the already-public beta's hosting, not a declaration that `LAUNCH.md`'s outstanding publication/rights review is resolved. That review is unchanged.

## Free static-only layout

- **Pages** `strudelify.pages.dev`: complete prerendered home/song/artist/A–Z pages, search/player JS, local fonts, icons and acoustic audio.
- **Workers Static Assets** `strudelify-catalogue.arthurenard.workers.dev/db/`: complete referenced song sources, index, moved-song map, cover catalogue and `build.json`.
- The app's `/db/*` requests get a static 302 to the catalogue; catalogue responses allow CORS. No request reaches Vercel. There are **no Pages Functions or executable Worker code**, so delivery uses the static-assets layers, not a request-metered Worker proxy.
- Both Pages Free and Workers Free cap each project/version at 20,000 assets (25 MiB per asset). The full site exceeds that. Splitting catalogue and frontend keeps each dedicated payload below 20,000; fail-closed count/size checks enforce it. No upgrade or purchase is necessary.
- Pages is used for the frontend because it supports an external-DNS custom domain via CNAME. A Workers Custom Domain instead requires an active Cloudflare zone, which `arthurenard.me` currently is not. This avoids needing an apex/nameserver migration to achieve the eventual subdomain.
- Only `tools/cloudflare-publish.mjs`'s allowlist publishes into ignored `dist/cloudflare/{app,catalogue}`. It never deploys the repository root. Unknown/private files fail closed or are excluded; only sources referenced by the index are copied.

## Reproduce

Node 24, Python 3, curl; the checked-in lockfile. No dependency upgrades required.

```sh
npm ci
npm run check
node --test tools/cloudflare-publish.test.mjs
export STRUDELIFY_BASE=/ SITE_URL=https://strudelify.pages.dev
export GITHUB_SHA=$(git rev-parse HEAD)
npm run build:site
node tools/cloudflare-publish.mjs
# Supply CLOUDFLARE_API_TOKEN securely via environment, never in source or CLI arguments.
export CLOUDFLARE_ACCOUNT_ID=3895c336f41117ff296c37229e73cbf2
npx --yes wrangler@4.152.0 deploy --config cloudflare/catalogue.wrangler.json
npx --yes wrangler@4.152.0 pages deploy dist/cloudflare/app --project-name strudelify --branch main --commit-hash "$GITHUB_SHA"
node tools/cloudflare-verify.mjs
```

`.github/workflows/cloudflare.yml` runs this pipeline on `main` pushes and manual dispatches. Repository secret `CLOUDFLARE_API_TOKEN` must permit these deployments. `GITHUB_SHA` is recorded in the build manifest. It rebuilds datasets and refuses a reduced catalogue (baseline 13,622 songs / 3,261 scores), rather than silently deploying the base-only fallback. Catalogue first, app second; workflow concurrency serializes deployment. Source URLs are stable. For changes that remove sources or change index semantics, stage versioned catalogues first; these two services are not an atomic release transaction.

`tools/cloudflare-verify.mjs` verifies deployed byte hashes for home/song/artist pages, JS/CSS/icons, database/index/moved/covers/source and audio, checks CSP/CORS/404/private-file behaviour and every sitemap URL's generated HTML. It does not replace real browser playback tests.

## Verified provider deployment (25 October 2026)

The replacement is live at https://strudelify.pages.dev. Initial Pages deployment
`cf7d68f4-f40c-466a-a923-ef2072da596d` and catalogue version
`1f970724-3fd3-443a-bdde-23553aa141c7` were read back from Cloudflare. It carries
13,622 songs, 3,261 scores, 13,622 covers, 4,436 artists, 340 moved IDs and
18,088 sitemap URLs. Payloads: 18,482 frontend and 14,182 catalogue assets.

Sixteen representative live byte hashes plus headers, CORS, sitemap and private/unknown
404 checks passed. A Chromium desktop/mobile check loaded the editor and artwork,
measured a nonzero WebAudio signal during playback, paused successfully, and found no
horizontal overflow at 390px. No page exceptions; the existing Vercel analytics script
fails on this host (not replaced or enabled here).

Typecheck, three publisher tests and three Python tests pass. The serial Vitest suite
against the rebuilt production dataset returned 561 passes and two catalogue-dependent
failures: Pink Floyd part-2 canonical-ID expectation and Coolio landing-pool ID. These
are not being hidden by changing expectations or loosening tests. The initial live build
identifies the source application commit `c335f78d847c89216b802172f8b2c896780c4f71`;
the GitHub workflow rebuilds with the subsequent deployment commit in `GITHUB_SHA`.

Pages rejects a custom `--config` path: deploy using the positional output directory as
above. `pages.wrangler.json` records settings but is not consumed by that CLI invocation.

## Domain and cutover gate

The owner-authorised traffic cutover uses `https://strudelify.pages.dev` directly;
no DNS change is needed. The portfolio's `/strudelify` URLs permanently redirect
there, stripping the prefix and preserving paths/query values; visible portfolio
links and its sitemap pointer use Cloudflare directly. `vercel.json` now builds
only a tiny redirect placeholder (no install, download or dataset build) and
permanently redirects both root and legacy `/strudelify/` URLs on the old Vercel
host. The Cloudflare workflow ignores changes that only affect this retirement
configuration. Redirect requests still count on Vercel; subsequent application
and catalogue requests go to Cloudflare. Historical usage is not erased.

Canonicals and sitemap use the verified `pages.dev` origin. The custom subdomain
below is optional, not a migration blocker. At initial inspection,
`arthurenard.me` had Namecheap nameservers, was not an accessible Cloudflare zone
and `strudelify.arthurenard.me` had no DNS answer. No apex or other DNS is changed.

To activate that unused subdomain without moving nameservers:
1. Add `strudelify.arthurenard.me` as this Pages project's custom domain **before** adding the DNS record (Cloudflare warns that CNAME-only setup can fail).
2. In Namecheap DNS, add only `CNAME strudelify → strudelify.pages.dev` (TTL automatic). Do not alter apex, www or MX records.
3. Wait for Pages domain validation and HTTPS to become active.
4. Change workflow `SITE_URL` to `https://strudelify.arthurenard.me`, rebuild/deploy, and verify HTTPS/canonicals/sitemap/search/playback.
5. If the canonical origin changes, update the redirects and direct links too;
   preserve song/artist paths, query strings, moved-song pages and legacy hashes.
   Do not delete the old sites: their redirects keep existing links working.

References: https://developers.cloudflare.com/workers/platform/limits/ ; https://developers.cloudflare.com/pages/platform/limits/ ; https://developers.cloudflare.com/workers/static-assets/redirects/ ; https://developers.cloudflare.com/pages/configuration/custom-domains/ .
