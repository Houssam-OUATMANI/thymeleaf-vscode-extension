import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ControllerHandler,
  indexJavaSources,
  JavaClass,
  JavaProperty,
  JavaTypeReference,
  SourcePosition
} from "./javaIndexer";
import { findThymeleafAttributes } from "../thymeleaf/htmlParser";

export interface IndexedFragment {
  readonly name: string;
  readonly position: SourcePosition;
}

export interface IndexedThymesVar {
  readonly id: string;
  readonly typeName: string;
  readonly position: SourcePosition;
}

export interface IndexedMessageProperty {
  readonly key: string;
  readonly value: string;
  readonly uri: string;
  readonly position: SourcePosition;
}

export interface IndexedTemplate {
  readonly name: string;
  readonly uri: string;
  readonly fragments: readonly IndexedFragment[];
  readonly thymesVars: readonly IndexedThymesVar[];
  readonly content: string;
}

export interface CompilerJavaType {
  readonly alias: string;
  readonly name: string;
  readonly uri: string;
  readonly position: SourcePosition;
  readonly superClassName?: string;
  readonly typeParameters?: readonly string[];
  readonly properties: readonly {
    readonly name: string;
    readonly typeName: string;
    readonly position: SourcePosition;
  }[];
  readonly methods: readonly {
    readonly name: string;
    readonly returnType: string;
    readonly position?: SourcePosition;
  }[];
}

const EXCLUDED_DIRECTORIES = new Set([
  ".angular", ".git", ".gradle", ".idea", ".next", ".turbo", ".vscode",
  "bin", "build", "coverage", "dist", "node_modules", "out", "target", "vendor"
]);
const DEFAULT_TEMPLATE_LOCATIONS = ["src/main/resources/templates"];

export class ProjectIndex {
  private templateByName = new Map<string, IndexedTemplate>();
  private templateByUri = new Map<string, IndexedTemplate>();
  private classesByName = new Map<string, JavaClass>();
  private messagesByKey = new Map<string, IndexedMessageProperty[]>();
  private handlers: readonly ControllerHandler[] = [];
  private typeReferences: readonly JavaTypeReference[] = [];
  private compilerTypes = new Map<string, JavaClass>();
  private ambiguousCompilerAliases = new Set<string>();

  public get templates(): readonly IndexedTemplate[] {
    return [...this.templateByName.values()];
  }

  public get javaClasses(): readonly JavaClass[] {
    return [...new Set([...this.classesByName.values(), ...this.compilerTypes.values()])];
  }

  public get unresolvedJavaTypeReferences(): readonly JavaTypeReference[] {
    return this.typeReferences.filter(({ typeName }) => !this.findClass(typeName));
  }

  public get javaTypeReferences(): readonly JavaTypeReference[] {
    return this.typeReferences;
  }

  public addCompilerJavaTypes(types: readonly CompilerJavaType[]): void {
    for (const type of types) {
      const properties = new Map<string, JavaProperty>();
      for (const property of type.properties) {
        properties.set(property.name, {
          ...property,
          uri: type.uri,
          renameable: true
        });
      }
      const methodReturns = new Map<string, Set<string>>();
      for (const method of type.methods) {
        const returns = methodReturns.get(method.name) ?? new Set<string>();
        returns.add(method.returnType);
        methodReturns.set(method.name, returns);
      }
      const methodReturnTypes = new Map<string, string>();
      for (const method of type.methods) {
        const returns = methodReturns.get(method.name);
        if (!returns || returns.size !== 1) continue;
        methodReturnTypes.set(method.name, method.returnType);
        const propertyName = getterPropertyName(method.name, method.returnType);
        if (!propertyName || properties.has(propertyName) || !method.position) continue;
        properties.set(propertyName, {
          name: propertyName,
          typeName: method.returnType,
          uri: type.uri,
          position: method.position,
          renameable: false
        });
      }
      const javaClass: JavaClass = {
        name: type.name,
        qualifiedName: type.name,
        uri: type.uri,
        position: type.position,
        properties,
        methodReturnTypes,
        ...(type.typeParameters && { typeParameters: type.typeParameters }),
        ...(type.superClassName && { superClassName: type.superClassName })
      };
      this.registerCompilerTypeAlias(type.name, javaClass);
      this.registerCompilerTypeAlias(type.alias, javaClass);
    }
  }

