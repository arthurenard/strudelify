"""Stream the upstream CSV/archive; extract only selected regular MIDI files to a staging directory."""
import csv, json, sys, tarfile
from pathlib import Path

def value(text):
    return '' if text.strip().lower() in ('', 'na', 'n/a', 'none', 'unknown', 'anonymous') else text.strip()

def eligible(r):
    return (r['license_conflict'] == 'False' and r['is_draft'] == 'False'
        and r['has_paywall'] == 'False' and r['subset:all_valid'] == 'True'
        and r['is_best_unique_arrangement'] == 'True' and r['has_lyrics'] == 'False'
        and float(r['rating'] or 0) >= 4.5 and int(r['n_ratings'] or 0) >= 5
        and 2 <= int(r['n_tracks'] or 0) <= 16
        and 30 <= float(r['song_length.seconds'] or 0) <= 600
        and 100 <= int(r['n_notes'] or 0) <= 12000
        and bool(value(r['song_name']) or value(r['title']))
        and bool(value(r['composer_name']) or value(r['artist_name'])))

def select(csv_path, archive_path, destination, limit):
    destination.mkdir(parents=True, exist_ok=True)
    rows = []
    with csv_path.open(newline='') as f:
        for r in csv.DictReader(f):
            try:
                if eligible(r): rows.append(r)
            except (ValueError, KeyError):
                continue
    rows.sort(key=lambda r: (float(r['rating']), min(int(r['n_ratings']), 1000)), reverse=True)
    selected = {}
    identities = set()
    for r in rows:
        title = value(r['song_name']) or value(r['title'])
        artist = value(r['composer_name']) or value(r['artist_name'])
        identity = (artist.casefold(), title.casefold())
        if identity in identities: continue
        identities.add(identity)
        filename = Path(r['mid']).name
        score_id = Path(r['metadata']).stem
        if not score_id.isdigit() or not filename.endswith('.mid') or '..' in Path(r['mid']).parts: continue
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
    (destination / 'manifest.json').write_text(json.dumps(extracted, ensure_ascii=False))
    print(json.dumps(dict(qualityCandidates=len(rows), selected=len(selected), extracted=len(extracted))))

if __name__ == "__main__":
    select(*map(Path, sys.argv[1:4]), int(sys.argv[4]))
