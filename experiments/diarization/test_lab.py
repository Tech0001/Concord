import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

from lab import connect_lab, stitch, windows, summarize


class IsolationAndTimelineTests(unittest.TestCase):
    def test_refuses_archive_alias_without_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'archive.db'
            with sqlite3.connect(archive) as db:
                db.execute('CREATE TABLE sentinel(value TEXT)')
                db.execute("INSERT INTO sentinel VALUES ('untouched')")
            original = archive.read_bytes()
            root = Path(folder) / 'lab'
            root.mkdir()
            (root / 'lab.sqlite3').symlink_to(archive)
            with self.assertRaises(ValueError):
                connect_lab(root, archive)
            self.assertEqual(archive.read_bytes(), original)

    def test_refuses_production_schema_at_lab_path(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'lab.sqlite3'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE video_queue(id TEXT)')
            with self.assertRaises(ValueError):
                connect_lab(folder)
            with sqlite3.connect(path) as db:
                self.assertFalse(db.execute("SELECT name FROM sqlite_master WHERE name='runs'").fetchall())

    def test_overlap_ownership_clips_and_discards_duplicates(self):
        turns = [{'start': 0, 'end': 8, 'speaker': 1},
                 {'start': 8, 'end': 15, 'speaker': 2},
                 {'start': 119, 'end': 123, 'speaker': 3}]
        self.assertEqual(stitch(turns, 110, 120, 230), [
            {'start': 120, 'end': 125, 'speaker': '2'},
            {'start': 229, 'end': 230, 'speaker': '3'}])

    def test_windows_cover_end_without_duplicate_tail(self):
        self.assertEqual(list(windows(231, 120, 10)), [(0,120),(110,230),(220,231)])
        self.assertEqual(list(windows(120, 120, 10)), [(0,120)])
        with self.assertRaises(ValueError):
            list(windows(20, 10, 10))

    def test_same_person_multiple_baseline_labels_remains_one_name(self):
        output = [{'start':0,'end':10,'speaker':'S0'}]
        old = [{'start':0,'end':4,'speaker':'Ryan'}, {'start':4,'end':10,'speaker':'Ryan'}]
        summary = summarize(output, old)
        self.assertEqual(summary['speakers']['S0']['baseline_overlap'], {'Ryan':10})
        self.assertIn('not ground truth', summary['reference_kind'])

    def test_reference_comparison_exposes_merges_and_splits(self):
        old = [{'start':0,'end':20,'speaker':'A'}, {'start':20,'end':40,'speaker':'B'},
               {'start':40,'end':60,'speaker':'A'}, {'start':60,'end':80,'speaker':'A'}]
        output = [{'start':0,'end':40,'speaker':'S0'}, {'start':40,'end':60,'speaker':'S1'},
                  {'start':60,'end':80,'speaker':'S2'}]
        ref = summarize(output, old)['reference_comparison']
        self.assertEqual(ref['tracks_with_two_substantial_reference_voices'], ['S0'])
        self.assertEqual(ref['people_not_dominant_in_any_substantial_track'], ['B'])
        self.assertEqual(ref['reference_people_split_across_substantial_tracks'], {'A':['S0','S1','S2']})


if __name__ == '__main__':
    unittest.main()
