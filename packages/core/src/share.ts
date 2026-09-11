/** Share links: strudel.cc keeps the whole program base64-encoded in the URL hash. */
export function code2hash(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return encodeURIComponent(btoa(bin));
}

export function hash2code(hash: string): string {
  const bin = atob(decodeURIComponent(hash.replace(/^#/, '')));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function shareUrl(code: string, base = 'https://strudel.cc/'): string {
  return `${base}#${code2hash(code)}`;
}
