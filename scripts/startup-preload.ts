/** Preload for startup profiling: stamps process-start before the entry module graph loads. */
(globalThis as { __amuxStartupT0?: number }).__amuxStartupT0 = performance.now();
