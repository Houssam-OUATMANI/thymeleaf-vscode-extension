import { Location, Position, Range, TextDocument } from "vscode-languageserver/node";
import { findThymeleafAttributes } from "../../thymeleaf/htmlParser";
import { findThymeleafExpressions } from "../../thymeleaf/expressions";
import { JavaProperty } from "../javaIndexer";
import { findThymesVars, ProjectIndex } from "../projectIndex";

export function findSelectedObjectType(
  text: string,
  offset: number,
  modelAttributes: ReadonlyMap<string, string>
): string | undefined {
  const before = text.slice(0, offset);
  const objectPattern = /\bth:object\s*=\s*(["'])\s*\$\{\s*([\w$]+)\s*\}\s*\1/g;
  let selectedName: string | undefined;
  for (const match of before.matchAll(objectPattern)) selectedName = match[2];
  return selectedName ? modelAttributes.get(selectedName) : undefined;
}

export function getCollectionElementType(typeName: string): string {
  const match = /^(?:[\w$.]+<([\w$.]+)>|([\w$.]+)\[\])$/.exec(typeName.trim());
  if (match) {
    return match[1] ?? match[2];
  }
  return typeName;
}

export interface LoopVariableInfo {
  readonly name: string;
  readonly typeName: string;
  readonly declarationOffset: number;
}

export function findEnclosingLoopVariables(
  text: string,
  offset: number,
  modelAttributes: ReadonlyMap<string, string>,
  index: ProjectIndex
): LoopVariableInfo[] {
  const variables: LoopVariableInfo[] = [];
  for (const attribute of findThymeleafAttributes(text)) {
    if (attribute.name !== "th:each" || attribute.nameStart > offset) continue;
    if (!isOffsetInsideElement(text, attribute.nameStart, offset)) continue;
    const iteration = /^\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?:\s*([\s\S]+)$/.exec(attribute.value);
    if (!iteration) continue;
    const loopVar = iteration[1];
    const statVar = iteration[2];
    const loopVarOffset = attribute.valueStart + attribute.value.indexOf(loopVar);

    let typeName = "java.lang.Object";
    const sourceExpression = findThymeleafExpressions(iteration[3])
      .find(({ prefix }) => prefix === "$" || prefix === "*");
    if (sourceExpression) {
      if (sourceExpression.body.includes("#numbers.sequence")) {
        typeName = "java.lang.Integer";
      } else {
        const [root, ...properties] = sourceExpression.body.trim().split(".");
        let currentType: string | undefined = root ? modelAttributes.get(root) : undefined;
        if (currentType) {
          for (const propertyName of properties) {
            const property = index.findProperty(currentType, propertyName);
            if (!property) {
              currentType = undefined;
              break;
            }
            currentType = property.typeName;
          }
          if (currentType) typeName = getCollectionElementType(currentType);
        }
      }
    }
    variables.push({ name: loopVar, typeName, declarationOffset: loopVarOffset });
    if (statVar) {
      const statVarOffset = attribute.valueStart + attribute.value.indexOf(statVar);
      variables.push({
        name: statVar,
        typeName: "org.thymeleaf.spring6.context.IterStatus",
        declarationOffset: statVarOffset
      });
    }
  }
  return variables;
}

export function resolveModelType(
  modelName: string,
  text: string,
  offset: number,
  modelAttributes: ReadonlyMap<string, string>,
  index: ProjectIndex
): string | undefined {
  const declaredType = modelAttributes.get(modelName);
  if (declaredType) return declaredType;

  const loopVars = findEnclosingLoopVariables(text, offset, modelAttributes, index);
  const found = loopVars.find((v) => v.name === modelName);
  if (found) return found.typeName;

  return undefined;
}

export interface ResolvedModelPath {
  readonly typeName: string;
  readonly property: JavaProperty | undefined;
  readonly unresolved: {
    readonly name: string;
    readonly typeName: string;
    readonly offset: number;
  } | undefined;
  readonly consumedLength: number;
}

export function resolveModelPath(
  body: string,
  prefix: string,
  text: string,
  expressionOffset: number,
  templateName: string,
  index: ProjectIndex
): ResolvedModelPath | undefined {
  const modelAttributes = new Map(index.modelAttributesForTemplate(templateName));
  for (const thymesVar of findThymesVars(text)) {
    modelAttributes.set(thymesVar.id, thymesVar.typeName);
  }

  const rootMatch = /^\s*([\w$]+)/.exec(body);
  if (!rootMatch || rootMatch.index === undefined) return undefined;
  const rootName = rootMatch[1];
  const chainOffset = rootMatch.index + rootMatch[0].length;
  const accessPattern = /\s*\.\s*([\w$]+)(\s*\([^()]*\))?/y;
  let typeName = prefix === "*"
    ? findSelectedObjectType(text, expressionOffset, modelAttributes)
    : resolveModelType(rootName, text, expressionOffset, modelAttributes, index);
  if (!typeName) return undefined;

  let lastProperty: JavaProperty | undefined;
  let consumedLength = chainOffset;
  if (prefix === "*") {
    const property = index.findProperty(typeName, rootName);
    if (!property) {
      return {
        typeName,
        property: undefined,
        unresolved: { name: rootName, typeName, offset: rootMatch.index },
        consumedLength
      };
    }
    typeName = property.typeName;
    lastProperty = property;
  }

  let accessOffset = chainOffset;
  while (accessOffset < body.length) {
    accessPattern.lastIndex = accessOffset;
    const access = accessPattern.exec(body);
    if (!access) break;
    const name = access[1];
    const isMethodCall = access[2] !== undefined;
    const nameOffset = accessOffset + access[0].indexOf(name);
    accessOffset += access[0].length;
    consumedLength = accessOffset;

    if (isMethodCall) {
      const returnType = index.findMethodReturnType(typeName, name);
      if (returnType) {
        typeName = returnType;
        lastProperty = undefined;
        continue;
      }
    }

    const property = index.findProperty(typeName, name);
    if (!property) {
      return {
        typeName,
        property: undefined,
        unresolved: { name, typeName, offset: nameOffset },
        consumedLength
      };
    }
    typeName = property.typeName;
    lastProperty = property;
  }

  return { typeName, property: lastProperty, unresolved: undefined, consumedLength };
}

export interface ExecutionObjectMethod {
  readonly name: string;
  readonly returnType: string;
  readonly documentation?: string;
}

export const THYMELEAF_EXECUTION_OBJECTS: Record<
  string,
  { readonly description: string; readonly methods: readonly ExecutionObjectMethod[] }
> = {
  "#numbers": {
    description: "Utility methods for numeric objects: sequences, formatting, etc.",
    methods: [
      { name: "sequence(from, to)", returnType: "List<Integer>", documentation: "Generate a sequence of integers from `from` to `to` inclusive." },
      { name: "sequence(from, to, step)", returnType: "List<Integer>", documentation: "Generate a sequence of integers with a given step." },
      { name: "formatInteger(target, minIntegerDigits)", returnType: "String", documentation: "Format integer with minimum integer digits." },
      { name: "formatDecimal(target, minIntegerDigits, decimalDigits)", returnType: "String", documentation: "Format decimal number." },
      { name: "formatPercent(target, minIntegerDigits, decimalDigits)", returnType: "String", documentation: "Format percentage." }
    ]
  },
  "#strings": {
    description: "Utility methods for String objects: empty checks, substring, contains, etc.",
    methods: [
      { name: "isEmpty(target)", returnType: "boolean", documentation: "Check whether a string is empty or null." },
      { name: "defaultString(target, defaultValue)", returnType: "String", documentation: "Return default string if target is null or empty." },
      { name: "contains(target, fragment)", returnType: "boolean", documentation: "Check whether a string contains a fragment." },
      { name: "startsWith(target, prefix)", returnType: "boolean", documentation: "Check whether a string starts with a prefix." },
      { name: "endsWith(target, suffix)", returnType: "boolean", documentation: "Check whether a string ends with a suffix." },
      { name: "length(target)", returnType: "int", documentation: "Return the length of a string." },
      { name: "toUpperCase(target)", returnType: "String", documentation: "Convert string to upper case." },
      { name: "toLowerCase(target)", returnType: "String", documentation: "Convert string to lower case." },
      { name: "capitalize(target)", returnType: "String", documentation: "Capitalize first character." },
      { name: "trim(target)", returnType: "String", documentation: "Trim whitespace." },
      { name: "replace(target, before, after)", returnType: "String", documentation: "Replace occurrences of substring." }
    ]
  },
  "#dates": {
    description: "Utility methods for java.util.Date objects.",
    methods: [
      { name: "format(target, pattern)", returnType: "String", documentation: "Format Date with pattern." },
      { name: "day(target)", returnType: "int", documentation: "Get day of month." },
      { name: "month(target)", returnType: "int", documentation: "Get month." },
      { name: "year(target)", returnType: "int", documentation: "Get year." },
      { name: "createNow()", returnType: "Date", documentation: "Get current Date." }
    ]
  },
  "#temporals": {
    description: "Utility methods for Java 8 java.time (LocalDate, LocalDateTime) objects.",
    methods: [
      { name: "format(target, pattern)", returnType: "String", documentation: "Format Temporal with pattern." },
      { name: "day(target)", returnType: "int", documentation: "Get day." },
      { name: "month(target)", returnType: "int", documentation: "Get month." },
      { name: "year(target)", returnType: "int", documentation: "Get year." },
      { name: "createNow()", returnType: "LocalDateTime", documentation: "Get current LocalDateTime." }
    ]
  },
  "#lists": {
    description: "Utility methods for java.util.List objects.",
    methods: [
      { name: "size(target)", returnType: "int", documentation: "Get size of list." },
      { name: "isEmpty(target)", returnType: "boolean", documentation: "Check if list is empty." },
      { name: "contains(target, element)", returnType: "boolean", documentation: "Check if list contains element." },
      { name: "sort(target)", returnType: "List", documentation: "Return sorted copy of list." }
    ]
  },
  "#fields": {
    description: "Spring Form validation and errors utility.",
    methods: [
      { name: "hasErrors(field)", returnType: "boolean", documentation: "Check if field has validation errors." },
      { name: "errors(field)", returnType: "List<String>", documentation: "Get list of error messages for field." },
      { name: "allErrors()", returnType: "List<String>", documentation: "Get all validation errors." }
    ]
  },
  "#messages": {
    description: "Utility methods for i18n messages.",
    methods: [
      { name: "msg(key)", returnType: "String", documentation: "Get message for key." },
      { name: "msgWithParams(key, ...params)", returnType: "String", documentation: "Get parameterized message." }
    ]
  },
  "#uris": {
    description: "Utility methods for URI / URL escaping.",
    methods: [
      { name: "escapePath(path)", returnType: "String", documentation: "Escape URI path." },
      { name: "escapeQueryParam(param)", returnType: "String", documentation: "Escape query param." }
    ]
  }
};

export function modelAttributeDefinition(
  templateName: string,
  modelName: string,
  index: ProjectIndex,
  currentText?: string
): Location | undefined {
  const definition = index.modelAttributeDefinitionsForTemplate(templateName).get(modelName);
  if (definition) return locationAt(definition.uri, definition.position);
  if (currentText) {
    for (const thymesVar of findThymesVars(currentText)) {
      if (thymesVar.id === modelName) {
        const javaClass = index.findClass(thymesVar.typeName);
        if (javaClass) return locationAt(javaClass.uri, javaClass.position);
      }
    }
  }
  for (const handler of index.getHandlersForTemplate(templateName)) {
    const typeName = handler.modelAttributes.get(modelName);
    const javaClass = typeName ? index.findClass(typeName) : undefined;
    if (javaClass) return locationAt(javaClass.uri, javaClass.position);
  }
  return undefined;
}

export function resolveExpressionProperty(
  body: string,
  prefix: string,
  text: string,
  expressionOffset: number,
  templateName: string,
  index: ProjectIndex
): JavaProperty | undefined {
  return resolveModelPath(body, prefix, text, expressionOffset, templateName, index)?.property;
}

export function findEnclosingExpression(
  text: string,
  offset: number
): { prefix: string; body: string; start: number; end: number } | undefined {
  const modelExpression = /([$*])\{([^{}]*)\}/g;
  for (const match of text.matchAll(modelExpression)) {
    if (match.index === undefined) continue;
    const bodyStart = match.index + 2;
    const bodyEnd = bodyStart + (match[2]?.length ?? 0);
    if (offset >= match.index && offset <= bodyEnd) {
      return { prefix: match[1], body: match[2] ?? "", start: match.index, end: bodyEnd + 1 };
    }
  }
  for (const expression of findThymeleafExpressions(text)) {
    if (offset >= expression.start && offset <= expression.end) {
      return expression;
    }
  }
  const open = Math.max(text.lastIndexOf("${", offset), text.lastIndexOf("*{", offset));
  if (open >= 0 && !text.slice(open, offset).includes("}")) {
    return { prefix: text[open], body: text.slice(open + 2, offset), start: open, end: offset };
  }
  return undefined;
}

export function routePath(expressionBody: string): string | undefined {
  const body = expressionBody.trim();
  if (!body.startsWith("/")) return undefined;
  const parameterStart = body.indexOf("(");
  return parameterStart < 0 ? body : body.slice(0, parameterStart);
}

export function sameRoute(left: string | undefined, right: string): boolean {
  return left !== undefined && left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

export function rangeAtOffset(text: string, start: number, end: number): Range {
  return Range.create(positionAt(text, start), positionAt(text, end));
}

export function locationAt(
  uri: string,
  position: { readonly line: number; readonly character: number }
): Location {
  const point = Position.create(position.line, position.character);
  return Location.create(uri, Range.create(point, point));
}

export function rangeAt(document: TextDocument, offsets: readonly [number, number]): Range {
  return Range.create(document.positionAt(offsets[0]), document.positionAt(offsets[1]));
}

export function positionAt(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lineBreaks = before.match(/\n/g)?.length ?? 0;
  const lastBreak = before.lastIndexOf("\n");
  return Position.create(lineBreaks, before.length - lastBreak - 1);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isOffsetInsideElement(text: string, elementStart: number, offset: number): boolean {
  const tagStart = text.lastIndexOf("<", elementStart);
  if (tagStart < 0) return false;
  const openingTag = text.slice(tagStart, text.indexOf(">", tagStart) + 1);
  const tagName = /^<\s*([\w:-]+)/.exec(openingTag)?.[1];
  if (!tagName || /\/\s*>$/.test(openingTag)) {
    return offset <= tagStart + openingTag.length;
  }

  const tagPattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = tagStart;
  let depth = 0;
  for (let match = tagPattern.exec(text); match; match = tagPattern.exec(text)) {
    if (match.index > offset) break;
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return offset < match.index;
    } else if (!/\/\s*>$/.test(match[0])) {
      depth += 1;
    }
  }
  return depth > 0 && offset < text.length;
}
