import {
  CodeAction,
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  Range,
  TextDocument,
  TextEdit
} from "vscode-languageserver/node";
import { THYMELEAF_ATTRIBUTES } from "../../thymeleaf/attributes";
import {
  findInlineExpressions,
  findThymeleafExpressions,
  findUnclosedAttributeExpressions,
  findUnclosedInlineExpressions,
  ThymeleafExpression
} from "../../thymeleaf/expressions";
import { findThymeleafAttributes } from "../../thymeleaf/htmlParser";
import { normalizeTemplateName, ProjectIndex } from "../projectIndex";
import {
  rangeAtOffset,
  resolveModelPath,
  routePath
} from "./featureUtils";

const ATTRIBUTE_NAMES = new Set(THYMELEAF_ATTRIBUTES.map(({ name }) => name));

export interface ThymeleafSettings {
  readonly templateLocations: readonly string[];
  readonly validation: {
    readonly unclosedExpressions: boolean;
    readonly unknownAttributes: boolean;
    readonly unknownModelProperties: boolean;
  };
}

export const DEFAULT_SETTINGS: ThymeleafSettings = {
  templateLocations: ["src/main/resources/templates"],
  validation: {
    unclosedExpressions: true,
    unknownAttributes: true,
    unknownModelProperties: true
  }
};

export function validateDocument(
  document: TextDocument,
  index: ProjectIndex,
  settings: ThymeleafSettings
): Diagnostic[] {
  const text = document.getText();
  const diagnostics: Diagnostic[] = [];

  if (settings.validation.unclosedExpressions) {
    const unclosed = [
      ...findUnclosedAttributeExpressions(text),
      ...findUnclosedInlineExpressions(text)
    ];
    for (const { start, end } of unclosed) {
      diagnostics.push({
        range: rangeAtOffset(text, start, end),
        severity: DiagnosticSeverity.Error,
        code: "unclosed-expression",
        source: "Thymeleaf",
        message: "Thymeleaf expression is missing a closing brace."
      });
    }
  }

  if (settings.validation.unknownAttributes) {
    for (const attribute of findThymeleafAttributes(text)) {
      const name = attribute.name;
      if (isKnownAttribute(name)) continue;
      const suggestion = closestAttribute(name);
      const displayedSuggestion = suggestion && attribute.sourceName.startsWith("data-th-")
        ? `data-th-${suggestion.slice("th:".length)}`
        : suggestion;
      diagnostics.push({
        range: rangeAtOffset(text, attribute.nameStart, attribute.nameEnd),
        severity: DiagnosticSeverity.Warning,
        code: "unknown-attribute",
        source: "Thymeleaf",
        message: `Unknown Thymeleaf attribute '${attribute.sourceName}'.${displayedSuggestion ? ` Did you mean '${displayedSuggestion}'?` : ""}`
      });
    }
  }

  const currentTemplate = index.findTemplateByUri(document.uri);
  const currentTemplateName = currentTemplate?.name ?? "";

  for (const attribute of findThymeleafAttributes(text)) {
    if (!["th:insert", "th:replace", "th:include"].includes(attribute.name)) continue;
    for (const expression of findThymeleafExpressions(attribute.value)) {
      if (expression.prefix !== "~") continue;
      const [templateName, fragmentName] = expression.body.split("::", 2).map((part) => part.trim());
      const target = templateName ? index.findTemplate(templateName) : currentTemplate;
      const expressionRange = rangeAtOffset(
        text,
        attribute.valueStart + expression.start,
        attribute.valueStart + expression.end
      );
      if (!target) {
        diagnostics.push({
          range: expressionRange,
          severity: DiagnosticSeverity.Error,
          code: "missing-template",
          source: "Thymeleaf",
          message: `Template '${normalizeTemplateName(templateName ?? "")}' was not found in the configured template locations.`
        });
        continue;
      }
      const normalizedFragment = fragmentName?.split("(", 1)[0]?.trim();
      if (normalizedFragment && !target.fragments.some(({ name }) => name === normalizedFragment)) {
        diagnostics.push({
          range: expressionRange,
          severity: DiagnosticSeverity.Error,
          code: "missing-fragment",
          source: "Thymeleaf",
          message: `Fragment '${normalizedFragment}' was not found in template '${target.name}'.`
        });
      }
    }
  }

  for (const attribute of findThymeleafAttributes(text)) {
    if (attribute.name !== "th:href" && attribute.name !== "th:action") continue;
    for (const expression of findThymeleafExpressions(attribute.value)) {
      if (expression.prefix !== "@") continue;
      const routeValue = routePath(expression.body);
      if (
        !routeValue ||
        (attribute.name === "th:href" && !isNavigationalHref(text, attribute.valueStart)) ||
        index.findHandlersForRoute(routeValue).length > 0
      ) continue;
      diagnostics.push({
        range: rangeAtOffset(text, attribute.valueStart + expression.start, attribute.valueStart + expression.end),
        severity: DiagnosticSeverity.Warning,
        code: "missing-route",
        source: "Thymeleaf",
        message: `No indexed Spring controller route matches '${routeValue}'.`
      });
    }

  }

  if (index.hasMessageProperties()) {
    const messageExpressions: { expression: ThymeleafExpression; baseOffset: number }[] = [];
    for (const attribute of findThymeleafAttributes(text)) {
      for (const expression of findThymeleafExpressions(attribute.value)) {
        if (expression.prefix === "#") {
          messageExpressions.push({ expression, baseOffset: attribute.valueStart });
        }
      }
    }
    for (const inline of findInlineExpressions(text)) {
      for (const expression of findThymeleafExpressions(inline.content)) {
        if (expression.prefix === "#") {
          messageExpressions.push({ expression, baseOffset: inline.contentStart });
        }
      }
    }
    for (const { expression, baseOffset } of messageExpressions) {
      const key = expression.body.split("(", 1)[0]?.trim();
      if (key && !index.findMessageProperty(key)) {
        diagnostics.push({
          range: rangeAtOffset(text, baseOffset + expression.start, baseOffset + expression.end),
          severity: DiagnosticSeverity.Warning,
          code: "missing-message-key",
          source: "Thymeleaf",
          message: `Message key '${key}' was not found in message bundles.`
        });
      }
    }
  }

  if (settings.validation.unknownModelProperties) {
    diagnostics.push(...validateModelProperties(text, currentTemplateName, index, document.uri));
  }
  return diagnostics;
}

