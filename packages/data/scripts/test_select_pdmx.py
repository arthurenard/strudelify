import csv, io, json, tarfile, tempfile, unittest
from pathlib import Path
from select_pdmx import eligible, select

def row(**overrides):
    return dict(license_conflict='False', is_draft='False', has_paywall='False', **{'subset:all_valid': 'True', 'song_length.seconds': '120'},
        is_best_unique_arrangement='True', has_lyrics='False', rating='4.8', n_ratings='10', n_tracks='3', n_notes='300',
        song_name='Test', title='Test', composer_name='Composer', artist_name='', mid='./mid/test.mid', metadata='./metadata/123.json', license_url='https://creativecommons.org/publicdomain/zero/1.0/', **overrides)

class SelectionTests(unittest.TestCase):
    def test_quality_filters(self):
        valid = row()
        self.assertTrue(eligible(valid))
        for key, value in [('license_conflict', 'True'), ('is_draft', 'True'), ('has_paywall', 'True'), ('has_lyrics', 'True'), ('rating', '4.4'), ('n_ratings', '4'), ('n_tracks', '1'), ('n_notes', '99'), ('composer_name', 'unknown'), ('composer_name', '\u00aa'), ('song_name', '\u00aa -')]:
            with self.subTest(key=key): self.assertFalse(eligible({**valid, key: value}))

    def test_safe_extraction_and_metadata_deduplication(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); csvfile = base / 'source.csv'; archive = base / 'mid.tar.gz'; dest = base / 'stage'
            valid = row()
            # The first copy of 'Test' is unusable (no score id): it must not hide the valid one after it.
            rows = [{**valid, 'metadata': './metadata/draft.json', 'rating': '5'}, valid, {**valid, 'mid': './mid/duplicate.mid'}, {**valid, 'song_name': 'Symlink', 'mid': './mid/link.mid', 'metadata': './metadata/124.json'}, {**valid, 'song_name': 'Escape', 'mid': '../escape.mid', 'metadata': './metadata/125.json'}, {**valid, 'song_name': 'Malformed', 'rating': 'n/a'}]
            with csvfile.open('w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=valid.keys()); writer.writeheader(); writer.writerows(rows)
            with tarfile.open(archive, 'w:gz') as f:
                for name in ['mid/test.mid', '../escape.mid']:
                    member = tarfile.TarInfo(name); member.size = 14; f.addfile(member, io.BytesIO(b'MThd' + b'0' * 10))
                member = tarfile.TarInfo('mid/link.mid'); member.type = tarfile.SYMTYPE; member.linkname = '/etc/passwd'; f.addfile(member)
            select(csvfile, archive, dest, 100)
            manifest = json.loads((dest / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual([r['scoreId'] for r in manifest], ['123'])
            self.assertEqual(sorted(p.name for p in dest.iterdir()), ['manifest.json', 'test.mid'])
            self.assertFalse((base / 'escape.mid').exists())

if __name__ == '__main__': unittest.main()
