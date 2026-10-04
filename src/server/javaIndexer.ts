import { pathToFileURL } from "node:url";

export interface SourcePosition {
  readonly line: number;
  readonly character: number;
}

export interface JavaProperty {
  readonly name: string;
  readonly typeName: string;
  readonly uri: string;
  readonly position: SourcePosition;
  readonly renameable?: boolean;
}

export interface JavaClass {
  readonly name: string;
  readonly qualifiedName: string;
  readonly uri: string;
  readonly position: SourcePosition;
  readonly properties: ReadonlyMap<string, JavaProperty>;
  readonly methodReturnTypes: ReadonlyMap<string, string>;
  readonly typeParameters?: readonly string[];
  readonly superClassName?: string;
  readonly superTypeNames?: readonly string[];
}

export interface JavaTypeReference {
  readonly uri: string;
  readonly position: SourcePosition;
  readonly typeName: string;
}

export interface ControllerHandler {
  readonly uri: string;
  readonly name: string;
  readonly routePaths: readonly string[];
  readonly viewName: string | undefined;
  readonly position: SourcePosition;
  readonly modelAttributes: ReadonlyMap<string, string>;
  readonly modelAttributePositions: ReadonlyMap<string, SourcePosition>;
  readonly modelAttributeExpressions: ReadonlyMap<string, { readonly expression: string; readonly position: SourcePosition }>;
  readonly ownerType: string;
}

export interface JavaSourceIndex {
  readonly classes: readonly JavaClass[];
  readonly handlers: readonly ControllerHandler[];
  readonly typeReferences: readonly JavaTypeReference[];
}

interface Token {
  readonly text: string;
  readonly kind: "identifier" | "string" | "symbol";
  readonly start: number;
  readonly end: number;
}

interface Annotation {
  readonly name: string;
  readonly stringArguments: readonly string[];
  readonly stringArgumentOffsets: readonly number[];
  readonly tokenIndex: number;
}

interface ParsedParameter {
  readonly name: string;
  readonly typeName: string;
  readonly modelAttributeName: string | undefined;
  readonly modelAttributeOffset: number | undefined;
  readonly nameTokenIndex: number;
  readonly typeReferences: readonly { readonly typeName: string; readonly tokenIndex: number }[];
}

const CONTROLLER_ANNOTATIONS = new Set(["Controller", "RestController"]);
const REQUEST_MAPPINGS = new Set([
  "RequestMapping",
  "GetMapping",
  "PostMapping",
  "PutMapping",
  "PatchMapping",
  "DeleteMapping"
]);

export function indexJavaSources(sources: ReadonlyMap<string, string>): JavaSourceIndex {
  const classes: JavaClass[] = [];
  const handlers: ControllerHandler[] = [];
  const typeReferences: JavaTypeReference[] = [];

  for (const [filePath, source] of sources) {
    const parsed = parseJavaSource(filePath, source);
    classes.push(...parsed.classes);
    handlers.push(...parsed.handlers);
    typeReferences.push(...parsed.typeReferences);
  }

  const classesByName = new Map<string, JavaClass>();
  for (const javaClass of classes) {
    classesByName.set(javaClass.name, javaClass);
    classesByName.set(javaClass.qualifiedName, javaClass);
  }

  const resolvedHandlers = handlers.map((handler) => {
    const modelAttributes = new Map(handler.modelAttributes);
    for (const [attributeName, modelExpression] of handler.modelAttributeExpressions) {
      const typeName = inferModelExpressionType(modelExpression.expression, handler, classesByName);
      if (typeName) modelAttributes.set(attributeName, typeName);
    }
    const modelAttributePositions = new Map(handler.modelAttributePositions);
    for (const [attributeName, modelExpression] of handler.modelAttributeExpressions) {
      modelAttributePositions.set(attributeName, modelExpression.position);
    }
    return { ...handler, modelAttributes, modelAttributePositions };
  });

  return { classes, handlers: resolvedHandlers, typeReferences };
}

