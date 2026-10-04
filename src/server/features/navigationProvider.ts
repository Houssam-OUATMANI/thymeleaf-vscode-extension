import {
  Location,
  Position,
  Range,
  TextDocument
} from "vscode-languageserver/node";
import { findThymeleafAttributes } from "../../thymeleaf/htmlParser";
import {
  findInlineExpressions,
  findThymeleafExpressions,
  ThymeleafExpression
} from "../../thymeleaf/expressions";
import { JavaProperty } from "../javaIndexer";
import { findThymesVars, ProjectIndex, normalizeTemplateName, sameFileUri } from "../projectIndex";
import {
  escapeRegExp,
  findEnclosingExpression,
  getCollectionElementType,
  locationAt,
  modelAttributeDefinition,
  rangeAt,
  rangeAtOffset,
  resolveExpressionProperty,
  resolveModelPath,
  resolveModelType,
  routePath,
  sameRoute
} from "./featureUtils";

export function provideDefinition(
  document: TextDocument,
  position: Position,
  index: ProjectIndex
): Location | undefined {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const template = index.findTemplateByUri(document.uri);

  if (template) {
    const fragmentReference = findFragmentReference(text, offset);
    if (fragmentReference) {
      const targetTemplate = fragmentReference.templateName
        ? index.findTemplate(fragmentReference.templateName)
        : template;
      if (!targetTemplate) return undefined;
      if (!fragmentReference.fragmentName) {
        return locationAt(targetTemplate.uri, Position.create(0, 0));
      }
      const fragment = targetTemplate.fragments.find(({ name }) => name === fragmentReference.fragmentName);
      return fragment ? locationAt(targetTemplate.uri, fragment.position) : undefined;
    }

    const route = findRouteReference(text, offset);
    if (route) {
      const handler = index.findHandlersForRoute(route.path)[0];
      return handler ? locationAt(handler.uri, handler.position) : undefined;
    }

    const modelDefinition = findModelDefinitionAt(text, offset, template.name, index);
    if (modelDefinition) return modelDefinition;

    const property = findModelPropertyAt(text, offset, template.name, index);
    if (property) return locationAt(property.uri, property.position);

    const messageRef = findMessageReference(text, offset);
    if (messageRef) {
      const msgProp = index.findMessageProperty(messageRef.key);
      if (msgProp) return locationAt(msgProp.uri, msgProp.position);
    }

    return undefined;
  }

  const javaString = findJavaStringAt(text, offset);
  if (javaString?.kind === "view") {
    const targetTemplate = index.findTemplate(javaString.value);
    return targetTemplate ? locationAt(targetTemplate.uri, Position.create(0, 0)) : undefined;
  }
  if (javaString?.kind === "route") {
    const handler = index.findHandlersForRoute(javaString.value)[0];
    return handler ? locationAt(handler.uri, handler.position) : undefined;
  }
  if (javaString?.kind === "modelAttribute") {
    const typeName = findModelAttributeType(javaString.value, document.uri, index);
    const javaClass = typeName
      ? index.findClass(typeName) ?? index.findClass(getCollectionElementType(typeName))
      : undefined;
    return javaClass ? locationAt(javaClass.uri, javaClass.position) : undefined;
  }
  return undefined;
}

export function provideTypeDefinition(
  document: TextDocument,
  position: Position,
  index: ProjectIndex
): Location | undefined {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const template = index.findTemplateByUri(document.uri);
  if (!template) return undefined;

  const member = findModelMethodAt(text, offset, template.name, index) ??
    findModelPropertyAt(text, offset, template.name, index);
  if (member) {
    const javaClass = findTypeClass(member.typeName, index);
    return javaClass ? locationAt(javaClass.uri, javaClass.position) : undefined;
  }

  const expression = findEnclosingExpression(text, offset);
  if (!expression || expression.prefix !== "$") return undefined;
  const rootMatch = /^\s*([\w$]+)/.exec(expression.body);
  if (!rootMatch || rootMatch.index === undefined) return undefined;
  const rootStart = expression.start + 2 + rootMatch.index + rootMatch[0].length - rootMatch[1].length;
  if (offset < rootStart || offset > rootStart + rootMatch[1].length) return undefined;

  const modelAttributes = new Map(index.modelAttributesForTemplate(template.name));
  for (const thymesVar of findThymesVars(text)) {
    modelAttributes.set(thymesVar.id, thymesVar.typeName);
  }
  const typeName = resolveModelType(rootMatch[1], text, expression.start, modelAttributes, index);
  const javaClass = typeName ? findTypeClass(typeName, index) : undefined;
  return javaClass ? locationAt(javaClass.uri, javaClass.position) : undefined;
}

