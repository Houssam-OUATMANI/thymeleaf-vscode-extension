import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findThymeleafAttributes } from "../thymeleaf/htmlParser";

test("finds Thymeleaf attributes but ignores comments and script contents", () => {
  const html = `<!-- <div th:missing="comment"> -->
<div th:text="\${user.name}" data-id="1"></div>
<script>const example = '<span th:fake="script">';</script>`;
  const attributes = findThymeleafAttributes(html);

  assert.equal(attributes.length, 1);
  assert.equal(attributes[0].name, "th:text");
  assert.equal(attributes[0].sourceName, "th:text");
  assert.equal(attributes[0].value, "${user.name}");
  assert.equal(html.slice(attributes[0].nameStart, attributes[0].nameEnd), "th:text");
});

test("recognizes data-th attributes as their th equivalents", () => {
  const html = `<div data-th-text="\${user.name}" data-th-each="user : \${users}"></div>`;
  const attributes = findThymeleafAttributes(html);

  assert.deepEqual(attributes.map(({ name, sourceName }) => [name, sourceName]), [
    ["th:text", "data-th-text"],
    ["th:each", "data-th-each"]
  ]);
  assert.ok(attributes.every(({ nameStart, nameEnd }) =>
    html.slice(nameStart, nameEnd).startsWith("data-th-")
  ));
});
