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
import { findThymesVars, normalizeTemplateName, ProjectIndex, sameFileUri } from "../projectIndex";
import {
  findEnclosingLocalVariables,
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
    readonly undefinedVariables?: boolean;
  };
}

export const DEFAULT_SETTINGS: ThymeleafSettings = {
  templateLocations: ["src/main/resources/templates"],
  validation: {
    unclosedExpressions: true,
    unknownAttributes: true,
    unknownModelProperties: true,
    undefinedVariables: true
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
    const isLayoutDecorate = attribute.name === "layout:decorate" || attribute.name === "layout:decorator";
    if (!["th:insert", "th:replace", "th:include"].includes(attribute.name) && !isLayoutDecorate) continue;

    if (isLayoutDecorate) {
      const rawValue = attribute.value.trim().replace(/^['"]|['"]$/g, "");
      const exprs = findThymeleafExpressions(attribute.value);
      let targetTemplateName = rawValue;
      let exprRange: Range;

      if (exprs.length > 0 && exprs[0].prefix === "~") {
        const [tpl] = exprs[0].body.split("::", 2).map((p) => p.trim());
        targetTemplateName = tpl;
        exprRange = rangeAtOffset(
          text,
          attribute.valueStart + exprs[0].start,
          attribute.valueStart + exprs[0].end
        );
      } else {
        const [tpl] = rawValue.split("::", 2).map((p) => p.trim());
        targetTemplateName = tpl;
        exprRange = rangeAtOffset(
          text,
          attribute.valueStart,
          attribute.valueStart + attribute.value.length
        );
      }

      if (targetTemplateName && !targetTemplateName.includes("${")) {
        const target = index.findTemplate(targetTemplateName);
        if (!target) {
          diagnostics.push({
            range: exprRange,
            severity: DiagnosticSeverity.Error,
            code: "missing-template",
            source: "Thymeleaf",
            message: `Layout template '${normalizeTemplateName(targetTemplateName)}' was not found in the configured template locations.`
          });
        }
      }
      continue;
    }
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
        routeValue.includes("${") ||
        routeValue.includes("+") ||
        routeValue.includes("'") ||
        (attribute.name === "th:href" && !isNavigationalHref(text, attribute.valueStart)) ||
        index.findHandlersForRoute(routeValue).length > 0 ||
        index.findStaticFile(routeValue) !== undefined
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

  if (settings.validation.unknownModelProperties || settings.validation.undefinedVariables !== false) {
    diagnostics.push(...validateModelProperties(
      text,
      currentTemplateName,
      index,
      document.uri,
      settings.validation.undefinedVariables !== false,
      settings.validation.unknownModelProperties !== false
    ));
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
    } else if (diagnostic.code === "undefined-variable" && rangesOverlap(diagnostic.range, range)) {
      const match = /Variable '([^']+)' is not defined/.exec(diagnostic.message);
      if (match) {
        const varName = match[1];
        const currentTemplate = index.findTemplateByUri(document.uri);
        const templateName = currentTemplate?.name ?? "";
        const candidates: string[] = [
          ...index.modelAttributesForTemplate(templateName, document.uri).keys(),
          ...findThymesVars(document.getText()).map((v) => v.id),
          ...findEnclosingLocalVariables(document.getText(), document.offsetAt(diagnostic.range.start), new Map(), index).map((v) => v.name)
        ];
        const suggestion = closestProperty(varName, candidates);
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
          title: `Add <!--/*@thymesVar id="${varName}" type="Object"*/--> directive`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [document.uri]: [
                TextEdit.insert(Position.create(0, 0), `<!--/*@thymesVar id="${varName}" type="Object"*/-->\n`)
              ]
            }
          }
        });
      }
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
      if (!sameFileUri(handler.uri, document.uri)) continue;
      const viewNames = handler.viewNames && handler.viewNames.length > 0
        ? handler.viewNames
        : handler.viewName ? [handler.viewName] : [];

      for (const viewName of viewNames) {
        const normalized = normalizeTemplateName(viewName);
        if (index.findTemplate(normalized)) continue;

        const target = handler.viewTargets?.find((t) => t.name === viewName);
        const viewLine = target ? target.range.start.line : (handler.viewNameRange?.start.line ?? handler.position.line);
        const handlerLine = handler.position.line;
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
    if (!sameFileUri(handler.uri, document.uri)) continue;
    if (handler.viewTargets && handler.viewTargets.length > 0) {
      for (const target of handler.viewTargets) {
        const normalized = normalizeTemplateName(target.name);
        if (index.findTemplate(normalized)) continue;
        diagnostics.push({
          range: Range.create(
            Position.create(target.range.start.line, target.range.start.character),
            Position.create(target.range.end.line, target.range.end.character)
          ),
          severity: DiagnosticSeverity.Information,
          code: "missing-controller-view",
          source: "Thymeleaf",
          message: `Thymeleaf template '${normalized}.html' does not exist.`
        });
      }
    } else if (handler.viewName) {
      const normalized = normalizeTemplateName(handler.viewName);
      const targetTemplate = index.findTemplate(normalized);
      if (!targetTemplate) {
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
    }
  }
  return diagnostics;
}

