/**
 * Shared VAD constants.
 *
 * Kept dependency-free so the segmentation logic can be imported and tested
 * in plain Node without pulling in onnxruntime-web.
 */

export const VAD_SAMPLE_RATE = 16000;

/** Silero VAD v5 operates on fixed 512-sample windows (32ms at 16 kHz). */
export const VAD_WINDOW_SIZE = 512;

/**
 * Silero v5 expects the tail of the previous window prepended to each input,
 * so the tensor it actually receives is 576 samples, not 512.
 *
 * This is not optional. The ONNX input axis is dynamic, so passing a bare 512
 * samples runs without any error and returns near-zero for real speech —
 * a silent failure that looks exactly like "the microphone is not working".
 */
export const VAD_CONTEXT_SIZE = 64;
