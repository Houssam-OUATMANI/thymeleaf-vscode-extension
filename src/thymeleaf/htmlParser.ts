export interface ThymeleafHtmlAttribute {
  readonly name: string;
  readonly sourceName: string;
  readonly nameStart: number;
  readonly nameEnd: number;
  readonly value: string;
  readonly valueStart: number;
}

export function findThymeleafAttributes(text: string): ThymeleafHtmlAttribute[] {
  const attributes: ThymeleafHtmlAttribute[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const openingTag = text.indexOf("<", cursor);
    if (openingTag < 0) break;

    if (text.startsWith("<!--", openingTag)) {
      const commentEnd = text.indexOf("-->", openingTag + 4);
      cursor = commentEnd < 0 ? text.length : commentEnd + 3;
      continue;
    }

    const nextCharacter = text[openingTag + 1];
    if (!nextCharacter || nextCharacter === "/" || nextCharacter === "!" || nextCharacter === "?") {
      cursor = openingTag + 1;
      continue;
    }

    const tagEnd = findTagEnd(text, openingTag + 1);
    if (tagEnd < 0) break;
    readTagAttributes(text, openingTag + 1, tagEnd, attributes);
    const tagName = readTagName(text, openingTag + 1, tagEnd).toLowerCase();
    cursor = tagEnd + 1;
    if (tagName === "script" || tagName === "style") {
      const closingTag = text.toLowerCase().indexOf(`</${tagName}`, cursor);
      if (closingTag < 0) break;
      const closingEnd = text.indexOf(">", closingTag);
      cursor = closingEnd < 0 ? text.length : closingEnd + 1;
    }
  }

  return attributes;
}

const HTML5_VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"
]);

export function isVoidElement(tagName: string): boolean {
  return HTML5_VOID_ELEMENTS.has(tagName.toLowerCase());
}

export function findTagEnd(text: string, start: number): number {
  let quote: "'" | '"' | undefined;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote && text[index - 1] !== "\\") quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

export function readTagName(text: string, start: number, end: number): string {
  let cursor = start;
  while (cursor < end && !/\s/.test(text[cursor])) cursor += 1;
  return text.slice(start, cursor);
}

function readTagAttributes(
  text: string,
  start: number,
  end: number,
  attributes: ThymeleafHtmlAttribute[]
): void {
  let cursor = start;
  while (cursor < end && !/\s/.test(text[cursor])) cursor += 1;

  while (cursor < end) {
    while (cursor < end && (/\s/.test(text[cursor]) || text[cursor] === "/")) cursor += 1;
    const nameStart = cursor;
    while (cursor < end && !/[\s=/>]/.test(text[cursor])) cursor += 1;
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const name = text.slice(nameStart, cursor);
    const nameEnd = cursor;
    while (cursor < end && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] !== "=") continue;
    cursor += 1;
    while (cursor < end && /\s/.test(text[cursor])) cursor += 1;

    const quote = text[cursor] === "'" || text[cursor] === '"' ? text[cursor] : undefined;
    if (quote) cursor += 1;
    const valueStart = cursor;
    if (quote) {
      while (cursor < end && text[cursor] !== quote) cursor += 1;
    } else {
      while (cursor < end && !/[\s>]/.test(text[cursor])) cursor += 1;
    }

    let canonicalName = name;
    if (name.startsWith("data-th-")) {
      canonicalName = `th:${name.slice("data-th-".length)}`;
    } else if (name.startsWith("data-sec-")) {
      canonicalName = `sec:${name.slice("data-sec-".length)}`;
    } else if (name.startsWith("data-layout-")) {
      canonicalName = `layout:${name.slice("data-layout-".length)}`;
    }

    if (
      canonicalName.startsWith("th:") ||
      canonicalName.startsWith("sec:") ||
      canonicalName.startsWith("layout:")
    ) {
      attributes.push({
        name: canonicalName,
        sourceName: name,
        nameStart,
        nameEnd,
        value: text.slice(valueStart, cursor),
        valueStart
      });
    }
    if (quote && text[cursor] === quote) cursor += 1;
  }
}