function parseJavaSource(
  filePath: string,
  source: string
): { classes: JavaClass[]; handlers: ControllerHandler[]; typeReferences: JavaTypeReference[] } {
  const tokens = tokenizeJava(source);
  const packageName = readPackageName(tokens);
  const uri = pathToFileURL(filePath).toString();
  const classes: JavaClass[] = [];
  const handlers: ControllerHandler[] = [];
  const typeReferences: JavaTypeReference[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (!["class", "record", "enum", "interface"].includes(tokens[index].text)) {
      continue;
    }

    const nameToken = tokens[index + 1];
    if (!nameToken || nameToken.kind !== "identifier") {
      continue;
    }
    const bodyStart = findNextToken(tokens, index + 2, "{");
    const bodyEnd = bodyStart < 0 ? -1 : findMatching(tokens, bodyStart, "{", "}");
    if (bodyEnd < 0) {
      continue;
    }

    const declarationKeyword = tokens[index].text;
    const typeParameters = parseTypeParameters(tokens, index + 2, bodyStart);
    const headerTypeReferences = getTypeReferencesInRange(tokens, index + 2, bodyStart)
      .filter(({ typeName }) =>
        !typeParameters.includes(typeName) &&
        !["extends", "implements", "permits", "super"].includes(typeName)
      );
    typeReferences.push(...toJavaTypeReferences(headerTypeReferences, uri, source, tokens));
    const className = nameToken.text;
    const enclosingTypes = findEnclosingTypeNames(tokens, index);
    const qualifiedClassName = [...enclosingTypes, className].join(".");
    const qualifiedName = packageName ? `${packageName}.${qualifiedClassName}` : qualifiedClassName;
    const classAnnotations = readAnnotations(tokens, declarationStart(tokens, index), index);

    let superClassName: string | undefined;
    let genericDepth = 0;
    for (let i = index + 2; i < bodyStart; i += 1) {
      if (tokens[i].text === "<") genericDepth += 1;
      else if (tokens[i].text === ">") genericDepth -= 1;
      if (
        genericDepth === 0 &&
        tokens[i].text === "extends" &&
        tokens[i + 1]?.kind === "identifier"
      ) {
        superClassName = tokens[i + 1].text;
        break;
      }
    }
    const superTypeNames = readSuperTypeNames(tokens, index + 2, bodyStart);

    const classMembers = readClassMembers(tokens, bodyStart, bodyEnd);
    const properties = new Map<string, JavaProperty>();
    const methodReturnTypes = new Map<string, string>();

    if (declarationKeyword === "record") {
      const openParen = findNextToken(tokens, index + 2, "(");
      if (openParen >= 0 && openParen < bodyStart) {
        const closeParen = findMatching(tokens, openParen, "(", ")");
        if (closeParen > openParen && closeParen < bodyStart) {
          const recordParams = parseParameters(tokens, openParen + 1, closeParen);
          for (const param of recordParams) {
            typeReferences.push(...toJavaTypeReferences(param.typeReferences, uri, source, tokens));
            properties.set(param.name, {
              name: param.name,
              typeName: param.typeName,
              uri,
              position: positionAt(source, tokens[param.nameTokenIndex].start),
              renameable: true
            });
            methodReturnTypes.set(param.name, param.typeName);
            const getter = `get${param.name[0].toUpperCase()}${param.name.slice(1)}`;
            methodReturnTypes.set(getter, param.typeName);
          }
        }
      }
    }

    for (const member of classMembers) {
      typeReferences.push(...toJavaTypeReferences(member.typeReferences, uri, source, tokens));
      if (member.kind === "field") {
        properties.set(member.name, {
          name: member.name,
          typeName: member.typeName,
          uri,
          position: positionAt(source, tokens[member.nameTokenIndex].start),
          renameable: true
        });
      } else {
        methodReturnTypes.set(member.name, member.returnType);
        const getterProperty = getterPropertyName(member.name);
        if (getterProperty && member.returnType !== "void" && !properties.has(getterProperty)) {
          properties.set(getterProperty, {
            name: getterProperty,
            typeName: member.returnType,
            uri,
            position: positionAt(source, tokens[member.nameTokenIndex].start),
            renameable: false
          });
        }
      }
    }

    const hasLombokGetter = classAnnotations.some(({ name }) =>
      name === "Data" || name === "Getter" || name === "Value"
    );
    if (hasLombokGetter) {
      for (const [propName, prop] of properties) {
        const getter = `get${propName[0].toUpperCase()}${propName.slice(1)}`;
        if (!methodReturnTypes.has(getter)) {
          methodReturnTypes.set(getter, prop.typeName);
        }
        const isGetter = `is${propName[0].toUpperCase()}${propName.slice(1)}`;
        if (!methodReturnTypes.has(isGetter) && (prop.typeName === "boolean" || prop.typeName === "Boolean")) {
          methodReturnTypes.set(isGetter, prop.typeName);
        }
      }
    }

    classes.push({
      name: className,
      qualifiedName,
      uri,
      position: positionAt(source, nameToken.start),
      properties,
      methodReturnTypes,
      typeParameters,
      superClassName,
      superTypeNames
    });

    if (!classAnnotations.some(({ name }) => CONTROLLER_ANNOTATIONS.has(name))) {
      continue;
    }

    const classPaths = annotationPaths(classAnnotations, "RequestMapping");
    const classModelAttributes = new Map<string, string>();
    const classModelAttributePositions = new Map<string, SourcePosition>();
    for (const member of classMembers) {
      if (member.kind === "method" && member.modelAttributeName) {
        classModelAttributes.set(member.modelAttributeName, member.returnType);
        classModelAttributePositions.set(
          member.modelAttributeName,
          positionAt(source, tokens[member.nameTokenIndex].start)
        );
      }
    }

    for (const member of classMembers) {
      if (member.kind !== "method") {
        continue;
      }

      const methodAnnotations = member.annotations;
      const methodMappings = methodAnnotations.filter(({ name }) => REQUEST_MAPPINGS.has(name));
      const routePaths = methodMappings.flatMap((annotation) => annotationPaths([annotation], annotation.name));
      const effectiveRoutePaths = methodMappings.length > 0
        ? combinePaths(classPaths, routePaths)
        : [];
      const modelAttributes = new Map(classModelAttributes);
      const modelAttributePositions = new Map(classModelAttributePositions);
      const modelAttributeExpressions = new Map<
        string,
        { expression: string; position: SourcePosition }
      >();

      for (const parameter of member.parameters) {
        if (parameter.modelAttributeName) {
          modelAttributes.set(parameter.modelAttributeName, parameter.typeName);
          if (parameter.modelAttributeOffset !== undefined) {
            modelAttributePositions.set(
              parameter.modelAttributeName,
              positionAt(source, parameter.modelAttributeOffset)
            );
          }
        } else if (
          !isSimpleJavaType(parameter.typeName) &&
          !isSpringInfrastructureType(parameter.typeName)
        ) {
          modelAttributes.set(parameter.name, parameter.typeName);
        }
      }
      if (member.modelAttributeName) {
        modelAttributes.set(member.modelAttributeName, member.returnType);
        modelAttributePositions.set(
          member.modelAttributeName,
          positionAt(source, tokens[member.nameTokenIndex].start)
        );
      }

      for (const [key, variableName, attributeNameTokenIndex] of member.addedModelVariables) {
        const parameter = member.parameters.find(({ name }) => name === variableName);
        if (parameter) {
          modelAttributes.set(key, parameter.typeName);
        }
        const local = member.localVariables.get(variableName);
        if (local && local.typeName !== "var") {
          modelAttributes.set(key, local.typeName);
        }
        modelAttributeExpressions.set(key, {
          expression: local?.expression ?? variableName,
          position: positionAt(source, tokens[attributeNameTokenIndex].start + 1)
        });
      }

      handlers.push({
        uri,
        name: member.name,
        routePaths: effectiveRoutePaths,
        viewName: member.viewName,
        position: positionAt(source, tokens[member.nameTokenIndex].start),
        modelAttributes,
        modelAttributePositions,
        modelAttributeExpressions,
        ownerType: qualifiedName
      });
    }

  }

  return { classes, handlers, typeReferences };
}

