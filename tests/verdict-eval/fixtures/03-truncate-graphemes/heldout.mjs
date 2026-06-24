import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { truncate } = await import(pathToFileURL(process.env.GSD_SUT).href);

// The non-inferable edge: "character" = grapheme. A code-unit slice splits an emoji's surrogate
// pair (a broken half-character) or a ZWJ sequence. All code points are written as explicit escapes
// so the committed source carries no invisible joiner characters.
test('does not split an emoji at the boundary', () => {
  // graphemes: ['a', U+1F600, 'b'] -> first 2 graphemes = 'a' + grinning face
  assert.equal(truncate('a\u{1F600}b', 2), 'a\u{1F600}');
});
test('treats a ZWJ family emoji as one grapheme', () => {
  // man + ZWJ + woman + ZWJ + girl is ONE grapheme (many code units) -> first 1 grapheme keeps it whole
  const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
  assert.equal(truncate(`${family} family`, 1), family);
});