  public clearCompilerJavaTypes(): void {
    this.compilerTypes.clear();
    this.ambiguousCompilerAliases.clear();
  }

  public async refresh(
    workspaceUris: readonly string[],
    templateLocations: readonly string[] = DEFAULT_TEMPLATE_LOCATIONS,
    openDocuments: ReadonlyMap<string, string> = new Map()
  ): Promise<void> {
    const templateByName = new Map<string, IndexedTemplate>();
    const templateByUri = new Map<string, IndexedTemplate>();
    const javaSources = new Map<string, string>();
    const messagesByKey = new Map<string, IndexedMessageProperty[]>();
    const normalizedOpenDocuments = new Map<string, string>();
    for (const [uri, content] of openDocuments) {
      const key = fileUriKey(uri);
      if (key) normalizedOpenDocuments.set(key, content);
    }

    for (const workspaceUri of workspaceUris) {
      const workspacePath = fileURLToPath(workspaceUri);
      const javaFiles = await findFiles(workspacePath, ".java");
      for (const javaFile of javaFiles) {
        javaSources.set(javaFile, await readContent(javaFile, normalizedOpenDocuments));
      }

      const propertyFiles = await findFiles(workspacePath, ".properties");
      for (const propertyFile of propertyFiles) {
        const fileUri = pathToFileURL(propertyFile).toString();
        const content = await readContent(propertyFile, normalizedOpenDocuments);
        for (const item of parsePropertiesFile(content, fileUri)) {
          const list = messagesByKey.get(item.key) ?? [];
          list.push(item);
          messagesByKey.set(item.key, list);
        }
      }

      for (const configuredLocation of templateLocations) {
        const relativeLocation = configuredLocation.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
        if (!relativeLocation) continue;
        const templateRoot = path.resolve(workspacePath, relativeLocation);
        if (!isWithin(workspacePath, templateRoot)) continue;

        for (const templatePath of await findFiles(templateRoot, ".html")) {
          const content = await readContent(templatePath, normalizedOpenDocuments);
          const name = toPosix(path.relative(templateRoot, templatePath)).replace(/\.html$/i, "");
          const template: IndexedTemplate = {
            name,
            uri: pathToFileURL(templatePath).toString(),
            fragments: findFragments(content),
            thymesVars: findThymesVars(content),
            content
          };
          templateByName.set(name, template);
          const uriKey = fileUriKey(template.uri);
          if (uriKey) templateByUri.set(uriKey, template);
        }
      }
    }

    const javaIndex = indexJavaSources(javaSources);
    const classesByName = new Map<string, JavaClass>();
    for (const javaClass of javaIndex.classes) {
      classesByName.set(javaClass.name, javaClass);
      classesByName.set(javaClass.qualifiedName, javaClass);
    }

    this.templateByName = templateByName;
    this.templateByUri = templateByUri;
    this.classesByName = classesByName;
    this.messagesByKey = messagesByKey;
    this.handlers = javaIndex.handlers;
    this.typeReferences = javaIndex.typeReferences;
    this.compilerTypes.clear();
    this.ambiguousCompilerAliases.clear();
  }

  public findTemplate(name: string): IndexedTemplate | undefined {
    return this.templateByName.get(normalizeTemplateName(name));
  }

  public findTemplateByUri(uri: string): IndexedTemplate | undefined {
    const key = fileUriKey(uri);
    return key ? this.templateByUri.get(key) : undefined;
  }

  public getHandlersForTemplate(templateName: string): readonly ControllerHandler[] {
    const normalizedName = normalizeTemplateName(templateName);
    return this.handlers.filter(({ viewName }) => viewName === normalizedName);
  }

