# Synthetic JPEG fixtures

These files contain constant pixels generated locally with Pillow; they contain no real photographs or private data. Pillow is needed only to regenerate them, not to run tests.

- `progressive.jpg`: RGB 2×3, color `(120,180,60)`, quality80, progressive.
- `grayscale.jpg`: grayscale 2×3, value120, quality80.
- `restart.jpg`: RGB 16×16, the same color, quality80, subsampling0, `restart_marker_blocks=1`; DRI/RST markers were verified after generation.

Tests cover mandatory scans/component coverage, byte stuffing, segment bounds, restart continuity and exact terminal EOI alongside bounded pixel decoding. Marker framing follows [ITU-T T.81 Annex B](https://www.w3.org/Graphics/JPEG/itu-t81.pdf). This is not camera-authenticity, metadata-stripping, exhaustive JPEG-conformance or deployed Worker-performance evidence.
