import {
  CodeAction,
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  Position,
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
import { normalizeTemplateName, ProjectIndex, sameFileUri } from "../projectIndex";
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
      actions.push({
        title: `Add <!--/*@thymesVar id="${propertyName}" type="Object"*/--> directive`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          changes: {
            [document.uri]: [
              TextEdit.insert(Position.create(0, 0), `<!--/*@thymesVar id="${propertyName}" type="Object"*/-->\n`)
            ]
          }
        }
      });
    } else if (diagnostic.code === "missing-template" && rangesOverlap(diagnostic.range, range)) {
      const match = /Template '([^']+)' was not found/.exec(diagnostic.message);
      if (match) {
        const templateName = match[1];
        actions.push({
          title: `Create template '${templateName}.html'`,
          kind: CodeActionKind.QuickFix,
          isPreferred: true,
          diagnostics: [diagnostic],
          command: {
            title: `Create template '${templateName}.html'`,
            command: "thymeleaf.createTemplate",
            arguments: [templateName, document.uri]
          }
        });
      }
    } else if (diagnostic.code === "missing-controller-view" && rangesOverlap(diagnostic.range, range)) {
      const match = /template '([^']+)' does not exist/.exec(diagnostic.message);
      if (match) {
        const templateFile = match[1];
        const templateName = templateFile.replace(/\.html$/i, "");
        actions.push({
          title: `Create template '${templateFile}'`,
          kind: CodeActionKind.QuickFix,
          isPreferred: true,
          diagnostics: [diagnostic],
          command: {
            title: `Create template '${templateFile}'`,
            command: "thymeleaf.createTemplate",
            arguments: [templateName, document.uri]
          }
        });
      }
    } else if (diagnostic.code === "missing-message-key" && rangesOverlap(diagnostic.range, range)) {
      const match = /Message key '([^']+)' was not found/.exec(diagnostic.message);
      if (match) {
        const key = match[1];
        const allMessages = index.getAllMessageProperties();
        const targetUri = allMessages[0]?.uri;
        if (targetUri) {
          actions.push({
            title: `Create message key '${key}' in message bundle`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            edit: {
              changes: {
                [targetUri]: [TextEdit.insert(Position.create(100000, 0), `\n${key}=${key}\n`)]
              }
            }
          });
        }
      }
    }
  }

  if (document.languageId === "java") {
    for (const handler of index.controllerHandlers) {
      if (!sameFileUri(handler.uri, document.uri) || !handler.viewName) continue;
      const normalized = normalizeTemplateName(handler.viewName);
      if (index.findTemplate(normalized)) continue;

      const handlerLine = handler.position.line;
      const viewLine = handler.viewNameRange?.start.line ?? handlerLine;
      const minLine = Math.min(handlerLine, viewLine);
      const maxLine = Math.max(handlerLine, viewLine);
      if (range.start.line >= minLine - 1 && range.start.line <= maxLine + 2) {
        const title = `Create template '${normalized}.html'`;
        if (!actions.some((a) => a.title === title)) {
          actions.push({
            title,
            kind: CodeActionKind.QuickFix,
            isPreferred: true,
            command: {
              title,
              command: "thymeleaf.createTemplate",
              arguments: [normalized, document.uri]
            }
          });
        }
      }
    }
  }

  if (document.languageId !== "java" && (range.start.line !== range.end.line || range.start.character !== range.end.character)) {
    const selectedText = document.getText(range);
    if (selectedText.trim().length > 0) {
      const fragmentName = "extractedFragment";
      const replaceText = `<div th:replace="~{::${fragmentName}}"></div>`;
      const fullText = document.getText();
      const bodyClose = fullText.lastIndexOf("</body>");
      const insertPos = bodyClose >= 0 ? document.positionAt(bodyClose) : document.positionAt(fullText.length);
      const fragmentDef = `\n<div th:fragment="${fragmentName}">\n${selectedText}\n</div>\n`;

      actions.push({
        title: "Thymeleaf: Extract Fragment",
        kind: CodeActionKind.RefactorExtract,
        edit: {
          changes: {
            [document.uri]: [
              TextEdit.replace(range, replaceText),
              TextEdit.insert(insertPos, fragmentDef)
            ]
          }
        },
        command: {
          title: "Thymeleaf: Extract Fragment",
          command: "thymeleaf.extractFragment",
          arguments: [document.uri, range]
        }
      });
    }
  }

  return actions;
}