type ClassMember =
  | {
      readonly kind: "field";
      readonly name: string;
      readonly typeName: string;
      readonly nameTokenIndex: number;
      readonly typeReferences: readonly { readonly typeName: string; readonly tokenIndex: number }[];
    }
  | {
      readonly kind: "method";
      readonly name: string;
      readonly returnType: string;
      readonly nameTokenIndex: number;
      readonly annotations: readonly Annotation[];
      readonly parameters: readonly ParsedParameter[];
      readonly localVariables: ReadonlyMap<string, {
        readonly typeName: string;
        readonly expression?: string;
        readonly tokenIndex: number;
        readonly typeReferences: readonly { readonly typeName: string; readonly tokenIndex: number }[];
      }>;
      readonly modelAttributeName: string | undefined;
      readonly addedModelVariables: readonly [string, string, number][];
      readonly viewName: string | undefined;
      readonly typeReferences: readonly { readonly typeName: string; readonly tokenIndex: number }[];
    };

function readClassMembers(tokens: readonly Token[], bodyStart: number, bodyEnd: number): ClassMember[] {
  const members: ClassMember[] = [];
  let memberStart = bodyStart + 1;
  let braceDepth = 1;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let index = bodyStart + 1; index < bodyEnd; index += 1) {
    const token = tokens[index];
    if (token.text === "(") parenDepth += 1;
    if (token.text === ")") parenDepth -= 1;
    if (token.text === "[") bracketDepth += 1;
    if (token.text === "]") bracketDepth -= 1;

    if (token.text === "{" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 1) {
      const close = findMatching(tokens, index, "{", "}");
      if (close < 0) break;
      const isNestedType = tokens
        .slice(memberStart, index)
        .some(({ text }) => ["class", "record", "enum", "interface"].includes(text));
      if (!isNestedType) {
        const method = parseMethod(tokens, memberStart, index, close);
        if (method) members.push(method);
      }
      index = close;
      memberStart = close + 1;
      continue;
    }

    if (token.text === "}" && parenDepth === 0 && bracketDepth === 0) {
      braceDepth -= 1;
      continue;
    }

    if (token.text === ";" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 1) {
      const method = parseMethod(tokens, memberStart, index, index);
      if (method) {
        members.push(method);
      } else {
        const field = parseField(tokens, memberStart, index);
        if (field) members.push(field);
      }
      memberStart = index + 1;
    }
  }

  return members;
}

function parseTypeParameters(tokens: readonly Token[], start: number, end: number): string[] {
  if (tokens[start]?.text !== "<") return [];
  const parameters: string[] = [];
  let depth = 0;
  let segmentStart = start + 1;
  for (let index = start + 1; index < end; index += 1) {
    if (tokens[index].text === "<") depth += 1;
    else if (tokens[index].text === ">") {
      if (depth === 0) {
        const firstIdentifier = tokens.slice(segmentStart, index).find(({ kind }) => kind === "identifier");
        if (firstIdentifier) parameters.push(firstIdentifier.text);
        break;
      }
      depth -= 1;
    } else if (tokens[index].text === "," && depth === 0) {
      const firstIdentifier = tokens.slice(segmentStart, index).find(({ kind }) => kind === "identifier");
      if (firstIdentifier) parameters.push(firstIdentifier.text);
      segmentStart = index + 1;
    }
  }
  return parameters;
}

