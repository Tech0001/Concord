"""Optional numeric tests; run with the existing Concord embedding environment."""
import unittest

try:
    import numpy as np
    import scipy
except ImportError:
    np = None

from cluster import group_local_tracks


@unittest.skipIf(np is None, 'NumPy/SciPy required; use the embedding environment')
class GlobalVoiceGroupingTests(unittest.TestCase):
    def test_more_than_eight_global_voices_with_repeated_local_channels(self):
        segments, embeddings = [], []
        # Sixteen synthetic independent profiles, each in two sessions. This
        # tests grouping capacity, not the model's accuracy on sixteen people.
        for window in range(2):
            for person in range(16):
                segments.append({'start': window*100 + person*3, 'end': window*100 + person*3+2,
                                 'speaker': f'w{window}:{person}'})
                embeddings.append(np.eye(16)[person])
        output = group_local_tracks(segments, np.stack(embeddings), np.ones(32, dtype=bool), 8, 0.1)
        self.assertEqual(len({s['speaker'] for s in output}), 16)
        self.assertEqual([s['speaker'] for s in output[:16]], [s['speaker'] for s in output[16:]])

    def test_short_turns_keep_channel_identity_and_unknown_channels_remain(self):
        segments = [{'start':0, 'end':0.5, 'speaker':'w0:1'},
                    {'start':1, 'end':4, 'speaker':'w0:1'},
                    {'start':5, 'end':5.3, 'speaker':'w0:2'}]
        output = group_local_tracks(segments, np.array([[0,0],[1,0],[0,0]]),
                                    np.array([False,True,False]), 8, 0.3)
        self.assertEqual(output[0]['speaker'], output[1]['speaker'])
        self.assertEqual(output[2]['speaker'], 'unresolved:w0:2')
        self.assertEqual([(s['start'],s['end']) for s in output], [(0,0.5),(1,4),(5,5.3)])

    def test_invalid_embedding_is_not_silently_clustered(self):
        with self.assertRaises(ValueError):
            group_local_tracks([{'start':0,'end':3,'speaker':'w0:1'}],
                               np.array([[float('nan'),0]]), np.array([True]), 8, 0.3)


if __name__ == '__main__':
    unittest.main()
