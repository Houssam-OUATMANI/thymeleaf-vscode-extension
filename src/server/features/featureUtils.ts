import { Location, Position, Range, TextDocument } from "vscode-languageserver/node";
import {
  findTagEnd,
  findThymeleafAttributes,
  isVoidElement,
  readTagName
} from "../../thymeleaf/htmlParser";
import { findThymeleafExpressions } from "../../thymeleaf/expressions";
import { JavaProperty } from "../javaIndexer";
import { findThymesVars, ProjectIndex } from "../projectIndex";

export function findSelectedObjectType(
  text: string,
  offset: number,
  modelAttributes: ReadonlyMap<string, string>,
  index?: ProjectIndex
): string | undefined {
  const allAttributes = findThymeleafAttributes(text);
  const objectAttributes = allAttributes.filter((attr) => attr.name === "th:object");
  const enclosing = objectAttributes.filter((attr) =>
    isOffsetInsideElement(text, attr.nameStart, offset)
  );
  if (enclosing.length === 0) return undefined;

  const innermost = enclosing.sort((a, b) => b.nameStart - a.nameStart)[0];
  const expr = findThymeleafExpressions(innermost.value)[0];
  if (!expr) return undefined;

  const parts = expr.body.trim().split(".");
  const root = parts[0];
  let currentType = root ? modelAttributes.get(root) : undefined;
  if (index && currentType) {
    for (let i = 1; i < parts.length; i += 1) {
      const cleanProp = parts[i].replace(/\(\)$/, "");
      const prop = index.findProperty(currentType, cleanProp);
      if (!prop) {
        currentType = undefined;
        break;
      }
      currentType = prop.typeName;
    }
  }
  return currentType;
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

export function findEnclosingLocalVariables(
  text: string,
  offset: number,
  modelAttributes: ReadonlyMap<string, string>,
  index: ProjectIndex
): LoopVariableInfo[] {
  const variables: LoopVariableInfo[] = [];

  for (const attribute of findThymeleafAttributes(text)) {
    if (!isOffsetInsideElement(text, attribute.nameStart, offset)) continue;

    if (attribute.name === "th:each") {
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
              const cleanProp = propertyName.replace(/\(\)$/, "");
              const property = index.findProperty(currentType, cleanProp);
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
      const statVarName = statVar ?? `${loopVar}Stat`;
      const statVarOffset = statVar
        ? attribute.valueStart + attribute.value.indexOf(statVar)
        : loopVarOffset;
      variables.push({
        name: statVarName,
        typeName: "org.thymeleaf.spring6.context.IterStatus",
        declarationOffset: statVarOffset
      });
    } else if (attribute.name === "th:with") {
      const declarations = splitVariableAssignments(attribute.value);
      for (const { name: varName, expr: varExpr, nameOffset } of declarations) {
        let typeName = "java.lang.Object";
        const innerExpr = findThymeleafExpressions(varExpr).find(
          ({ prefix }) => prefix === "$" || prefix === "*"
        );
        if (innerExpr) {
          const [root, ...properties] = innerExpr.body.trim().split(".");
          let currentType: string | undefined = root ? modelAttributes.get(root) : undefined;
          if (currentType) {
            for (const propertyName of properties) {
              const cleanProp = propertyName.replace(/\(\)$/, "");
              const property = index.findProperty(currentType, cleanProp);
              if (!property) {
                currentType = undefined;
                break;
              }
              currentType = property.typeName;
            }
            if (currentType) typeName = currentType;
          }
        } else if (varExpr === "true" || varExpr === "false") {
          typeName = "boolean";
        } else if (/^\d+$/.test(varExpr)) {
          typeName = "java.lang.Integer";
        } else if (/^\d+\.\d+$/.test(varExpr)) {
          typeName = "java.lang.Double";
        } else if (varExpr.startsWith("'") && varExpr.endsWith("'")) {
          typeName = "java.lang.String";
        }
        variables.push({
          name: varName,
          typeName,
          declarationOffset: attribute.valueStart + nameOffset
        });
      }
    }
  }

  return variables;
}

export function findEnclosingLoopVariables(
  text: string,
  offset: number,
  modelAttributes: ReadonlyMap<string, string>,
  index: ProjectIndex
): LoopVariableInfo[] {
  return findEnclosingLocalVariables(text, offset, modelAttributes, index);
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

  const localVars = findEnclosingLocalVariables(text, offset, modelAttributes, index);
  const found = localVars.find((v) => v.name === modelName);
  if (found) return found.typeName;

  return undefined;
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
      { name: "hasErrors()", returnType: "boolean", documentation: "Check if form has any validation errors." },
      { name: "hasErrors(field)", returnType: "boolean", documentation: "Check if field has validation errors." },
      { name: "hasGlobalErrors()", returnType: "boolean", documentation: "Check if form has global errors." },
      { name: "errors()", returnType: "List<String>", documentation: "Get all error messages." },
      { name: "errors(field)", returnType: "List<String>", documentation: "Get list of error messages for field." },
      { name: "globalErrors()", returnType: "List<String>", documentation: "Get list of global error messages." },
      { name: "allErrors()", returnType: "List<String>", documentation: "Get all validation errors." },
      { name: "idFromName(field)", returnType: "String", documentation: "Compute field id for a field expression." },
      { name: "detailedErrors()", returnType: "List", documentation: "Get list of detailed FieldError objects." },
      { name: "detailedErrors(field)", returnType: "List", documentation: "Get list of detailed FieldError objects for field." }
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
  },
  "#ctx": {
    description: "Current Thymeleaf expression evaluation context.",
    methods: [
      { name: "getVariable(name)", returnType: "Object", documentation: "Get context variable by name." },
      { name: "getVariableNames()", returnType: "Set<String>", documentation: "Get all variable names in context." },
      { name: "getLocale()", returnType: "Locale", documentation: "Get current locale." },
      { name: "containsVariable(name)", returnType: "boolean", documentation: "Check if variable is defined in context." }
    ]
  },
  "#locale": {
    description: "Current request java.util.Locale.",
    methods: [
      { name: "getLanguage()", returnType: "String", documentation: "Get language code." },
      { name: "getCountry()", returnType: "String", documentation: "Get country code." },
      { name: "getDisplayName()", returnType: "String", documentation: "Get display name." }
    ]
  },
  "#request": {
    description: "Current HttpServletRequest object.",
    methods: [
      { name: "getContextPath()", returnType: "String", documentation: "Get request context path." },
      { name: "getRequestURI()", returnType: "String", documentation: "Get request URI." },
      { name: "getParameter(name)", returnType: "String", documentation: "Get request parameter by name." },
      { name: "getParameterValues(name)", returnType: "String[]", documentation: "Get request parameter values by name." },
      { name: "getHeader(name)", returnType: "String", documentation: "Get HTTP header value." },
      { name: "getMethod()", returnType: "String", documentation: "Get HTTP method." },
      { name: "getSession()", returnType: "HttpSession", documentation: "Get current session." }
    ]
  },
  "#response": {
    description: "Current HttpServletResponse object.",
    methods: [
      { name: "getStatus()", returnType: "int", documentation: "Get HTTP status code." },
      { name: "getContentType()", returnType: "String", documentation: "Get response content type." },
      { name: "getHeader(name)", returnType: "String", documentation: "Get HTTP response header." }
    ]
  },
  "#session": {
    description: "Current HttpSession object.",
    methods: [
      { name: "getId()", returnType: "String", documentation: "Get session ID." },
      { name: "getAttribute(name)", returnType: "Object", documentation: "Get session attribute." },
      { name: "getAttributeNames()", returnType: "Enumeration<String>", documentation: "Get all session attribute names." }
    ]
  },
  "#servletContext": {
    description: "Current ServletContext object.",
    methods: [
      { name: "getContextPath()", returnType: "String", documentation: "Get servlet context path." },
      { name: "getInitParameter(name)", returnType: "String", documentation: "Get init parameter." }
    ]
  },
  "#conversions": {
    description: "Spring ConversionService utility.",
    methods: [
      { name: "convert(target, className)", returnType: "Object", documentation: "Convert target object to target class." }
    ]
  },
  "#sets": {
    description: "Utility methods for java.util.Set objects.",
    methods: [
      { name: "size(target)", returnType: "int", documentation: "Get size of set." },
      { name: "isEmpty(target)", returnType: "boolean", documentation: "Check if set is empty." },
      { name: "contains(target, element)", returnType: "boolean", documentation: "Check if set contains element." }
    ]
  },
  "#maps": {
    description: "Utility methods for java.util.Map objects.",
    methods: [
      { name: "size(target)", returnType: "int", documentation: "Get size of map." },
      { name: "isEmpty(target)", returnType: "boolean", documentation: "Check if map is empty." },
      { name: "containsKey(target, key)", returnType: "boolean", documentation: "Check if map contains key." },
      { name: "containsValue(target, value)", returnType: "boolean", documentation: "Check if map contains value." }
    ]
  },
  "#aggregates": {
    description: "Utility methods for creating aggregates on arrays or collections.",
    methods: [
      { name: "sum(target)", returnType: "Number", documentation: "Calculate sum of numbers." },
      { name: "avg(target)", returnType: "Number", documentation: "Calculate average of numbers." }
    ]
  }
};

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
  index: ProjectIndex,
  templateUri?: string
): ResolvedModelPath | undefined {
  const modelAttributes = new Map(index.modelAttributesForTemplate(templateName, templateUri));
  for (const thymesVar of findThymesVars(text)) {
    modelAttributes.set(thymesVar.id, thymesVar.typeName);
  }

  const rootMatch = /^\s*([#\w$]+)/.exec(body);
  if (!rootMatch || rootMatch.index === undefined) return undefined;
  const rootName = rootMatch[1];
  const chainOffset = rootMatch.index + rootMatch[0].length;
  let rawTypeName: string | undefined = prefix === "*"
    ? findSelectedObjectType(text, expressionOffset, modelAttributes, index)
    : resolveModelType(rootName, text, expressionOffset, modelAttributes, index);

  if (!rawTypeName && rootName.startsWith("#")) {
    const execObj = THYMELEAF_EXECUTION_OBJECTS[rootName];
    if (execObj) {
      rawTypeName = rootName;
    }
  }

  if (!rawTypeName) return undefined;

  let currentTypeName: string = rawTypeName;
  let lastProperty: JavaProperty | undefined;
  let consumedLength = chainOffset;
  if (prefix === "*") {
    const property = index.findProperty(currentTypeName, rootName);
    if (!property) {
      return {
        typeName: currentTypeName,
        property: undefined,
        unresolved: { name: rootName, typeName: currentTypeName, offset: rootMatch.index },
        consumedLength
      };
    }
    currentTypeName = property.typeName;
    lastProperty = property;
  }

  let accessOffset = chainOffset;
  while (accessOffset < body.length) {
    const remaining = body.slice(accessOffset);
    const dotMatch = /^\s*\.\s*([\w$]+)/.exec(remaining);
    if (!dotMatch) break;

    const name = dotMatch[1];
    const nameOffset = accessOffset + dotMatch[0].indexOf(name);
    let afterNameOffset = accessOffset + dotMatch[0].length;

    let isMethodCall = false;
    const parenMatch = /^\s*\(/.exec(body.slice(afterNameOffset));
    if (parenMatch) {
      const openParenIndex = afterNameOffset + parenMatch[0].indexOf("(");
      const closeParenIndex = readBalancedParentheses(body, openParenIndex);
      if (closeParenIndex >= 0) {
        isMethodCall = true;
        afterNameOffset = closeParenIndex + 1;
      }
    }

    accessOffset = afterNameOffset;
    consumedLength = accessOffset;

    if (isMethodCall) {
      if (currentTypeName.startsWith("#")) {
        const execObj = THYMELEAF_EXECUTION_OBJECTS[currentTypeName];
        const method = execObj?.methods.find(
          (m: ExecutionObjectMethod) => m.name === name || m.name.startsWith(`${name}(`)
        );
        if (method) {
          currentTypeName = method.returnType;
          lastProperty = undefined;
          continue;
        }
        return {
          typeName: currentTypeName,
          property: undefined,
          unresolved: { name, typeName: currentTypeName, offset: nameOffset },
          consumedLength
        };
      }

      const returnType = index.findMethodReturnType(currentTypeName, name);
      if (returnType) {
        currentTypeName = returnType;
        lastProperty = undefined;
        continue;
      }
    }

    if (currentTypeName.startsWith("#")) {
      const execObj = THYMELEAF_EXECUTION_OBJECTS[currentTypeName];
      const method = execObj?.methods.find(
        (m: ExecutionObjectMethod) => m.name === name || m.name.startsWith(`${name}(`)
      );
      if (method) {
        currentTypeName = method.returnType;
        lastProperty = undefined;
        continue;
      }
      return {
        typeName: currentTypeName,
        property: undefined,
        unresolved: { name, typeName: currentTypeName, offset: nameOffset },
        consumedLength
      };
    }

    const property = index.findProperty(currentTypeName, name);
    if (!property) {
      return {
        typeName: currentTypeName,
        property: undefined,
        unresolved: { name, typeName: currentTypeName, offset: nameOffset },
        consumedLength
      };
    }
    currentTypeName = property.typeName;
    lastProperty = property;
  }

  return { typeName: currentTypeName, property: lastProperty, unresolved: undefined, consumedLength };
}

function readBalancedParentheses(text: string, openIndex: number): number {
  if (text[openIndex] !== "(") return -1;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitVariableAssignments(
  value: string
): { readonly name: string; readonly expr: string; readonly nameOffset: number }[] {
  const result: { name: string; expr: string; nameOffset: number }[] = [];
  let depthParen = 0;
  let depthBrace = 0;
  let quote: "'" | '"' | undefined;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      depthParen += 1;
    } else if (char === ")") {
      depthParen -= 1;
    } else if (char === "{" || char === "[") {
      depthBrace += 1;
    } else if (char === "}" || char === "]") {
      depthBrace -= 1;
    } else if (char === "," && depthParen === 0 && depthBrace === 0) {
      parseAssignment(value.slice(start, index), start, result);
      start = index + 1;
    }
  }
  if (start < value.length) {
    parseAssignment(value.slice(start), start, result);
  }
  return result;
}

function parseAssignment(
  part: string,
  baseOffset: number,
  result: { name: string; expr: string; nameOffset: number }[]
): void {
  const eqIndex = part.indexOf("=");
  if (eqIndex < 0) return;
  const rawName = part.slice(0, eqIndex);
  const leadingWhitespace = /^\s*/.exec(rawName)?.[0].length ?? 0;
  const name = rawName.trim();
  const expr = part.slice(eqIndex + 1).trim();
  if (name && expr) {
    result.push({
      name,
      expr,
      nameOffset: baseOffset + leadingWhitespace
    });
  }
}

export function modelAttributeDefinition(
  templateName: string,
  modelName: string,
  index: ProjectIndex,
  currentText?: string,
  templateUri?: string
): Location | undefined {
  const definition = index.modelAttributeDefinitionsForTemplate(templateName, templateUri).get(modelName);
  if (definition) return locationAt(definition.uri, definition.position);
  if (currentText) {
    for (const thymesVar of findThymesVars(currentText)) {
      if (thymesVar.id === modelName) {
        const javaClass = index.findClass(thymesVar.typeName);
        if (javaClass) return locationAt(javaClass.uri, javaClass.position);
      }
    }
  }
  for (const handler of index.getHandlersForTemplate(templateName, templateUri)) {
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
  index: ProjectIndex,
  templateUri?: string
): JavaProperty | undefined {
  return resolveModelPath(body, prefix, text, expressionOffset, templateName, index, templateUri)?.property;
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

export function isOffsetInsideElement(text: string, elementStart: number, offset: number): boolean {
  const tagStart = text.lastIndexOf("<", elementStart);
  if (tagStart < 0 || offset < tagStart) return false;

  const tagEnd = findTagEnd(text, tagStart + 1);
  if (tagEnd < 0) return false;

  if (offset >= tagStart && offset <= tagEnd) {
    return true;
  }

  const rawOpeningTag = text.slice(tagStart + 1, tagEnd);
  const tagName = readTagName(text, tagStart + 1, tagEnd).toLowerCase();
  if (!tagName) return false;

  const isSelfClosing = /\/\s*$/.test(rawOpeningTag);
  if (isSelfClosing || isVoidElement(tagName)) {
    return false;
  }

  let depth = 1;
  let cursor = tagEnd + 1;

  while (cursor < text.length) {
    const nextTag = text.indexOf("<", cursor);
    if (nextTag < 0) break;

    if (nextTag > offset) {
      break;
    }

    if (text.startsWith("<!--", nextTag)) {
      const commentEnd = text.indexOf("-->", nextTag + 4);
      cursor = commentEnd < 0 ? text.length : commentEnd + 3;
      continue;
    }

    const nextChar = text[nextTag + 1];
    if (!nextChar || nextChar === "!" || nextChar === "?") {
      cursor = nextTag + 1;
      continue;
    }

    const currentTagEnd = findTagEnd(text, nextTag + 1);
    if (currentTagEnd < 0) break;

    const currentRawTag = text.slice(nextTag + 1, currentTagEnd);

    if (nextChar === "/") {
      const closingName = readTagName(text, nextTag + 2, currentTagEnd).toLowerCase();
      if (closingName === tagName) {
        depth -= 1;
        if (depth === 0) {
          return offset <= currentTagEnd;
        }
      }
    } else {
      const openingName = readTagName(text, nextTag + 1, currentTagEnd).toLowerCase();
      const currentSelfClosing = /\/\s*$/.test(currentRawTag) || isVoidElement(openingName);
      if (openingName === tagName && !currentSelfClosing) {
        depth += 1;
      }
      if (openingName === "script" || openingName === "style") {
        const closingTag = text.toLowerCase().indexOf(`</${openingName}`, currentTagEnd + 1);
        if (closingTag >= 0) {
          const closingEnd = text.indexOf(">", closingTag);
          cursor = closingEnd < 0 ? text.length : closingEnd + 1;
          continue;
        }
      }
    }

    cursor = currentTagEnd + 1;
  }

  return depth > 0 && offset < text.length;
}