function parseMethod(
  tokens: readonly Token[],
  memberStart: number,
  headerEnd: number,
  bodyEnd: number
): Extract<ClassMember, { kind: "method" }> | undefined {
  let openParen = -1;
  for (let index = memberStart; index < headerEnd; index += 1) {
    if (
      tokens[index].text === "(" &&
      isIdentifier(tokens[index - 1]) &&
      tokens[index - 2]?.text !== "@" &&
      findDeclaredType(tokens, memberStart, index - 1)
    ) {
      openParen = index;
    }
  }
  if (openParen < 1 || tokens[openParen - 1].kind !== "identifier") return undefined;
  const nameTokenIndex = openParen - 1;
  const name = tokens[nameTokenIndex].text;
  if (["if", "for", "while", "switch", "catch", "synchronized"].includes(name)) return undefined;

  const closeParen = findMatching(tokens, openParen, "(", ")");
  if (closeParen < 0 || closeParen > headerEnd) return undefined;
  const returnTypeInfo = findDeclaredTypeInfo(tokens, memberStart, nameTokenIndex);
  if (!returnTypeInfo) return undefined;

  const annotations = readAnnotations(tokens, memberStart, nameTokenIndex);
  const parameters = parseParameters(tokens, openParen + 1, closeParen);
  const methodBodyStart = tokens[headerEnd]?.text === "{" ? headerEnd : -1;
  const methodBody = methodBodyStart >= 0
    ? tokens.slice(methodBodyStart + 1, bodyEnd)
    : [];
  const localVariables = findLocalVariables(methodBody);
  const typeReferences = [
    ...getTypeReferencesInRange(tokens, returnTypeInfo.startTokenIndex, nameTokenIndex),
    ...parameters.flatMap(({ typeReferences: refs }) => refs),
    ...[...localVariables.values()].flatMap(({ typeReferences: refs }) =>
      refs.map((reference) => ({
        ...reference,
        tokenIndex: reference.tokenIndex + methodBodyStart + 1
      }))
    ),
    ...getConstructorTypeReferences(tokens, methodBodyStart, bodyEnd)
  ];
  const addedModelVariables = findAddedModelVariables(methodBody).map(
    ([attributeName, variableName, tokenIndex]) =>
      [attributeName, variableName, tokenIndex + methodBodyStart + 1] as [string, string, number]
  );
  const viewName = findReturnedView(methodBody);
  const modelAnnotation = annotations.find(({ name }) => name === "ModelAttribute");

  return {
    kind: "method",
    name,
    returnType: returnTypeInfo.typeName,
    nameTokenIndex,
    annotations,
    parameters,
    localVariables,
    modelAttributeName: modelAnnotation?.stringArguments[0] ?? (modelAnnotation ? name : undefined),
    addedModelVariables,
    viewName,
    typeReferences
  };
}

function parseField(
  tokens: readonly Token[],
  start: number,
  end: number
): Extract<ClassMember, { kind: "field" }> | undefined {
  if (start >= end) return undefined;

  let equalsIndex = -1;
  let pDepth = 0;
  let bDepth = 0;
  for (let i = start; i < end; i += 1) {
    const t = tokens[i].text;
    if (t === "(") pDepth += 1;
    else if (t === ")") pDepth -= 1;
    else if (t === "[") bDepth += 1;
    else if (t === "]") bDepth -= 1;
    else if (t === "=" && pDepth === 0 && bDepth === 0) {
      equalsIndex = i;
      break;
    }
  }

  const searchEnd = equalsIndex >= 0 ? equalsIndex : end;
  let nameTokenIndex = searchEnd - 1;
  while (nameTokenIndex >= start && !isIdentifier(tokens[nameTokenIndex])) {
    nameTokenIndex -= 1;
  }
  if (nameTokenIndex <= start) return undefined;

  if (tokens[nameTokenIndex + 1]?.text === "(") return undefined;
  if (tokens.slice(start, nameTokenIndex).some(({ text }) => text === "return")) return undefined;

  const typeInfo = findDeclaredTypeInfo(tokens, start, nameTokenIndex);
  if (!typeInfo) return undefined;

  return {
    kind: "field",
    name: tokens[nameTokenIndex].text,
    typeName: typeInfo.typeName,
    nameTokenIndex,
    typeReferences: getTypeReferencesInRange(tokens, typeInfo.startTokenIndex, nameTokenIndex)
  };
}

