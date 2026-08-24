# First-run graphics preset benchmark
> **Historical benchmark:** The pre-rebrand output filename and capture port
> are retained verbatim so the recorded measurement remains reproducible.


Captured 2026-08-03 for the first-browser-use graphics chooser.

## Method

The reproducible runner is `scripts/benchmark-first-run-graphics.mjs`:

```sh
node scripts/benchmark-first-run-graphics.mjs \
  --url http://127.0.0.1:5299 \
  --out /tmp/simforge-first-run-graphics.json
```

- Machine: Apple M5 Pro, 15 logical CPUs, 24 GB unified memory, macOS/Darwin 25.3.0.
- Browser: system Chrome, 1360 × 850 viewport, 4-second renderer benchmark.
- Maps: Easterbrook Discovery School (127 MB source tree, smallest shipped map) and Yale Street (3.6 GB source tree, largest shipped map).
- Hardware condition: Chrome launched with the GPU blocklist ignored and GPU rasterization enabled. WebGL reported ANGLE Metal on Apple M5 Pro.
- Software condition: Chrome launched with GPU disabled and SwiftShader requested. WebGL reported Vulkan SwiftShader and `software: true`.
- Every run used a new browser context and CDP-disabled HTTP cache. Timing starts with the preset click. Transfer bytes accumulate until the settled/timeout sample and benchmark complete.
- The renderer's `residentBytes` is a decoded resident scene allocation estimate, not direct physical VRAM. Chrome does not expose trustworthy per-tab VRAM here.
- Process memory aggregates steady and peak RSS for the Chrome processes reported by that browser session. It includes browser overhead and is not a GPU-memory measurement.

## Raw summary

| Condition | Map | Preset | Cold transfer | Road visible | Settled/sample | Resident estimate | JS heap | Process steady / peak | Display fps | p95 frame |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Metal | Easterbrook | Ultra Low | 22.9 MB | 728 ms | 2.1 s | 10.5 MB | 77.7 MB | 1,398 / 1,398 MB | 120.5 | 10.3 ms |
| Metal | Easterbrook | Minimal | 54.9 MB | 1,423 ms | 5.1 s | 369.5 MB | 131.1 MB | 1,711 / 2,140 MB | 114.3 | 10.0 ms |
| Metal | Easterbrook | High | 61.7 MB | 1,125 ms | 3.1 s | 376.7 MB | 123.1 MB | 1,712 / 2,125 MB | 107.7 | 10.8 ms |
| Metal | Yale | Ultra Low | 41.4 MB | 365 ms | 3.3 s | 47.3 MB | 128.0 MB | 1,615 / 1,615 MB | 114.9 | 10.3 ms |
| Metal | Yale | Minimal | 533.5 MB | 1,248 ms | 6.3 s | 639.6 MB | 595.2 MB | 2,027 / 2,369 MB | 106.8 | 10.5 ms |
| Metal | Yale | High | 816.1 MB | 1,157 ms | 62.4 s* | 1,600.6 MB | 182.6 MB | 2,431 / 2,505 MB | 71.7 | 30.9 ms |
| SwiftShader | Easterbrook | Ultra Low | 17.7 MB | 563 ms | 2.1 s | 10.5 MB | 96.3 MB | 1,479 / 1,555 MB | 39.2 | 32.5 ms |
| SwiftShader | Easterbrook | Minimal | 44.9 MB | 4,170 ms | 12.4 s | 369.5 MB | 117.6 MB | 2,222 / 2,577 MB | 14.7 | 59.5 ms |
| SwiftShader | Easterbrook | High | 43.8 MB | 2,576 ms | 28.5 s | 376.7 MB | 77.8 MB | 2,172 / 2,690 MB | 0.4 | n/a† |
| SwiftShader | Yale | Ultra Low | 57.8 MB | 984 ms | 6.8 s | 47.2 MB | 133.6 MB | 1,962 / 1,962 MB | 16.2 | 124.6 ms |
| SwiftShader | Yale | Minimal | 454.9 MB | 5,079 ms | 66.3 s* | 628.0 MB | 173.7 MB | 2,906 / 3,108 MB | 6.7 | 208.2 ms |
| SwiftShader | Yale | High | 376.7 MB | 3,797 ms | 65.1 s* | 1,337.8 MB | 189.1 MB | 2,810 / 3,389 MB | 1.2 | 1,620.5 ms |

\* Streaming had not quiesced at the 60-second timeout, so the sample was taken after timeout.  
† Chrome delivered too few benchmark frames for a meaningful percentile.

## Chooser guidance

The chooser displays honest min–max cold transfers and renderer resident estimates observed across both rendering conditions and both maps. Recommended GPU memory is deliberately rounded up beyond the observed renderer allocation to leave practical room for framebuffers, browser composition, drivers, actors, and other applications:

| Preset | Measured cold load | Renderer resident estimate | Recommended GPU memory |
|---|---:|---:|---:|
| Ultra Low | 18–58 MB | 11–47 MB | 1 GB |
| Minimal | 45–534 MB | 370–640 MB | 2 GB |
| High | 44–816 MB | 377–1,601 MB | 4 GB |

The counterintuitive overlap in transfer ranges is real: map size, paced streaming, time to quiescence, and software-rendering throughput all affect how much data is requested during the measurement window. These are guidance ranges, not download guarantees.
