import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ControllerHandler,
  inferModelExpressionType,
  indexJavaSources,
  JavaClass,
  JavaProperty,
  JavaTypeReference,
  SourcePosition,
  substituteTypeParameters
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
  readonly superTypeNames?: readonly string[];
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
    readonly parameterCount?: number;
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
  private ambiguousTemplateNames = new Set<string>();
  private classesByName = new Map<string, JavaClass>();
  private ambiguousClassNames = new Set<string>();
  private messagesByKey = new Map<string, IndexedMessageProperty[]>();
  private sourceHandlers: readonly ControllerHandler[] = [];
  private handlers: readonly ControllerHandler[] = [];
  private typeReferences: readonly JavaTypeReference[] = [];
  private compilerTypes = new Map<string, JavaClass>();
  private ambiguousCompilerAliases = new Set<string>();

  public get templates(): readonly IndexedTemplate[] {
    return [...this.templateByUri.values()];
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
      const sourceClass = this.classesByName.get(type.name) ?? this.classesByName.get(type.alias);
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
          renameable: false,
          ...(method.parameterCount !== undefined && { parameterCount: method.parameterCount })
        });
      }
      const methodDefinitions = new Map<string, JavaProperty>();
      const methodsByName = new Map<string, NonNullable<CompilerJavaType["methods"][number]>[]>();
      for (const method of type.methods) {
        if (!method.position) continue;
        const candidates = methodsByName.get(method.name) ?? [];
        candidates.push(method);
        methodsByName.set(method.name, candidates);
      }
      for (const [name, candidates] of methodsByName) {
        const uniquePositions = new Set(candidates.map(({ position }) =>
          `${position?.line}:${position?.character}`
        ));
        const [method] = candidates;
        if (uniquePositions.size !== 1 || !method?.position) continue;
        methodDefinitions.set(name, {
          name,
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
        methodDefinitions,
        ...((type.typeParameters ?? sourceClass?.typeParameters) && {
          typeParameters: type.typeParameters ?? sourceClass?.typeParameters
        }),
        ...((type.superClassName ?? sourceClass?.superClassName) && {
          superClassName: type.superClassName ?? sourceClass?.superClassName
        }),
        ...((type.superTypeNames ?? sourceClass?.superTypeNames) && {
          superTypeNames: type.superTypeNames ?? sourceClass?.superTypeNames
        })
      };
      this.registerCompilerTypeAlias(type.name, javaClass);
      this.registerCompilerTypeAlias(type.alias, javaClass);
    }
    this.refreshHandlerModelTypes();
  }

  public clearCompilerJavaTypes(): void {
    this.compilerTypes.clear();
    this.ambiguousCompilerAliases.clear();
    this.handlers = this.sourceHandlers;
  }

  public async refresh(
    workspaceUris: readonly string[],
    templateLocations: readonly string[] = DEFAULT_TEMPLATE_LOCATIONS,
    openDocuments: ReadonlyMap<string, string> = new Map()
  ): Promise<void> {
    const templateByName = new Map<string, IndexedTemplate>();
    const templateByUri = new Map<string, IndexedTemplate>();
    const ambiguousTemplateNames = new Set<string>();
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
          if (!ambiguousTemplateNames.has(name) && templateByName.has(name)) {
            templateByName.delete(name);
            ambiguousTemplateNames.add(name);
          } else if (!ambiguousTemplateNames.has(name)) {
            templateByName.set(name, template);
          }
          const uriKey = fileUriKey(template.uri);
          if (uriKey) templateByUri.set(uriKey, template);
        }
      }
    }

    const javaIndex = indexJavaSources(javaSources);
    const classesByName = new Map<string, JavaClass>();
    const ambiguousClassNames = new Set<string>();
    for (const javaClass of javaIndex.classes) {
      const existing = classesByName.get(javaClass.name);
      if (existing && existing.uri !== javaClass.uri) {
        classesByName.delete(javaClass.name);
        ambiguousClassNames.add(javaClass.name);
      } else if (!ambiguousClassNames.has(javaClass.name)) {
        classesByName.set(javaClass.name, javaClass);
      }
      classesByName.set(javaClass.qualifiedName, javaClass);
    }

    this.templateByName = templateByName;
    this.templateByUri = templateByUri;
    this.ambiguousTemplateNames = ambiguousTemplateNames;
    this.classesByName = classesByName;
    this.ambiguousClassNames = ambiguousClassNames;
    this.messagesByKey = messagesByKey;
    this.sourceHandlers = javaIndex.handlers;
    this.handlers = javaIndex.handlers;
    this.typeReferences = javaIndex.typeReferences;
    this.compilerTypes.clear();
    this.ambiguousCompilerAliases.clear();
  }

  public findTemplate(name: string): IndexedTemplate | undefined {
    const normalizedName = normalizeTemplateName(name);
    return this.ambiguousTemplateNames.has(normalizedName)
      ? undefined
      : this.templateByName.get(normalizedName);
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
    if (this.ambiguousClassNames.has(rawType)) return undefined;
    if (this.ambiguousCompilerAliases.has(rawType)) return undefined;
    return this.compilerTypes.get(rawType) ?? this.classesByName.get(rawType);
  }

  public propertyNamesForType(typeName: string): readonly string[] {
    return this.getPropertiesForClass(typeName).map(({ name }) => name);
  }

  public findProperty(typeName: string, propertyName: string): JavaProperty | undefined {
    const cleanProp = propertyName.replace(/\(\)$/, "");
    const property = this.findInheritedProperty(typeName, propertyName, cleanProp, new Set());
    if (property) return property;

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
    const returnType = this.findInheritedMethodReturnType(typeName, cleanMethodName, new Set());
    if (returnType) return returnType;

    const baseType = typeName.replace(/<.*>$/, "").split(".").at(-1) ?? typeName;
    return BUILTIN_TYPE_PROPERTIES.get(baseType)
      ?.find(({ name }) => name === cleanMethodName || name.startsWith(`${cleanMethodName}(`))
      ?.typeName;
  }

  public findMethodDefinition(typeName: string, methodName: string): JavaProperty | undefined {
    return this.findInheritedMethodDefinition(typeName, methodName.replace(/\(\)$/, ""), new Set());
  }

  public getPropertiesForClass(typeName: string): readonly JavaProperty[] {
    const properties = new Map<string, JavaProperty>();
    this.collectInheritedProperties(typeName, properties, new Set());
    this.collectInheritedMethods(typeName, properties, new Set());

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

  private refreshHandlerModelTypes(): void {
    const classesByName = new Map<string, JavaClass>();
    for (const javaClass of [...this.classesByName.values(), ...this.compilerTypes.values()]) {
      classesByName.set(javaClass.name, javaClass);
      classesByName.set(javaClass.qualifiedName, javaClass);
    }
    this.handlers = this.sourceHandlers.map((handler) => {
      const modelAttributes = new Map(handler.modelAttributes);
      for (const [attributeName, modelExpression] of handler.modelAttributeExpressions) {
        const typeName = inferModelExpressionType(modelExpression.expression, handler, classesByName);
        if (typeName) modelAttributes.set(attributeName, typeName);
      }
      return { ...handler, modelAttributes };
    });
  }

  private findInheritedProperty(
    typeName: string,
    propertyName: string,
    cleanPropertyName: string,
    visited: Set<string>
  ): JavaProperty | undefined {
    const currentClass = this.findClass(typeName);
    if (!currentClass || visited.has(currentClass.qualifiedName)) return undefined;
    visited.add(currentClass.qualifiedName);

    const property = currentClass.properties.get(propertyName) ?? currentClass.properties.get(cleanPropertyName);
    if (property) {
      return {
        ...property,
        typeName: substituteTypeParameters(property.typeName, currentClass, typeName)
      };
    }
    for (const superType of superTypesForClass(currentClass)) {
      const resolvedSuperType = substituteTypeParameters(superType, currentClass, typeName);
      const inherited = this.findInheritedProperty(
        resolvedSuperType,
        propertyName,
        cleanPropertyName,
        visited
      );
      if (inherited) return inherited;
    }
    return undefined;
  }

  private findInheritedMethodReturnType(
    typeName: string,
    methodName: string,
    visited: Set<string>
  ): string | undefined {
    const currentClass = this.findClass(typeName);
    if (!currentClass || visited.has(currentClass.qualifiedName)) return undefined;
    visited.add(currentClass.qualifiedName);

    const returnType = currentClass.methodReturnTypes.get(methodName);
    if (returnType) return substituteTypeParameters(returnType, currentClass, typeName);
    for (const superType of superTypesForClass(currentClass)) {
      const resolvedSuperType = substituteTypeParameters(superType, currentClass, typeName);
      const inherited = this.findInheritedMethodReturnType(resolvedSuperType, methodName, visited);
      if (inherited) return inherited;
    }
    return undefined;
  }

  private findInheritedMethodDefinition(
    typeName: string,
    methodName: string,
    visited: Set<string>
  ): JavaProperty | undefined {
    const currentClass = this.findClass(typeName);
    if (!currentClass || visited.has(currentClass.qualifiedName)) return undefined;
    visited.add(currentClass.qualifiedName);

    const method = currentClass.methodDefinitions.get(methodName);
    if (method) {
      return {
        ...method,
        typeName: substituteTypeParameters(method.typeName, currentClass, typeName)
      };
    }
    for (const superType of superTypesForClass(currentClass)) {
      const resolvedSuperType = substituteTypeParameters(superType, currentClass, typeName);
      const inherited = this.findInheritedMethodDefinition(resolvedSuperType, methodName, visited);
      if (inherited) return inherited;
    }
    return undefined;
  }

  private collectInheritedProperties(
    typeName: string,
    properties: Map<string, JavaProperty>,
    visited: Set<string>
  ): void {
    const currentClass = this.findClass(typeName);
    if (!currentClass || visited.has(currentClass.qualifiedName)) return;
    visited.add(currentClass.qualifiedName);
    for (const [name, property] of currentClass.properties) {
      if (!properties.has(name)) {
        properties.set(name, {
          ...property,
          typeName: substituteTypeParameters(property.typeName, currentClass, typeName)
        });
      }
    }
    for (const superType of superTypesForClass(currentClass)) {
      this.collectInheritedProperties(
        substituteTypeParameters(superType, currentClass, typeName),
        properties,
        visited
      );
    }
  }

  private collectInheritedMethods(
    typeName: string,
    properties: Map<string, JavaProperty>,
    visited: Set<string>
  ): void {
    const currentClass = this.findClass(typeName);
    if (!currentClass || visited.has(currentClass.qualifiedName)) return;
    visited.add(currentClass.qualifiedName);

    for (const method of currentClass.methodDefinitions.values()) {
      if (method.parameterCount !== 0) continue;
      const name = `${method.name}()`;
      if (!properties.has(name)) {
        properties.set(name, {
          ...method,
          name,
          typeName: substituteTypeParameters(method.typeName, currentClass, typeName)
        });
      }
    }
    for (const superType of superTypesForClass(currentClass)) {
      this.collectInheritedMethods(
        substituteTypeParameters(superType, currentClass, typeName),
        properties,
        visited
      );
    }
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

function superTypesForClass(javaClass: JavaClass): readonly string[] {
  if (javaClass.superTypeNames && javaClass.superTypeNames.length > 0) {
    return javaClass.superTypeNames;
  }
  return javaClass.superClassName ? [javaClass.superClassName] : [];
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
  const lines = content.split(/\r\n|\n|\r/);
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const logicalStartLine = lineIndex;
    let logicalLine = lines[lineIndex] ?? "";
    while (hasUnescapedTrailingBackslash(logicalLine) && lineIndex + 1 < lines.length) {
      logicalLine = logicalLine.slice(0, -1) + (lines[lineIndex + 1] ?? "").trimStart();
      lineIndex += 1;
    }
    lineIndex += 1;

    const leadingWhitespace = /^\s*/.exec(logicalLine)?.[0].length ?? 0;
    const rawLine = logicalLine.slice(leadingWhitespace);
    if (!rawLine || rawLine.startsWith("#") || rawLine.startsWith("!")) continue;

    let separatorIndex = -1;
    let escaped = false;
    for (let index = 0; index < rawLine.length; index += 1) {
      const character = rawLine[index];
      if (!escaped && (character === "=" || character === ":" || /\s/.test(character))) {
        separatorIndex = index;
        break;
      }
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
    }

    const keyEnd = separatorIndex < 0 ? rawLine.length : separatorIndex;
    const rawKey = rawLine.slice(0, keyEnd);
    if (!rawKey) continue;

    let valueStart = keyEnd;
    while (valueStart < rawLine.length && /\s/.test(rawLine[valueStart])) valueStart += 1;
    if (rawLine[valueStart] === "=" || rawLine[valueStart] === ":") valueStart += 1;
    while (valueStart < rawLine.length && /\s/.test(rawLine[valueStart])) valueStart += 1;

    const key = decodePropertiesEscapes(rawKey);
    const value = decodePropertiesEscapes(rawLine.slice(valueStart));
    const property: IndexedMessageProperty = {
      key,
      value,
      uri,
      position: { line: logicalStartLine, character: leadingWhitespace }
    };
    const existingIndex = result.findIndex((item) => item.key === key);
    if (existingIndex >= 0) result[existingIndex] = property;
    else result.push(property);
  }
  return result;
}

function hasUnescapedTrailingBackslash(value: string): boolean {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === "\\"; index -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function decodePropertiesEscapes(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})|\\(.)/gs, (_match, unicode: string | undefined, escaped: string | undefined) => {
    if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
    switch (escaped) {
      case "t": return "\t";
      case "n": return "\n";
      case "r": return "\r";
      case "f": return "\f";
      default: return escaped ?? "";
    }
  });
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