function parseParameters(tokens: readonly Token[], start: number, end: number): ParsedParameter[] {
  const parameters: ParsedParameter[] = [];
  let parameterStart = start;
  let nesting = 0;
  const segments: [number, number][] = [];

  for (let index = start; index <= end; index += 1) {
    const text = tokens[index]?.text;
    if (text === "<" || text === "(" || text === "[") nesting += 1;
    if (text === ">" || text === ")" || text === "]") nesting -= 1;
    if ((text === "," && nesting === 0) || index === end) {
      segments.push([parameterStart, index]);
      parameterStart = index + 1;
    }
  }

  for (const [segmentStart, segmentEnd] of segments) {
    const nameTokenIndex = segmentEnd - 1;
    if (nameTokenIndex < segmentStart || !isIdentifier(tokens[nameTokenIndex])) continue;
    const typeInfo = findDeclaredTypeInfo(tokens, segmentStart, nameTokenIndex);
    if (!typeInfo) continue;
    const annotations = readAnnotations(tokens, segmentStart, nameTokenIndex);
    const modelAnnotation = annotations.find(({ name }) => name === "ModelAttribute");
    parameters.push({
      name: tokens[nameTokenIndex].text,
      typeName: typeInfo.typeName,
      modelAttributeName: modelAnnotation?.stringArguments[0] ?? (modelAnnotation ? tokens[nameTokenIndex].text : undefined),
      modelAttributeOffset: modelAnnotation?.stringArgumentOffsets[0]
        ? tokens[modelAnnotation.stringArgumentOffsets[0]]?.start
        : undefined,
      nameTokenIndex,
      typeReferences: getTypeReferencesInRange(tokens, typeInfo.startTokenIndex, nameTokenIndex)
    });
  }

  return parameters;
}

function findLocalVariables(
  body: readonly Token[]
): Map<string, {
  readonly typeName: string;
  readonly expression?: string;
  readonly tokenIndex: number;
  readonly typeReferences: readonly { readonly typeName: string; readonly tokenIndex: number }[];
}> {
  const variables = new Map<string, {
    typeName: string;
    expression?: string;
    tokenIndex: number;
    typeReferences: readonly { readonly typeName: string; readonly tokenIndex: number }[];
  }>();
  let statementStart = 0;
  let pDepth = 0;
  let bDepth = 0;

  for (let i = 0; i < body.length; i += 1) {
    const text = body[i].text;
    if (text === "(") pDepth += 1;
    else if (text === ")") pDepth -= 1;
    else if (text === "[") bDepth += 1;
    else if (text === "]") bDepth -= 1;
    else if (text === "{" || text === "}") {
      statementStart = i + 1;
    } else if (text === ";" && pDepth === 0 && bDepth === 0) {
      statementStart = i + 1;
    } else if (text === "=" && pDepth === 0 && bDepth === 0 && body[i - 1] && body[i + 1]?.text !== "=") {
      const nameIndex = i - 1;
      if (isIdentifier(body[nameIndex])) {
        const varName = body[nameIndex].text;
        const typeInfo = findDeclaredTypeInfo(body, statementStart, nameIndex);
        let typeName = typeInfo?.typeName;
        let expression: string | undefined;
        if (typeName === "var") {
          if (body[i + 1]?.text === "new" && isIdentifier(body[i + 2])) {
            typeName = body[i + 2].text;
          } else {
            const semi = body.findIndex((t, idx) => idx > i && t.text === ";" && pDepth === 0);
            if (semi > i + 1) {
              expression = body.slice(i + 1, semi).map((t) => t.text).join("");
            }
          }
        }
        if (typeName) {
          variables.set(varName, {
            typeName,
            expression,
            tokenIndex: nameIndex,
            typeReferences: typeInfo && typeInfo.typeName !== "var"
              ? getTypeReferencesInRange(body, typeInfo.startTokenIndex, nameIndex)
              : []
          });
        }
      }
    }
  }
  return variables;
}

function findDeclaredType(tokens: readonly Token[], start: number, nameTokenIndex: number): string | undefined {
  return findDeclaredTypeInfo(tokens, start, nameTokenIndex)?.typeName;
}

function findDeclaredTypeInfo(
  tokens: readonly Token[],
  start: number,
  nameTokenIndex: number
): { readonly typeName: string; readonly startTokenIndex: number } | undefined {
  const ignored = new Set([
    "public", "protected", "private", "static", "final", "abstract", "synchronized",
    "volatile", "transient", "default", "native"
  ]);
  let genericDepth = 0;
  let typeEnd = -1;
  for (let index = nameTokenIndex - 1; index >= start; index -= 1) {
    const text = tokens[index].text;
    if (text === ">") {
      genericDepth += 1;
      if (typeEnd < 0) typeEnd = index;
    } else if (text === "<") {
      genericDepth -= 1;
    } else if (genericDepth === 0) {
      const token = tokens[index];
      if (token.kind === "identifier" && !ignored.has(token.text)) {
        if (tokens[index - 1]?.text === "@") continue;
        if (typeEnd >= 0) {
          return {
            typeName: tokens.slice(index, nameTokenIndex).map(({ text }) => text).join(""),
            startTokenIndex: index
          };
        }
        if (nameTokenIndex - 1 > index && tokens[nameTokenIndex - 1].text === "]") {
          return {
            typeName: tokens.slice(index, nameTokenIndex).map(({ text }) => text).join(""),
            startTokenIndex: index
          };
        }
        return { typeName: token.text, startTokenIndex: index };
      }
    }
  }
  return undefined;
}

