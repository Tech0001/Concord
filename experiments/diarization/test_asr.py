import unittest

from asr import bridge_module, normalized_result
from asr_report import matching_cpu


class NativeTranscriptionAdapterTests(unittest.TestCase):
    def test_word_times_are_shifted_across_concord_chunks(self):
        chunks = [(0, {'text': 'First.', 'words': [{'word':'First.', 'start':1.0, 'end':1.5}]}),
                  (180, {'text': 'Next.', 'words': [{'word':'Next.', 'start':0.5, 'end':1.0}]})]
        result = normalized_result(chunks, 360, bridge_module(), 'test/nemotron', 'en-US')
        self.assertEqual(result['model'], 'test/nemotron')
        self.assertEqual(result['language'], 'en-US')
        self.assertEqual(result['words'], [
            {'text':'First.', 'start':1.0, 'end':1.5},
            {'text':'Next.', 'start':180.5, 'end':181.0}])
        self.assertEqual(result['text'], 'First. Next.')
        self.assertEqual(result['segment_count'], 2)
        self.assertEqual(result['duration_seconds'], 360)

    def test_silence_remains_empty_instead_of_inventing_text(self):
        result = normalized_result([(0, {'text':'', 'words':[]})], 60, bridge_module())
        self.assertEqual(result['words'], [])
        self.assertEqual(result['segments'], [])
        self.assertEqual(result['text'], '')

    def test_backend_comparison_does_not_mix_models_or_language_modes(self):
        def config(model, mode='offline', language='en-US'):
            return dict(engine='native', device='cpu', model=model, mode=mode, language=language)
        runs = [('parakeet', config('parakeet')), ('streaming', config('nemotron', 'streaming')),
                ('auto', config('nemotron', language='auto')), ('matched', config('nemotron'))]
        gpu = dict(config('nemotron'), device='vulkan:0')
        self.assertEqual(matching_cpu(runs, gpu)[0], 'matched')
        self.assertIsNone(matching_cpu(runs[:-1], gpu))


if __name__ == '__main__':
    unittest.main()
