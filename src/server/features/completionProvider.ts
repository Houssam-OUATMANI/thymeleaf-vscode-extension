import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompletionItem,
  CompletionItemKind,
  Position,
  Range,
  TextDocument,
  TextEdit
} from "vscode-languageserver/node";
import { THYMELEAF_ATTRIBUTES } from "../../thymeleaf/attributes";
import {
  findEnclosingExpression,
  findEnclosingLoopVariables,
  findSelectedObjectType,
  resolveModelPath,
  THYMELEAF_EXECUTION_OBJECTS
} from "./featureUtils";
import { findThymesVars, ProjectIndex } from "../projectIndex";

export function provideCompletions(
  document: TextDocument,
  position: Position,
  index: ProjectIndex
): CompletionItem[] {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const linePrefix = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);

  const messageContext = findMessageKeyContext(linePrefix);
  if (messageContext !== undefined) {
    return prioritizeThymeleaf(index.getAllMessageProperties()
      .filter(({ key }) => key.startsWith(messageContext))
      .map(({ key, value, uri }) => {
        let baseName = "";
        try {
          baseName = path.basename(fileURLToPath(uri));
        } catch {
          baseName = "messages.properties";
        }
        return {
          label: key,
          kind: CompletionItemKind.Value,
          detail: value,
          documentation: `Message from ${baseName}`,
          insertText: key
        };
      }));
  }

  const templatePathContext = findTemplatePathContext(linePrefix);
  if (templatePathContext !== undefined) {
    return prioritizeThymeleaf(index.templates
      .filter(({ name }) => name.startsWith(templatePathContext))
      .map(({ name, uri }) => ({
        label: name,
        kind: CompletionItemKind.File,
        detail: uri,
        insertText: name
      })));
  }

  const fragmentContext = findFragmentContext(linePrefix);
  if (fragmentContext) {
    const currentTemplate = index.findTemplateByUri(document.uri);
    const targetTemplate = fragmentContext.templateName
      ? index.findTemplate(fragmentContext.templateName)
      : currentTemplate;
    return prioritizeThymeleaf((targetTemplate?.fragments ?? [])
      .filter(({ name }) => name.startsWith(fragmentContext.prefix))
      .map(({ name }) => ({
        label: name,
        kind: CompletionItemKind.Reference,
        detail: `Fragment in ${targetTemplate?.name ?? "current template"}`,
        insertText: name
      })));
  }

  const routeContext = findRouteContext(linePrefix);
  if (routeContext !== undefined) {
    return prioritizeThymeleaf(index.controllerHandlers
      .flatMap(({ routePaths }) => routePaths)
      .filter((route) => route.startsWith(routeContext))
      .filter((route, routeIndex, routes) => routes.indexOf(route) === routeIndex)
      .map((route) => ({
        label: route,
        kind: CompletionItemKind.Reference,
        detail: "Spring controller route",
        insertText: route
      })));
  }

  const execMatch = /(#[a-zA-Z]+)\.([a-zA-Z]*)$/.exec(linePrefix);
  if (execMatch) {
    const objName = execMatch[1];
    const prefix = execMatch[2];
    const execObj = THYMELEAF_EXECUTION_OBJECTS[objName];
    if (execObj) {
      return prioritizeThymeleaf(execObj.methods
        .filter((m) => m.name.startsWith(prefix))
        .map((m) => ({
          label: m.name,
          kind: CompletionItemKind.Method,
          detail: m.returnType,
          documentation: m.documentation,
          textEdit: TextEdit.replace(
            Range.create(
              position.line,
              Math.max(0, position.character - prefix.length),
              position.line,
              position.character
            ),
            m.name
          )
        })));
    }
  }

  const hashObjectMatch = /(#[a-zA-Z]*)$/.exec(linePrefix);
  if (hashObjectMatch && !linePrefix.endsWith("}")) {
    const prefix = hashObjectMatch[1];
    return prioritizeThymeleaf(Object.entries(THYMELEAF_EXECUTION_OBJECTS)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, obj]) => ({
        label: name,
        kind: CompletionItemKind.Class,
        detail: obj.description,
        textEdit: TextEdit.replace(
          Range.create(
            position.line,
            Math.max(0, position.character - prefix.length),
            position.line,
            position.character
          ),
          name
        )
      })));
  }

  const modelPropertyContext = findModelPropertyContext(text, offset, document.uri, index);
  if (modelPropertyContext) {
    const properties = index.getPropertiesForClass(modelPropertyContext.typeName);
    return prioritizeThymeleaf(properties
      .filter(({ name }) => name.startsWith(modelPropertyContext.prefix))
      .map((property) => ({
        label: property.name,
        kind: property.name.endsWith("()") ? CompletionItemKind.Method : CompletionItemKind.Property,
        detail: property.typeName,
        documentation: `Java model property \`${property.name}\``,
        textEdit: TextEdit.replace(
          Range.create(
            position.line,
            Math.max(0, position.character - modelPropertyContext.prefix.length),
            position.line,
            position.character
          ),
          property.name
        )
      })));
  }

  const selectionPropertyContext = findSelectionPropertyContext(text, offset, document.uri, index);
  if (selectionPropertyContext) {
    return prioritizeThymeleaf(index.getPropertiesForClass(selectionPropertyContext.typeName)
      .filter(({ name }) => name.startsWith(selectionPropertyContext.prefix))
      .map((property) => ({
        label: property.name,
        kind: property.name.endsWith("()") ? CompletionItemKind.Method : CompletionItemKind.Property,
        detail: property.typeName,
        documentation: `Java model member \`${property.name}\``,
        textEdit: TextEdit.replace(
          Range.create(
            position.line,
            Math.max(0, position.character - selectionPropertyContext.prefix.length),
            position.line,
            position.character
          ),
          property.name
        )
      })));
  }

  const modelNameContext = findModelNameContext(text, offset, document.uri, index);
  if (modelNameContext) {
    const modelAttributes = new Map(index.modelAttributesForTemplate(modelNameContext.templateName));
    for (const thymesVar of findThymesVars(text)) {
      modelAttributes.set(thymesVar.id, thymesVar.typeName);
    }
    const loopVars = findEnclosingLoopVariables(text, offset, modelAttributes, index);
    for (const v of loopVars) {
      modelAttributes.set(v.name, v.typeName);
    }

    const items: CompletionItem[] = [...modelAttributes]
      .filter(([name]) => name.startsWith(modelNameContext.prefix))
      .map(([name, typeName]) => ({
        label: name,
        kind: CompletionItemKind.Variable,
        detail: typeName,
        textEdit: TextEdit.replace(
          Range.create(
            position.line,
            Math.max(0, position.character - modelNameContext.prefix.length),
            position.line,
            position.character
          ),
          name
        )
      }));

    if (modelNameContext.prefix.startsWith("#") || modelNameContext.prefix === "") {
      for (const [name, obj] of Object.entries(THYMELEAF_EXECUTION_OBJECTS)) {
        if (name.startsWith(modelNameContext.prefix)) {
          items.push({
            label: name,
            kind: CompletionItemKind.Class,
            detail: obj.description,
            textEdit: TextEdit.replace(
              Range.create(
                position.line,
                Math.max(0, position.character - modelNameContext.prefix.length),
                position.line,
                position.character
              ),
              name
            )
          });
        }
      }
    }

    return prioritizeThymeleaf(items);
  }

  if (isInsideTag(text, offset) && !isInsideAttributeValue(text, offset)) {
    return prioritizeThymeleaf(THYMELEAF_ATTRIBUTES.map(({ name, description, value }) => ({
      label: name,
      kind: CompletionItemKind.Property,
      detail: value,
      documentation: description,
      insertText: `${name}="$1"`,
      insertTextFormat: 2
    })));
  }
  return [];
}

