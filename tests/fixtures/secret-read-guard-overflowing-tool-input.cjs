'use strict';

// Preloaded into the secret-read guard by tests/gsd-secret-read-guard.test.cjs
// (#5784): a payload whose text holds OVERFLOWING_INPUT parses to an object
// whose `tool_input` overflows the stack when it is read. main() reads it
// after it has the tool name, inside the try its outer catch guards, so the
// row's Read payload raises a real RangeError on a tool that is not Bash.
const parse = JSON.parse;
JSON.parse = function parseWithOverflowingInput(text, ...rest) {
  const data = parse.call(this, text, ...rest);
  if (typeof text === 'string' && text.includes('OVERFLOWING_INPUT')) {
    Object.defineProperty(data, 'tool_input', { get() { return this.tool_input; } });
  }
  return data;
};
