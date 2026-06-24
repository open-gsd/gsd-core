# Task 03 — `truncate(str, max)`

Truncate a string to at most `max` characters.

## must_haves
1. Export a named function `truncate(str, max)` returning a string.
2. If the input has `max` characters or fewer, return it unchanged.
3. If longer, return only the first `max` characters.
4. Coerce non-string input to a string first.

> NON-INFERABLE EDGE (corpus documentation — STRIP before showing a critic): the spec
> intentionally does NOT define "character" precisely. Whether a "character" is a UTF-16 code unit
> or a user-perceived grapheme is the omitted edge. Slice: domain-knowledge (grapheme clustering is
> known Unicode correctness a capable model can surface when prompted to disconfirm; code-unit
> slicing is simply wrong, not a free choice).

## visible test cases (the executor ran these)
- `truncate('hello world', 5) === 'hello'`
- `truncate('hi', 5) === 'hi'`
