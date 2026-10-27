// jpeg-js 0.4.4 skips unconsumed scan bytes; require complete scans and legal padding.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
assert.equal(require('jpeg-js/package.json').version, '0.4.4', 'Re-review the strict JPEG patch before upgrading.');
const path = require.resolve('jpeg-js/lib/decoder.js');
const digest = (source) => createHash('sha256').update(source).digest('hex');
let source = readFileSync(path, 'utf8');
const original = 'a3f175fd6f62d142aad94d3bd90f3a30be4e076baf9b6a6fa31c8e84d9d4aa9f';
const strict = '882a8517b8b3d5b394716308f96426ef187e1866d4c73a59f75007c66174b993';
if (digest(source) !== strict) {
  assert.equal(digest(source), original, 'Unknown JPEG decoder source; refusing an unreviewed patch.');
  const start = source.indexOf('      if (mcu === mcuExpected) {\n        // Skip trailing bytes at the end of the scan');
  const end = source.indexOf('\n      // find marker', start);
  assert(start >= 0 && end > start);
  source = source.slice(0, start) + `      if (bitsCount > 0 && (bitsData & ((1 << bitsCount) - 1)) !== ((1 << bitsCount) - 1)) {
        throw new Error("Invalid JPEG entropy padding");
      }
` + source.slice(end);
  source = source.replace('    return offset - startOffset;',
    '    if (mcu !== mcuExpected) throw new Error("Incomplete JPEG scan");\n    return offset - startOffset;');
  source = source.replace('if (marker < 0xFF00)', 'if (marker <= 0xFF00)');
  source = source.replace('          decodeBlock(component, decodeFn, mcu);\n          mcu++;',
    '          decodeBlock(component, decodeFn, mcu);\n          mcu++;\n          if (mcu === mcuExpected) break;');
  assert.equal(digest(source), strict, 'JPEG patch output did not match the reviewed source.');
  writeFileSync(path, source);
}