function validateModelProperties(
  text: string,
  templateName: string,
  index: ProjectIndex,
  templateUri: string,
  checkUndefinedVariables: boolean = true,
  checkUnknownProperties: boolean = true
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
      if (checkUndefinedVariables && resolved?.undefinedVariable) {
        const hasProjectControllers = index.controllerHandlers.length > 0;
        const hasModelAttrs = index.modelAttributesForTemplate(templateName, templateUri).size > 0;
        const hasThymesVars = findThymesVars(text).length > 0;
        if (hasProjectControllers || hasModelAttrs || hasThymesVars) {
          const { name, offset } = resolved.undefinedVariable;
          const varOffset = baseOffset + expression.start + 2 + subOffset + offset;
          diagnostics.push({
            range: rangeAtOffset(text, varOffset, varOffset + name.length),
            severity: DiagnosticSeverity.Warning,
            code: "undefined-variable",
            source: "Thymeleaf",
            message: `Variable '${name}' is not defined in the model or enclosing scope.`
          });
        }
      } else if (checkUnknownProperties && resolved?.unresolved) {
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
  }
  return diagnostics;
}

function extractSubPaths(body: string): { readonly subPath: string; readonly offset: number }[] {
  const trimmed = body.trim();
  if (/^[@#\w$]+(?:(?:\.|\?\.)[@#\w$]+(?:\([^()]*\))?|\[[^\]]+\])*$/.test(trimmed)) {
    const leadingSpaces = /^\s*/.exec(body)?.[0].length ?? 0;
    return [{ subPath: trimmed, offset: leadingSpaces }];
  }

  const results: { subPath: string; offset: number }[] = [];
  const keywords = new Set([
    "true", "false", "null", "empty", "and", "or", "not",
    "eq", "ne", "lt", "gt", "le", "ge", "div", "mod", "instanceof", "matches", "T", "this"
  ]);

  const maskedBody = maskStringLiterals(body);

  const pathRegex = /(?:^|[^.\w$])([@#a-zA-Z_$][\w$]*(?:\s*(?:\.|\?\.)\s*[a-zA-Z_$][\w$]*(?:\s*\([^()]*\))?|\[[^\]]+\])*)/g;
  for (const match of maskedBody.matchAll(pathRegex)) {
    if (match.index === undefined || !match[1]) continue;
    const fullMatch = match[0];
    const pathStr = match[1].trim();
    const leadingInMatch = fullMatch.indexOf(pathStr);
    const offset = match.index + (leadingInMatch >= 0 ? leadingInMatch : 0);
    const root = pathStr.split(/[.?[\]\s]/)[0]?.trim();
    if (root && !keywords.has(root) && !/^\d+$/.test(root)) {
      results.push({ subPath: pathStr, offset });
    }
  }

  return results;
}

function maskStringLiterals(text: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  const chars = text.split("");

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (escaped) {
      if (inSingleQuote || inDoubleQuote) {
        chars[i] = " ";
      }
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      if (inSingleQuote || inDoubleQuote) {
        chars[i] = " ";
      }
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      chars[i] = " ";
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      chars[i] = " ";
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      chars[i] = " ";
    }
  }

  return chars.join("");
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