  public findHandlersForRoute(routePath: string): readonly ControllerHandler[] {
    return this.handlers.filter(({ routePaths }) =>
      routePaths.some((candidate) => routeMatches(candidate, routePath))
    );
  }

  public findClass(typeName: string): JavaClass | undefined {
    const rawType = typeName.replace(/<.*>$/, "").trim();
    if (rawType.includes(".")) {
      return this.classesByName.get(rawType) ?? this.compilerTypes.get(rawType);
    }
    if (this.ambiguousCompilerAliases.has(rawType)) return undefined;
    return this.compilerTypes.get(rawType) ?? this.classesByName.get(rawType);
  }

  public propertyNamesForType(typeName: string): readonly string[] {
    const names = new Set<string>();
    let currentClass = this.findClass(typeName);
    const visited = new Set<string>();
    while (currentClass && !visited.has(currentClass.name)) {
      visited.add(currentClass.name);
      for (const name of currentClass.properties.keys()) names.add(name);
      if (!currentClass.superClassName) break;
      currentClass = this.findClass(currentClass.superClassName);
    }
    return [...names];
  }

  public findProperty(typeName: string, propertyName: string): JavaProperty | undefined {
    const cleanProp = propertyName.replace(/\(\)$/, "");
    let currentClass = this.findClass(typeName);
    const declaredClass = currentClass;
    const visited = new Set<string>();
    while (currentClass && !visited.has(currentClass.name)) {
      visited.add(currentClass.name);
      const prop = currentClass.properties.get(propertyName) ?? currentClass.properties.get(cleanProp);
      if (prop) {
        return currentClass === declaredClass
          ? { ...prop, typeName: substituteTypeParameters(prop.typeName, currentClass, typeName) }
          : prop;
      }
      if (!currentClass.superClassName) break;
      currentClass = this.findClass(currentClass.superClassName);
    }

    const baseType = typeName.replace(/<.*>$/, "").split(".").at(-1) ?? typeName;
    const builtins = BUILTIN_TYPE_PROPERTIES.get(baseType);
    if (builtins) {
      const found = builtins.find(
        (p) => p.name === propertyName || p.name.replace(/\(\)$/, "") === cleanProp
      );
      if (found) return found;
    }
    return undefined;
  }

  public findMethodReturnType(typeName: string, methodName: string): string | undefined {
    const cleanMethodName = methodName.replace(/\(\)$/, "");
    let currentClass = this.findClass(typeName);
    const declaredClass = currentClass;
    const visited = new Set<string>();
    while (currentClass && !visited.has(currentClass.name)) {
      visited.add(currentClass.name);
      const returnType = currentClass.methodReturnTypes.get(cleanMethodName);
      if (returnType) {
        return currentClass === declaredClass
          ? substituteTypeParameters(returnType, currentClass, typeName)
          : returnType;
      }
      if (!currentClass.superClassName) break;
      currentClass = this.findClass(currentClass.superClassName);
    }

    const baseType = typeName.replace(/<.*>$/, "").split(".").at(-1) ?? typeName;
    return BUILTIN_TYPE_PROPERTIES.get(baseType)
      ?.find(({ name }) => name === cleanMethodName || name.startsWith(`${cleanMethodName}(`))
      ?.typeName;
  }

  public getPropertiesForClass(typeName: string): readonly JavaProperty[] {
    const properties = new Map<string, JavaProperty>();
    let currentClass = this.findClass(typeName);
    const visited = new Set<string>();
    while (currentClass && !visited.has(currentClass.name)) {
      visited.add(currentClass.name);
      for (const [name, prop] of currentClass.properties) {
        if (!properties.has(name)) properties.set(name, prop);
      }
      if (!currentClass.superClassName) break;
      currentClass = this.findClass(currentClass.superClassName);
    }

    const baseType = typeName.replace(/<.*>$/, "").split(".").at(-1) ?? typeName;
    const builtins = BUILTIN_TYPE_PROPERTIES.get(baseType);
    if (builtins) {
      for (const prop of builtins) {
        if (!properties.has(prop.name)) properties.set(prop.name, prop);
      }
    }
    return [...properties.values()];
  }

