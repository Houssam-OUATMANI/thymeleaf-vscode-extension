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
      if (!sameFileUri(handler.uri, document.uri) || !handler.viewName) continue;
      const targetTemplate = index.findTemplate(handler.viewName);
      const line = handler.position.line;

      if (targetTemplate) {
        lenses.push({
          range: Range.create(Position.create(line, 0), Position.create(line, 0)),
          command: {
            title: `$(file-code) Open template '${handler.viewName}.html'`,
            command: "thymeleaf.openTemplate",
            arguments: [targetTemplate.uri]
          }
        });
      } else {
        const normalized = normalizeTemplateName(handler.viewName);
        lenses.push({
          range: Range.create(Position.create(line, 0), Position.create(line, 0)),
          command: {
            title: `$(new-file) Create template '${normalized}.html'`,
            command: "thymeleaf.createTemplate",
            arguments: [normalized, document.uri]
          }
        });
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
            ? `$(server-process) Spring Controller: ${first.ownerType}.${first.name}()`
            : `$(server-process) ${handlers.length} Spring Controllers linked`,
          command: "thymeleaf.openController",
          arguments: [first.uri, first.position.line, first.position.character]
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
              : `$(file-code) Jump to template '${targetTemplate.name}'`,
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

export function provideGutterDecorations(
  documentUri: string,
  languageId: string,
  index: ProjectIndex
): GutterDecoration[] {
  const decorations: GutterDecoration[] = [];

  if (languageId === "java") {
    for (const handler of index.controllerHandlers) {
      if (!sameFileUri(handler.uri, documentUri) || !handler.viewName) continue;
      const targetTemplate = index.findTemplate(handler.viewName);
      if (targetTemplate) {
        decorations.push({
          line: handler.position.line,
          tooltip: `Thymeleaf template: ${handler.viewName}.html`
        });
      } else {
        const normalized = normalizeTemplateName(handler.viewName);
        decorations.push({
          line: handler.position.line,
          tooltip: `Missing Thymeleaf template: ${normalized}.html (click CodeLens or run Quick Fix to create)`
        });
      }
    }
  } else if (languageId === "html") {
    const template = index.findTemplateByUri(documentUri);
    if (!template) return decorations;

    const handlers = index.getHandlersForTemplate(template.name, documentUri);
    if (handlers.length > 0) {
      decorations.push({
        line: 0,
        tooltip: `Spring Controllers: ${handlers.map((h) => `${h.ownerType}.${h.name}()`).join(", ")}`
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
