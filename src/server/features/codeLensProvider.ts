import {
  CodeLens,
  Position,
  Range,
  TextDocument
} from "vscode-languageserver/node";
import { findThymeleafExpressions } from "../../thymeleaf/expressions";
import { findThymeleafAttributes } from "../../thymeleaf/htmlParser";
import { normalizeTemplateName, ProjectIndex, sameFileUri } from "../projectIndex";
import { positionAt } from "./featureUtils";

export interface ControllerCodeLensTarget {
  readonly uri: string;
  readonly line: number;
  readonly character: number;
  readonly label: string;
}

export interface GutterDecoration {
  readonly line: number;
  readonly tooltip: string;
}

export function provideCodeLenses(
  document: TextDocument,
  index: ProjectIndex
): CodeLens[] {
  const lenses: CodeLens[] = [];
  const text = document.getText();

  if (document.languageId === "java") {
    for (const handler of index.controllerHandlers) {
      if (!sameFileUri(handler.uri, document.uri)) continue;
      const viewNames = handler.viewNames && handler.viewNames.length > 0
        ? handler.viewNames
        : handler.viewName ? [handler.viewName] : [];
      if (viewNames.length === 0) continue;
      const line = handler.position.line;

      for (const viewName of viewNames) {
        const targetTemplate = index.findTemplate(viewName);
        if (targetTemplate) {
          const fragmentPart = viewName.includes("::")
            ? viewName.split("::")[1].trim().split("(", 1)[0].trim()
            : undefined;
          const fragment = fragmentPart
            ? targetTemplate.fragments.find(({ name }) => name === fragmentPart)
            : undefined;

          if (fragment) {
            lenses.push({
              range: Range.create(Position.create(line, 0), Position.create(line, 0)),
              command: {
                title: `$(symbol-reference) Open fragment '${fragment.name}' in '${compactTemplateName(targetTemplate.name)}.html'`,
                command: "thymeleaf.openFragment",
                arguments: [targetTemplate.uri, fragment.position.line, fragment.position.character]
              }
            });
          } else {
            lenses.push({
              range: Range.create(Position.create(line, 0), Position.create(line, 0)),
              command: {
                title: `$(file-code) Open template '${compactTemplateName(targetTemplate.name)}.html'`,
                command: "thymeleaf.openTemplate",
                arguments: [targetTemplate.uri]
              }
            });
          }
        } else {
          const normalized = normalizeTemplateName(viewName);
          lenses.push({
            range: Range.create(Position.create(line, 0), Position.create(line, 0)),
            command: {
              title: `$(new-file) Create template '${compactTemplateName(normalized)}.html'`,
              command: "thymeleaf.createTemplate",
              arguments: [normalized, document.uri]
            }
          });
        }
      }
    }
    return lenses;
  }

  if (document.languageId === "html") {
    const template = index.findTemplateByUri(document.uri);
    if (!template) return lenses;

    const handlers = index.getHandlersForTemplate(template.name, document.uri);
    if (handlers.length > 0) {
      const [first] = handlers;
      lenses.push({
        range: Range.create(Position.create(0, 0), Position.create(0, 0)),
        command: {
          title: handlers.length === 1
            ? `$(server-process) Spring Controller: ${shortTypeName(first.ownerType)}.${first.name}()`
            : `$(server-process) ${handlers.length} Spring Controllers linked`,
          command: "thymeleaf.openController",
          arguments: [handlers.map((handler): ControllerCodeLensTarget => ({
            uri: handler.uri,
            line: handler.position.line,
            character: handler.position.character,
            label: `${shortTypeName(handler.ownerType)}.${handler.name}()`
          }))]
        }
      });
    }

    for (const attribute of findThymeleafAttributes(text)) {
      if (!["th:replace", "th:insert", "th:include"].includes(attribute.name)) continue;
      for (const expr of findThymeleafExpressions(attribute.value)) {
        if (expr.prefix !== "~") continue;
        const [templatePart, fragmentPart] = expr.body.split("::", 2).map((p) => p.trim());
        const targetTemplate = templatePart ? index.findTemplate(templatePart) : template;
        if (!targetTemplate) continue;

        const normalizedFrag = fragmentPart?.split("(", 1)[0]?.trim();
        const frag = normalizedFrag
          ? targetTemplate.fragments.find(({ name }) => name === normalizedFrag)
          : undefined;

        const pos = positionAt(text, attribute.nameStart);
        lenses.push({
          range: Range.create(Position.create(pos.line, 0), Position.create(pos.line, 0)),
          command: {
            title: frag
              ? `$(symbol-reference) Jump to fragment '${frag.name}'`
              : `$(file-code) Jump to template '${compactTemplateName(targetTemplate.name)}'`,
            command: "thymeleaf.openFragment",
            arguments: [
              targetTemplate.uri,
              frag ? frag.position.line : 0,
              frag ? frag.position.character : 0
            ]
          }
        });
      }
    }
  }

  return lenses;
}

function shortTypeName(qualifiedName: string): string {
  return qualifiedName.split(".").at(-1) ?? qualifiedName;
}

function compactTemplateName(name: string, maxLength = 36): string {
  if (name.length <= maxLength) return name;
  const fileName = name.split("/").at(-1) ?? name;
  const suffixLength = maxLength - 2;
  if (fileName.length >= suffixLength) {
    return `${fileName.slice(0, suffixLength - 1)}…`;
  }
  return `…/${name.slice(-(maxLength - 2))}`;
}

export function provideGutterDecorations(
  documentUri: string,
  languageId: string,
  index: ProjectIndex
): GutterDecoration[] {
  const decorations: GutterDecoration[] = [];

  if (languageId === "java") {
    for (const handler of index.controllerHandlers) {
      if (!sameFileUri(handler.uri, documentUri)) continue;
      const viewNames = handler.viewNames && handler.viewNames.length > 0
        ? handler.viewNames
        : handler.viewName ? [handler.viewName] : [];
      if (viewNames.length === 0) continue;
      for (const viewName of viewNames) {
        const targetTemplate = index.findTemplate(viewName);
        if (targetTemplate) {
          const fragmentPart = viewName.includes("::")
            ? viewName.split("::")[1].trim().split("(", 1)[0].trim()
            : undefined;
          decorations.push({
            line: handler.position.line,
            tooltip: fragmentPart
              ? `Thymeleaf fragment: ${fragmentPart} in ${compactTemplateName(targetTemplate.name)}.html`
              : `Thymeleaf template: ${compactTemplateName(targetTemplate.name)}.html`
          });
        } else {
          const normalized = normalizeTemplateName(viewName);
          decorations.push({
            line: handler.position.line,
            tooltip: `Missing Thymeleaf template: ${compactTemplateName(normalized)}.html (click CodeLens or run Quick Fix to create)`
          });
        }
      }
    }
  } else if (languageId === "html") {
    const template = index.findTemplateByUri(documentUri);
    if (!template) return decorations;

    const handlers = index.getHandlersForTemplate(template.name, documentUri);
    if (handlers.length > 0) {
      decorations.push({
        line: 0,
        tooltip: `Spring Controllers: ${handlers.map((h) => `${shortTypeName(h.ownerType)}.${h.name}()`).join(", ")}`
      });
    }

    for (const frag of template.fragments) {
      decorations.push({
        line: frag.position.line,
        tooltip: `Thymeleaf fragment: ${frag.name}`
      });
    }
  }

  return decorations;
}
