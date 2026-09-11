/** Map the many free-text section labels in the sources onto a small vocabulary. */
export function normaliseSectionLabel(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (/^[a-z]'*$/.test(s)) return 'section';
  if (s.includes('pre-chorus') || s.includes('prechorus') || s.includes('pre chorus')) return 'pre-chorus';
  if (s.includes('pre-verse')) return 'pre-verse';
  if (s.includes('pre-intro')) return 'intro';
  if (s.includes('intro')) return 'intro';
  if (s.includes('chorus') || s.includes('refrain')) return 'chorus';
  if (s.includes('verse')) return 'verse';
  if (s.includes('bridge')) return 'bridge';
  if (s.includes('solo')) return 'solo';
  if (s.includes('instrumental') || s.includes('interlude')) return 'interlude';
  if (s.includes('outro') || s.includes('coda') || s.includes('ending') || s.includes('fade')) return 'outro';
  if (s.includes('trans')) return 'transition';
  if (s.includes('theme')) return 'theme';
  return s.replace(/[^a-z0-9-]+/g, '-') || 'section';
}
