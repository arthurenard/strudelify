Selected acoustic percussion recordings from the [Versilian Community Sample Library](https://github.com/sgossner/VCSL), by Versilian Studios LLC, under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

Each hit is its source WAV re-encoded losslessly as FLAC: it decodes to exactly the source samples at about a fifth of the size (1.8 MB instead of 8.6 MB). `provenance.json` records each source URL with the SHA-256 and size of both the source WAV and the FLAC. `samples.json` keeps the Strudel default sample indices; only the reviewed hits use local URLs. Other variants continue to use the upstream bank. Regenerate with `node tools/vendor-acoustic-samples.mjs` after building core.

These files prevent third-party sample fetch failures from silently removing the snare or other kit pieces during playback. The player decodes the local hits before starting a reviewed acoustic arrangement.
