// Vercel only serves permanent redirects now. Do not download or build the
// catalogue here: the complete application is published by Cloudflare CI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const output = new URL('../dist/vercel-redirect/', import.meta.url);
mkdirSync(output, { recursive: true });
writeFileSync(new URL('index.html', output), '<!doctype html><html lang="en"><title>Strudelify has moved</title><a href="https://strudelify.pages.dev/">Open Strudelify</a></html>\n');
console.log(`Redirect-only output: ${fileURLToPath(output)}`);
