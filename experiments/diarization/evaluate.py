#!/usr/bin/env python3
"""Run prepared cases sequentially, keeping native and embedding GPU use separate."""
import argparse
from pathlib import Path
import subprocess
from types import SimpleNamespace

import lab


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=lab.DEFAULT_ROOT)
    p.add_argument('--cases', nargs='+', required=True)
    p.add_argument('--device', default='cpu')
    p.add_argument('--geometry', choices=['recording','live'], default='recording')
    p.add_argument('--embedding-device', choices=['cuda', 'cpu'], default='cuda')
    p.add_argument('--embedding-python', default=str(Path.home()/'.local/share/concord/venv/bin/python'))
    p.add_argument('--runtime', default=str(lab.CACHE/'NeMo-Speech.cpp/build-lab/bin/nemo-speech'))
    p.add_argument('--model', default=str(lab.CACHE/'models/nemotron-3/Nemotron-3-Diarization.q8_0.gguf'))
    a = p.parse_args()
    for case in a.cases:
        lab.run(SimpleNamespace(**vars(a), case=case, mode='native', window_seconds=120, overlap_seconds=10))
    for case in a.cases:
        run_id = lab.run(SimpleNamespace(**vars(a), case=case, mode='windowed', window_seconds=120, overlap_seconds=10))
        subprocess.run([a.embedding_python, str(Path(__file__).with_name('cluster.py')),
                        '--root', str(a.root), '--run', run_id, '--device', a.embedding_device], check=True)
    lab.report(a)


if __name__ == '__main__':
    main()
