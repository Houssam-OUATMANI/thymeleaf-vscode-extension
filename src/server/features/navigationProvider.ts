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
import { findThymesVars, IndexedTemplate, ProjectIndex, normalizeTemplateName, sameFileUri } from "../projectIndex";
import {
  escapeRegExp,
  findEnclosingExpression,
  findEnclosingLocalVariables,
  findSelectedObjectType,
  getCollectionElementType,
  locationAt,
  modelAttributeDefinition,
  positionAt,
  rangeAt,
  rangeAtOffset,
  resolveExpressionProperty,
  resolveModelPath,
  resolveModelType,
  routePath,
  sameRoute,
  THYMELEAF_EXECUTION_OBJECTS
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
    const thymesVarDefinition = findThymesVarTypeAt(text, offset, index);
    if (thymesVarDefinition) return thymesVarDefinition;

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
      if (handler) return locationAt(handler.uri, handler.position);
      const staticFile = index.findStaticFile(route.path);
      if (staticFile) return locationAt(staticFile.uri, Position.create(0, 0));
      return undefined;
    }

    const modelDefinition = findModelDefinitionAt(text, offset, template.name, index, document.uri);
    if (modelDefinition) return modelDefinition;

    const property = findModelPropertyAt(text, offset, template.name, index, document.uri);
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

