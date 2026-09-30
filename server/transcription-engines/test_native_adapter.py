import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('native_adapter', Path(__file__).with_name('transcribe-nemo.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeWordTimingTests(unittest.TestCase):
    def test_streaming_padding_cannot_assign_words_to_the_next_chunk(self):
        raw = {'words': [
            {'word':'last', 'start':179.8, 'end':180.24},
            {'word':'padding', 'start':180.48, 'end':180.56},
        ]}
        self.assertEqual(native.normalized_words(raw, 180, 180), [
            {'text':'last', 'start':359.8, 'end':360}])

    def test_only_exact_duplicate_events_are_removed_not_spoken_repetitions(self):
        raw = {'words': [
            {'word':'yes', 'start':1, 'end':1.08},
            {'word':'yes', 'start':1, 'end':1.08},
            {'word':'yes', 'start':1.2, 'end':1.28},
        ]}
        self.assertEqual(len(native.normalized_words(raw, 0, 10)), 2)

    def test_invalid_times_fail_before_publication(self):
        for start, end in [(2,1), (float('nan'),2), (1,float('inf'))]:
            with self.assertRaises(ValueError):
                native.normalized_words({'words':[{'word':'bad','start':start,'end':end}]}, 0, 10)


if __name__ == '__main__':
    unittest.main()