function getTypeReferencesInRange(
  tokens: readonly Token[],
  start: number,
  end: number
): { readonly typeName: string; readonly tokenIndex: number }[] {
  const references: { typeName: string; tokenIndex: number }[] = [];
  for (let index = start; index < end; index += 1) {
    if (tokens[index].kind !== "identifier" || tokens[index - 1]?.text === "@") continue;
    let lastIndex = index;
    while (tokens[lastIndex + 1]?.text === "." && tokens[lastIndex + 2]?.kind === "identifier") {
      lastIndex += 2;
    }
    const typeName = tokens.slice(index, lastIndex + 1).map(({ text }) => text).join("");
    if (!isPrimitiveJavaType(typeName)) references.push({ typeName, tokenIndex: lastIndex });
    index = lastIndex;
  }
  return references;
}

function getConstructorTypeReferences(
  tokens: readonly Token[],
  methodBodyStart: number,
  bodyEnd: number
): { readonly typeName: string; readonly tokenIndex: number }[] {
  if (methodBodyStart < 0) return [];
  const references: { typeName: string; tokenIndex: number }[] = [];
  for (let index = methodBodyStart + 1; index < bodyEnd - 1; index += 1) {
    if (tokens[index].text !== "new" || tokens[index + 1].kind !== "identifier") continue;
    let lastIndex = index + 1;
    while (tokens[lastIndex + 1]?.text === "." && tokens[lastIndex + 2]?.kind === "identifier") {
      lastIndex += 2;
    }
    references.push({
      typeName: tokens.slice(index + 1, lastIndex + 1).map(({ text }) => text).join(""),
      tokenIndex: lastIndex
    });
    index = lastIndex;
  }
  return references;
}

function toJavaTypeReferences(
  references: readonly { readonly typeName: string; readonly tokenIndex: number }[],
  uri: string,
  source: string,
  tokens: readonly Token[]
): JavaTypeReference[] {
  return references.map(({ typeName, tokenIndex }) => ({
    uri,
    typeName,
    position: positionAt(source, tokens[tokenIndex].start)
  }));
}

function isPrimitiveJavaType(typeName: string): boolean {
  return new Set(["boolean", "byte", "char", "short", "int", "long", "float", "double", "void"]).has(typeName);
}

function readAnnotations(tokens: readonly Token[], start: number, end: number): Annotation[] {
  const annotations: Annotation[] = [];
  let index = start;
  while (index < end) {
    if (tokens[index].text !== "@" || tokens[index + 1]?.kind !== "identifier") {
      index += 1;
      continue;
    }

    const tokenIndex = index;
    let name = tokens[index + 1].text;
    let nextIndex = index + 2;
    while (tokens[nextIndex]?.text === "." && tokens[nextIndex + 1]?.kind === "identifier") {
      name = tokens[nextIndex + 1].text;
      nextIndex += 2;
    }
    const stringArguments: string[] = [];
    const stringArgumentOffsets: number[] = [];
    if (tokens[nextIndex]?.text === "(") {
      const close = findMatching(tokens, nextIndex, "(", ")");
      if (close > nextIndex) {
        for (let argumentIndex = nextIndex + 1; argumentIndex < close; argumentIndex += 1) {
          if (tokens[argumentIndex].kind === "string") {
            stringArguments.push(tokens[argumentIndex].text);
            stringArgumentOffsets.push(argumentIndex);
          }
        }
        nextIndex = close + 1;
      }
    }
    annotations.push({ name, stringArguments, stringArgumentOffsets, tokenIndex });
    index = nextIndex;
  }
  return annotations;
}

function annotationPaths(annotations: readonly Annotation[], annotationName: string): string[] {
  return annotations
    .filter(({ name }) => name === annotationName)
    .flatMap(({ stringArguments }) => stringArguments)
    .map((route) => route.trim())
    .filter(Boolean);
}

function combinePaths(prefixes: readonly string[], suffixes: readonly string[]): string[] {
  const left = prefixes.length > 0 ? prefixes : [""];
  const right = suffixes.length > 0 ? suffixes : [""];
  return left.flatMap((prefix) => right.map((suffix) => `/${prefix}/${suffix}`.replace(/\/+/g, "/")));
}

function findReturnedView(body: readonly Token[]): string | undefined {
  for (let index = 0; index < body.length - 1; index += 1) {
    if (body[index].text !== "return" || body[index + 1].kind !== "string") continue;
    const value = body[index + 1].text;
    return value.startsWith("redirect:") || value.startsWith("forward:") ? undefined : value;
  }
  return undefined;
}

function findAddedModelVariables(body: readonly Token[]): [string, string, number][] {
  const attributes: [string, string, number][] = [];
  for (let index = 0; index < body.length - 4; index += 1) {
    if (body[index].text !== "addAttribute" || body[index + 1].text !== "(") continue;
    const callEnd = findMatching(body, index + 1, "(", ")");
    if (callEnd < 0) continue;
    const nameTokenIndex = index + 2;
    if (body[nameTokenIndex].kind !== "string") continue;

    let commaIndex = nameTokenIndex + 1;
    while (commaIndex < callEnd && body[commaIndex].text !== ",") commaIndex += 1;
    if (commaIndex >= callEnd || commaIndex + 1 >= callEnd) continue;

    const expressionTokens = body.slice(commaIndex + 1, callEnd).filter(({ text }) => text !== ";");
    const expression = expressionTokens.map(({ text }) => text).join("");
    if (expression) attributes.push([body[nameTokenIndex].text, expression, nameTokenIndex]);
    index = callEnd;
  }
  return attributes;
}

