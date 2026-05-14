// AudioWorklet processor source. Inlined as a string and turned into a
// Blob URL at runtime by useVoiceRecorder() — the simplest way to load
// a worklet without setting up a separate static asset path in Vite.
//
// What it does on each render quantum (128 frames @ context sample rate):
//
//   1. Average the input channels into mono (most mics are mono anyway
//      but Bluetooth headsets can be stereo).
//   2. Downsample from the AudioContext's native rate to 16 kHz using a
//      naive linear-interp resampler. FluidAudio is forgiving about
//      input quality; no need for a proper FIR filter here.
//   3. Convert each float sample in [-1, 1] to a 16-bit signed int.
//   4. Buffer until we have ~10 seconds, then post the Int16Array back
//      to the main thread for upload.
//
// Why not just send native-rate float32 and let the server resample:
// network bandwidth (96 kHz float32 stereo = 768 KB/s vs 16 kHz int16
// mono = 32 KB/s). Localhost can handle either fine, but if LAN access
// is on we don't want to assume the user's phone has localhost bandwidth.

export const PCM_WORKLET_SOURCE = /* js */ `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.chunkSeconds = 5;
    // Resampling state: fractional sample position into the input we're
    // reading from. Carried across blocks so chunk boundaries don't
    // introduce clicks.
    this.inputPosition = 0;
    // Output buffer for int16 samples — grows to ~chunkSeconds worth
    // and then flushes via port.postMessage.
    this.outputBuffer = new Int16Array(this.targetRate * this.chunkSeconds);
    this.outputIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Down-mix to mono. Most input is already mono; this is cheap insurance.
    const frameCount = input[0].length;
    const mono = new Float32Array(frameCount);
    for (let ch = 0; ch < input.length; ch++) {
      const channel = input[ch];
      for (let i = 0; i < frameCount; i++) mono[i] += channel[i];
    }
    if (input.length > 1) {
      for (let i = 0; i < frameCount; i++) mono[i] /= input.length;
    }

    // Resample to 16 kHz via linear interpolation. sampleRate is a global
    // exposed in AudioWorkletGlobalScope.
    const step = sampleRate / this.targetRate;
    let pos = this.inputPosition;
    while (pos < frameCount) {
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, frameCount - 1);
      const frac = pos - i0;
      const sample = mono[i0] * (1 - frac) + mono[i1] * frac;
      // Clamp + convert to int16. Math.max/min is faster than Math.round
      // followed by a clip — and saturating to ±32767 prevents wraparound
      // on loud peaks.
      const clipped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      this.outputBuffer[this.outputIndex++] = clipped < 0
        ? clipped * 32768
        : clipped * 32767;

      if (this.outputIndex >= this.outputBuffer.length) {
        // Full chunk — ship it. Transfer the buffer to avoid a copy; we
        // allocate a fresh one for the next chunk.
        this.port.postMessage(this.outputBuffer.buffer, [this.outputBuffer.buffer]);
        this.outputBuffer = new Int16Array(this.targetRate * this.chunkSeconds);
        this.outputIndex = 0;
      }
      pos += step;
    }
    // Carry the fractional remainder into the next process() call.
    this.inputPosition = pos - frameCount;
    return true;
  }

  // Called via port.postMessage({type:"flush"}) when recording stops.
  // Ships whatever partial buffer is sitting around.
  static get parameterDescriptors() { return []; }
}

// Static handler to receive the "flush" message — registered separately
// per processor instance via the constructor.
registerProcessor("pcm-downsampler", class extends PcmDownsampler {
  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e && e.data && e.data.type === "flush") {
        if (this.outputIndex > 0) {
          const partial = new Int16Array(this.outputBuffer.buffer, 0, this.outputIndex);
          // Copy into a fresh ArrayBuffer because we can't transfer a slice.
          const copy = new Int16Array(partial);
          this.port.postMessage(copy.buffer, [copy.buffer]);
          this.outputIndex = 0;
        }
        this.port.postMessage({ type: "flushed" });
      }
    };
  }
});
`;