function findThymesVarTypeAt(
  text: string,
  offset: number,
  index: ProjectIndex
): Location | undefined {
  for (const thymesVar of findThymesVars(text)) {
    const idStart = offsetAt(text, thymesVar.position);
    if (offset >= idStart && offset <= idStart + thymesVar.id.length) {
      const typeName = getCollectionElementType(thymesVar.typeName);
      const javaClass = index.findClass(typeName) ?? index.findClass(thymesVar.typeName);
      if (javaClass) return locationAt(javaClass.uri, javaClass.position);
    }

    const typeStart = offsetAt(text, thymesVar.typePosition);
    const rawTypeEnd = typeStart + thymesVar.rawTypeName.length;
    if (offset < typeStart || offset > rawTypeEnd) continue;

    const relativeOffset = offset - typeStart;
    const typeTokens = /[\w$]+(?:\.[\w$]+)*/g;
    for (const match of thymesVar.rawTypeName.matchAll(typeTokens)) {
      if (match.index === undefined) continue;
      const tokenEnd = match.index + match[0].length;
      if (relativeOffset < match.index || relativeOffset > tokenEnd) continue;
      const javaClass = index.findClass(match[0]);
      return javaClass ? locationAt(javaClass.uri, javaClass.position) : undefined;
    }

    const elementType = getCollectionElementType(thymesVar.typeName);
    const javaClass = index.findClass(elementType);
    if (javaClass) return locationAt(javaClass.uri, javaClass.position);
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

  const member = findModelMethodAt(text, offset, template.name, index, document.uri) ??
    findModelPropertyAt(text, offset, template.name, index, document.uri);
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

  const modelAttributes = new Map(
    index.modelAttributesForTemplate(template.name, document.uri)
  );
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

  const method = findModelMethodAt(text, offset, template.name, index, document.uri);
  if (method) {
    const docPart = method.javadoc ? `\n\n${method.javadoc}` : "\n\nJava method.";
    return {
      contents: {
        kind: "markdown",
        value: `**${method.name}()**: \`${method.typeName}\`${docPart}`
      },
      range: rangeAtOffset(text, ...findWordRange(text, offset))
    };
  }

  const property = findModelPropertyAt(text, offset, template.name, index, document.uri);
  if (property) {
    const docPart = property.javadoc ? `\n\n${property.javadoc}` : "\n\nJava model property.";
    return {
      contents: {
        kind: "markdown",
        value: `**${property.name}**: \`${property.typeName}\`${docPart}`
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
  if (route) {
    const handlers = index.findHandlersForRoute(route.path);
    if (handlers.length > 0) {
      return {
        contents: {
          kind: "markdown",
          value: `Spring route \`${route.path}\`\n\n${handlers.map(({ name }) => `- \`${name}()\``).join("\n")}`
        },
        range: rangeAt(document, route.range)
      };
    }
    const staticFile = index.findStaticFile(route.path);
    if (staticFile) {
      return {
        contents: {
          kind: "markdown",
          value: `Static asset: \`${staticFile.path}\``
        },
        range: rangeAt(document, route.range)
      };
    }
  }

  const expr = findEnclosingExpression(text, offset);
  if (expr && expr.prefix === "$") {
    const rootMatch = /^\s*([@#\w$]+)/.exec(expr.body);
    if (rootMatch && rootMatch.index !== undefined) {
      const rootName = rootMatch[1];
      const rootStart = expr.start + 2 + rootMatch.index + rootMatch[0].length - rootName.length;
      const rootEnd = rootStart + rootName.length;
      if (offset >= rootStart && offset <= rootEnd) {
        if (rootName.startsWith("@")) {
          const bean = index.findSpringBean(rootName.slice(1));
          if (bean) {
            return {
              contents: {
                kind: "markdown",
                value: `**@${bean.name}**: \`${bean.typeName}\`\n\nSpring Bean.`
              },
              range: rangeAtOffset(text, rootStart, rootEnd)
            };
          }
        } else if (rootName.startsWith("#")) {
          const execObj = THYMELEAF_EXECUTION_OBJECTS[rootName];
          if (execObj) {
            return {
              contents: {
                kind: "markdown",
                value: `**${rootName}**\n\n${execObj.description}`
              },
              range: rangeAtOffset(text, rootStart, rootEnd)
            };
          }
        }
      }
    }
  }

  return undefined;
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
            index,
            candidate.uri
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

  const property = findModelPropertyAt(text, offset, template.name, index, document.uri);
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
          index,
          candidate.uri
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

  const fragmentDef = findFragmentDefinitionAt(text, offset);
  if (fragmentDef) {
    return findFragmentReferences(template.name, fragmentDef, index);
  }

  const fragmentRef = findFragmentReference(text, offset);
  if (fragmentRef?.fragmentName) {
    const target = fragmentRef.templateName ?? template.name;
    return findFragmentReferences(target, fragmentRef.fragmentName, index);
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
        index,
        template.uri
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
        index,
        template.uri
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
  index: ProjectIndex,
  templateUri?: string
): { readonly property: JavaProperty; readonly range: Range } | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression) return undefined;
  return findModelPropertyOccurrences(expression, text, 0, templateName, index, templateUri)
    .find(({ range: occurrenceRange }) =>
      offset >= offsetAt(text, occurrenceRange.start) && offset <= offsetAt(text, occurrenceRange.end)
    );
}

function findModelMethodOccurrence(
  text: string,
  offset: number,
  templateName: string,
  index: ProjectIndex,
  templateUri?: string
): { readonly property: JavaProperty; readonly range: Range } | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression) return undefined;
  return findModelMethodOccurrences(expression, text, 0, templateName, index, templateUri)
    .find(({ range }) =>
      offset >= offsetAt(text, range.start) && offset <= offsetAt(text, range.end)
    );
}

function findModelMethodOccurrences(
  expression: Pick<ThymeleafExpression, "prefix" | "body" | "start">,
  text: string,
  baseOffset: number,
  templateName: string,
  index: ProjectIndex,
  templateUri?: string
): { readonly property: JavaProperty; readonly range: Range }[] {
  if (expression.prefix !== "$" && expression.prefix !== "*") return [];
  const rootMatch = /^\s*([@#\w$]+)/.exec(expression.body);
  if (!rootMatch || rootMatch.index === undefined) return [];
  const occurrences: { readonly property: JavaProperty; readonly range: Range }[] = [];
  let accessOffset = rootMatch.index + rootMatch[0].length;

  while (accessOffset < expression.body.length) {
    const access = readMemberAccess(expression.body, accessOffset);
    if (!access) break;
    const { name, nameOffset } = access;
    if (access.isMethodCall) {
      const receiver = resolveModelPath(
        expression.body.slice(0, nameOffset),
        expression.prefix,
        text,
        baseOffset + expression.start,
        templateName,
        index,
        templateUri
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
    accessOffset = access.endOffset;
  }
  return occurrences;
}

function findModelPropertyOccurrences(
  expression: Pick<ThymeleafExpression, "prefix" | "body" | "start">,
  text: string,
  baseOffset: number,
  templateName: string,
  index: ProjectIndex,
  templateUri?: string
): { readonly property: JavaProperty; readonly range: Range }[] {
  if (expression.prefix !== "$" && expression.prefix !== "*") return [];
  const body = expression.body;
  const rootMatch = /^\s*([@#\w$]+)/.exec(body);
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
      index,
      templateUri
    );
    if (result?.property) {
      const start = baseOffset + expression.start + 2 + rootMatch.index + rootMatch[0].lastIndexOf(rootName);
      occurrences.push({
        property: result.property,
        range: rangeAtOffset(text, start, start + rootName.length)
      });
    }
  }

  let accessOffset = rootMatch.index + rootMatch[0].length;
  while (accessOffset < body.length) {
    const access = readMemberAccess(body, accessOffset);
    if (!access) break;
    const { name, nameOffset, isMethodCall } = access;
    accessOffset = access.endOffset;
    if (isMethodCall) continue;

    const result = resolveModelPath(
      body.slice(0, nameOffset + name.length),
      expression.prefix,
      text,
      baseOffset + expression.start,
      templateName,
      index,
      templateUri
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
  index: ProjectIndex,
  templateUri?: string
): JavaProperty | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression) return undefined;
  const method = findModelMethodAt(text, offset, templateName, index, templateUri);
  if (method) return method;
  return findModelPropertyOccurrences(expression, text, 0, templateName, index, templateUri)
    .find(({ range }) =>
      offset >= offsetAt(text, range.start) && offset <= offsetAt(text, range.end)
    )?.property;
}

function findModelMethodAt(
  text: string,
  offset: number,
  templateName: string,
  index: ProjectIndex,
  templateUri?: string
): JavaProperty | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression || (expression.prefix !== "$" && expression.prefix !== "*")) return undefined;
  const rootMatch = /^\s*([@#\w$]+)/.exec(expression.body);
  if (!rootMatch || rootMatch.index === undefined) return undefined;

  if (expression.prefix === "*") {
    const rootName = rootMatch[1];
    const rootStart = expression.start + 2 + rootMatch.index + rootMatch[0].length - rootName.length;
    const rootEnd = rootStart + rootName.length;
    const remainingAfterRoot = expression.body.slice(rootMatch.index + rootMatch[0].length);
    if (/^\s*\(/.test(remainingAfterRoot)) {
      if (offset >= rootStart && offset <= rootEnd) {
        const modelAttributes = new Map(index.modelAttributesForTemplate(templateName, templateUri));
        for (const thymesVar of findThymesVars(text)) {
          modelAttributes.set(thymesVar.id, thymesVar.typeName);
        }
        const selectedType = findSelectedObjectType(text, expression.start, modelAttributes, index);
        if (selectedType) {
          return index.findMethodDefinition(selectedType, rootName);
        }
      }
    }
  }

  let accessOffset = rootMatch.index + rootMatch[0].length;
  while (accessOffset < expression.body.length) {
    const access = readMemberAccess(expression.body, accessOffset);
    if (!access) break;
    const { name, nameOffset } = access;
    const nameStart = expression.start + 2 + nameOffset;
    const nameEnd = nameStart + name.length;
    if (access.isMethodCall && offset >= nameStart && offset <= nameEnd) {
      const receiver = resolveModelPath(
        expression.body.slice(0, nameOffset),
        expression.prefix,
        text,
        expression.start,
        templateName,
        index,
        templateUri
      );
      return receiver
        ? index.findMethodDefinition(receiver.typeName, name)
        : undefined;
    }
    accessOffset = access.endOffset;
  }
  return undefined;
}

function readMemberAccess(
  body: string,
  offset: number
): { readonly name: string; readonly nameOffset: number; readonly isMethodCall: boolean; readonly endOffset: number } | undefined {
  let cursor = offset;
  while (cursor < body.length && /\s/.test(body[cursor] ?? "")) cursor += 1;
  while (cursor < body.length && body[cursor] === "[") {
    const closeBracket = body.indexOf("]", cursor);
    if (closeBracket < 0) return undefined;
    cursor = closeBracket + 1;
    while (cursor < body.length && /\s/.test(body[cursor] ?? "")) cursor += 1;
  }

  if (body[cursor] === "?" && body[cursor + 1] === ".") {
    cursor += 2;
  } else if (body[cursor] === ".") {
    cursor += 1;
  } else {
    return undefined;
  }
  while (cursor < body.length && /\s/.test(body[cursor] ?? "")) cursor += 1;

  const nameMatch = /^[\w$]+/.exec(body.slice(cursor));
  const name = nameMatch?.[0];
  if (!name) return undefined;
  const nameOffset = cursor;
  cursor += name.length;
  while (cursor < body.length && /\s/.test(body[cursor] ?? "")) cursor += 1;
  if (body[cursor] !== "(") {
    return { name, nameOffset, isMethodCall: false, endOffset: cursor };
  }

  const endOffset = findClosingParenthesis(body, cursor);
  return {
    name,
    nameOffset,
    isMethodCall: true,
    endOffset: endOffset < 0 ? body.length : endOffset + 1
  };
}

function findClosingParenthesis(text: string, openOffset: number): number {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let offset = openOffset; offset < text.length; offset += 1) {
    const character = text[offset];
    if (quote) {
      if (character === quote && text[offset - 1] !== "\\") quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return offset;
    }
  }
  return -1;
}

function findModelDefinitionAt(
  text: string,
  offset: number,
  templateName: string,
  index: ProjectIndex,
  templateUri: string
): Location | undefined {
  const expression = findEnclosingExpression(text, offset);
  if (!expression || expression.prefix !== "$") return undefined;
  const rootMatch = /^\s*([@#\w$]+)/.exec(expression.body);
  if (!rootMatch || rootMatch.index === undefined) return undefined;
  const modelName = rootMatch[1];
  const rootStart = expression.start + 2 + rootMatch.index + rootMatch[0].length - modelName.length;
  if (offset < rootStart || offset > rootStart + modelName.length) return undefined;
  if (modelName.startsWith("@")) {
    const bean = index.findSpringBean(modelName.slice(1));
    return bean ? locationAt(bean.uri, bean.position) : undefined;
  }

  const modelAttributes = new Map(index.modelAttributesForTemplate(templateName, templateUri));
  for (const thymesVar of findThymesVars(text)) {
    modelAttributes.set(thymesVar.id, thymesVar.typeName);
  }

  // 1. Chercher si modelName est une variable locale déclarée (th:each, th:with, th:fragment args)
  const localVars = findEnclosingLocalVariables(text, expression.start, modelAttributes, index);
  const foundLocal = localVars.find((v) => v.name === modelName);
  if (foundLocal) {
    return locationAt(templateUri, positionAt(text, foundLocal.declarationOffset));
  }

  return modelAttributeDefinition(templateName, modelName, index, text, templateUri) ??
    (() => {
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

  for (const attribute of findThymeleafAttributes(text)) {
    if (attribute.name === "layout:decorate" || attribute.name === "layout:decorator") {
      if (offset >= attribute.valueStart && offset <= attribute.valueStart + attribute.value.length) {
        const raw = attribute.value.trim().replace(/^['"]|['"]$/g, "");
        const [templateName, fragment] = raw.split("::", 2).map((part) => part.trim());
        return {
          templateName: templateName ? normalizeTemplateName(templateName) : undefined,
          fragmentName: fragment?.split("(", 1)[0]?.trim()
        };
      }
    } else if (attribute.name === "layout:fragment" || attribute.name === "th:fragment") {
      if (offset >= attribute.valueStart && offset <= attribute.valueStart + attribute.value.length) {
        const fragName = attribute.value.trim().split("(", 1)[0]?.trim();
        for (const otherAttr of findThymeleafAttributes(text)) {
          if (otherAttr.name === "layout:decorate" || otherAttr.name === "layout:decorator") {
            const raw = otherAttr.value.trim().replace(/^['"]|['"]$/g, "");
            const [parentTemplateName] = raw.split("::", 2).map((part) => part.trim());
            return {
              templateName: parentTemplateName ? normalizeTemplateName(parentTemplateName) : undefined,
              fragmentName: fragName
            };
          }
        }
      }
    }
  }

  return undefined;
}

function findFragmentDefinitionAt(text: string, offset: number): string | undefined {
  for (const attribute of findThymeleafAttributes(text)) {
    if (attribute.name !== "th:fragment" && attribute.name !== "layout:fragment") continue;
    if (offset >= attribute.valueStart && offset <= attribute.valueStart + attribute.value.length) {
      return attribute.value.trim().split("(", 1)[0]?.trim();
    }
  }
  return undefined;
}

function findFragmentReferences(
  templateName: string,
  fragmentName: string,
  index: ProjectIndex
): Location[] {
  const normalizedTarget = normalizeTemplateName(templateName);
  const references: Location[] = [];

  const targetTemplate = index.findTemplate(normalizedTarget);
  const relatedTemplates: IndexedTemplate[] = [];
  if (targetTemplate) {
    relatedTemplates.push(targetTemplate);
    for (const attr of findThymeleafAttributes(targetTemplate.content)) {
      if (attr.name === "layout:decorate" || attr.name === "layout:decorator") {
        const raw = attr.value.trim().replace(/^['"]|['"]$/g, "");
        const [tpl] = raw.split("::", 2).map((p) => p.trim());
        const parent = index.findTemplate(tpl);
        if (parent && !relatedTemplates.includes(parent)) relatedTemplates.push(parent);
      }
    }
  }

  for (const candidate of index.templates) {
    for (const attr of findThymeleafAttributes(candidate.content)) {
      if (attr.name === "layout:decorate" || attr.name === "layout:decorator") {
        const raw = attr.value.trim().replace(/^['"]|['"]$/g, "");
        const [tpl] = raw.split("::", 2).map((p) => p.trim());
        if (normalizeTemplateName(tpl) === normalizedTarget && !relatedTemplates.includes(candidate)) {
          relatedTemplates.push(candidate);
        }
      }
    }
  }

  for (const tpl of relatedTemplates) {
    for (const attribute of findThymeleafAttributes(tpl.content)) {
      if (attribute.name !== "th:fragment" && attribute.name !== "layout:fragment") continue;
      const rawName = attribute.value.trim().split("(", 1)[0]?.trim();
      if (rawName === fragmentName) {
        const nameOffset = attribute.value.indexOf(fragmentName);
        const start = attribute.valueStart + (nameOffset >= 0 ? nameOffset : 0);
        references.push(Location.create(
          tpl.uri,
          rangeAtOffset(tpl.content, start, start + fragmentName.length)
        ));
      }
    }
  }

  const targetNames = new Set(relatedTemplates.map((t) => normalizeTemplateName(t.name)));
  targetNames.add(normalizedTarget);

  for (const candidate of index.templates) {
    for (const expression of findThymeleafExpressions(candidate.content)) {
      if (expression.prefix !== "~") continue;
      const [tplPart, fragPart] = expression.body.split("::", 2).map((p) => p.trim());
      const normalizedTpl = tplPart ? normalizeTemplateName(tplPart) : normalizeTemplateName(candidate.name);
      if (targetNames.has(normalizedTpl)) {
        const callFrag = fragPart?.split("(", 1)[0]?.trim();
        if (callFrag === fragmentName) {
          const bodyStart = expression.start + 2;
          const fragOffsetInBody = expression.body.indexOf(fragPart);
          const start = bodyStart + (fragOffsetInBody >= 0 ? fragOffsetInBody : 0);
          references.push(Location.create(
            candidate.uri,
            rangeAtOffset(candidate.content, start, start + fragmentName.length)
          ));
        }
      }
    }
  }

  return references;
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
    if (
      (/return\s*$/.test(prefix) && !/redirect:|forward:/.test(match[2] ?? "")) ||
      /(?:setViewName|new\s+ModelAndView)\s*\([^)]*$/.test(prefix)
    ) {
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
