import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  findUnclosedAttributeExpressions,
  findUnclosedExpressions
} from "../thymeleaf/expressions";

test("finds an expression without a closing brace", () => {
  assert.deepEqual(findUnclosedExpressions('<p th:text="${user.name"></p>'), [
    { start: 12, end: 29 }
  ]);
});

test("ignores closing braces inside quoted values", () => {
  assert.deepEqual(findUnclosedExpressions('th:text="${#strings.replace(name, \'}\', \'\')}"}'), []);
});

test("supports nested braces and multiple expression types", () => {
  assert.deepEqual(findUnclosedExpressions('th:text="${map[\'key\']}" th:href="@{/users/{id}(id=${id})}"'), []);
});

test("reports only the first unterminated expression", () => {
  assert.deepEqual(findUnclosedExpressions('th:text="${first" th:href="@{/second"'), [
    { start: 9, end: 37 }
  ]);
});

test("reports unclosed expressions in Thymeleaf attributes with document offsets", () => {
  assert.deepEqual(findUnclosedAttributeExpressions('<p th:text="${user"></p>'), [
    { start: 12, end: 18 }
  ]);
});

test("does not report JavaScript template strings as Thymeleaf expressions", () => {
  assert.deepEqual(
    findUnclosedAttributeExpressions('<script>const value = `${unfinished`;</script>'),
    []
  );
});