  public findMessageProperty(key: string): IndexedMessageProperty | undefined {
    return this.messagesByKey.get(key)?.[0];
  }

  public getAllMessageProperties(): readonly IndexedMessageProperty[] {
    const seen = new Set<string>();
    const results: IndexedMessageProperty[] = [];
    for (const list of this.messagesByKey.values()) {
      for (const item of list) {
        if (!seen.has(item.key)) {
          seen.add(item.key);
          results.push(item);
        }
      }
    }
    return results;
  }

  public hasMessageProperties(): boolean {
    return this.messagesByKey.size > 0;
  }

  public modelAttributesForTemplate(templateName: string): ReadonlyMap<string, string> {
    const attributes = new Map<string, string>();
    const handlerTypes = new Map<string, Set<string>>();
    const template = this.findTemplate(templateName);
    for (const handler of this.getHandlersForTemplate(templateName)) {
      for (const [name, typeName] of handler.modelAttributes) {
        const types = handlerTypes.get(name) ?? new Set<string>();
        types.add(typeName);
        handlerTypes.set(name, types);
      }
    }
    for (const [name, types] of handlerTypes) {
      const [typeName] = types;
      if (types.size === 1 && typeName) attributes.set(name, typeName);
    }
    if (template) {
      for (const thymesVar of template.thymesVars) {
        attributes.set(thymesVar.id, thymesVar.typeName);
      }
    }
    return attributes;
  }

  public modelAttributeDefinitionsForTemplate(
    templateName: string
  ): ReadonlyMap<string, { readonly uri: string; readonly position: SourcePosition }> {
    const definitions = new Map<string, { readonly uri: string; readonly position: SourcePosition }>();
    const handlerDefinitions = new Map<
      string,
      Map<string, { readonly uri: string; readonly position: SourcePosition }>
    >();
    const template = this.findTemplate(templateName);
    if (template) {
      for (const thymesVar of template.thymesVars) {
        definitions.set(thymesVar.id, { uri: template.uri, position: thymesVar.position });
      }
    }
    for (const handler of this.getHandlersForTemplate(templateName)) {
      for (const [name, position] of handler.modelAttributePositions) {
        const definitionKey = `${handler.uri}:${position.line}:${position.character}`;
        const candidates = handlerDefinitions.get(name) ?? new Map();
        candidates.set(definitionKey, { uri: handler.uri, position });
        handlerDefinitions.set(name, candidates);
      }
    }
    for (const [name, candidates] of handlerDefinitions) {
      if (candidates.size === 1) {
        const [definition] = candidates.values();
        if (definition) definitions.set(name, definition);
      }
    }
    return definitions;
  }

  public get controllerHandlers(): readonly ControllerHandler[] {
    return this.handlers;
  }

  private registerCompilerTypeAlias(alias: string, javaClass: JavaClass): void {
    if (this.ambiguousCompilerAliases.has(alias)) return;
    const existing = this.compilerTypes.get(alias);
    if (existing && (existing.uri !== javaClass.uri || existing.name !== javaClass.name)) {
      this.compilerTypes.delete(alias);
      this.ambiguousCompilerAliases.add(alias);
      return;
    }
    this.compilerTypes.set(alias, javaClass);
  }
}

export function normalizeTemplateName(name: string): string {
  const withoutFragment = name.split("::", 1)[0]?.trim() ?? "";
  return withoutFragment.replace(/\.html$/i, "").replaceAll("\\", "/").replace(/^\/+/, "");
}

export function sameFileUri(left: string, right: string): boolean {
  if (left === right) return true;
  const leftKey = fileUriKey(left);
  const rightKey = fileUriKey(right);
  return leftKey !== undefined && leftKey === rightKey;
}