function findTypeClass(typeName: string, index: ProjectIndex) {
  return index.findClass(typeName) ?? index.findClass(getCollectionElementType(typeName));
}

export function provideHover(
  document: TextDocument,
  position: Position,
  index: ProjectIndex
): { contents: { kind: "markdown"; value: string }; range: Range } | undefined {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const template = index.findTemplateByUri(document.uri);
  if (!template) return undefined;

  const method = findModelMethodAt(text, offset, template.name, index);
  if (method) {
    return {
      contents: {
        kind: "markdown",
        value: `**${method.name}()**: \`${method.typeName}\`\n\nJava method.`
      },
      range: rangeAtOffset(text, ...findWordRange(text, offset))
    };
  }

  const property = findModelPropertyAt(text, offset, template.name, index);
  if (property) {
    return {
      contents: {
        kind: "markdown",
        value: `**${property.name}**: \`${property.typeName}\`\n\nJava model property.`
      },
      range: rangeAtOffset(text, ...findWordRange(text, offset))
    };
  }

  const fragmentReference = findFragmentReference(text, offset);
  if (fragmentReference) {
    const target = fragmentReference.templateName
      ? index.findTemplate(fragmentReference.templateName)
      : template;
    if (target) {
      return {
        contents: {
          kind: "markdown",
          value: `Thymeleaf template: \`${target.name}\`${fragmentReference.fragmentName ? `, fragment \`${fragmentReference.fragmentName}\`` : ""}`
        },
        range: rangeAt(document, findWordRange(text, offset))
      };
    }
  }

  const messageRef = findMessageReference(text, offset);
  if (messageRef) {
    const msgProp = index.findMessageProperty(messageRef.key);
    if (msgProp) {
      return {
        contents: {
          kind: "markdown",
          value: `**${msgProp.key}**\n\n\`${msgProp.value}\``
        },
        range: rangeAt(document, messageRef.range)
      };
    }
  }

  const route = findRouteReference(text, offset);
  if (!route) return undefined;
  const handlers = index.findHandlersForRoute(route.path);
  if (handlers.length === 0) return undefined;
  return {
    contents: {
      kind: "markdown",
      value: `Spring route \`${route.path}\`\n\n${handlers.map(({ name }) => `- \`${name}()\``).join("\n")}`
    },
    range: rangeAt(document, route.range)
  };
}

export function provideReferences(
  document: TextDocument,
  position: Position,
  index: ProjectIndex
): Location[] {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const template = index.findTemplateByUri(document.uri);

  if (!template) {
    const javaDeclaration = findJavaPropertyAt(document, position, index);
    if (javaDeclaration) {
      const locations: Location[] = [];
      for (const candidate of index.templates) {
        for (const { expression, baseOffset } of collectAllExpressionsInTemplate(candidate.content)) {
          if (expression.prefix !== "$" && expression.prefix !== "*") continue;
          const resolved = resolveExpressionProperty(
            expression.body,
            expression.prefix,
            candidate.content,
            baseOffset + expression.start,
            candidate.name,
            index
          );
          if (
            !resolved ||
            !sameFileUri(resolved.uri, javaDeclaration.property.uri) ||
            resolved.position.line !== javaDeclaration.property.position.line ||
            resolved.position.character !== javaDeclaration.property.position.character
          ) continue;
          locations.push(Location.create(
            candidate.uri,
            rangeAtOffset(
              candidate.content,
              baseOffset + expression.start,
              baseOffset + expression.end
            )
          ));
        }
      }
      return locations;
    }

    const javaRoute = findJavaStringAt(text, offset);
    if (javaRoute?.kind === "route") return findRouteReferences(javaRoute.value, index);
    if (javaRoute?.kind === "modelAttribute") {
      return findModelAttributeReferences(javaRoute.value, index);
    }
    return [];
  }

  const property = findModelPropertyAt(text, offset, template.name, index);
  if (property) {
    const references: Location[] = [];
    for (const candidate of index.templates) {
      for (const { expression, baseOffset } of collectAllExpressionsInTemplate(candidate.content)) {
        if (expression.prefix !== "$" && expression.prefix !== "*") continue;
        const resolved = resolveExpressionProperty(
          expression.body,
          expression.prefix,
          candidate.content,
          baseOffset + expression.start,
          candidate.name,
          index
        );
        if (
          !resolved ||
          !sameFileUri(resolved.uri, property.uri) ||
          resolved.position.line !== property.position.line ||
          resolved.position.character !== property.position.character
        ) continue;
        references.push(Location.create(
          candidate.uri,
          rangeAtOffset(
            candidate.content,
            baseOffset + expression.start,
            baseOffset + expression.end
          )
        ));
      }
    }
    return references;
  }

  const modelAttribute = findModelAttributeReference(text, offset);
  if (modelAttribute) {
    return findModelAttributeReferences(modelAttribute, index);
  }

  const route = findRouteReference(text, offset);
  return route ? findRouteReferences(route.path, index) : [];
}

export interface ThymeleafRenameInfo {
  readonly placeholder: string;
  readonly range: Range;
  readonly javaUri: string;
  readonly javaPosition: Position;
  readonly declarationRange: Range;
}

export interface ThymeleafRenameEdit {
  readonly uri: string;
  readonly range: Range;
  readonly newText: string;
}

export function prepareThymeleafRename(
  document: TextDocument,
  position: Position,
  index: ProjectIndex
): ThymeleafRenameInfo | undefined {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const template = index.findTemplateByUri(document.uri);
  const javaProperty = template ? undefined : findJavaPropertyAt(document, position, index)?.property;
  const target = template
    ? findModelMethodOccurrence(text, offset, template.name, index) ??
      findModelPropertyOccurrence(text, offset, template.name, index)
    : javaProperty && {
        property: javaProperty,
        range: Range.create(
          Position.create(javaProperty.position.line, javaProperty.position.character),
          Position.create(javaProperty.position.line, javaProperty.position.character + javaProperty.name.length)
        )
      };
  if (!target || target.property.renameable !== true) return undefined;

  const declarationStart = Position.create(
    target.property.position.line,
    target.property.position.character
  );
  return {
    placeholder: target.property.name,
    range: target.range,
    javaUri: target.property.uri,
    javaPosition: declarationStart,
    declarationRange: Range.create(
      declarationStart,
      Position.create(declarationStart.line, declarationStart.character + target.property.name.length)
    )
  };
}

export function provideThymeleafRenameEdits(
  javaUri: string,
  javaPosition: Position,
  newName: string,
  index: ProjectIndex,
  openDocuments: ReadonlyMap<string, string> = new Map()
): ThymeleafRenameEdit[] {
  const target = index.javaClasses
    .flatMap((javaClass) => [
      ...javaClass.properties.values(),
      ...javaClass.methodDefinitions.values()
    ])
    .find((property) =>
      sameFileUri(property.uri, javaUri) &&
      property.position.line === javaPosition.line &&
      property.position.character === javaPosition.character &&
      property.renameable === true
    );
  if (!target) return [];

  const edits: ThymeleafRenameEdit[] = [];
  for (const template of index.templates) {
    const content = openDocuments.get(template.uri) ?? template.content;
    for (const { expression, baseOffset } of collectAllExpressionsInTemplate(content)) {
      for (const occurrence of findModelPropertyOccurrences(
        expression,
        content,
        baseOffset,
        template.name,
        index
      )) {
        if (!sameJavaProperty(occurrence.property, target)) continue;
        edits.push({
          uri: template.uri,
          range: occurrence.range,
          newText: newName
        });
      }
      for (const occurrence of findModelMethodOccurrences(
        expression,
        content,
        baseOffset,
        template.name,
        index
      )) {
        if (!sameJavaProperty(occurrence.property, target)) continue;
        edits.push({
          uri: template.uri,
          range: occurrence.range,
          newText: newName
        });
      }
    }
  }
  return edits;
}

function findModelPropertyOccurrence(
  text: string,
  offset: number,
  templateName: string,
  index: ProjectIndex
): { readonly property: JavaProperty; readonly range: Range } | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression) return undefined;
  return findModelPropertyOccurrences(expression, text, 0, templateName, index)
    .find(({ range: occurrenceRange }) =>
      offset >= offsetAt(text, occurrenceRange.start) && offset <= offsetAt(text, occurrenceRange.end)
    );
}

function findModelMethodOccurrence(
  text: string,
  offset: number,
  templateName: string,
  index: ProjectIndex
): { readonly property: JavaProperty; readonly range: Range } | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression) return undefined;
  return findModelMethodOccurrences(expression, text, 0, templateName, index)
    .find(({ range }) =>
      offset >= offsetAt(text, range.start) && offset <= offsetAt(text, range.end)
    );
}

function findModelMethodOccurrences(
  expression: Pick<ThymeleafExpression, "prefix" | "body" | "start">,
  text: string,
  baseOffset: number,
  templateName: string,
  index: ProjectIndex
): { readonly property: JavaProperty; readonly range: Range }[] {
  if (expression.prefix !== "$" && expression.prefix !== "*") return [];
  const rootMatch = /^\s*([\w$]+)/.exec(expression.body);
  if (!rootMatch || rootMatch.index === undefined) return [];
  const occurrences: { readonly property: JavaProperty; readonly range: Range }[] = [];
  const accessPattern = /\s*\.\s*([\w$]+)(\s*\([^()]*\))?/y;
  let accessOffset = rootMatch.index + rootMatch[0].length;

  while (accessOffset < expression.body.length) {
    accessPattern.lastIndex = accessOffset;
    const access = accessPattern.exec(expression.body);
    if (!access) break;
    const name = access[1];
    const nameOffset = accessOffset + access[0].indexOf(name);
    if (access[2]) {
      const receiver = resolveModelPath(
        expression.body.slice(0, nameOffset),
        expression.prefix,
        text,
        baseOffset + expression.start,
        templateName,
        index
      );
      const property = receiver
        ? index.findMethodDefinition(receiver.typeName, name)
        : undefined;
      if (property) {
        const start = baseOffset + expression.start + 2 + nameOffset;
        occurrences.push({
          property,
          range: rangeAtOffset(text, start, start + name.length)
        });
      }
    }
    accessOffset += access[0].length;
  }
  return occurrences;
}

function findModelPropertyOccurrences(
  expression: Pick<ThymeleafExpression, "prefix" | "body" | "start">,
  text: string,
  baseOffset: number,
  templateName: string,
  index: ProjectIndex
): { readonly property: JavaProperty; readonly range: Range }[] {
  if (expression.prefix !== "$" && expression.prefix !== "*") return [];
  const body = expression.body;
  const rootMatch = /^\s*([\w$]+)/.exec(body);
  if (!rootMatch || rootMatch.index === undefined) return [];
  const rootName = rootMatch[1];
  const occurrences: { property: JavaProperty; range: Range }[] = [];

  if (expression.prefix === "*") {
    const rootEnd = rootMatch.index + rootMatch[0].length;
    const result = resolveModelPath(
      body.slice(0, rootEnd),
      expression.prefix,
      text,
      baseOffset + expression.start,
      templateName,
      index
    );
    if (result?.property) {
      const start = baseOffset + expression.start + 2 + rootMatch.index + rootMatch[0].lastIndexOf(rootName);
      occurrences.push({
        property: result.property,
        range: rangeAtOffset(text, start, start + rootName.length)
      });
    }
  }

  const accessPattern = /\s*\.\s*([\w$]+)(\s*\([^()]*\))?/y;
  let accessOffset = rootMatch.index + rootMatch[0].length;
  while (accessOffset < body.length) {
    accessPattern.lastIndex = accessOffset;
    const access = accessPattern.exec(body);
    if (!access) break;
    const name = access[1];
    const nameOffset = accessOffset + access[0].indexOf(name);
    accessOffset += access[0].length;
    if (access[2]) continue;

    const result = resolveModelPath(
      body.slice(0, nameOffset + name.length),
      expression.prefix,
      text,
      baseOffset + expression.start,
      templateName,
      index
    );
    if (result?.property) {
      const start = baseOffset + expression.start + 2 + nameOffset;
      occurrences.push({
        property: result.property,
        range: rangeAtOffset(text, start, start + name.length)
      });
    }
  }
  return occurrences;
}

function sameJavaProperty(left: JavaProperty, right: JavaProperty): boolean {
  return sameFileUri(left.uri, right.uri) &&
    left.position.line === right.position.line &&
    left.position.character === right.position.character;
}

function offsetAt(text: string, position: Position): number {
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) return text.length;
    offset = newline + 1;
  }
  return Math.min(text.length, offset + position.character);
}

function findRouteReferences(routePathValue: string, index: ProjectIndex): Location[] {
  const references: Location[] = [];
  for (const candidate of index.templates) {
    for (const { expression, baseOffset } of collectAllExpressionsInTemplate(candidate.content)) {
      if (expression.prefix !== "@" || !sameRoute(routePath(expression.body), routePathValue)) continue;
      references.push(Location.create(
        candidate.uri,
        rangeAtOffset(
          candidate.content,
          baseOffset + expression.start,
          baseOffset + expression.end
        )
      ));
    }
  }
  return references;
}

function findJavaPropertyAt(
  document: TextDocument,
  position: Position,
  index: ProjectIndex
): { property: JavaProperty; typeName: string } | undefined {
  for (const javaClass of index.javaClasses) {
    if (!sameFileUri(javaClass.uri, document.uri)) continue;
    for (const property of javaClass.properties.values()) {
      if (property.position.line !== position.line) continue;
      const endCharacter = property.position.character + property.name.length;
      if (position.character >= property.position.character && position.character <= endCharacter) {
        return { property, typeName: javaClass.qualifiedName };
      }
    }
    for (const method of javaClass.methodDefinitions.values()) {
      if (method.position.line !== position.line) continue;
      const endCharacter = method.position.character + method.name.length;
      if (position.character >= method.position.character && position.character <= endCharacter) {
        return { property: method, typeName: javaClass.qualifiedName };
      }
    }
  }
  return undefined;
}

function findModelPropertyAt(
  text: string,
  offset: number,
  templateName: string,
  index: ProjectIndex
): JavaProperty | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression) return undefined;
  const method = findModelMethodAt(text, offset, templateName, index);
  if (method) return method;
  return findModelPropertyOccurrences(expression, text, 0, templateName, index)
    .find(({ range }) =>
      offset >= offsetAt(text, range.start) && offset <= offsetAt(text, range.end)
    )?.property;
}

function findModelMethodAt(
  text: string,
  offset: number,
  templateName: string,
  index: ProjectIndex
): JavaProperty | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression || (expression.prefix !== "$" && expression.prefix !== "*")) return undefined;
  const rootMatch = /^\s*([\w$]+)/.exec(expression.body);
  if (!rootMatch || rootMatch.index === undefined) return undefined;

  const accessPattern = /\s*\.\s*([\w$]+)(\s*\([^()]*\))?/y;
  let accessOffset = rootMatch.index + rootMatch[0].length;
  while (accessOffset < expression.body.length) {
    accessPattern.lastIndex = accessOffset;
    const access = accessPattern.exec(expression.body);
    if (!access) break;
    const name = access[1];
    const nameOffset = accessOffset + access[0].indexOf(name);
    const nameStart = expression.start + 2 + nameOffset;
    const nameEnd = nameStart + name.length;
    if (access[2] && offset >= nameStart && offset <= nameEnd) {
      const receiver = resolveModelPath(
        expression.body.slice(0, nameOffset),
        expression.prefix,
        text,
        expression.start,
        templateName,
        index
      );
      return receiver
        ? index.findMethodDefinition(receiver.typeName, name)
        : undefined;
    }
    accessOffset += access[0].length;
  }
  return undefined;
}

function findModelDefinitionAt(
  text: string,
  offset: number,
  templateName: string,
  index: ProjectIndex
): Location | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression || expression.prefix !== "$") return undefined;
  const rootMatch = /^\s*([\w$]+)/.exec(expression.body);
  if (!rootMatch || rootMatch.index === undefined) return undefined;
  const modelName = rootMatch[1];
  const rootStart = expression.start + 2 + rootMatch.index + rootMatch[0].length - modelName.length;
  if (offset < rootStart || offset > rootStart + modelName.length) return undefined;
  return modelAttributeDefinition(templateName, modelName, index, text) ??
    (() => {
      const modelAttributes = new Map(index.modelAttributesForTemplate(templateName));
      for (const thymesVar of findThymesVars(text)) {
        modelAttributes.set(thymesVar.id, thymesVar.typeName);
      }
      const typeName = resolveModelType(
        modelName,
        text,
        expression.start,
        modelAttributes,
        index
      );
      const javaClass = typeName ? index.findClass(typeName) : undefined;
      return javaClass ? locationAt(javaClass.uri, javaClass.position) : undefined;
    })();
}

function findFragmentReference(
  text: string,
  offset: number
): { templateName: string | undefined; fragmentName: string | undefined } | undefined {
  for (const expression of findThymeleafExpressions(text)) {
    if (expression.prefix !== "~" || offset < expression.start || offset > expression.end) continue;
    const [templateName, fragment] = expression.body.split("::", 2).map((part) => part.trim());
    return {
      templateName: templateName ? normalizeTemplateName(templateName) : undefined,
      fragmentName: fragment?.split("(", 1)[0]?.trim()
    };
  }
  return undefined;
}

function findRouteReference(
  text: string,
  offset: number
): { path: string; range: [number, number] } | undefined {
  for (const expression of findThymeleafExpressions(text)) {
    if (expression.prefix !== "@") continue;
    const route = routePath(expression.body);
    if (!route) continue;
    const bodyStart = expression.start + 2;
    const leadingWhitespace = expression.body.length - expression.body.trimStart().length;
    const routeStart = bodyStart + leadingWhitespace;
    const routeEnd = routeStart + route.length;
    if (offset >= routeStart && offset <= routeEnd) {
      return { path: route, range: [routeStart, routeEnd] };
    }
  }
  return undefined;
}

function findJavaStringAt(
  text: string,
  offset: number
): { kind: "view" | "route" | "modelAttribute"; value: string } | undefined {
  const stringPattern = /(["'])(.*?)\1/g;
  for (const match of text.matchAll(stringPattern)) {
    if (match.index === undefined) continue;
    const valueStart = match.index + 1;
    const valueEnd = valueStart + (match[2]?.length ?? 0);
    if (offset < valueStart || offset > valueEnd) continue;
    const prefix = text.slice(0, match.index);
    if (/return\s*$/.test(prefix) && !/redirect:|forward:/.test(match[2] ?? "")) {
      return { kind: "view", value: match[2] ?? "" };
    }
    if (/@(?:Request|Get|Post|Put|Patch|Delete)?Mapping\s*\([^)]*$/.test(prefix)) {
      return { kind: "route", value: match[2] ?? "" };
    }
    if (/@ModelAttribute\s*\([^)]*$/.test(prefix) || /addAttribute\s*\([^,]*$/.test(prefix)) {
      return { kind: "modelAttribute", value: match[2] ?? "" };
    }
  }

  return undefined;
}

function findModelAttributeType(
  name: string,
  documentUri: string,
  index: ProjectIndex
): string | undefined {
  for (const handler of index.controllerHandlers) {
    if (handler.uri !== documentUri) continue;
    const typeName = handler.modelAttributes.get(name);
    if (typeName) return typeName;
  }
  return undefined;
}

function findModelAttributeReference(text: string, offset: number): string | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression || expression.prefix !== "$" || expression.body.includes(".")) return undefined;
  return expression.body.trim();
}

function findModelAttributeReferences(name: string, index: ProjectIndex): Location[] {
  const references: Location[] = [];
  const escapedName = escapeRegExp(name);
  for (const template of index.templates) {
    const pattern = new RegExp(`\\$\\{\\s*${escapedName}(?=[.}\\s])`, "g");
    for (const match of template.content.matchAll(pattern)) {
      if (match.index === undefined) continue;
      references.push(Location.create(
        template.uri,
        rangeAtOffset(template.content, match.index, match.index + match[0].length)
      ));
    }
  }
  return references;
}

function findWordRange(text: string, offset: number): [number, number] {
  let start = offset;
  let end = offset;
  while (start > 0 && /[\w.$-]/.test(text[start - 1])) start -= 1;
  while (end < text.length && /[\w.$-]/.test(text[end])) end += 1;
  return [start, end];
}

function findMessageReference(
  text: string,
  offset: number
): { key: string; range: [number, number] } | undefined {
  for (const expression of findThymeleafExpressions(text)) {
    if (expression.prefix !== "#") continue;
    const bodyStart = expression.start + 2;
    const key = expression.body.split("(", 1)[0]?.trim();
    if (!key) continue;
    const leadingWhitespace = expression.body.length - expression.body.trimStart().length;
    const keyStart = bodyStart + leadingWhitespace;
    const keyEnd = keyStart + key.length;
    if (offset >= keyStart && offset <= keyEnd) {
      return { key, range: [keyStart, keyEnd] };
    }
  }
  return undefined;
}

function collectAllExpressionsInTemplate(content: string): { expression: ThymeleafExpression; baseOffset: number }[] {
  const result: { expression: ThymeleafExpression; baseOffset: number }[] = [];
  for (const attribute of findThymeleafAttributes(content)) {
    for (const expression of findThymeleafExpressions(attribute.value)) {
      result.push({ expression, baseOffset: attribute.valueStart });
    }
  }
  for (const inline of findInlineExpressions(content)) {
    for (const expression of findThymeleafExpressions(inline.content)) {
      result.push({ expression, baseOffset: inline.contentStart });
    }
  }
  return result;
}