export function inferModelExpressionType(
  expression: string,
  handler: ControllerHandler,
  classesByName: ReadonlyMap<string, JavaClass>
): string | undefined {
  const directType = handler.modelAttributes.get(expression);
  if (directType) return directType;

  const constructorMatch = /^new\s*([\w$]+)(?:<[^>]+>)?/.exec(expression);
  if (constructorMatch) {
    const className = constructorMatch[1];
    return classesByName.get(className)?.qualifiedName ?? className;
  }

  const tokens = tokenizeJava(expression);
  if (tokens.length === 0) return undefined;
  const owner = classesByName.get(handler.ownerType);
  if (!owner) return undefined;

  let tokenIndex = 0;
  if (tokens[tokenIndex]?.text === "this" && tokens[tokenIndex + 1]?.text === ".") {
    tokenIndex += 2;
  }
  const root = tokens[tokenIndex];
  if (!root || root.kind !== "identifier") return undefined;
  tokenIndex += 1;

  let typeName = owner.properties.get(root.text)?.typeName
    ?? resolveMethodReturnType(owner.qualifiedName, root.text, classesByName);
  if (!typeName) return undefined;

  while (tokenIndex < tokens.length) {
    if (tokens[tokenIndex]?.text !== ".") return undefined;
    const member = tokens[tokenIndex + 1];
    if (!member || member.kind !== "identifier") return undefined;
    tokenIndex += 2;

    const isMethodCall = tokens[tokenIndex]?.text === "(";
    if (isMethodCall) {
      const close = findMatching(tokens, tokenIndex, "(", ")");
      if (close < 0) return undefined;
      tokenIndex = close + 1;
      const returnType = resolveMethodReturnType(typeName, member.text, classesByName);
      if (!returnType) return undefined;
      typeName = returnType;
    } else {
      const propertyType = resolvePropertyType(typeName, member.text, classesByName);
      if (!propertyType) return undefined;
      typeName = propertyType;
    }
  }
  return typeName;
}

function resolveMethodReturnType(
  typeName: string,
  methodName: string,
  classesByName: ReadonlyMap<string, JavaClass>,
  visited = new Set<string>()
): string | undefined {
  const javaClass = findClassByName(typeName, classesByName);
  if (!javaClass || visited.has(javaClass.qualifiedName)) return undefined;
  visited.add(javaClass.qualifiedName);

  const ownReturnType = javaClass.methodReturnTypes.get(methodName);
  if (ownReturnType) return substituteTypeParameters(ownReturnType, javaClass, typeName);

  for (const superType of getSuperTypeNames(javaClass)) {
    const resolvedSuperType = substituteTypeParameters(superType, javaClass, typeName);
    const returnType = resolveMethodReturnType(resolvedSuperType, methodName, classesByName, visited);
    if (returnType) return returnType;
  }
  return undefined;
}

function resolvePropertyType(
  typeName: string,
  propertyName: string,
  classesByName: ReadonlyMap<string, JavaClass>,
  visited = new Set<string>()
): string | undefined {
  const javaClass = findClassByName(typeName, classesByName);
  if (!javaClass || visited.has(javaClass.qualifiedName)) return undefined;
  visited.add(javaClass.qualifiedName);

  const property = javaClass.properties.get(propertyName);
  if (property) return substituteTypeParameters(property.typeName, javaClass, typeName);

  for (const superType of getSuperTypeNames(javaClass)) {
    const resolvedSuperType = substituteTypeParameters(superType, javaClass, typeName);
    const propertyType = resolvePropertyType(resolvedSuperType, propertyName, classesByName, visited);
    if (propertyType) return propertyType;
  }
  return undefined;
}

function findClassByName(
  typeName: string,
  classesByName: ReadonlyMap<string, JavaClass>
): JavaClass | undefined {
  const rawType = typeName.replace(/<.*>$/, "").trim();
  const simpleName = rawType.split(".").at(-1) ?? rawType;
  return classesByName.get(rawType) ?? classesByName.get(simpleName);
}

function getSuperTypeNames(javaClass: JavaClass): readonly string[] {
  if (javaClass.superTypeNames && javaClass.superTypeNames.length > 0) {
    return javaClass.superTypeNames;
  }
  return javaClass.superClassName ? [javaClass.superClassName] : [];
}

export function substituteTypeParameters(
  memberType: string,
  javaClass: JavaClass,
  declaredType: string
): string {
  const parameters = javaClass.typeParameters ?? [];
  const actualTypes = parseTypeArguments(declaredType);
  if (parameters.length === 0 || actualTypes.length !== parameters.length) return memberType;

  let resolvedType = memberType;
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    const actualType = actualTypes[index];
    if (!parameter || !actualType) continue;
    resolvedType = resolvedType.replace(
      new RegExp(`\\b${escapeJavaRegExp(parameter)}\\b`, "g"),
      actualType
    );
  }
  return resolvedType;
}

