import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseJavaVariableTypeFromHover } from "../javaTypeUtils";

test("parses concrete generic local-variable types from Java hover markdown", () => {
  assert.equal(
    parseJavaVariableTypeFromHover(
      ["```java\nPage<demo.Category> categories\n```"],
      "categories"
    ),
    "Page<demo.Category>"
  );
});

test("does not mistake another hover symbol for the requested variable", () => {
  assert.equal(
    parseJavaVariableTypeFromHover(["```java\nPage<Category> results\n```"], "categories"),
    undefined
  );
});
