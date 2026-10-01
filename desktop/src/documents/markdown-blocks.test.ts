import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlocks } from "./markdown-blocks.ts";

test("code fences with C++, titles, or tildes finish and retain their content", () => {
  assert.deepEqual(parseBlocks('```c++ title="example"\nint main() {}\n```\nAfter'), [
    { kind: "code", lang: "c++", text: "int main() {}" },
    { kind: "paragraph", text: "After" },
  ]);
  assert.deepEqual(parseBlocks("~~~shell\necho hi\n~~~~"), [{ kind: "code", lang: "shell", text: "echo hi" }]);
});
test("long fences can contain shorter fences and incomplete fences preserve the tail", () => {
  assert.deepEqual(parseBlocks("````markdown\n```js\nexample\n```\n````"), [{ kind: "code", lang: "markdown", text: "```js\nexample\n```" }]);
  assert.deepEqual(parseBlocks("```rust\nlast line"), [{ kind: "code", lang: "rust", text: "last line" }]);
  assert.deepEqual(parseBlocks("```bad`info\ntext"), [{ kind: "paragraph", text: "```bad`info text" }]);
});
test("ordinary headings, lists and following prose remain separate blocks", () => {
  assert.deepEqual(parseBlocks("# Heading\n\n- One\n- Two\n\nTail"), [
    { kind: "heading", level: 1, text: "Heading" },
    { kind: "ul", items: ["One", "Two"] },
    { kind: "paragraph", text: "Tail" },
  ]);
});