function isNavigationalHref(text: string, valueStart: number): boolean {
  const tagStart = text.lastIndexOf("<", valueStart);
  const tagEnd = text.indexOf(">", valueStart);
  if (tagStart < 0 || tagEnd < 0) return false;
  const tagName = /^<\s*([\w:-]+)/.exec(text.slice(tagStart, tagEnd + 1))?.[1].toLowerCase();
  return tagName === "a" || tagName === "area";
}

export function provideCodeActions(
  document: TextDocument,
  range: Range,
  diagnostics: readonly Diagnostic[],
  index: ProjectIndex
): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === "unclosed-expression") {
      actions.push({
        title: "Insert missing closing brace",
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          changes: {
            [document.uri]: [TextEdit.insert(diagnostic.range.end, "}")]
          }
        }
      });
    } else if (diagnostic.code === "unknown-attribute") {
      const suggestion = diagnostic.message.match(/Did you mean '([^']+)'/)?.[1];
      if (suggestion && rangesOverlap(diagnostic.range, range)) {
        actions.push({
          title: `Replace with '${suggestion}'`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [document.uri]: [TextEdit.replace(diagnostic.range, suggestion)]
            }
          }
        });
      }
    } else if (diagnostic.code === "unknown-model-property" && rangesOverlap(diagnostic.range, range)) {
      const [, propertyName, typeName] = /Property '([^']+)' was not found on model type '([^']+)'/.exec(
        diagnostic.message
      ) ?? [];
      if (!propertyName || !typeName) continue;
      const suggestion = closestProperty(propertyName, index.propertyNamesForType(typeName));
      if (suggestion) {
        actions.push({
          title: `Replace with '${suggestion}'`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [document.uri]: [TextEdit.replace(diagnostic.range, suggestion)]
            }
          }
        });
      }
    }
  }
  return actions;
}

function validateModelProperties(
  text: string,
  templateName: string,
  index: ProjectIndex,
  templateUri: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const expressionsToCheck: { expression: ThymeleafExpression; baseOffset: number }[] = [];

  for (const attribute of findThymeleafAttributes(text)) {
    for (const expression of findThymeleafExpressions(attribute.value)) {
      expressionsToCheck.push({ expression, baseOffset: attribute.valueStart });
    }
  }

  for (const inline of findInlineExpressions(text)) {
    for (const expression of findThymeleafExpressions(inline.content)) {
      expressionsToCheck.push({ expression, baseOffset: inline.contentStart });
    }
  }

  for (const { expression, baseOffset } of expressionsToCheck) {
    if (!expression.body.trim() || (expression.prefix !== "$" && expression.prefix !== "*")) continue;
    const resolved = resolveModelPath(
      expression.body,
      expression.prefix,
      text,
      baseOffset + expression.start,
      templateName,
      index,
      templateUri
    );
    if (!resolved?.unresolved) continue;
    const { name, typeName, offset } = resolved.unresolved;
    const propertyOffset = baseOffset + expression.start + 2 + offset;
    diagnostics.push({
      range: rangeAtOffset(text, propertyOffset, propertyOffset + name.length),
      severity: DiagnosticSeverity.Warning,
      code: "unknown-model-property",
      source: "Thymeleaf",
      message: `Property '${name}' was not found on model type '${typeName}'.`
    });
  }
  return diagnostics;
}

function isKnownAttribute(name: string): boolean {
  return ATTRIBUTE_NAMES.has(name) ||
    name.startsWith("th:lang-") ||
    name.startsWith("th:xml-lang-") ||
    name.startsWith("th:xml:lang-");
}

function closestAttribute(name: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of ATTRIBUTE_NAMES) {
    const distance = levenshtein(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function closestProperty(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  let tied = false;
  for (const candidate of candidates) {
    const distance = levenshtein(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function rangesOverlap(left: Range, right: Range): boolean {
  return left.start.line <= right.end.line && right.start.line <= left.end.line;
}
