import { findThymeleafAttributes } from "./htmlParser";

export interface UnclosedExpression {
  readonly start: number;
  readonly end: number;
}

export interface ThymeleafExpression {
  readonly prefix: string;
  readonly body: string;
  readonly start: number;
  readonly end: number;
  readonly closed: boolean;
}

const EXPRESSION_PREFIXES = new Set(["$", "*", "#", "@", "~"]);

export function findThymeleafExpressions(text: string): ThymeleafExpression[] {
  const expressions: ThymeleafExpression[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (!isExpressionStart(text, index)) continue;
    const closingBrace = findExpressionEnd(text, index + 1);
    const closed = closingBrace >= 0;
    const bodyEnd = closed ? closingBrace : text.length;
    expressions.push({
      prefix: text[index],
      body: text.slice(index + 2, bodyEnd),
      start: index,
      end: closed ? closingBrace + 1 : text.length,
      closed
    });
    if (!closed) break;
    index = closingBrace;
  }
  return expressions;
}

export function findUnclosedExpressions(text: string): UnclosedExpression[] {
  return findThymeleafExpressions(text)
    .filter(({ closed }) => !closed)
    .map(({ start, end }) => ({ start, end }));
}

export function findUnclosedAttributeExpressions(text: string): UnclosedExpression[] {
  const unclosedExpressions: UnclosedExpression[] = [];

  for (const attribute of findThymeleafAttributes(text)) {
    for (const expression of findUnclosedExpressions(attribute.value)) {
      unclosedExpressions.push({
        start: attribute.valueStart + expression.start,
        end: attribute.valueStart + expression.end
      });
    }
  }

  return unclosedExpressions;
}

export interface InlineExpression {
  readonly kind: "escaped" | "unescaped";
  readonly start: number;
  readonly end: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly content: string;
}

export function findInlineExpressions(text: string): InlineExpression[] {
  const inlines: InlineExpression[] = [];
  let index = 0;
  while (index < text.length - 1) {
    if (text[index] === "[" && text[index + 1] === "[") {
      const open = index;
      const contentStart = open + 2;
      const close = text.indexOf("]]", contentStart);
      if (close >= 0) {
        inlines.push({
          kind: "escaped",
          start: open,
          end: close + 2,
          contentStart,
          contentEnd: close,
          content: text.slice(contentStart, close)
        });
        index = close + 2;
        continue;
      }
    } else if (text[index] === "[" && text[index + 1] === "(") {
      const open = index;
      const contentStart = open + 2;
      const close = text.indexOf(")]", contentStart);
      if (close >= 0) {
        inlines.push({
          kind: "unescaped",
          start: open,
          end: close + 2,
          contentStart,
          contentEnd: close,
          content: text.slice(contentStart, close)
        });
        index = close + 2;
        continue;
      }
    }
    index += 1;
  }
  return inlines;
}

export function findUnclosedInlineExpressions(text: string): UnclosedExpression[] {
  const unclosed: UnclosedExpression[] = [];
  let index = 0;
  while (index < text.length - 1) {
    if (text[index] === "[" && (text[index + 1] === "[" || text[index + 1] === "(")) {
      const isSquare = text[index + 1] === "[";
      const closeStr = isSquare ? "]]" : ")]";
      const contentStart = index + 2;
      const close = text.indexOf(closeStr, contentStart);
      if (close < 0) {
        unclosed.push({ start: index, end: text.length });
        break;
      } else {
        const content = text.slice(contentStart, close);
        for (const expression of findUnclosedExpressions(content)) {
          unclosed.push({
            start: contentStart + expression.start,
            end: contentStart + expression.end
          });
        }
        index = close + 2;
        continue;
      }
    }
    index += 1;
  }
  return unclosed;
}

function isExpressionStart(text: string, index: number): boolean {
  return EXPRESSION_PREFIXES.has(text[index] ?? "") && text[index + 1] === "{";
}

function findExpressionEnd(text: string, openingBraceIndex: number): number {
  let braceDepth = 1;
  let quote: "'" | '"' | undefined;

  for (let index = openingBraceIndex + 1; index < text.length; index += 1) {
    const character = text[index];
    const previousCharacter = text[index - 1];

    if (quote) {
      if (character === quote && previousCharacter !== "\\") {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return index;
      }
    }
  }

  return -1;
}
