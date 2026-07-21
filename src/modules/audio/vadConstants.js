/**
 * Shared VAD constants.
 *
 * Kept dependency-free so the segmentation logic can be imported and tested
 * in plain Node without pulling in onnxruntime-web.
 */

export const VAD_SAMPLE_RATE = 16000;

/** Silero VAD v5 operates on fixed 512-sample windows (32ms at 16 kHz). */
export const VAD_WINDOW_SIZE = 512;
