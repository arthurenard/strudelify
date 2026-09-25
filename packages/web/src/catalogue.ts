/**
 * The app's cover catalogue (see covers.ts): the files are read from the site's `db/covers/`, and every cover
 * lookup (art.ts) asks it before any provider.
 */
import { useCatalogue } from './art.js';
import { coverCatalogue } from './covers.js';
import { sitePath } from './ui.js';

export const catalogue = coverCatalogue((shard) => sitePath(`db/covers/${shard}.json`));
useCatalogue(catalogue);
/** A card's cover from what the catalogue knows now: the release's, not an artist portrait. */
export const knownCover = (id: string): string | undefined => {
  const info = catalogue.peek(id);
  return info?.kind === 'track' ? info.art : undefined;
};