function findSelectionPropertyContext(
  text: string,
  offset: number,
  documentUri: string,
  index: ProjectIndex
): { readonly typeName: string; readonly prefix: string } | undefined {
  const template = index.findTemplateByUri(documentUri);
  const expression = findEnclosingExpression(text, offset);
  if (!expression || expression.prefix !== "*") return undefined;
  const bodyStart = expression.start + 2;
  const beforeCursor = expression.body.slice(0, Math.max(0, offset - bodyStart));
  if (beforeCursor.includes(".")) return undefined;

  const modelAttributes = new Map(index.modelAttributesForTemplate(template?.name ?? ""));
  for (const thymesVar of findThymesVars(text)) {
    modelAttributes.set(thymesVar.id, thymesVar.typeName);
  }
  for (const loopVar of findEnclosingLoopVariables(text, offset, modelAttributes, index)) {
    modelAttributes.set(loopVar.name, loopVar.typeName);
  }
  const typeName = findSelectedObjectType(text, expression.start, modelAttributes);
  if (!typeName) return undefined;
  return {
    typeName,
    prefix: /([\w$]*)$/.exec(beforeCursor)?.[1] ?? ""
  };
}

function prioritizeThymeleaf(items: CompletionItem[]): CompletionItem[] {
  return items.map((item, index) => ({
    ...item,
    sortText: `0000_${item.label}`,
    ...(index === 0 ? { preselect: true } : {})
  }));
}