export function validateJavaDocument(
  document: TextDocument,
  index: ProjectIndex
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const handler of index.controllerHandlers) {
    if (!sameFileUri(handler.uri, document.uri) || !handler.viewName) continue;
    const normalized = normalizeTemplateName(handler.viewName);
    const targetTemplate = index.findTemplate(normalized);
    if (targetTemplate) continue;

    const range = handler.viewNameRange
      ? Range.create(
          Position.create(handler.viewNameRange.start.line, handler.viewNameRange.start.character),
          Position.create(handler.viewNameRange.end.line, handler.viewNameRange.end.character)
        )
      : Range.create(
          Position.create(handler.position.line, 0),
          Position.create(handler.position.line, 100)
        );

    diagnostics.push({
      range,
      severity: DiagnosticSeverity.Information,
      code: "missing-controller-view",
      source: "Thymeleaf",
      message: `Thymeleaf template '${normalized}.html' does not exist.`
    });
  }
  return diagnostics;
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
    const subPaths = extractSubPaths(expression.body);
    for (const { subPath, offset: subOffset } of subPaths) {
      const resolved = resolveModelPath(
        subPath,
        expression.prefix,
        text,
        baseOffset + expression.start + 2 + subOffset,
        templateName,
        index,
        templateUri
      );
      if (!resolved?.unresolved) continue;
      const { name, typeName, offset } = resolved.unresolved;
      const propertyOffset = baseOffset + expression.start + 2 + subOffset + offset;
      diagnostics.push({
        range: rangeAtOffset(text, propertyOffset, propertyOffset + name.length),
        severity: DiagnosticSeverity.Warning,
        code: "unknown-model-property",
        source: "Thymeleaf",
        message: `Property '${name}' was not found on model type '${typeName}'.`
      });
    }
  }
  return diagnostics;
}

function extractSubPaths(body: string): { readonly subPath: string; readonly offset: number }[] {
  if (/^[#\w$]+(?:\.[#\w$]+(?:\([^()]*\))?)*$/.test(body.trim())) {
    const leadingSpaces = /^\s*/.exec(body)?.[0].length ?? 0;
    return [{ subPath: body.trim(), offset: leadingSpaces }];
  }

  const results: { subPath: string; offset: number }[] = [];
  const keywords = new Set([
    "true", "false", "null", "empty", "and", "or", "not",
    "eq", "ne", "lt", "gt", "le", "ge", "div", "mod", "instanceof"
  ]);

  const pathRegex = /(?:#|[a-zA-Z_$])[\w$]*(?:\s*\.\s*[a-zA-Z_$][\w$]*(?:\s*\([^()]*\))?)+/g;
  for (const match of body.matchAll(pathRegex)) {
    if (match.index === undefined) continue;
    const pathStr = match[0];
    const root = pathStr.split(".")[0]?.trim();
    if (root && !keywords.has(root)) {
      results.push({ subPath: pathStr, offset: match.index });
    }
  }

  if (results.length === 0) {
    const simpleMatch = /^\s*([#a-zA-Z_$][\w$]*)/.exec(body);
    if (simpleMatch && !keywords.has(simpleMatch[1])) {
      results.push({ subPath: simpleMatch[1], offset: simpleMatch.index ?? 0 });
    }
  }

  return results;
}

function isKnownAttribute(name: string): boolean {
  return ATTRIBUTE_NAMES.has(name) ||
    name.startsWith("sec:") ||
    name.startsWith("layout:") ||
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