function parseTypeArguments(typeName: string): string[] {
  const open = typeName.indexOf("<");
  const close = typeName.lastIndexOf(">");
  if (open < 0 || close <= open) return [];
  const argumentsList: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    if (typeName[index] === "<") depth += 1;
    else if (typeName[index] === ">") depth -= 1;
    else if (typeName[index] === "," && depth === 0) {
      argumentsList.push(typeName.slice(start, index).trim());
      start = index + 1;
    }
  }
  argumentsList.push(typeName.slice(start, close).trim());
  return argumentsList;
}

function escapeJavaRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPackageName(tokens: readonly Token[]): string {
  const packageIndex = tokens.findIndex(({ text }) => text === "package");
  if (packageIndex < 0) return "";
  return tokens.slice(packageIndex + 1, tokens.findIndex((token, index) => index > packageIndex && token.text === ";"))
    .map(({ text }) => text)
    .join("");
}

function readSuperTypeNames(tokens: readonly Token[], start: number, end: number): string[] {
  const superTypes: string[] = [];
  let angleDepth = 0;
  let collecting = false;
  let currentType: string[] = [];
  const addCurrentType = (): void => {
    const typeName = currentType.join("");
    if (typeName) superTypes.push(typeName);
    currentType = [];
  };

  for (let index = start; index < end; index += 1) {
    const text = tokens[index]?.text;
    if (text === "<") {
      angleDepth += 1;
      if (collecting) currentType.push(text);
    } else if (text === ">") {
      angleDepth -= 1;
      if (collecting) currentType.push(text);
    } else if (angleDepth === 0 && ["extends", "implements", "permits"].includes(text ?? "")) {
      if (collecting) addCurrentType();
      collecting = text !== "permits";
    } else if (collecting && angleDepth === 0 && text === ",") {
      addCurrentType();
    } else if (collecting && text !== undefined) {
      currentType.push(text);
    }
  }
  if (collecting) addCurrentType();
  return superTypes;
}

function declarationStart(tokens: readonly Token[], declarationIndex: number): number {
  for (let index = declarationIndex - 1; index >= 0; index -= 1) {
    if (tokens[index].text === ";" || tokens[index].text === "}" || tokens[index].text === "{") {
      return index + 1;
    }
  }
  return 0;
}

function findEnclosingTypeNames(tokens: readonly Token[], declarationIndex: number): string[] {
  const enclosingTypes: { readonly index: number; readonly name: string }[] = [];
  for (let index = 0; index < declarationIndex; index += 1) {
    if (!["class", "record", "enum", "interface"].includes(tokens[index].text)) continue;
    const name = tokens[index + 1];
    if (!name || name.kind !== "identifier") continue;
    const bodyStart = findNextToken(tokens, index + 2, "{");
    if (bodyStart < 0 || bodyStart >= declarationIndex) continue;
    const bodyEnd = findMatching(tokens, bodyStart, "{", "}");
    if (bodyEnd > declarationIndex) enclosingTypes.push({ index, name: name.text });
  }
  return enclosingTypes.sort((left, right) => left.index - right.index).map(({ name }) => name);
}

function getterPropertyName(methodName: string): string | undefined {
  const suffix = methodName.startsWith("get")
    ? methodName.slice(3)
    : methodName.startsWith("is")
      ? methodName.slice(2)
      : "";
  if (!suffix || suffix.length === 0) return undefined;
  return suffix[0].toLowerCase() + suffix.slice(1);
}

function isSimpleJavaType(typeName: string): boolean {
  return new Set([
    "String", "Integer", "Long", "Double", "Float", "Boolean", "Byte", "Short", "Character",
    "Date", "UUID", "BigDecimal", "BigInteger", "LocalDate", "LocalTime", "LocalDateTime",
    "OffsetDateTime", "ZonedDateTime", "Instant"
  ]).has(typeName);
}

function isSpringInfrastructureType(typeName: string): boolean {
  return new Set([
    "Model", "ModelMap", "BindingResult", "Errors", "RedirectAttributes",
    "HttpServletRequest", "HttpServletResponse", "Principal", "Authentication",
    "ServletRequest", "ServletResponse", "UriComponentsBuilder"
  ]).has(typeName.split(".").at(-1) ?? typeName);
}

function tokenizeJava(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      index += 1;
      let value = "";
      while (index < source.length) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
        } else if (source[index] === quote) {
          index += 1;
          break;
        } else {
          value += source[index];
          index += 1;
        }
      }
      if (quote === '"') tokens.push({ text: value, kind: "string", start, end: index });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      index += 1;
      while (index < source.length && /[\w$]/.test(source[index])) index += 1;
      tokens.push({ text: source.slice(start, index), kind: "identifier", start, end: index });
      continue;
    }
    tokens.push({ text: character, kind: "symbol", start, end: ++index });
  }
  return tokens;
}

function findMatching(tokens: readonly Token[], start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].text === open) depth += 1;
    if (tokens[index].text === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findNextToken(tokens: readonly Token[], start: number, target: string): number {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].text === target) return index;
    if (tokens[index].text === ";") return -1;
  }
  return -1;
}

function isIdentifier(token: Token | undefined): token is Token {
  return token?.kind === "identifier";
}

function positionAt(source: string, offset: number): SourcePosition {
  const before = source.slice(0, offset);
  const line = before.split("\n");
  return { line: line.length - 1, character: line[line.length - 1].length };
}