function findModelPropertyContext(
  text: string,
  offset: number,
  documentUri: string,
  index: ProjectIndex
): { typeName: string; prefix: string } | undefined {
  const template = index.findTemplateByUri(documentUri);
  const templateName = template?.name ?? "";
  const expression = findEnclosingExpression(text, offset);
  if (!expression) return undefined;

  const bodyOffset = expression.start + 2;
  const beforeCursor = expression.body.slice(0, Math.max(0, offset - bodyOffset));
  const chainMatch = /([\w$]+(?:\s*\.\s*[\w$]+(?:\s*\([^()]*\))?)*)\s*\.\s*([\w$]*)$/.exec(beforeCursor);
  if (!chainMatch) return undefined;

  const resolved = resolveModelPath(
    chainMatch[1],
    expression.prefix,
    text,
    expression.start,
    templateName,
    index
  );
  if (!resolved || resolved.unresolved) return undefined;
  return {
    typeName: resolved.typeName,
    prefix: chainMatch[2]
  };
}

function findModelNameContext(
  text: string,
  offset: number,
  documentUri: string,
  index: ProjectIndex
): { templateName: string; prefix: string } | undefined {
  const template = index.findTemplateByUri(documentUri);
  const templateName = template?.name ?? "";
  const expression = findEnclosingExpression(text, offset);
  if (!expression || expression.prefix !== "$") return undefined;
  const bodyStart = expression.start + 2;
  const beforeCursor = expression.body.slice(0, Math.max(0, offset - bodyStart));
  const lastDot = beforeCursor.lastIndexOf(".");
  if (lastDot >= 0) return undefined;
  const match = /([#\w$]*)$/.exec(beforeCursor);
  return { templateName, prefix: match ? match[1] : beforeCursor.trim() };
}

function findTemplatePathContext(linePrefix: string): string | undefined {
  const marker = linePrefix.lastIndexOf("~{");
  if (marker < 0) return undefined;
  const reference = linePrefix.slice(marker + 2);
  if (reference.includes("::") || reference.includes("}")) return undefined;
  return reference.replace(/^[\s"']*/, "");
}

function findFragmentContext(
  linePrefix: string
): { readonly templateName: string; readonly prefix: string } | undefined {
  const marker = linePrefix.lastIndexOf("~{");
  if (marker < 0) return undefined;
  const reference = linePrefix.slice(marker + 2);
  const separator = reference.indexOf("::");
  if (separator < 0 || reference.includes("}")) return undefined;
  return {
    templateName: reference.slice(0, separator).trim(),
    prefix: reference.slice(separator + 2).trim()
  };
}

function findRouteContext(linePrefix: string): string | undefined {
  const marker = linePrefix.lastIndexOf("@{/");
  if (marker < 0) return undefined;
  const routePrefix = linePrefix.slice(marker + 3);
  if (routePrefix.includes("}") || routePrefix.includes("(")) return undefined;
  return routePrefix;
}

function isInsideTag(text: string, offset: number): boolean {
  const prefix = text.slice(0, offset);
  const open = prefix.lastIndexOf("<");
  return open > prefix.lastIndexOf(">") && !prefix.slice(open).startsWith("<!--");
}

function isInsideAttributeValue(text: string, offset: number): boolean {
  const tagStart = text.lastIndexOf("<", offset);
  const tagEnd = text.lastIndexOf(">", offset);
  if (tagStart < 0 || tagStart < tagEnd) return false;
  let quote: "'" | '"' | undefined;
  for (let index = tagStart + 1; index < offset; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote && text[index - 1] !== "\\") quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    }
  }
  return quote !== undefined;
}

function findMessageKeyContext(linePrefix: string): string | undefined {
  const marker = linePrefix.lastIndexOf("#{");
  if (marker < 0) return undefined;
  const keyPrefix = linePrefix.slice(marker + 2);
  if (keyPrefix.includes("}") || keyPrefix.includes("(")) return undefined;
  return keyPrefix.trim();
}
