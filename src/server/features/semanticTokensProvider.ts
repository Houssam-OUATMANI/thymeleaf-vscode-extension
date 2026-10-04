import { SemanticTokens, SemanticTokensBuilder, TextDocument } from "vscode-languageserver/node";
import { findInlineExpressions, findThymeleafExpressions } from "../../thymeleaf/expressions";
import { findThymeleafAttributes } from "../../thymeleaf/htmlParser";
import { findThymesVars, ProjectIndex } from "../projectIndex";
import {
  findEnclosingLoopVariables,
  resolveModelPath
} from "./featureUtils";

export const SEMANTIC_TOKEN_TYPES = [
  "variable",       // 0
  "parameter",      // 1
  "property",       // 2
  "method",         // 3
  "class",          // 4
  "keyword",        // 5
  "string",         // 6
  "number",         // 7
  "operator",       // 8
  "function"        // 9
];

export const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",    // 0 -> 1 << 0 = 1
  "defaultLibrary", // 1 -> 1 << 1 = 2
  "readonly"        // 2 -> 1 << 2 = 4
];

const TOKEN_TYPE_MAP: Record<string, number> = Object.fromEntries(
  SEMANTIC_TOKEN_TYPES.map((type, index) => [type, index])
);

const SPEL_KEYWORDS = new Set([
  "and", "or", "not", "eq", "ne", "lt", "gt", "le", "ge", "div", "mod", "true", "false", "null", "instanceof"
]);

interface RawSemanticToken {
  readonly offset: number;
  readonly length: number;
  readonly typeIndex: number;
  readonly modifierMask: number;
}

export function provideSemanticTokens(
  document: TextDocument,
  index: ProjectIndex
): SemanticTokens {
  const text = document.getText();
  const rawTokens: RawSemanticToken[] = [];

  const template = index.findTemplateByUri(document.uri);
  const templateName = template?.name ?? "";
  const modelAttributes = new Map(index.modelAttributesForTemplate(templateName, document.uri));
  for (const thymesVar of findThymesVars(text)) {
    modelAttributes.set(thymesVar.id, thymesVar.typeName);
  }

  // 1. Highlight loop variable declarations in th:each="p: ${ps}" or "s, iterStat : ${status}"
  for (const attribute of findThymeleafAttributes(text)) {
    if (attribute.name === "th:each") {
      const iteration = /^\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?:/.exec(attribute.value);
      if (iteration) {
        const loopVar = iteration[1];
        const loopVarOffset = attribute.valueStart + attribute.value.indexOf(loopVar);
        rawTokens.push({
          offset: loopVarOffset,
          length: loopVar.length,
          typeIndex: TOKEN_TYPE_MAP["parameter"],
          modifierMask: 1 // declaration
        });
        if (iteration[2]) {
          const statVar = iteration[2];
          const statVarOffset = attribute.valueStart + attribute.value.indexOf(statVar);
          rawTokens.push({
            offset: statVarOffset,
            length: statVar.length,
            typeIndex: TOKEN_TYPE_MAP["parameter"],
            modifierMask: 1 // declaration
          });
        }
      }
    }
  }

  // 2. Collect all expression regions
  const expressionBlocks: { body: string; prefix: string; baseOffset: number }[] = [];

  for (const attribute of findThymeleafAttributes(text)) {
    for (const expression of findThymeleafExpressions(attribute.value)) {
      expressionBlocks.push({
        body: expression.body,
        prefix: expression.prefix,
        baseOffset: attribute.valueStart + expression.start + 2
      });
    }
  }

  for (const inline of findInlineExpressions(text)) {
    for (const expression of findThymeleafExpressions(inline.content)) {
      expressionBlocks.push({
        body: expression.body,
        prefix: expression.prefix,
        baseOffset: inline.contentStart + expression.start + 2
      });
    }
  }

  // 3. Tokenize each expression block
  for (const { body, prefix, baseOffset } of expressionBlocks) {
    tokenizeExpression(
      body,
      prefix,
      baseOffset,
      text,
      templateName,
      modelAttributes,
      index,
      rawTokens,
      document.uri
    );
  }

  // 4. Sort tokens sequentially by offset asc
  rawTokens.sort((a, b) => a.offset - b.offset);

  // 5. Build LSP SemanticTokens
  const builder = new SemanticTokensBuilder();
  let lastOffset = -1;

  for (const token of rawTokens) {
    if (token.offset < lastOffset) continue; // prevent overlapping tokens
    const pos = document.positionAt(token.offset);
    builder.push(pos.line, pos.character, token.length, token.typeIndex, token.modifierMask);
    lastOffset = token.offset + token.length;
  }

  return builder.build();
}

