# Synthetic JPEG fixtures

These files contain constant pixels generated locally with Pillow; they contain no real photographs or private data. Pillow is needed only to regenerate them, not to run tests.

- `progressive.jpg`: RGB 2×3, color `(120,180,60)`, quality80, progressive.
- `grayscale.jpg`: grayscale 2×3, value120, quality80.
- `restart.jpg`: RGB 16×16, the same color, quality80, subsampling0, `restart_marker_blocks=1`; DRI/RST markers were verified after generation.
- `grayscale-restart.jpg`: grayscale16×16, value120, quality80, restart interval3 with a short final interval.
- `progressive-restart.jpg`: RGB16×16, color `(120,180,60)`, quality80, progressive/subsampling0, restart interval3.

Tests cover mandatory scans/component coverage, byte stuffing, segment bounds, restart continuity and exact terminal EOI alongside bounded pixel decoding. Marker framing follows [ITU-T T.81 Annex B](https://www.w3.org/Graphics/JPEG/itu-t81.pdf). This is not camera-authenticity, metadata-stripping, exhaustive JPEG-conformance or deployed Worker-performance evidence.

Root `npm ci` runs `.github/scripts/strict_jpeg_decoder.mjs` to patch pinned jpeg-js 0.4.4's permissive scan-byte skipping. The small patch requires complete image blocks, immediate scan-marker consumption and all-one final-byte padding; an unused stuffed byte is rejected too. Both original and patched decoder sources are SHA-256 checked; unknown versions/sources fail installation rather than silently weakening validation. It is idempotent. Upgrade the codec only with a new review of this patch and the malformed-image regressions. Runtime builds use the patched decoder; `--ignore-scripts` is not a supported install path. No new patching dependency or native runtime is needed.

The patch also stops the one-component loop at its expected block count, preserving legal short final restart intervals for grayscale and progressive scans. It does not silently add missing blocks or relax malformed-image validation.