export function normalizeRoute(route: string): string {
  const pathWithoutQuery = route.split(/[?(]/, 1)[0] ?? "";
  return `/${pathWithoutQuery.replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "/");
}

async function findFiles(root: string, extension: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }

  function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    return typeof error.code === "string" ? error.code : undefined;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...await findFiles(entryPath, extension));
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readContent(filePath: string, openDocuments: ReadonlyMap<string, string>): Promise<string> {
  const uriKey = fileUriKey(pathToFileURL(filePath).toString());
  const openContent = uriKey ? openDocuments.get(uriKey) : undefined;
  return openContent ?? await readFile(filePath, "utf8");
}

function fileUriKey(uri: string): string | undefined {
  try {
    const filePath = path.normalize(path.resolve(fileURLToPath(uri)));
    return process.platform === "win32" ? filePath.toLowerCase() : filePath;
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function routeMatches(pattern: string, value: string): boolean {
  const normalizedPattern = normalizeRoute(pattern);
  const normalizedValue = normalizeRoute(value);
  if (normalizedPattern === normalizedValue) return true;
  const patternSegments = normalizedPattern.split("/").map((segment) => {
    if (segment === "**") return ".*";
    if (segment === "*") return "[^/]+";
    if (/^\{[^}]+\}$/.test(segment)) return "[^/]+";
    return escapeRegExp(segment);
  });
  return new RegExp(`^${patternSegments.join("/")}$`).test(normalizedValue);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function getterPropertyName(methodName: string, returnType: string): string | undefined {
  const suffix = methodName.startsWith("get")
    ? methodName.slice(3)
    : methodName.startsWith("is") && (returnType === "boolean" || returnType === "Boolean")
      ? methodName.slice(2)
      : "";
  return suffix ? suffix[0].toLowerCase() + suffix.slice(1) : undefined;
}

function substituteTypeParameters(
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
      new RegExp(`\\b${escapeRegExp(parameter)}\\b`, "g"),
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

function findFragments(content: string): IndexedFragment[] {
  const fragments: IndexedFragment[] = [];
  for (const attribute of findThymeleafAttributes(content)) {
    if (attribute.name !== "th:fragment") continue;
    const rawName = attribute.value.trim();
    const name = rawName?.split("(", 1)[0]?.trim();
    if (!name) continue;
    const before = content.slice(0, attribute.nameStart);
    const lines = before.split("\n");
    fragments.push({
      name,
      position: { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
    });
  }
  return fragments;
}

export function findThymesVars(content: string): IndexedThymesVar[] {
  const vars: IndexedThymesVar[] = [];
  const thymesVarPattern = /@thymesVar\s+(?:id=(["'])(.*?)\1\s+type=(["'])(.*?)\3|type=(["'])(.*?)\5\s+id=(["'])(.*?)\7)/g;
  for (const match of content.matchAll(thymesVarPattern)) {
    if (match.index === undefined) continue;
    const id = match[2] ?? match[8];
    const rawType = match[4] ?? match[6];
    if (!id || !rawType) continue;
    const typeName = rawType.split(".").at(-1) ?? rawType;
    const before = content.slice(0, match.index);
    const lines = before.split("\n");
    vars.push({
      id,
      typeName,
      position: { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
    });
  }
  return vars;
}

export function parsePropertiesFile(content: string, uri: string): IndexedMessageProperty[] {
  const result: IndexedMessageProperty[] = [];
  const lines = content.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex].trim();
    if (!rawLine || rawLine.startsWith("#") || rawLine.startsWith("!")) continue;
    const separatorMatch = /[:=]/.exec(rawLine);
    if (!separatorMatch || separatorMatch.index === undefined) continue;
    const key = rawLine.slice(0, separatorMatch.index).trim();
    const value = rawLine.slice(separatorMatch.index + 1).trim();
    if (!key) continue;
    const originalLine = lines[lineIndex];
    const keyCharacter = originalLine.indexOf(key);
    result.push({
      key,
      value,
      uri,
      position: { line: lineIndex, character: Math.max(0, keyCharacter) }
    });
  }
  return result;
}

function createBuiltinProperty(name: string, typeName: string): JavaProperty {
  return {
    name,
    typeName,
    uri: "",
    position: { line: 0, character: 0 }
  };
}

const BUILTIN_TYPE_PROPERTIES = new Map<string, JavaProperty[]>([
  ["String", [
    createBuiltinProperty("length()", "int"),
    createBuiltinProperty("isEmpty()", "boolean"),
    createBuiltinProperty("isBlank()", "boolean"),
    createBuiltinProperty("toUpperCase()", "String"),
    createBuiltinProperty("toLowerCase()", "String"),
    createBuiltinProperty("trim()", "String"),
    createBuiltinProperty("strip()", "String"),
    createBuiltinProperty("substring(int)", "String"),
    createBuiltinProperty("contains(CharSequence)", "boolean"),
    createBuiltinProperty("startsWith(String)", "boolean"),
    createBuiltinProperty("endsWith(String)", "boolean")
  ]],
  ["Page", [
    createBuiltinProperty("size", "int"),
    createBuiltinProperty("getSize", "int"),
    createBuiltinProperty("number", "int"),
    createBuiltinProperty("getNumber", "int"),
    createBuiltinProperty("numberOfElements", "int"),
    createBuiltinProperty("getNumberOfElements", "int"),
    createBuiltinProperty("totalPages", "int"),
    createBuiltinProperty("getTotalPages", "int"),
    createBuiltinProperty("totalElements", "long"),
    createBuiltinProperty("getTotalElements", "long"),
    createBuiltinProperty("first", "boolean"),
    createBuiltinProperty("isFirst()", "boolean"),
    createBuiltinProperty("last", "boolean"),
    createBuiltinProperty("isLast()", "boolean"),
    createBuiltinProperty("hasNext()", "boolean"),
    createBuiltinProperty("hasPrevious()", "boolean"),
    createBuiltinProperty("hasContent()", "boolean"),
    createBuiltinProperty("empty", "boolean"),
    createBuiltinProperty("isEmpty()", "boolean"),
    createBuiltinProperty("content", "java.util.List"),
    createBuiltinProperty("getContent", "java.util.List"),
    createBuiltinProperty("sort", "org.springframework.data.domain.Sort"),
    createBuiltinProperty("pageable", "org.springframework.data.domain.Pageable")
  ]],
  ["Slice", [
    createBuiltinProperty("size", "int"),
    createBuiltinProperty("getSize", "int"),
    createBuiltinProperty("number", "int"),
    createBuiltinProperty("getNumber", "int"),
    createBuiltinProperty("numberOfElements", "int"),
    createBuiltinProperty("getNumberOfElements", "int"),
    createBuiltinProperty("first", "boolean"),
    createBuiltinProperty("isFirst()", "boolean"),
    createBuiltinProperty("last", "boolean"),
    createBuiltinProperty("isLast()", "boolean"),
    createBuiltinProperty("hasNext()", "boolean"),
    createBuiltinProperty("hasPrevious()", "boolean"),
    createBuiltinProperty("hasContent()", "boolean"),
    createBuiltinProperty("empty", "boolean"),
    createBuiltinProperty("isEmpty()", "boolean"),
    createBuiltinProperty("content", "java.util.List"),
    createBuiltinProperty("getContent", "java.util.List")
  ]],
  ["List", [
    createBuiltinProperty("size", "int"),
    createBuiltinProperty("empty", "boolean"),
    createBuiltinProperty("isEmpty()", "boolean")
  ]],
  ["Collection", [
    createBuiltinProperty("size", "int"),
    createBuiltinProperty("empty", "boolean"),
    createBuiltinProperty("isEmpty()", "boolean")
  ]],
  ["Set", [
    createBuiltinProperty("size", "int"),
    createBuiltinProperty("empty", "boolean"),
    createBuiltinProperty("isEmpty()", "boolean")
  ]],
  ["Optional", [
    createBuiltinProperty("present", "boolean"),
    createBuiltinProperty("isPresent()", "boolean"),
    createBuiltinProperty("empty", "boolean"),
    createBuiltinProperty("isEmpty()", "boolean"),
    createBuiltinProperty("get()", "java.lang.Object")
  ]]
]);
