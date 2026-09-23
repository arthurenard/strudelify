"""Stream the upstream CSV/archive; extract only selected regular MIDI files to a staging directory."""
import csv, json, sys, tarfile, unicodedata
from pathlib import Path

def value(text):
    return '' if text.strip().lower() in ('', 'na', 'n/a', 'none', 'unknown', 'anonymous') else text.strip()

def named(text):
    """A title or artist with at least two letters or digits: 'ª -' names nothing. The importer cleans the rest."""
    return sum(c.isalnum() for c in unicodedata.normalize('NFKC', value(text))) >= 2

# A score is good enough when three or more reviewers rate it 4/5 or better, or, with fewer ratings (none
# below 4), when at least ten users made it a favourite.
MIN_RATING, MIN_RATINGS, MIN_FAVOURITES = 4.0, 3, 10

def liked(r):
    rating, ratings = float(r['rating'] or 0), int(r['n_ratings'] or 0)
    if ratings >= MIN_RATINGS: return rating >= MIN_RATING
    return int(r['n_favorites'] or 0) >= MIN_FAVOURITES and (ratings == 0 or rating >= MIN_RATING)

def eligible(r):
    return (r['license_conflict'] == 'False' and r['is_draft'] == 'False'
        and r['has_paywall'] == 'False' and r['subset:all_valid'] == 'True'
        and r['is_best_unique_arrangement'] == 'True' and r['has_lyrics'] == 'False'
        and liked(r)
        and 2 <= int(r['n_tracks'] or 0) <= 16
        and 30 <= float(r['song_length.seconds'] or 0) <= 600
        and 100 <= int(r['n_notes'] or 0) <= 12000
        and named(value(r['song_name']) or value(r['title']))
        and named(value(r['composer_name']) or value(r['artist_name'])))

def select(csv_path, archive_path, destination, limit):
    destination.mkdir(parents=True, exist_ok=True)
    rows = []
    with csv_path.open(newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            try:
                if eligible(r): rows.append(r)
            except (ValueError, KeyError):
                continue
    # Rated scores first, best rated first; then by favourites. The first row of an artist and title wins.
    rows.sort(key=lambda r: (int(r['n_ratings'] or 0) >= MIN_RATINGS, float(r['rating'] or 0), min(int(r['n_ratings'] or 0), 1000), int(r['n_favorites'] or 0)), reverse=True)
    selected = {}
    identities = set()
    for r in rows:
        title = value(r['song_name']) or value(r['title'])
        artist = value(r['composer_name']) or value(r['artist_name'])
        filename = Path(r['mid']).name
        score_id = Path(r['metadata']).stem
        if not score_id.isdigit() or not filename.endswith('.mid') or '..' in Path(r['mid']).parts: continue
        # Only a row that can be imported claims its identity: an invalid one must not hide a valid duplicate.
        identity = (artist.casefold(), title.casefold())
        if identity in identities: continue
        identities.add(identity)
        selected[r['mid'].removeprefix('./')] = dict(file=filename, title=title, artist=artist,
            rating=float(r['rating']), ratings=int(r['n_ratings']), license=r['license_url'],
            scoreId=score_id)
        if len(selected) >= limit: break
    extracted = []
    with tarfile.open(archive_path, 'r|gz') as archive:
        for member in archive:
            item = selected.get(member.name.removeprefix('./'))
            if item is None or not member.isfile(): continue
            if not 14 <= member.size <= 10_000_000: continue
            stream = archive.extractfile(member)
            if stream:
                (destination / item['file']).write_bytes(stream.read())
                extracted.append(item)
    (destination / 'manifest.json').write_text(json.dumps(extracted, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(dict(qualityCandidates=len(rows), selected=len(selected), extracted=len(extracted))))

if __name__ == "__main__":
    select(*map(Path, sys.argv[1:4]), int(sys.argv[4]))
