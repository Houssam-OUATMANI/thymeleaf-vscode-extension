import {
  DocumentHighlight,
  DocumentHighlightKind,
  Position,
  TextDocument
} from "vscode-languageserver/node";
import { findInlineExpressions, findThymeleafExpressions, maskStringLiterals } from "../../thymeleaf/expressions";
import { findThymeleafAttributes } from "../../thymeleaf/htmlParser";
import { ProjectIndex } from "../projectIndex";
import {
  findEnclosingLocalVariables,
  LoopVariableInfo,
  rangeAtOffset
} from "./featureUtils";

interface TemplateExpression {
  readonly body: string;
  readonly bodyOffset: number;
}

interface VariableToken {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export function provideDocumentHighlights(
  document: TextDocument,
  position: Position,
  index: ProjectIndex
): DocumentHighlight[] {
  const template = index.findTemplateByUri(document.uri);
  if (!template || document.languageId !== "html") return [];

  const text = document.getText();
  const offset = document.offsetAt(position);
  const modelAttributes = index.modelAttributesForTemplate(template.name, document.uri);
  const attributes = findThymeleafAttributes(text);
  const expressions: TemplateExpression[] = [];

  for (const attribute of attributes) {
    for (const expression of findThymeleafExpressions(attribute.value)) {
      expressions.push({
        body: expression.body,
        bodyOffset: attribute.valueStart + expression.start + 2
      });
    }
  }
  for (const inline of findInlineExpressions(text)) {
    for (const expression of findThymeleafExpressions(inline.content)) {
      expressions.push({
        body: expression.body,
        bodyOffset: inline.contentStart + expression.start + 2
      });
    }
  }

  const clickedToken = expressions
    .flatMap(({ body, bodyOffset }) => findVariableTokens(body, bodyOffset, true))
    .find(({ start, end }) => offset >= start && offset < end);
  const declarationToken = clickedToken ? undefined : findDeclarationAt(
    text,
    offset,
    attributes,
    modelAttributes,
    index
  );
  const token = clickedToken ?? declarationToken;
  if (!token) return [];

  const selectedVariable = nearestLocalVariable(
    text,
    token.start,
    token.name,
    modelAttributes,
    index
  );
  if (!selectedVariable) return [];
  if (declarationToken && selectedVariable.declarationOffset !== token.start) return [];

  const ranges = new Map<string, DocumentHighlight>();
  const addRange = (start: number, end: number): void => {
    const key = `${start}:${end}`;
    ranges.set(key, {
      range: rangeAtOffset(text, start, end),
      kind: DocumentHighlightKind.Text
    });
  };

  for (const attribute of attributes) {
    const valueEnd = attribute.valueStart + attribute.value.length;
    for (const variable of findEnclosingLocalVariables(
      text,
      attribute.valueStart,
      modelAttributes,
      index
    )) {
      if (variable.name !== token.name || variable.declarationOffset < attribute.valueStart ||
          variable.declarationOffset >= valueEnd) continue;
      const end = variable.declarationOffset + variable.name.length;
      if (text.slice(variable.declarationOffset, end) === variable.name) {
        addRange(variable.declarationOffset, end);
      }
    }
  }

  for (const { body, bodyOffset } of expressions) {
    for (const occurrence of findVariableTokens(body, bodyOffset, true)) {
      const activeVariable = nearestLocalVariable(
        text,
        occurrence.start,
        occurrence.name,
        modelAttributes,
        index
      );
      if (occurrence.name === token.name &&
          activeVariable?.declarationOffset === selectedVariable.declarationOffset) {
        addRange(occurrence.start, occurrence.end);
      }
    }
  }

  return [...ranges.values()].sort((left, right) =>
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character
  );
}

function findDeclarationAt(
  text: string,
  offset: number,
  attributes: ReturnType<typeof findThymeleafAttributes>,
  modelAttributes: ReadonlyMap<string, string>,
  index: ProjectIndex
): VariableToken | undefined {
  for (const attribute of attributes) {
    const valueEnd = attribute.valueStart + attribute.value.length;
    for (const variable of findEnclosingLocalVariables(
      text,
      offset,
      modelAttributes,
      index
    )) {
      if (variable.declarationOffset < attribute.valueStart ||
          variable.declarationOffset >= valueEnd) continue;
      const end = variable.declarationOffset + variable.name.length;
      if (offset >= variable.declarationOffset && offset < end &&
          text.slice(variable.declarationOffset, end) === variable.name) {
        return { name: variable.name, start: variable.declarationOffset, end };
      }
    }
  }
  return undefined;
}

function nearestLocalVariable(
  text: string,
  offset: number,
  name: string,
  modelAttributes: ReadonlyMap<string, string>,
  index: ProjectIndex
): LoopVariableInfo | undefined {
  return findEnclosingLocalVariables(text, offset, modelAttributes, index)
    .filter((variable) => variable.name === name)
    .sort((left, right) => right.declarationOffset - left.declarationOffset)[0];
}

function findVariableTokens(
  body: string,
  bodyOffset: number,
  referencesOnly: boolean
): VariableToken[] {
  const maskedBody = maskStringLiterals(body);
  const tokens: VariableToken[] = [];
  const identifier = /[\w$]+/g;
  for (const match of maskedBody.matchAll(identifier)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const previous = maskedBody.slice(0, start).trimEnd();
    if (referencesOnly && (
      previous.endsWith(".") ||
      previous.endsWith("?.") ||
      previous.endsWith("#") ||
      previous.endsWith("@")
    )) continue;
    tokens.push({
      name: match[0],
      start: bodyOffset + start,
      end: bodyOffset + start + match[0].length
    });
  }
  return tokens;
}