function tokenizeExpression(
  body: string,
  prefix: string,
  baseOffset: number,
  fullText: string,
  templateName: string,
  modelAttributes: ReadonlyMap<string, string>,
  index: ProjectIndex,
  outTokens: RawSemanticToken[],
  templateUri: string
): void {
  let indexInBody = 0;
  const length = body.length;

  while (indexInBody < length) {
    const char = body[indexInBody];

    // Whitespace
    if (/\s/.test(char)) {
      indexInBody += 1;
      continue;
    }

    // String literal: '...' or "..."
    if (char === "'" || char === '"') {
      const quote = char;
      const start = indexInBody;
      indexInBody += 1;
      while (indexInBody < length && body[indexInBody] !== quote) {
        if (body[indexInBody] === "\\" && indexInBody + 1 < length) {
          indexInBody += 2;
        } else {
          indexInBody += 1;
        }
      }
      if (indexInBody < length) indexInBody += 1; // closing quote
      outTokens.push({
        offset: baseOffset + start,
        length: indexInBody - start,
        typeIndex: TOKEN_TYPE_MAP["string"],
        modifierMask: 0
      });
      continue;
    }

    // Number literal: \b[0-9]+(?:\.[0-9]+)?\b
    if (/[0-9]/.test(char)) {
      const start = indexInBody;
      while (indexInBody < length && /[0-9.]/.test(body[indexInBody])) {
        indexInBody += 1;
      }
      outTokens.push({
        offset: baseOffset + start,
        length: indexInBody - start,
        typeIndex: TOKEN_TYPE_MAP["number"],
        modifierMask: 0
      });
      continue;
    }

    // Built-in execution object: #numbers, #strings, etc.
    if (char === "#" && /[a-zA-Z]/.test(body[indexInBody + 1] ?? "")) {
      const start = indexInBody;
      indexInBody += 1;
      while (indexInBody < length && /[\w$]/.test(body[indexInBody])) {
        indexInBody += 1;
      }
      const name = body.slice(start, indexInBody);
      outTokens.push({
        offset: baseOffset + start,
        length: name.length,
        typeIndex: TOKEN_TYPE_MAP["class"],
        modifierMask: 2 // defaultLibrary
      });
      continue;
    }

    // Identifiers and property chains: [a-zA-Z_$][\w$]*
    if (/[a-zA-Z_$]/.test(char)) {
      const start = indexInBody;
      while (indexInBody < length && /[\w$]/.test(body[indexInBody])) {
        indexInBody += 1;
      }
      const word = body.slice(start, indexInBody);
      const absOffset = baseOffset + start;

      // Check if keyword
      if (SPEL_KEYWORDS.has(word)) {
        outTokens.push({
          offset: absOffset,
          length: word.length,
          typeIndex: TOKEN_TYPE_MAP["keyword"],
          modifierMask: 0
        });
        continue;
      }

      // Check context: preceded by '.'?
      let lookBack = start - 1;
      while (lookBack >= 0 && /\s/.test(body[lookBack])) lookBack -= 1;
      const isProperty = lookBack >= 0 && body[lookBack] === ".";

      // Followed by '('?
      let lookAhead = indexInBody;
      while (lookAhead < length && /\s/.test(body[lookAhead])) lookAhead += 1;
      const isMethodCall = lookAhead < length && body[lookAhead] === "(";

      if (isProperty) {
        const receiverType = resolveReceiverType(
          body,
          start,
          prefix,
          baseOffset,
          fullText,
          templateName,
          index,
          templateUri
        );
        if (isMethodCall) {
          if (receiverType && index.findMethodReturnType(receiverType, word)) {
            outTokens.push({
              offset: absOffset,
              length: word.length,
              typeIndex: TOKEN_TYPE_MAP["method"],
              modifierMask: 0
            });
          }
        } else if (receiverType && index.findProperty(receiverType, word)) {
          outTokens.push({
            offset: absOffset,
            length: word.length,
            typeIndex: TOKEN_TYPE_MAP["property"],
            modifierMask: 0
          });
        }
      } else {
        // Root identifier
        const loopVars = findEnclosingLoopVariables(fullText, absOffset, modelAttributes, index);
        const isLoopVar = loopVars.some((v) => v.name === word);

        if (isLoopVar) {
          outTokens.push({
            offset: absOffset,
            length: word.length,
            typeIndex: TOKEN_TYPE_MAP["parameter"],
            modifierMask: 0
          });
        } else if (modelAttributes.has(word)) {
          outTokens.push({
            offset: absOffset,
            length: word.length,
            typeIndex: TOKEN_TYPE_MAP["variable"],
            modifierMask: 4 // readonly
          });
        } else if (isMethodCall) {
          outTokens.push({
            offset: absOffset,
            length: word.length,
            typeIndex: TOKEN_TYPE_MAP["function"],
            modifierMask: 0
          });
        } else {
          outTokens.push({
            offset: absOffset,
            length: word.length,
            typeIndex: TOKEN_TYPE_MAP["variable"],
            modifierMask: 0
          });
        }
      }

      continue;
    }

    // Operators
    if (/[=!<>+\-*/%?:&|~]/.test(char)) {
      const start = indexInBody;
      while (indexInBody < length && /[=!<>+\-*/%?:&|~]/.test(body[indexInBody])) {
        indexInBody += 1;
      }
      outTokens.push({
        offset: baseOffset + start,
        length: indexInBody - start,
        typeIndex: TOKEN_TYPE_MAP["operator"],
        modifierMask: 0
      });
      continue;
    }

    // Punctuation (commas, parens, brackets)
    indexInBody += 1;
  }
}

function resolveReceiverType(
  body: string,
  propertyStart: number,
  prefix: string,
  baseOffset: number,
  fullText: string,
  templateName: string,
  index: ProjectIndex,
  templateUri: string
): string | undefined {
  const receiverMatch = /([\w$]+(?:\s*\.\s*[\w$]+)*(?:\s*\(\s*\))*)\s*\.\s*$/
    .exec(body.slice(0, propertyStart));
  if (!receiverMatch) return undefined;

  const resolved = resolveModelPath(
    receiverMatch[1],
    prefix,
    fullText,
    baseOffset - 2,
    templateName,
    index,
    templateUri
  );
  return resolved && !resolved.unresolved ? resolved.typeName : undefined;
}
