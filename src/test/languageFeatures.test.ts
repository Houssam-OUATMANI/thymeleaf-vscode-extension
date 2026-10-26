import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  DEFAULT_SETTINGS,
  provideCodeActions,
  validateDocument,
  validateJavaDocument
} from "../server/features/diagnosticsProvider";
import { provideCompletions } from "../server/features/completionProvider";
import {
  provideSemanticTokens,
  SEMANTIC_TOKEN_TYPES
} from "../server/features/semanticTokensProvider";
import {
  provideDefinition,
  provideHover,
  provideTypeDefinition,
  provideReferences,
  prepareThymeleafRename,
  provideThymeleafRenameEdits
} from "../server/features/navigationProvider";
import { findEnclosingLoopVariables } from "../server/features/featureUtils";
import { provideCodeLenses, provideGutterDecorations } from "../server/features/codeLensProvider";
import { parsePropertiesFile, ProjectIndex } from "../server/projectIndex";

test("navigates from a Thymeleaf model property to its Java declaration", async () => {
  const fixture = await createFixture();
  try {
    const document = TextDocument.create(fixture.templateUri, "html", 1, fixture.template);
    const offset = fixture.template.indexOf("displayName");
    const definition = provideDefinition(document, document.positionAt(offset + 2), fixture.index);

    assert.ok(definition);
    assert.equal(definition.uri, pathToFileURL(fixture.modelPath).toString());
    assert.equal(definition.range.start.line, 2);
  } finally {
    await fixture.dispose();
  }
});

test("navigates and hovers the exact member under the cursor in nested Java expressions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-nested-navigation-"));
  const java = path.join(root, "src", "main", "java", "demo");
  const templates = path.join(root, "src", "main", "resources", "templates");
  const modelPath = path.join(java, "User.java");
  const templatePath = path.join(templates, "home.html");
  const model = `package demo;
class User {
  Address address;
  Page<Post> page;
}
class Address {
  String city;
}
class Post {}
interface Slice<T> {
  boolean isLast();
}
interface Page<T> extends Slice<T> {}
`;
  const controller = `package demo;
@Controller class HomeController {
  @GetMapping("/")
  String home(Model model) {
    model.addAttribute("user", new User());
    return "home";
  }
}
`;
  const template = `<span th:text="\${user.address.city}"></span>
<span th:text="\${user.page.isLast()}"></span>`;

  try {
    await Promise.all([
      mkdir(java, { recursive: true }),
      mkdir(templates, { recursive: true })
    ]);
    await Promise.all([
      writeFile(modelPath, model),
      writeFile(path.join(java, "HomeController.java"), controller),
      writeFile(templatePath, template)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);
    const document = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);

    const addressOffset = template.indexOf("address");
    const addressDefinition = provideDefinition(
      document,
      document.positionAt(addressOffset + 2),
      index
    );
    assert.ok(addressDefinition);
    assert.equal(addressDefinition.uri, pathToFileURL(modelPath).toString());
    assert.equal(addressDefinition.range.start.line, 2);

    const addressHover = provideHover(document, document.positionAt(addressOffset + 2), index);
    assert.ok(addressHover);
    assert.match(addressHover.contents.value, /\*\*address\*\*: `Address`/);
    const addressTypeDefinition = provideTypeDefinition(
      document,
      document.positionAt(addressOffset + 2),
      index
    );
    assert.ok(addressTypeDefinition);
    assert.equal(addressTypeDefinition.range.start.line, 5);

    const pageOffset = template.indexOf("page.isLast");
    const pageTypeDefinition = provideTypeDefinition(
      document,
      document.positionAt(pageOffset + 1),
      index
    );
    assert.ok(pageTypeDefinition);
    assert.equal(pageTypeDefinition.range.start.line, 12);

    const modelOffset = template.indexOf("user") + 1;
    const modelTypeDefinition = provideTypeDefinition(
      document,
      document.positionAt(modelOffset),
      index
    );
    assert.ok(modelTypeDefinition);
    assert.equal(modelTypeDefinition.range.start.line, 1);

    const methodOffset = template.indexOf("isLast");
    const methodDefinition = provideDefinition(
      document,
      document.positionAt(methodOffset + 2),
      index
    );
    assert.ok(methodDefinition);
    assert.equal(methodDefinition.uri, pathToFileURL(modelPath).toString());
    assert.equal(methodDefinition.range.start.line, 10);

    const methodHover = provideHover(document, document.positionAt(methodOffset + 2), index);
    assert.ok(methodHover);
    assert.match(methodHover.contents.value, /\*\*isLast\(\)\*\*: `boolean`/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses escaped keys, whitespace separators, unicode and continued property values", () => {
  const properties = [
    "welcome.title=Hello\\ World",
    "escaped\\:key : value",
    "spaced key value",
    "unicode=\\u0048ello",
    "continued=first\\",
    "    second",
    "welcome.title=Overridden"
  ].join("\n");

  assert.deepEqual(
    parsePropertiesFile(properties, "file:///messages.properties").map(({ key, value }) => [key, value]),
    [
      ["welcome.title", "Overridden"],
      ["escaped:key", "value"],
      ["spaced", "key value"],
      ["unicode", "Hello"],
      ["continued", "firstsecond"]
    ]
  );
});

test("keeps same-named templates from multiple workspace roots without choosing arbitrarily", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-multi-root-"));
  const roots = ["first", "second"].map((name) => path.join(root, name));

  try {
    await Promise.all(roots.map(async (workspaceRoot, index) => {
      const packageName = index === 0 ? "firstapp" : "secondapp";
      const templates = path.join(workspaceRoot, "src", "main", "resources", "templates");
      const java = path.join(workspaceRoot, "src", "main", "java", packageName);
      const templatePath = path.join(templates, "home.html");
      await Promise.all([
        mkdir(templates, { recursive: true }),
        mkdir(java, { recursive: true })
      ]);
      await Promise.all([
        writeFile(
          templatePath,
          `<tr th:each="u : \${users}"><span th:text="\${u.${index === 0 ? "firstName" : "lastName"}}"></span></tr>`
        ),
        writeFile(
          path.join(java, "User.java"),
          `package ${packageName}; class User { String ${index === 0 ? "firstName" : "lastName"}; }`
        ),
        writeFile(
          path.join(java, "HomeController.java"),
          `package ${packageName};
@Controller class HomeController {
  @GetMapping("/home")
  String home(Model model) {
    model.addAttribute("users", List.of(new User()));
    return "home";
  }
}`
        )
      ]);
    }));

    const index = new ProjectIndex();
    await index.refresh(roots.map((workspaceRoot) => pathToFileURL(workspaceRoot).toString()));

    assert.equal(index.templates.length, 2);
    assert.equal(index.findTemplate("home"), undefined);
    assert.equal(index.findClass("User"), undefined);
    assert.equal(index.findClass("firstapp.User")?.name, "User");
    assert.equal(index.findClass("secondapp.User")?.name, "User");
    for (const [rootIndex, workspaceRoot] of roots.entries()) {
      const packageName = rootIndex === 0 ? "firstapp" : "secondapp";
      const templateUri = pathToFileURL(path.join(
        workspaceRoot,
        "src",
        "main",
        "resources",
        "templates",
        "home.html"
      )).toString();
      assert.equal(
        index.modelAttributesForTemplate("home", templateUri).get("users"),
        "List<" + packageName + ".User>"
      );
      const template = `<tr th:each="u : \${users}"><span th:text="\${u."></span></tr>`;
      const document = TextDocument.create(templateUri, "html", 1, template);
      const completions = provideCompletions(
        document,
        document.positionAt(template.indexOf("u.") + 2),
        index
      );
      assert.ok(completions.some(({ label }) =>
        label === (rootIndex === 0 ? "firstName" : "lastName")
      ));
      assert.ok(!completions.some(({ label }) =>
        label === (rootIndex === 0 ? "lastName" : "firstName")
      ));
      const propertyText = `<tr th:each="u : \${users}"><span th:text="\${u.${rootIndex === 0 ? "firstName" : "lastName"}}"></span></tr>`;
      const propertyDocument = TextDocument.create(templateUri, "html", 1, propertyText);
      const propertyOffset = propertyText.indexOf(rootIndex === 0 ? "firstName" : "lastName");
      const propertyDefinition = provideDefinition(
        propertyDocument,
        propertyDocument.positionAt(propertyOffset + 2),
        index
      );
      assert.ok(propertyDefinition);
      assert.equal(
        propertyDefinition.uri,
        pathToFileURL(path.join(
          workspaceRoot,
          "src",
          "main",
          "java",
          packageName,
          "User.java"
        )).toString()
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offers Thymeleaf attribute completion after a space and replaces partial prefixes", async () => {
  const fixture = await createFixture();
  try {
    for (const [text, prefix, expected] of [
      ["<div ", "", "th:text"],
      ["<div th:t", "th:t", "th:text"],
      ["<div\n  th:t", "th:t", "th:text"],
      ["<div data-th-t", "data-th-t", "data-th-text"]
    ] as const) {
      const document = TextDocument.create(fixture.templateUri, "html", 1, text);
      const completions = provideCompletions(
        document,
        document.positionAt(text.length),
        fixture.index
      );
      const completion = completions.find(({ label }) => label === expected);
      assert.ok(completion);
      assert.deepEqual(completion.textEdit && "range" in completion.textEdit
        ? document.getText(completion.textEdit.range)
        : undefined, prefix);
    }
  } finally {
    await fixture.dispose();
  }
});

test("supports data-th attributes in diagnostics and model completion", async () => {
  const fixture = await createFixture();
  try {
    const text = `<span data-th-text="\${user.displayName}"></span><span data-th-tex="value"></span>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const completionOffset = text.indexOf("displayName") + "display".length;
    const completions = provideCompletions(
      document,
      document.positionAt(completionOffset),
      fixture.index
    );
    assert.ok(completions.some(({ label }) => label === "displayName"));

    const diagnostics = validateDocument(document, fixture.index, DEFAULT_SETTINGS);
    assert.ok(diagnostics.some(({ code, message }) =>
      code === "unknown-attribute" &&
      message.includes("'data-th-tex'") &&
      message.includes("'data-th-text'")
    ));
    assert.ok(diagnostics.every(({ code }) => code !== "unknown-model-property"));
  } finally {
    await fixture.dispose();
  }
});

test("navigates between controller routes, views, and template links", async () => {
  const fixture = await createFixture();
  try {
    const templateDocument = TextDocument.create(fixture.templateUri, "html", 1, fixture.template);
    const routeOffset = fixture.template.indexOf("/users");
    const routeDefinition = provideDefinition(
      templateDocument,
      templateDocument.positionAt(routeOffset + 2),
      fixture.index
    );
    assert.ok(routeDefinition);
    assert.equal(routeDefinition.uri, pathToFileURL(fixture.controllerPath).toString());

    const nestedModelOffset = fixture.template.indexOf("user.id");
    const nestedModelDefinition = provideDefinition(
      templateDocument,
      templateDocument.positionAt(nestedModelOffset + 5),
      fixture.index
    );
    assert.ok(nestedModelDefinition);
    assert.equal(nestedModelDefinition.uri, pathToFileURL(fixture.modelPath).toString());

    const controllerDocument = TextDocument.create(
      pathToFileURL(fixture.controllerPath).toString(),
      "java",
      1,
      fixture.controller
    );
    const viewOffset = fixture.controller.indexOf("users/list");
    const viewDefinition = provideDefinition(
      controllerDocument,
      controllerDocument.positionAt(viewOffset + 2),
      fixture.index
    );
    assert.ok(viewDefinition);
    assert.equal(viewDefinition.uri, fixture.templateUri);
  } finally {
    await fixture.dispose();
  }
});

test("does not choose an arbitrary model type when multiple handlers share a view", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-ambiguous-model-"));
  const templates = path.join(root, "src", "main", "resources", "templates");
  const java = path.join(root, "src", "main", "java", "demo");
  const templatePath = path.join(templates, "shared.html");
  const controllerAPath = path.join(java, "FirstController.java");
  const controllerBPath = path.join(java, "SecondController.java");

  try {
    await Promise.all([
      mkdir(templates, { recursive: true }),
      mkdir(java, { recursive: true })
    ]);
    await Promise.all([
      writeFile(templatePath, `<span th:text="\${item.firstName}"></span>`),
      writeFile(controllerAPath, `package demo;
@Controller class FirstController {
  @GetMapping("/first")
  String first(Model model) {
    model.addAttribute("item", new FirstItem());
    return "shared";
  }
}`),
      writeFile(controllerBPath, `package demo;
@Controller class SecondController {
  @GetMapping("/second")
  String second(Model model) {
    model.addAttribute("item", new SecondItem());
    return "shared";
  }
}`),
      writeFile(path.join(java, "FirstItem.java"), `package demo; class FirstItem { String firstName; }`),
      writeFile(path.join(java, "SecondItem.java"), `package demo; class SecondItem { String secondName; }`)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);
    const templateUri = pathToFileURL(templatePath).toString();
    const attributes = index.modelAttributesForTemplate("shared");
    const definitions = index.modelAttributeDefinitionsForTemplate("shared");

    assert.equal(attributes.has("item"), false);
    assert.equal(definitions.has("item"), false);

    const document = TextDocument.create(templateUri, "html", 1, `<span th:text="\${item.}"></span>`);
    const completions = provideCompletions(document, document.positionAt(document.getText().indexOf("item.") + 5), index);
    assert.deepEqual(completions.filter(({ label }) => ["firstName", "secondName"].includes(label)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completes fragment paths and fragment names from the indexed template", async () => {
  const fixture = await createFixture();
  try {
    const pathText = `<div th:replace="~{frag"></div>`;
    const pathDocument = TextDocument.create(fixture.templateUri, "html", 1, pathText);
    const pathCompletions = provideCompletions(
      pathDocument,
      pathDocument.positionAt(pathText.indexOf("frag") + "frag".length),
      fixture.index
    );
    assert.ok(pathCompletions.some(({ label }) => label === "fragments/header"));

    const fragmentText = `<div th:replace="~{fragments/header :: na"></div>`;
    const fragmentDocument = TextDocument.create(
      fixture.templateUri,
      "html",
      1,
      fragmentText
    );
    const fragmentCompletions = provideCompletions(
      fragmentDocument,
      fragmentDocument.positionAt(fragmentText.indexOf("na") + 2),
      fixture.index
    );
    assert.ok(fragmentCompletions.some(({ label }) => label === "nav"));
  } finally {
    await fixture.dispose();
  }
});

test("updates open template fragments without replacing the indexed disk version", async () => {
  const fixture = await createFixture();
  try {
    const editedTemplate = `<div th:fragment="editedPanel"></div>`;
    assert.equal(
      fixture.index.updateOpenTemplate(fixture.templateUri, editedTemplate),
      true
    );
    assert.equal(fixture.index.findTemplateByUri(fixture.templateUri)?.content, editedTemplate);
    assert.ok(fixture.index.findTemplateByUri(fixture.templateUri)?.fragments.some(
      ({ name }) => name === "editedPanel"
    ));

    fixture.index.closeOpenTemplate(fixture.templateUri);
    assert.equal(
      fixture.index.findTemplateByUri(fixture.templateUri)?.content,
      fixture.template
    );
  } finally {
    await fixture.dispose();
  }
});

test("renames a resolved Java model property across exact Thymeleaf member ranges", async () => {
  const fixture = await createFixture();
  try {
    const secondTemplatePath = path.join(
      fixture.root,
      "src",
      "main",
      "resources",
      "templates",
      "users",
      "detail.html"
    );
    const secondTemplate = `<!--/*@thymesVar id="user" type="demo.UserForm"*/-->
<span th:text="\${user.displayName}"></span>`;
    await writeFile(secondTemplatePath, secondTemplate);
    await fixture.index.refresh([pathToFileURL(fixture.root).toString()]);

    const document = TextDocument.create(fixture.templateUri, "html", 1, fixture.template);
    const propertyOffset = fixture.template.indexOf("displayName") + 3;
    const renameInfo = prepareThymeleafRename(
      document,
      document.positionAt(propertyOffset),
      fixture.index
    );
    assert.ok(renameInfo);
    assert.equal(renameInfo.placeholder, "displayName");
    assert.equal(
      document.getText(renameInfo.range),
      "displayName"
    );
    assert.equal(renameInfo.javaUri, pathToFileURL(fixture.modelPath).toString());

    const edits = provideThymeleafRenameEdits(
      renameInfo.javaUri,
      renameInfo.javaPosition,
      "displayLabel",
      fixture.index
    );
    assert.equal(edits.length, 2);
    assert.ok(edits.every(({ newText }) => newText === "displayLabel"));
    assert.ok(edits.every(({ uri, range }) => {
      const content = uri === fixture.templateUri ? fixture.template : secondTemplate;
      return TextDocument.create(uri, "html", 1, content).getText(range) === "displayName";
    }));
    assert.ok(edits.some(({ uri }) => uri === fixture.templateUri));
    assert.ok(edits.some(({ uri }) => uri === pathToFileURL(secondTemplatePath).toString()));

    const modelSource = await readFile(fixture.modelPath, "utf8");
    const javaDocument = TextDocument.create(
      pathToFileURL(fixture.modelPath).toString(),
      "java",
      1,
      modelSource
    );
    const declarationOffset = modelSource.indexOf("displayName");
    const javaRenameInfo = prepareThymeleafRename(
      javaDocument,
      javaDocument.positionAt(declarationOffset + 2),
      fixture.index
    );
    assert.ok(javaRenameInfo);
    assert.equal(javaRenameInfo.placeholder, "displayName");
  } finally {
    await fixture.dispose();
  }
});

test("renames Java methods and their Thymeleaf invocations when the target is source-defined", async () => {
  const fixture = await createFixture();
  try {
    const originalModel = await readFile(fixture.modelPath, "utf8");
    const modelSource = originalModel.replace(
      /\}\s*$/,
      "  public String formatName() { return displayName; }\n}"
    );
    await writeFile(fixture.modelPath, modelSource);
    const templatePath = path.join(
      fixture.root,
      "src",
      "main",
      "resources",
      "templates",
      "users",
      "format.html"
    );
    const template = `<!--/*@thymesVar id="user" type="demo.UserForm"*/-->
<span th:text="\${user.formatName()}"></span>`;
    await writeFile(templatePath, template);
    await fixture.index.refresh([pathToFileURL(fixture.root).toString()]);

    const document = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);
    const methodOffset = template.indexOf("formatName");
    const renameInfo = prepareThymeleafRename(
      document,
      document.positionAt(methodOffset + 2),
      fixture.index
    );
    assert.ok(renameInfo);
    assert.equal(renameInfo.placeholder, "formatName");

    const edits = provideThymeleafRenameEdits(
      renameInfo.javaUri,
      renameInfo.javaPosition,
      "displayLabel",
      fixture.index
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.uri, pathToFileURL(templatePath).toString());
    assert.equal(document.getText(edits[0]?.range), "formatName");

    const javaDocument = TextDocument.create(
      pathToFileURL(fixture.modelPath).toString(),
      "java",
      1,
      modelSource
    );
    const declarationOffset = modelSource.lastIndexOf("formatName");
    const javaRenameInfo = prepareThymeleafRename(
      javaDocument,
      javaDocument.positionAt(declarationOffset + 2),
      fixture.index
    );
    assert.ok(javaRenameInfo);
    assert.equal(javaRenameInfo.placeholder, "formatName");
  } finally {
    await fixture.dispose();
  }
});

test("uses compiler-resolved classpath symbols for Thymeleaf model completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-compiler-types-"));
  const templateRoot = path.join(root, "src", "main", "resources", "templates");
  const javaRoot = path.join(root, "src", "main", "java", "demo");
  const templatePath = path.join(templateRoot, "remote.html");
  const controllerPath = path.join(javaRoot, "RemoteController.java");
  const template = `<span th:text="\${remote.}"></span>
<span th:each="item: \${remoteRows}" th:text="\${item.}"></span>`;
  try {
    await Promise.all([
      mkdir(templateRoot, { recursive: true }),
      mkdir(javaRoot, { recursive: true })
    ]);
    await Promise.all([
      writeFile(templatePath, template),
      writeFile(controllerPath, `package demo;
@Controller class RemoteController {
  private RemoteRepository remoteRepository;
  @GetMapping
  String index(Model model) {
    model.addAttribute("remote", new RemoteDto());
    model.addAttribute("remoteRows", remoteRepository.findAll());
    return "remote";
  }
}`)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);
    assert.ok(index.unresolvedJavaTypeReferences.some(({ typeName }) => typeName === "RemoteDto"));
    assert.ok(index.unresolvedJavaTypeReferences.some(({ typeName }) => typeName === "RemoteRepository"));
    index.addCompilerJavaTypes([{
      alias: "RemoteDto",
      name: "RemoteDto",
      uri: "jdt://contents/dependency.jar/demo/RemoteDto.class",
      position: { line: 0, character: 10 },
      properties: [{
        name: "displayName",
        typeName: "String",
        position: { line: 3, character: 15 }
      }],
      methods: [{
        name: "getAlias",
        returnType: "String",
        position: { line: 4, character: 15 }
      }]
    }, {
      alias: "RemotePage",
      name: "RemotePage",
      uri: "jdt://contents/dependency.jar/demo/RemotePage.class",
      position: { line: 0, character: 10 },
      typeParameters: ["T"],
      properties: [],
      methods: [{
        name: "getContent",
        returnType: "List<T>",
        position: { line: 5, character: 15 }
      }]
    }, {
      alias: "RemoteRepository",
      name: "RemoteRepository",
      uri: "jdt://contents/dependency.jar/demo/RemoteRepository.class",
      position: { line: 0, character: 10 },
      properties: [],
      methods: [],
      superTypeNames: ["RemoteJpaRepository<RemoteDto, UUID>"]
    }, {
      alias: "RemoteJpaRepository",
      name: "RemoteJpaRepository",
      uri: "jdt://contents/dependency.jar/demo/RemoteJpaRepository.class",
      position: { line: 0, character: 10 },
      typeParameters: ["T", "ID"],
      properties: [],
      methods: [{
        name: "findAll",
        returnType: "List<S>",
        parameterCount: 1
      }],
      superTypeNames: ["RemoteCrudRepository<T, ID>"]
    }, {
      alias: "RemoteCrudRepository",
      name: "RemoteCrudRepository",
      uri: "jdt://contents/dependency.jar/demo/RemoteCrudRepository.class",
      position: { line: 0, character: 10 },
      typeParameters: ["T", "ID"],
      properties: [],
      methods: [{
        name: "findAll",
        returnType: "List<T>",
        parameterCount: 0
      }]
    }]);

    assert.equal(
      index.findProperty("RemotePage<RemoteDto>", "content")?.typeName,
      "List<RemoteDto>"
    );
    assert.equal(index.modelAttributesForTemplate("remote").get("remoteRows"), "List<RemoteDto>");
    const document = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);
    const completions = provideCompletions(
      document,
      document.positionAt(template.indexOf("remote.") + "remote.".length),
      index
    );
    assert.ok(completions.some(({ label }) => label === "displayName"));
    assert.ok(completions.some(({ label }) => label === "alias"));
    const collectionCompletions = provideCompletions(
      document,
      document.positionAt(template.indexOf("item.") + "item.".length),
      index
    );
    assert.ok(collectionCompletions.some(({ label }) => label === "displayName"));
    index.clearCompilerJavaTypes();
    assert.equal(index.modelAttributesForTemplate("remote").has("remoteRows"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completes model properties for var values from Java time factory methods", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-time-model-"));
  const templateRoot = path.join(root, "src", "main", "resources", "templates");
  const javaRoot = path.join(root, "src", "main", "java", "demo");
  const templatePath = path.join(templateRoot, "time.html");
  const controllerPath = path.join(javaRoot, "TimeController.java");
  const template = `<time th:text="\${instant.}"></time>
<time th:text="\${localDateTime.}"></time>
<span th:text="\${str.}"></span>
<span th:each="item: \${strings}" th:text="\${item.}"></span>`;
  try {
    await Promise.all([
      mkdir(templateRoot, { recursive: true }),
      mkdir(javaRoot, { recursive: true })
    ]);
    await Promise.all([
      writeFile(templatePath, template),
      writeFile(controllerPath, `package demo;
import java.time.Instant;
import java.time.LocalDateTime;
@Controller class TimeController {
  @GetMapping("/time")
  String time(Model model) {
    var now = Instant.now();
    var now2 = LocalDateTime.now();
    var str = "azeazeazeza";
    var strings = List.of("one", "two");
    model.addAttribute("instant", now);
    model.addAttribute("localDateTime", now2);
    model.addAttribute("str", str);
    model.addAttribute("strings", strings);
    return "time";
  }
}`)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);
    assert.ok(index.unresolvedJavaTypeReferences.some(({ typeName }) => typeName === "Instant"));
    assert.ok(index.unresolvedJavaTypeReferences.some(({ typeName }) => typeName === "LocalDateTime"));

    index.addCompilerJavaTypes([{
      alias: "Instant",
      name: "Instant",
      uri: "jdt://contents/jdk/java/time/Instant.class",
      position: { line: 0, character: 0 },
      properties: [],
      methods: [
        { name: "now", returnType: "Instant", parameterCount: 0 },
        { name: "getEpochSecond", returnType: "long", parameterCount: 0, position: { line: 1, character: 0 } }
      ]
    }, {
      alias: "LocalDateTime",
      name: "LocalDateTime",
      uri: "jdt://contents/jdk/java/time/LocalDateTime.class",
      position: { line: 0, character: 0 },
      properties: [],
      methods: [
        { name: "now", returnType: "LocalDateTime", parameterCount: 0 },
        { name: "getDayOfMonth", returnType: "int", parameterCount: 0, position: { line: 1, character: 0 } }
      ]
    }]);

    assert.equal(index.modelAttributesForTemplate("time").get("instant"), "Instant");
    assert.equal(index.modelAttributesForTemplate("time").get("localDateTime"), "LocalDateTime");
    assert.equal(index.modelAttributesForTemplate("time").get("str"), "java.lang.String");
    assert.equal(index.modelAttributesForTemplate("time").get("strings"), "List<java.lang.String>");
    const document = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);
    const instantCompletions = provideCompletions(
      document,
      document.positionAt(template.indexOf("instant.") + "instant.".length),
      index
    );
    const dateTimeCompletions = provideCompletions(
      document,
      document.positionAt(template.indexOf("localDateTime.") + "localDateTime.".length),
      index
    );
    const stringCompletions = provideCompletions(
      document,
      document.positionAt(template.indexOf("str.") + "str.".length),
      index
    );
    const listItemCompletions = provideCompletions(
      document,
      document.positionAt(template.indexOf("item.") + "item.".length),
      index
    );
    assert.ok(instantCompletions.some(({ label }) => label === "epochSecond"));
    assert.ok(dateTimeCompletions.some(({ label }) => label === "dayOfMonth"));
    assert.ok(stringCompletions.some(({ label }) => label === "length()"));
    assert.ok(listItemCompletions.some(({ label }) => label === "length()"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("navigates to inherited dependency methods and completes no-argument methods", async () => {
  const fixture = await createFixture();
  try {
    fixture.index.addCompilerJavaTypes([
      {
        alias: "Page",
        name: "Page",
        uri: "jdt://contents/spring-data/Page.class",
        position: { line: 0, character: 20 },
        typeParameters: ["T"],
        superTypeNames: ["Slice<T>"],
        properties: [],
        methods: []
      },
      {
        alias: "Slice",
        name: "Slice",
        uri: "jdt://contents/spring-data/Slice.class",
        position: { line: 0, character: 21 },
        typeParameters: ["T"],
        properties: [],
        methods: [{
          name: "isLast",
          returnType: "boolean",
          parameterCount: 0,
          position: { line: 18, character: 13 }
        }]
      }
    ]);

    const template = `<span th:text="\${ps.isLast()}"></span>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, template);
    const methodOffset = template.indexOf("isLast");
    const definition = provideDefinition(
      document,
      document.positionAt(methodOffset + 2),
      fixture.index
    );
    assert.ok(definition);
    assert.equal(definition.uri, "jdt://contents/spring-data/Slice.class");
    assert.deepEqual(definition.range.start, { line: 18, character: 13 });

    const completionTemplate = `<span th:text="\${ps.}"></span>`;
    const completionDocument = TextDocument.create(
      fixture.templateUri,
      "html",
      1,
      completionTemplate
    );
    const completions = provideCompletions(
      completionDocument,
      completionDocument.positionAt(completionTemplate.indexOf("ps.") + 3),
      fixture.index
    );
    assert.ok(completions.some(({ label }) => label === "isLast()"));
  } finally {
    await fixture.dispose();
  }
});

test("navigates to JDK methods resolved from Java model properties", async () => {
  const fixture = await createFixture();
  try {
    fixture.index.addCompilerJavaTypes([{
      alias: "String",
      name: "String",
      uri: "jdt://contents/java.base/java/lang/String.class",
      position: { line: 0, character: 13 },
      properties: [],
      methods: [{
        name: "toUpperCase",
        returnType: "String",
        parameterCount: 0,
        position: { line: 504, character: 18 }
      }]
    }]);

    const template = `<span th:text="\${user.displayName.toUpperCase()}"></span>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, template);
    const methodOffset = template.indexOf("toUpperCase");
    const definition = provideDefinition(
      document,
      document.positionAt(methodOffset + 3),
      fixture.index
    );
    assert.ok(definition);
    assert.equal(definition.uri, "jdt://contents/java.base/java/lang/String.class");
    assert.deepEqual(definition.range.start, { line: 504, character: 18 });
  } finally {
    await fixture.dispose();
  }
});

test("finds template references from a Java model property", async () => {
  const fixture = await createFixture();
  try {
    const modelSource = await readFile(fixture.modelPath, "utf8");
    const modelDocument = TextDocument.create(
      pathToFileURL(fixture.modelPath).toString(),
      "java",
      1,
      modelSource
    );
    const propertyOffset = modelSource.indexOf("displayName");
    const references = provideReferences(
      modelDocument,
      modelDocument.positionAt(propertyOffset + 2),
      fixture.index
    );

    assert.equal(references.length, 1);
    assert.equal(references[0].uri, fixture.templateUri);
  } finally {
    await fixture.dispose();
  }
});

test("completes and navigates collection loop variables back to their Java model", async () => {
  const fixture = await createFixture();
  try {
    fixture.index.addCompilerJavaTypes([{
      alias: "Post",
      name: "Post",
      uri: pathToFileURL(fixture.postPath).toString(),
      position: { line: 1, character: 6 },
      properties: [],
      methods: []
    }]);
    const document = TextDocument.create(fixture.templateUri, "html", 1, fixture.template);
    const propertyOffset = fixture.template.indexOf("${p.");
    const completions = provideCompletions(
      document,
      document.positionAt(propertyOffset + "${p.".length),
      fixture.index
    );
    assert.deepEqual(
      completions.map(({ label }) => label).sort(),
      ["createdAt", "excerpt", "id", "status", "title", "updatedAt"]
    );

    const pagePropertyOffset = fixture.template.indexOf("${ps.isF") + "${ps.".length;
    const pageCompletions = provideCompletions(
      document,
      document.positionAt(pagePropertyOffset),
      fixture.index
    );
    assert.ok(pageCompletions.some(({ label }) => label === "isFirst()"));
    assert.ok(
      validateDocument(document, fixture.index, DEFAULT_SETTINGS)
        .every(({ code }) => code !== "unknown-model-property")
    );

    const idOffset = fixture.template.indexOf("${p.id}") + "${p.".length;
    const definition = provideDefinition(
      document,
      document.positionAt(idOffset),
      fixture.index
    );
    assert.ok(definition);
    assert.equal(definition.uri, pathToFileURL(fixture.postPath).toString());
    assert.equal(definition.range.start.line, 2);

    const prefixOffset = fixture.template.indexOf("${p.id}") + "${p.i".length;
    const prefixCompletions = provideCompletions(
      document,
      document.positionAt(prefixOffset),
      fixture.index
    );
    assert.ok(prefixCompletions.some(({ label }) => label === "id"));

    const modelNameOffset = fixture.template.indexOf("${ps}") + 2;
    const modelAttributeDefinition = provideDefinition(
      document,
      document.positionAt(modelNameOffset),
      fixture.index
    );
    assert.ok(modelAttributeDefinition);
    assert.equal(modelAttributeDefinition.uri, pathToFileURL(fixture.controllerPath).toString());

    const controllerDocument = TextDocument.create(
      pathToFileURL(fixture.controllerPath).toString(),
      "java",
      1,
      fixture.controller
    );
    const attributeNameOffset = fixture.controller.indexOf('"ps"') + 1;
    const attributeDefinition = provideDefinition(
      controllerDocument,
      controllerDocument.positionAt(attributeNameOffset),
      fixture.index
    );
    assert.ok(attributeDefinition);
    assert.equal(attributeDefinition.uri, pathToFileURL(fixture.postPath).toString());

    const modelAttributeReferences = provideReferences(
      controllerDocument,
      controllerDocument.positionAt(attributeNameOffset),
      fixture.index
    );
    assert.ok(modelAttributeReferences.some(({ uri }) => uri === fixture.templateUri));

    const postSource = await readFile(fixture.postPath, "utf8");
    const postDocument = TextDocument.create(
      pathToFileURL(fixture.postPath).toString(),
      "java",
      1,
      postSource
    );
    const idDeclarationOffset = postSource.indexOf("id;");
    const idReferences = provideReferences(
      postDocument,
      postDocument.positionAt(idDeclarationOffset),
      fixture.index
    );
    assert.ok(idReferences.some(({ uri, range }) =>
      uri === fixture.templateUri &&
      fixture.template.slice(
        document.offsetAt(range.start),
        document.offsetAt(range.end)
      ).includes("p.id")
    ));
  } finally {
    await fixture.dispose();
  }
});

test("completes no-argument methods for a loop variable typed by @thymesVar", async () => {
  const fixture = await createFixture();
  const javaPath = path.join(fixture.root, "src", "main", "java", "demo", "Player.java");
  const template = `<!-- @thymesVar id="pss" type="java.util.List<Player>" -->
<ul th:each="player : \${pss}">
  <li th:text="\${player.}"></li>
</ul>`;

  try {
    await writeFile(javaPath, `package demo;
public class Player {
  private java.util.UUID id;
  private Integer atk;
  public int size() { return 1 + 1; }
}`);
    await fixture.index.refresh([pathToFileURL(fixture.root).toString()]);
    fixture.index.updateOpenTemplate(fixture.templateUri, template);
    const document = TextDocument.create(fixture.templateUri, "html", 1, template);
    const completionOffset = template.indexOf("player.") + "player.".length;
    const completions = provideCompletions(
      document,
      document.positionAt(completionOffset),
      fixture.index
    );
    const labels = completions.map(({ label }) => label);
    assert.ok(labels.includes("size()"));
    assert.equal(completions[0]?.label, [...labels].sort((left, right) => left.localeCompare(right))[0]);
    assert.equal(completions[0]?.preselect, true);
    assert.ok(completions.some(({ label, kind }) => label === "size()" && kind === 2));
    assert.ok(completions.some(({ label, kind }) => label === "atk" && kind === 10));
  } finally {
    fixture.index.closeOpenTemplate(fixture.templateUri);
    await fixture.dispose();
  }
});

test("resolves th:each variables in earlier attributes on the same HTML element", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-loop-attribute-order-"));
  const templates = path.join(root, "src", "main", "resources", "templates");
  const java = path.join(root, "src", "main", "java", "demo");
  const templatePath = path.join(templates, "options.html");
  const template = `<select>
  <option th:selected="\${s.id == filter}" th:value="\${s.id}" th:text="\${s.name}" th:each="s : \${status}"></option>
</select>`;

  try {
    await Promise.all([
      mkdir(templates, { recursive: true }),
      mkdir(java, { recursive: true })
    ]);
    await Promise.all([
      writeFile(templatePath, template),
      writeFile(path.join(java, "Status.java"), `package demo;
class Status {
  private UUID id;
  private String name;
}`),
      writeFile(path.join(java, "StatusController.java"), `package demo;
@Controller class StatusController {
  @GetMapping("/options")
  String options(UUID filter, Model model) {
    List<Status> statuses = null;
    model.addAttribute("status", statuses);
    return "options";
  }
}`)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);
    const document = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);
    const completionTemplate = template.replace("s.id", "s.");
    const completionDocument = TextDocument.create(
      pathToFileURL(templatePath).toString(),
      "html",
      1,
      completionTemplate
    );
    const completionOffset = completionTemplate.indexOf("s.") + "s.".length;
    assert.deepEqual(
      findEnclosingLoopVariables(
        completionTemplate,
        completionOffset,
        index.modelAttributesForTemplate("options"),
        index
      ).map(({ name, typeName }) => ({ name, typeName })),
      [
        { name: "s", typeName: "Status" },
        { name: "sStat", typeName: "org.thymeleaf.spring6.context.IterStatus" }
      ]
    );
    const completions = provideCompletions(
      completionDocument,
      completionDocument.positionAt(completionOffset),
      index
    );
    assert.ok(completions.some(({ label }) => label === "id"));
    assert.ok(completions.some(({ label }) => label === "name"));

    const diagnostics = validateDocument(document, index, DEFAULT_SETTINGS);
    assert.deepEqual(
      diagnostics.filter(({ code }) => code === "unknown-model-property"),
      []
    );

    const definitions = provideDefinition(
      document,
      document.positionAt(template.indexOf("s.name") + 2),
      index
    );
    assert.ok(definitions);
    assert.equal(definitions.uri, pathToFileURL(path.join(java, "Status.java")).toString());
    assert.equal(definitions.range.start.line, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completes and validates th:each implicit iterStat properties (index, first, last, count)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-iterstat-"));
  const templates = path.join(root, "src", "main", "resources", "templates");
  const java = path.join(root, "src", "main", "java", "demo");
  const templatePath = path.join(templates, "list.html");

  // Template uses implicit userStat (no explicit stat var declared)
  const template = `<ul>
  <li th:each="user : \${users}" th:text="\${userStat.index + ' ' + userStat.count + ' ' + userStat.first + ' ' + userStat.last}"></li>
</ul>`;

  try {
    await Promise.all([
      mkdir(templates, { recursive: true }),
      mkdir(java, { recursive: true })
    ]);
    await Promise.all([
      writeFile(templatePath, template),
      writeFile(path.join(java, "User.java"), `package demo;\nclass User { private String name; }`),
      writeFile(path.join(java, "UserController.java"), `package demo;
@Controller class UserController {
  @GetMapping("/list")
  String list(Model model) {
    List<User> users = null;
    model.addAttribute("users", users);
    return "list";
  }
}`)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    const document = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);

    // Validate: no unknown-model-property on userStat.index, .count, .first, .last
    const diagnostics = validateDocument(document, index, DEFAULT_SETTINGS);
    const modelErrors = diagnostics.filter(({ code }) => code === "unknown-model-property");
    assert.deepEqual(modelErrors, []);

    // Completions: typing "userStat." should suggest index, count, size, first, last, even, odd
    const completionText = template.replace("userStat.index", "userStat.");
    const completionOffset = completionText.indexOf("userStat.") + "userStat.".length;
    const completionDoc = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, completionText);
    const completions = provideCompletions(completionDoc, completionDoc.positionAt(completionOffset), index);
    const completionLabels = completions.map(({ label }) => label);
    for (const prop of ["index", "count", "size", "first", "last", "even", "odd"]) {
      assert.ok(completionLabels.includes(prop), `Expected completion '${prop}' in iterStat completions`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates #fields execution object without false unknown-model-property errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-fields-"));
  const templates = path.join(root, "src", "main", "resources", "templates");
  const java = path.join(root, "src", "main", "java", "demo");
  const templatePath = path.join(templates, "form.html");

  const template = `<form th:object="\${user}">
  <input type="text" th:field="*{name}" />
  <span th:if="\${#fields.hasErrors('name')}" th:errors="*{name}"></span>
  <span th:text="\${#fields.errors('name')}"></span>
  <span th:if="\${#fields.hasErrors()}"></span>
</form>`;

  try {
    await Promise.all([
      mkdir(templates, { recursive: true }),
      mkdir(java, { recursive: true })
    ]);
    await Promise.all([
      writeFile(templatePath, template),
      writeFile(path.join(java, "User.java"), `package demo;\nclass User { private String name; }`),
      writeFile(path.join(java, "FormController.java"), `package demo;
@Controller class FormController {
  @GetMapping("/form")
  String form(Model model) {
    model.addAttribute("user", new User());
    return "form";
  }
}`)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    const document = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);
    const diagnostics = validateDocument(document, index, DEFAULT_SETTINGS);

    // No unknown-model-property errors from #fields usage
    const modelErrors = diagnostics.filter(({ code }) => code === "unknown-model-property");
    assert.deepEqual(modelErrors, [], `Unexpected model errors: ${JSON.stringify(modelErrors)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexes ModelAndView view name and addObject model attributes from Spring controller", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-modelandview-"));
  const templates = path.join(root, "src", "main", "resources", "templates");
  const java = path.join(root, "src", "main", "java", "demo");
  const templatePath = path.join(templates, "profile.html");

  try {
    await Promise.all([
      mkdir(templates, { recursive: true }),
      mkdir(java, { recursive: true })
    ]);
    await Promise.all([
      writeFile(templatePath, `<div th:text="\${username}"></div>`),
      writeFile(path.join(java, "Account.java"), `package demo;\nclass Account { private String username; private int age; }`),
      writeFile(path.join(java, "ProfileController.java"), `package demo;
@Controller class ProfileController {
  @GetMapping("/profile")
  ModelAndView profile() {
    ModelAndView mav = new ModelAndView("profile");
    mav.addObject("account", new Account());
    mav.addObject("username", "Alice");
    return mav;
  }

  @GetMapping("/profile2")
  ModelAndView profile2() {
    ModelAndView mav = new ModelAndView();
    mav.setViewName("profile");
    mav.addObject("account", new Account());
    return mav;
  }
}`)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    // Both handlers should resolve to the "profile" template
    const handlers = index.getHandlersForTemplate("profile");
    assert.ok(handlers.length >= 1, "Expected at least one handler for 'profile' template");

    // Model attributes indexed from ModelAndView
    const modelAttrs = index.modelAttributesForTemplate("profile");
    const attrMap = new Map(modelAttrs);
    assert.ok(attrMap.has("account"), "Expected 'account' model attribute from addObject");
    assert.ok(attrMap.has("username"), "Expected 'username' model attribute from addObject");

    // Template completions should include Account properties
    const template = `<div th:text="\${account.}"></div>`;
    const completionOffset = template.indexOf("account.") + "account.".length;
    const doc = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);
    const completions = provideCompletions(doc, doc.positionAt(completionOffset), index);
    assert.ok(
      completions.some(({ label }) => label === "username"),
      "Expected 'username' property completion from Account class"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prioritizes Thymeleaf suggestions for manual completion in HTML tags", async () => {
  const fixture = await createFixture();
  try {
    const text = `<form >`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const completions = provideCompletions(
      document,
      document.positionAt(text.indexOf(">")),
      fixture.index
    );

    assert.ok(completions.length > 0);
    assert.equal(completions[0].preselect, true);
    assert.ok(completions.every(({ sortText }) => sortText?.startsWith("0000_")));
    assert.ok(completions.some(({ label }) => label === "th:href"));
    assert.ok(completions.filter(({ preselect }) => preselect).length === 1);
  } finally {
    await fixture.dispose();
  }
});

test("colors model properties and methods using their inferred Java model types", async () => {
  const fixture = await createFixture();
  try {
    const text = `<span th:text="\${user.displayName}"></span>
<span th:text="\${ps.isFirst()}"></span>
<tr th:each="p: \${ps}"><td th:text="\${p.excerpt}"></td><td th:text="\${p.notAProperty}"></td></tr>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const semanticTokens = provideSemanticTokens(document, fixture.index);
    const decoded: { text: string; type: string }[] = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < semanticTokens.data.length; i += 5) {
      const deltaLine = semanticTokens.data[i];
      const deltaStart = semanticTokens.data[i + 1];
      line += deltaLine;
      character = deltaLine === 0 ? character + deltaStart : deltaStart;
      const offset = document.offsetAt({ line, character });
      const length = semanticTokens.data[i + 2];
      decoded.push({
        text: text.slice(offset, offset + length),
        type: SEMANTIC_TOKEN_TYPES[semanticTokens.data[i + 3]]
      });
    }

    assert.ok(decoded.some(({ text: token, type }) => token === "displayName" && type === "property"));
    assert.ok(decoded.some(({ text: token, type }) => token === "isFirst" && type === "method"));
    assert.ok(decoded.some(({ text: token, type }) => token === "excerpt" && type === "property"));
    assert.ok(!decoded.some(({ text: token, type }) => token === "notAProperty" && type === "property"));
  } finally {
    await fixture.dispose();
  }
});

test("indexes nested controller records added to the model for template tooling", async () => {
  const fixture = await createFixture();
  try {
    const text = `<span th:text="\${foo.bar}"></span><span th:text="\${foo.missing}"></span>
<span th:text="\${foo.bar.toUpperCase().isB}"></span><span th:text="\${foo.bar.missing}"></span>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const completionOffset = text.indexOf("foo.") + "foo.".length;
    const completions = provideCompletions(
      document,
      document.positionAt(completionOffset),
      fixture.index
    );
    assert.deepEqual(
      completions.map(({ label }) => label).sort(),
      ["bar", "total"]
    );
    const chainedCompletionOffset = text.indexOf("isB}") + "isB".length;
    const chainedCompletions = provideCompletions(
      document,
      document.positionAt(chainedCompletionOffset),
      fixture.index
    );
    assert.ok(chainedCompletions.some(({ label }) => label === "isBlank()"));

    const diagnostics = validateDocument(document, fixture.index, DEFAULT_SETTINGS);
    assert.ok(diagnostics.some(({ code, message }) =>
      code === "unknown-model-property" && message.includes("'missing'")
    ));
    assert.ok(diagnostics.some(({ code, message }) =>
      code === "unknown-model-property" && message.includes("'missing'") &&
      message.includes("model type 'String'")
    ));

    const definitionOffset = text.indexOf("${foo.bar}") + "${".length + 1;
    const definition = provideDefinition(
      document,
      document.positionAt(definitionOffset),
      fixture.index
    );
    assert.ok(definition);
    assert.equal(definition.uri, pathToFileURL(fixture.controllerPath).toString());
    const addAttributeOffset = fixture.controller.indexOf('model.addAttribute("foo"');
    const expectedPosition = TextDocument.create(
      definition.uri,
      "java",
      1,
      fixture.controller
    ).positionAt(addAttributeOffset + 'model.addAttribute("'.length);
    assert.deepEqual(definition.range.start, expectedPosition);

    const propertyOffset = text.indexOf("foo.bar") + "foo.".length;
    const propertyDefinition = provideDefinition(
      document,
      document.positionAt(propertyOffset),
      fixture.index
    );
    assert.ok(propertyDefinition);
    assert.equal(propertyDefinition.uri, pathToFileURL(fixture.controllerPath).toString());
    const recordPosition = TextDocument.create(
      propertyDefinition.uri,
      "java",
      1,
      fixture.controller
    ).positionAt(fixture.controller.indexOf("bar"));
    assert.deepEqual(propertyDefinition.range.start, recordPosition);
  } finally {
    await fixture.dispose();
  }
});

test("matches Windows document URIs with VS Code drive-letter encoding", async () => {
  if (process.platform !== "win32") return;

  const fixture = await createFixture();
  try {
    const vscodeUri = fixture.templateUri.replace(
      /^file:\/\/\/([A-Z]):/i,
      (_match, drive: string) => `file:///${drive.toLowerCase()}%3A`
    );
    const unsavedTemplate = fixture.template.replace("TITLE", "UNSAVED");
    const index = new ProjectIndex();
    await index.refresh(
      [pathToFileURL(fixture.root).toString()],
      ["src/main/resources/templates"],
      new Map([[vscodeUri, unsavedTemplate]])
    );

    assert.equal(index.findTemplateByUri(vscodeUri)?.content, unsavedTemplate);
    const document = TextDocument.create(vscodeUri, "html", 1, unsavedTemplate);
    const propertyOffset = unsavedTemplate.indexOf("${p.");
    const completions = provideCompletions(
      document,
      document.positionAt(propertyOffset + "${p.".length),
      index
    );
    assert.ok(completions.some(({ label }) => label === "title"));
  } finally {
    await fixture.dispose();
  }
});

test("completes model properties and reports template/model errors", async () => {
  const fixture = await createFixture();
  try {
    const completionDocument = TextDocument.create(fixture.templateUri, "html", 1, fixture.template);
    const completionOffset = fixture.template.indexOf("displayName") + "display".length;
    const completions = provideCompletions(
      completionDocument,
      completionDocument.positionAt(completionOffset),
      fixture.index
    );
    assert.ok(completions.some(({ label }) => label === "displayName"));

    const brokenTemplate = `<p th:text="\${user.badName}"></p><p th:class="\${user.badClass}"></p><tr th:each="p: \${ps}"><td th:text="\${p.badName}"></td></tr><p th:tex="text"></p><div th:replace="~{missing :: absent}"></div><a th:href="@{/missing}"></a><a th:href="@{/missing.css}"></a><link rel="stylesheet" th:href="@{/css/bundle.css}">`;
    const brokenDocument = TextDocument.create(fixture.templateUri, "html", 2, brokenTemplate);
    const diagnostics = validateDocument(brokenDocument, fixture.index, DEFAULT_SETTINGS);
    assert.ok(diagnostics.some(({ code }) => code === "unknown-attribute"));
    assert.ok(diagnostics.some(({ code, message }) =>
      code === "unknown-model-property" && message.includes("'badClass'")
    ));
    assert.ok(diagnostics.some(({ code }) => code === "missing-template"));
    assert.deepEqual(
      diagnostics.filter(({ code }) => code === "missing-route").map(({ message }) => message),
      [
        "No indexed Spring controller route matches '/missing'.",
        "No indexed Spring controller route matches '/missing.css'."
      ]
    );

    const malformedDocument = TextDocument.create(
      fixture.templateUri,
      "html",
      3,
      `<p th:text="\${user.displayName"></p><p th:tex="value"></p>`
    );
    const malformedDiagnostics = validateDocument(malformedDocument, fixture.index, DEFAULT_SETTINGS);
    const fixes = provideCodeActions(
      malformedDocument,
      malformedDiagnostics[0].range,
      malformedDiagnostics,
      fixture.index
    );
    assert.ok(fixes.some(({ title }) => title === "Insert missing closing brace"));
    assert.ok(fixes.some(({ title }) => title.includes("th:text")));

    const typoDocument = TextDocument.create(
      fixture.templateUri,
      "html",
      4,
      `<span th:text="\${user.displayNme}"></span>`
    );
    const typoDiagnostic = validateDocument(typoDocument, fixture.index, DEFAULT_SETTINGS)
      .find(({ code }) => code === "unknown-model-property");
    assert.ok(typoDiagnostic);
    const typoFixes = provideCodeActions(
      typoDocument,
      typoDiagnostic.range,
      [typoDiagnostic],
      fixture.index
    );
    assert.ok(typoFixes.some(({ title }) => title === "Replace with 'displayName'"));
  } finally {
    await fixture.dispose();
  }
});

test("supports @thymesVar directives for template typing without controllers", async () => {
  const fixture = await createFixture();
  try {
    const templateContent = `<!--/*@thymesVar id="author" type="demo.UserForm"*/-->
<div th:text="\${author.displayName}">Author</div>`;
    const doc = TextDocument.create(fixture.templateUri, "html", 10, templateContent);
    const offset = templateContent.indexOf("displayName") + 2;
    const def = provideDefinition(doc, doc.positionAt(offset), fixture.index);
    assert.ok(def);
    assert.equal(def.uri, pathToFileURL(fixture.modelPath).toString());

    const completions = provideCompletions(
      doc,
      doc.positionAt(templateContent.indexOf("author.") + "author.".length),
      fixture.index
    );
    assert.ok(completions.some(({ label }) => label === "displayName"));

    const badDoc = TextDocument.create(
      fixture.templateUri,
      "html",
      11,
      `<!--/*@thymesVar id="author" type="demo.UserForm"*/--><span th:text="\${author.badField}"></span>`
    );
    const diags = validateDocument(badDoc, fixture.index, DEFAULT_SETTINGS);
    assert.ok(diags.some(({ code }) => code === "unknown-model-property"));
  } finally {
    await fixture.dispose();
  }
});

test("supports generic collection types in @thymesVar directives", async () => {
  const fixture = await createFixture();
  const carPath = path.join(fixture.root, "src", "main", "java", "demo", "Car.java");
  await writeFile(carPath, `package demo;
class Car {
  private String make;
}`);
  await fixture.index.refresh([pathToFileURL(fixture.root).toString()]);

  try {
    for (const genericType of ["java.util.List<demo.Car>", "java.util.List&lt;demo.Car&gt;"]) {
      const template = `<!--/*@thymesVar id="cars" type="${genericType}"*/-->
<span th:text="\${cars.size}"></span>
<span th:each="car : \${cars}" th:text="\${car.make}"></span>`;
      fixture.index.updateOpenTemplate(fixture.templateUri, template);
      const document = TextDocument.create(fixture.templateUri, "html", 1, template);

      assert.equal(
        fixture.index.modelAttributesForTemplate("users/list", fixture.templateUri).get("cars"),
        "java.util.List<demo.Car>"
      );
      assert.deepEqual(
        validateDocument(document, fixture.index, DEFAULT_SETTINGS)
          .filter(({ code }) => code === "unknown-model-property"),
        []
      );
    }
  } finally {
    fixture.index.closeOpenTemplate(fixture.templateUri);
    await fixture.dispose();
  }
});

test("colors and navigates variables and types in regular @thymesVar comments", async () => {
  const fixture = await createFixture();
  const dtoPath = path.join(fixture.root, "src", "main", "java", "demo", "StatusResponseDto.java");
  const template = `<!-- @thymesVar id="status" type="java.util.List<StatusResponseDto>" -->
<span th:text="\${status}"></span>`;

  try {
    await writeFile(dtoPath, `package demo;
class StatusResponseDto {}`);
    await fixture.index.refresh([pathToFileURL(fixture.root).toString()]);
    fixture.index.updateOpenTemplate(fixture.templateUri, template);
    const document = TextDocument.create(fixture.templateUri, "html", 1, template);

    const idOffset = template.indexOf("status");
    const idDefinition = provideDefinition(
      document,
      document.positionAt(idOffset + 2),
      fixture.index
    );
    assert.ok(idDefinition);
    assert.equal(idDefinition.uri, pathToFileURL(dtoPath).toString());

    const typeOffset = template.indexOf("StatusResponseDto") + 4;
    const typeDefinition = provideDefinition(
      document,
      document.positionAt(typeOffset),
      fixture.index
    );
    assert.ok(typeDefinition);
    assert.equal(typeDefinition.uri, pathToFileURL(dtoPath).toString());

    const usageOffset = template.lastIndexOf("status");
    const usageDefinition = provideDefinition(
      document,
      document.positionAt(usageOffset + 2),
      fixture.index
    );
    assert.ok(usageDefinition);
    assert.equal(usageDefinition.uri, fixture.templateUri);
    assert.deepEqual(
      usageDefinition.range.start,
      document.positionAt(idOffset)
    );

    const tokens = provideSemanticTokens(document, fixture.index);
    const decoded: { text: string; type: string }[] = [];
    let line = 0;
    let character = 0;
    for (let index = 0; index < tokens.data.length; index += 5) {
      const deltaLine = tokens.data[index];
      const deltaStart = tokens.data[index + 1];
      line += deltaLine ?? 0;
      character = deltaLine === 0 ? character + (deltaStart ?? 0) : deltaStart ?? 0;
      const offset = document.offsetAt({ line, character });
      const length = tokens.data[index + 2] ?? 0;
      decoded.push({
        text: template.slice(offset, offset + length),
        type: SEMANTIC_TOKEN_TYPES[tokens.data[index + 3] ?? -1] ?? "unknown"
      });
    }
    assert.ok(decoded.some(({ text, type }) => text === "status" && type === "variable"));
    assert.ok(decoded.some(({ text, type }) => text === "StatusResponseDto" && type === "class"));
  } finally {
    fixture.index.closeOpenTemplate(fixture.templateUri);
    await fixture.dispose();
  }
});

test("supports i18n messages.properties resolution, completion, hover, and validation", async () => {
  const fixture = await createFixture();
  try {
    const doc = TextDocument.create(
      fixture.templateUri,
      "html",
      20,
      `<h1 th:text="#{welcome.title}"></h1><span th:text="#{nav."></span>`
    );
    const completionOffset = doc.getText().indexOf("#{nav.") + "#{nav.".length;
    const completions = provideCompletions(doc, doc.positionAt(completionOffset), fixture.index);
    assert.ok(completions.some(({ label }) => label === "nav.home"));

    const defOffset = doc.getText().indexOf("welcome.title") + 2;
    const def = provideDefinition(doc, doc.positionAt(defOffset), fixture.index);
    assert.ok(def);
    assert.equal(def.uri, pathToFileURL(fixture.messagesPath).toString());

    const hover = provideHover(doc, doc.positionAt(defOffset), fixture.index);
    assert.ok(hover);
    assert.ok(hover.contents.value.includes("Welcome to Thymeleaf"));

    const badDoc = TextDocument.create(fixture.templateUri, "html", 21, `<p th:text="#{missing.key}"></p>`);
    const diags = validateDocument(badDoc, fixture.index, DEFAULT_SETTINGS);
    assert.ok(diags.some(({ code }) => code === "missing-message-key"));
  } finally {
    await fixture.dispose();
  }
});

test("supports inlined expressions [[...]] and [(...)] with validation and references", async () => {
  const fixture = await createFixture();
  try {
    const inlineTemplate = `<!--/*@thymesVar id="user" type="demo.UserForm"*/-->
<p>Hello [[ \${user.displayName} ]] and [( \${user.id} )]</p>`;
    const inlinePath = path.join(fixture.root, "src", "main", "resources", "templates", "users", "inlines.html");
    await writeFile(inlinePath, inlineTemplate);
    await fixture.index.refresh([pathToFileURL(fixture.root).toString()]);

    const modelSource = await readFile(fixture.modelPath, "utf8");
    const modelDocument = TextDocument.create(
      pathToFileURL(fixture.modelPath).toString(),
      "java",
      1,
      modelSource
    );
    const propertyOffset = modelSource.indexOf("displayName");
    const references = provideReferences(
      modelDocument,
      modelDocument.positionAt(propertyOffset + 2),
      fixture.index
    );
    assert.ok(references.some(({ uri }) => uri === pathToFileURL(inlinePath).toString()));

    const brokenInline = TextDocument.create(
      fixture.templateUri,
      "html",
      31,
      `<p>Hello [[ \${user.badProperty} ]]</p><p>[( \${user.unclosed </p>`
    );
    const diags = validateDocument(brokenInline, fixture.index, DEFAULT_SETTINGS);
    assert.ok(diags.some(({ code }) => code === "unknown-model-property"));
    assert.ok(diags.some(({ code }) => code === "unclosed-expression"));
  } finally {
    await fixture.dispose();
  }
});

test("colors inline model members and navigates to inline Java methods", async () => {
  const fixture = await createFixture();
  const javaRoot = path.join(fixture.root, "src", "main", "java", "demo");
  const pagePath = path.join(javaRoot, "Page.java");
  const slicePath = path.join(javaRoot, "Slice.java");
  const template = `<!--/*@thymesVar id="page" type="demo.Page"*/-->
<p>[[\${page.title} \${page.hasNext()}]]</p>`;

  try {
    await writeFile(slicePath, `package demo;
public interface Slice {
 public boolean hasNext();
}`);
    await writeFile(pagePath, `package demo;
public class Page implements Slice {
  String title;
 public boolean matches(String value) { return true; }
 public String current() { return title; }
}`);
    await fixture.index.refresh([pathToFileURL(fixture.root).toString()]);

    const document = TextDocument.create(fixture.templateUri, "html", 1, template);
    const methodOffset = template.indexOf("hasNext");
    const definition = provideDefinition(
      document,
      document.positionAt(methodOffset + 2),
      fixture.index
    );
    assert.ok(definition);
    assert.equal(definition.uri, pathToFileURL(slicePath).toString());
    assert.ok(fixture.index.findMethodDefinition("demo.Page", "matches"));

    const nestedTemplate = `<!--/*@thymesVar id="page" type="demo.Page"*/-->
<p>[[\${page.matches(page.current())}]]</p>`;
    const nestedDocument = TextDocument.create(fixture.templateUri, "html", 1, nestedTemplate);
    const nestedMethodOffset = nestedTemplate.indexOf("matches");
    const nestedDefinition = provideDefinition(
      nestedDocument,
      nestedDocument.positionAt(nestedMethodOffset + 2),
      fixture.index
    );
    assert.ok(nestedDefinition);
    assert.equal(nestedDefinition.uri, pathToFileURL(pagePath).toString());

    const tokens = provideSemanticTokens(document, fixture.index);
    const decoded: { text: string; type: string }[] = [];
    let line = 0;
    let character = 0;
    for (let index = 0; index < tokens.data.length; index += 5) {
      const deltaLine = tokens.data[index];
      const deltaStart = tokens.data[index + 1];
      line += deltaLine ?? 0;
      character = deltaLine === 0 ? character + (deltaStart ?? 0) : deltaStart ?? 0;
      const offset = document.offsetAt({ line, character });
      const length = tokens.data[index + 2] ?? 0;
      decoded.push({
        text: template.slice(offset, offset + length),
        type: SEMANTIC_TOKEN_TYPES[tokens.data[index + 3] ?? -1] ?? "unknown"
      });
    }

    assert.ok(decoded.some(({ text, type }) => text === "title" && type === "property"));
    assert.ok(decoded.some(({ text, type }) => text === "hasNext" && type === "method"));
  } finally {
    await fixture.dispose();
  }
});

test("supports inherited properties from Java superclasses", async () => {
  const fixture = await createFixture();
  try {
    const doc = TextDocument.create(
      fixture.templateUri,
      "html",
      40,
      `<!--/*@thymesVar id="admin" type="demo.AdminForm"*/-->
<span th:text="\${admin.displayName}"></span>`
    );
    const offset = doc.getText().indexOf("displayName") + 2;
    const def = provideDefinition(doc, doc.positionAt(offset), fixture.index);
    assert.ok(def);
    assert.equal(def.uri, pathToFileURL(fixture.modelPath).toString());

    const completions = provideCompletions(
      doc,
      doc.positionAt(doc.getText().indexOf("admin.") + "admin.".length),
      fixture.index
    );
    assert.ok(completions.some(({ label }) => label === "role"));
    assert.ok(completions.some(({ label }) => label === "displayName"));
  } finally {
    await fixture.dispose();
  }
});

test("completes properties for model values returned by a repository call", async () => {
  const fixture = await createFixture();
  try {
    const text = `<tr th:each="post: \${repoPosts}"><td th:text="\${post.}"></td></tr>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const offset = text.indexOf("post.") + "post.".length;
    const completions = provideCompletions(
      document,
      document.positionAt(offset),
      fixture.index
    );

    assert.ok(completions.some(({ label }) => label === "id"));
    assert.ok(completions.some(({ label }) => label === "title"));
  } finally {
    await fixture.dispose();
  }
});

test("completes selection-expression properties from th:object context", async () => {
  const fixture = await createFixture();
  try {
    const text = `<form th:object="\${user}"><input th:field="*{dis}"></form>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const offset = text.indexOf("*{dis") + "*{dis".length;
    const completions = provideCompletions(
      document,
      document.positionAt(offset),
      fixture.index
    );

    assert.ok(completions.some(({ label }) => label === "displayName"));
  } finally {
    await fixture.dispose();
  }
});

test("supports th:with local variables in completion and diagnostics", async () => {
  const fixture = await createFixture();
  try {
    const text = `<div th:with="localUser=\${user}, count=42">
  <span th:text="\${localUser.dis}"></span>
</div>
<span th:text="\${local}"></span>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const insideOffset = text.indexOf("localUser.dis") + "localUser.dis".length;
    const insideCompletions = provideCompletions(
      document,
      document.positionAt(insideOffset),
      fixture.index
    );
    assert.ok(insideCompletions.some(({ label }) => label === "displayName"));

    const outsideOffset = text.indexOf("\${local}") + "\${local".length;
    const outsideCompletions = provideCompletions(
      document,
      document.positionAt(outsideOffset),
      fixture.index
    );
    assert.ok(!outsideCompletions.some(({ label }) => label === "localUser"));
  } finally {
    await fixture.dispose();
  }
});

test("restricts th:object scope strictly to its enclosing element without leaking", async () => {
  const fixture = await createFixture();
  try {
    const text = `<form th:object="\${user}">
  <input th:field="*{dis}">
</form>
<div th:text="*{dis}"></div>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const insideOffset = text.indexOf("*{dis") + "*{dis".length;
    const insideCompletions = provideCompletions(
      document,
      document.positionAt(insideOffset),
      fixture.index
    );
    assert.ok(insideCompletions.some(({ label }) => label === "displayName"));

    const outsideOffset = text.lastIndexOf("*{dis") + "*{dis".length;
    const outsideCompletions = provideCompletions(
      document,
      document.positionAt(outsideOffset),
      fixture.index
    );
    assert.ok(!outsideCompletions.some(({ label }) => label === "displayName"));
  } finally {
    await fixture.dispose();
  }
});

test("supports void HTML5 elements like input without corrupting th:each scope", async () => {
  const fixture = await createFixture();
  try {
    const text = `<div th:each="p : \${ps}">
  <input type="text" name="filter">
  <span th:text="\${p.tit}"></span>
</div>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const offset = text.indexOf("p.tit") + "p.tit".length;
    const completions = provideCompletions(
      document,
      document.positionAt(offset),
      fixture.index
    );
    assert.ok(completions.some(({ label }) => label === "title"));
  } finally {
    await fixture.dispose();
  }
});

test("provides quick fixes for missing message keys and unknown properties", async () => {
  const fixture = await createFixture();
  try {
    const text = `<p th:text="#{missing.test.key}"></p>
<p th:text="\${user.unknownProp}"></p>`;
    const document = TextDocument.create(fixture.templateUri, "html", 1, text);
    const diagnostics = validateDocument(document, fixture.index, DEFAULT_SETTINGS);

    const messageDiag = diagnostics.find((d) => d.code === "missing-message-key");
    assert.ok(messageDiag);
    const messageActions = provideCodeActions(
      document,
      messageDiag.range,
      [messageDiag],
      fixture.index
    );
    assert.ok(messageActions.some((a) => a.title.includes("missing.test.key")));

    const propDiag = diagnostics.find((d) => d.code === "unknown-model-property");
    assert.ok(propDiag);
    const propActions = provideCodeActions(
      document,
      propDiag.range,
      [propDiag],
      fixture.index
    );
    assert.ok(propActions.some((a) => a.title.includes("@thymesVar")));
  } finally {
    await fixture.dispose();
  }
});

test("provides bidirectional CodeLens and Gutter decorations between controllers and templates", async () => {
  const fixture = await createFixture();
  try {
    const javaDoc = TextDocument.create(
      pathToFileURL(fixture.controllerPath).toString(),
      "java",
      1,
      fixture.controller
    );
    const javaLenses = provideCodeLenses(javaDoc, fixture.index);
    assert.ok(javaLenses.length > 0);
    assert.ok(javaLenses.some((l) => l.command?.title.includes("users/list.html")));

    const javaGutter = provideGutterDecorations(
      pathToFileURL(fixture.controllerPath).toString(),
      "java",
      fixture.index
    );
    assert.ok(javaGutter.some((g) => g.tooltip.includes("users/list.html")));

    const htmlDoc = TextDocument.create(
      pathToFileURL(path.join(fixture.root, "src/main/resources/templates/users/list.html")).toString(),
      "html",
      1,
      `<div>Hello</div>`
    );
    const htmlLenses = provideCodeLenses(htmlDoc, fixture.index);
    assert.ok(htmlLenses.some((l) => l.command?.title.includes("UserController")));

    const htmlGutter = provideGutterDecorations(htmlDoc.uri, "html", fixture.index);
    assert.ok(htmlGutter.some((g) => g.tooltip.includes("UserController")));
  } finally {
    await fixture.dispose();
  }
});

test("suggests classic HTML attributes alongside Thymeleaf attributes in HTML tags", async () => {
  const fixture = await createFixture();
  try {
    // 1. In <div >: suggests both Thymeleaf attributes and global HTML attributes
    const divDoc = TextDocument.create(fixture.templateUri, "html", 1, "<div >");
    const divCompletions = provideCompletions(divDoc, divDoc.positionAt(5), fixture.index);
    assert.ok(divCompletions.some(({ label }) => label === "th:text"));
    assert.ok(divCompletions.some(({ label }) => label === "th:if"));
    assert.ok(divCompletions.some(({ label }) => label === "class"));
    assert.ok(divCompletions.some(({ label }) => label === "id"));
    assert.ok(divCompletions.some(({ label }) => label === "style"));

    // 2. In <form >: suggests form-specific attributes like action, method, enctype
    const formDoc = TextDocument.create(fixture.templateUri, "html", 1, "<form >");
    const formCompletions = provideCompletions(formDoc, formDoc.positionAt(6), fixture.index);
    assert.ok(formCompletions.some(({ label }) => label === "action"));
    assert.ok(formCompletions.some(({ label }) => label === "method"));
    assert.ok(formCompletions.some(({ label }) => label === "th:action"));
    assert.ok(formCompletions.some(({ label }) => label === "th:object"));

    // 3. Typing prefix "cl" suggests class, th:class, th:classappend
    const clDoc = TextDocument.create(fixture.templateUri, "html", 1, "<div cl>");
    const clCompletions = provideCompletions(clDoc, clDoc.positionAt(7), fixture.index);
    assert.ok(clCompletions.some(({ label }) => label === "class"));
    assert.ok(clCompletions.some(({ label }) => label === "th:class"));
    assert.ok(clCompletions.some(({ label }) => label === "th:classappend"));

    // 4. Typing prefix "ac" in form suggests action and th:action
    const acDoc = TextDocument.create(fixture.templateUri, "html", 1, "<form ac>");
    const acCompletions = provideCompletions(acDoc, acDoc.positionAt(8), fixture.index);
    assert.ok(acCompletions.some(({ label }) => label === "action"));
    assert.ok(acCompletions.some(({ label }) => label === "th:action"));

    // 5. Typing prefix "ty" in input suggests type
    const inputDoc = TextDocument.create(fixture.templateUri, "html", 1, "<input ty>");
    const inputCompletions = provideCompletions(inputDoc, inputDoc.positionAt(9), fixture.index);
    assert.ok(inputCompletions.some(({ label }) => label === "type"));
  } finally {
    await fixture.dispose();
  }
});

test("offers CodeLens, gutter decorations, diagnostics and Quick Fix to create missing template from controller action", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-create-template-"));
  const javaDir = path.join(root, "src", "main", "java", "demo");
  const controllerPath = path.join(javaDir, "AdminController.java");
  const controller = `package demo;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class AdminController {
  @GetMapping("/admin/users")
  public String listUsers() {
    return "admin/users/index";
  }

  @GetMapping("/home")
  public String home() {
    return "/index";
  }
}
`;

  try {
    await mkdir(javaDir, { recursive: true });
    await writeFile(controllerPath, controller);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    const javaDoc = TextDocument.create(
      pathToFileURL(controllerPath).toString(),
      "java",
      1,
      controller
    );

    // 1. CodeLens offers to create both missing templates
    const lenses = provideCodeLenses(javaDoc, index);
    const adminLens = lenses.find((l) => l.command?.title === "$(new-file) Create template 'admin/users/index.html'");
    assert.ok(adminLens);
    assert.equal(adminLens.command!.command, "thymeleaf.createTemplate");
    assert.deepEqual(adminLens.command!.arguments, ["admin/users/index", javaDoc.uri]);

    const homeLens = lenses.find((l) => l.command?.title === "$(new-file) Create template 'index.html'");
    assert.ok(homeLens);
    assert.equal(homeLens.command!.command, "thymeleaf.createTemplate");
    assert.deepEqual(homeLens.command!.arguments, ["index", javaDoc.uri]);

    // 2. Gutter decorations indicate missing templates
    const gutter = provideGutterDecorations(javaDoc.uri, "java", index);
    assert.ok(gutter.some((g) => g.tooltip.includes("admin/users/index.html")));
    assert.ok(gutter.some((g) => g.tooltip.includes("index.html")));

    // 3. Diagnostics detect missing controller views
    const diagnostics = validateJavaDocument(javaDoc, index);
    assert.equal(diagnostics.length, 2);
    assert.ok(diagnostics.some((d) => d.code === "missing-controller-view" && d.message.includes("admin/users/index.html")));
    assert.ok(diagnostics.some((d) => d.code === "missing-controller-view" && d.message.includes("index.html")));

    // 4. Quick Fix code actions offer to create the template
    const adminDiag = diagnostics.find((d) => d.message.includes("admin/users/index.html"))!;
    const actions = provideCodeActions(javaDoc, adminDiag.range, [adminDiag], index);
    const createAction = actions.find((a) => a.title.includes("admin/users/index.html"));
    assert.ok(createAction);
    assert.equal(createAction.command?.command, "thymeleaf.createTemplate");
    assert.deepEqual(createAction.command?.arguments, ["admin/users/index", javaDoc.uri]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("displays Javadoc on hover for model properties in Thymeleaf templates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-javadoc-"));
  const java = path.join(root, "src", "main", "java", "demo");
  const templates = path.join(root, "src", "main", "resources", "templates");
  const modelPath = path.join(java, "Customer.java");
  const templatePath = path.join(templates, "customer.html");

  const model = `package demo;
class Customer {
  /**
   * The unique identifier of the customer.
   */
  private Long id;

  /**
   * Full customer legal name.
   *
   * @return the customer name
   */
  public String getName() {
    return "John";
  }
}
`;
  const controller = `package demo;
@Controller class CustomerController {
  @GetMapping("/customer")
  String view(Model model) {
    model.addAttribute("customer", new Customer());
    return "customer";
  }
}
`;
  const template = `<div>
  <span th:text="\${customer.id}"></span>
  <span th:text="\${customer.name}"></span>
</div>`;

  try {
    await Promise.all([
      mkdir(java, { recursive: true }),
      mkdir(templates, { recursive: true })
    ]);
    await Promise.all([
      writeFile(modelPath, model),
      writeFile(path.join(java, "CustomerController.java"), controller),
      writeFile(templatePath, template)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);
    const document = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);

    // 1. Hover on property 'id'
    const idOffset = template.indexOf("customer.id") + "customer.".length;
    const idHover = provideHover(document, document.positionAt(idOffset), index);
    assert.ok(idHover, "Expected hover on customer.id");
    assert.match(idHover.contents.value, /\*\*id\*\*: `Long`/);
    assert.match(idHover.contents.value, /The unique identifier of the customer\./);

    // 2. Hover on getter property 'name'
    const nameOffset = template.indexOf("customer.name") + "customer.".length;
    const nameHover = provideHover(document, document.positionAt(nameOffset), index);
    assert.ok(nameHover, "Expected hover on customer.name");
    assert.match(nameHover.contents.value, /\*\*name\*\*: `String`/);
    assert.match(nameHover.contents.value, /Full customer legal name\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offers Extract Fragment refactoring code action on HTML selection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-extract-"));
  const templates = path.join(root, "src", "main", "resources", "templates");
  const templatePath = path.join(templates, "index.html");

  const templateContent = `<!DOCTYPE html>
<html>
<body>
  <header class="navbar">
    <h1>Site Title</h1>
  </header>
</body>
</html>`;

  try {
    await mkdir(templates, { recursive: true });
    await writeFile(templatePath, templateContent);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    const doc = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, templateContent);
    const startOffset = templateContent.indexOf('<header class="navbar">');
    const endOffset = templateContent.indexOf('</header>') + '</header>'.length;
    const range = {
      start: doc.positionAt(startOffset),
      end: doc.positionAt(endOffset)
    };

    const actions = provideCodeActions(doc, range, [], index);
    const extractAction = actions.find((a) => a.title === "Thymeleaf: Extract Fragment");
    assert.ok(extractAction, "Expected 'Thymeleaf: Extract Fragment' code action");
    assert.equal(extractAction.kind, "refactor.extract");

    // WorkspaceEdit replaces the selection with th:replace and inserts th:fragment before </body>
    const changes = extractAction.edit?.changes?.[doc.uri];
    assert.ok(changes && changes.length === 2, "Expected two edits: replacement and fragment declaration");

    const replaceEdit = changes.find((c) => c.newText.includes('th:replace="~{::extractedFragment}"'));
    assert.ok(replaceEdit, "Expected replacement edit with th:replace");

    const fragmentEdit = changes.find((c) => c.newText.includes('th:fragment="extractedFragment"'));
    assert.ok(fragmentEdit, "Expected fragment declaration edit with th:fragment");
    assert.match(fragmentEdit.newText, /<header class="navbar">/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexes static assets and prevents false positive missing-route warnings on links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-static-assets-"));
  const staticDir = path.join(root, "src", "main", "resources", "static", "css");
  const templates = path.join(root, "src", "main", "resources", "templates");
  const cssFile = path.join(staticDir, "style.css");
  const templatePath = path.join(templates, "index.html");

  const templateContent = `<!DOCTYPE html>
<html>
<body>
  <a th:href="@{/css/style.css}">CSS Link</a>
  <a th:href="@{'/user/' + \${userId}}">Dynamic Link</a>
  <a th:href="@{/nonexistent/missing}">Missing Route Link</a>
</body>
</html>`;

  try {
    await Promise.all([
      mkdir(staticDir, { recursive: true }),
      mkdir(templates, { recursive: true })
    ]);
    await Promise.all([
      writeFile(cssFile, "body { color: red; }"),
      writeFile(templatePath, templateContent)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    assert.ok(index.findStaticFile("/css/style.css"), "Static file should be indexed");
    assert.equal(index.findStaticFile("css/style.css")?.path, "/css/style.css");

    const doc = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, templateContent);
    const diagnostics = validateDocument(doc, index, DEFAULT_SETTINGS);

    // /css/style.css exists -> no diagnostic
    // '/user/' + ${userId} is dynamic -> no diagnostic
    // /nonexistent/missing -> reported as missing-route
    const missingRoutes = diagnostics.filter((d) => d.code === "missing-route");
    assert.equal(missingRoutes.length, 1);
    assert.match(missingRoutes[0].message, /missing/);

    // Definition jumps to static file
    const linkOffset = templateContent.indexOf("/css/style.css");
    const definition = provideDefinition(doc, doc.positionAt(linkOffset + 2), index);
    assert.ok(definition);
    assert.equal(definition.uri, pathToFileURL(cssFile).toString());

    // Hover indicates static asset
    const hover = provideHover(doc, doc.positionAt(linkOffset + 2), index);
    assert.ok(hover);
    assert.match(hover.contents.value, /Static asset/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports safe-navigation ?. and indexed bracket access in SpEL expressions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-spel-operators-"));
  const java = path.join(root, "src", "main", "java", "demo");
  const templates = path.join(root, "src", "main", "resources", "templates");
  const userFile = path.join(java, "User.java");
  const controllerFile = path.join(java, "UserController.java");
  const templatePath = path.join(templates, "users.html");

  const userJava = `package demo;
public class User {
  public Address address;
  public String name;
}
class Address {
  public String city;
}
`;
  const controllerJava = `package demo;
import java.util.List;
@Controller
public class UserController {
  @GetMapping("/users")
  public String getUsers(Model model) {
    model.addAttribute("users", List.of(new User()));
    model.addAttribute("user", new User());
    return "users";
  }
}
`;
  const templateContent = `<div th:text="\${user?.address?.city}"></div>
<div th:text="\${users[0].name}"></div>
<div th:text="\${users[0]?.address?.city}"></div>
<div th:text="\${user?.invalidProperty}"></div>
`;

  try {
    await Promise.all([
      mkdir(java, { recursive: true }),
      mkdir(templates, { recursive: true })
    ]);
    await Promise.all([
      writeFile(userFile, userJava),
      writeFile(controllerFile, controllerJava),
      writeFile(templatePath, templateContent)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    const doc = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, templateContent);
    const diagnostics = validateDocument(doc, index, DEFAULT_SETTINGS);

    // Only user?.invalidProperty should be reported
    const unknownProps = diagnostics.filter((d) => d.code === "unknown-model-property");
    assert.equal(unknownProps.length, 1);
    assert.match(unknownProps[0].message, /invalidProperty/);

    // Navigation on city in user?.address?.city
    const cityOffset = templateContent.indexOf("city");
    const definition = provideDefinition(doc, doc.positionAt(cityOffset + 1), index);
    assert.ok(definition, "Should navigate to Address.city through safe navigation");
    assert.equal(definition.uri, pathToFileURL(userFile).toString());

    // Navigation on name in users[0].name
    const nameOffset = templateContent.indexOf("name");
    const nameDef = provideDefinition(doc, doc.positionAt(nameOffset + 1), index);
    assert.ok(nameDef, "Should navigate to User.name through bracket indexing");
    assert.equal(nameDef.uri, pathToFileURL(userFile).toString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports Map dynamic keys and Object types without unknown-model-property errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-maps-"));
  const java = path.join(root, "src", "main", "java", "demo");
  const templates = path.join(root, "src", "main", "resources", "templates");
  const controllerFile = path.join(java, "MapController.java");
  const templatePath = path.join(templates, "map.html");

  const controllerJava = `package demo;
import java.util.Map;
public class Article {
  public String title;
}
@Controller
public class MapController {
  @GetMapping("/map")
  public String getMap(Model model) {
    model.addAttribute("articles", (Map<String, Article>) null);
    model.addAttribute("genericMap", (Map) null);
    model.addAttribute("rawObj", new Object());
    return "map";
  }
}
`;
  const templateContent = `<div th:text="\${articles.firstArticle.title}"></div>
<div th:text="\${articles['secondArticle'].title}"></div>
<div th:text="\${genericMap.arbitraryKey}"></div>
<div th:text="\${rawObj.anyProperty}"></div>
<div th:text="\${articles.firstArticle.unknownProperty}"></div>
`;

  try {
    await Promise.all([
      mkdir(java, { recursive: true }),
      mkdir(templates, { recursive: true })
    ]);
    await Promise.all([
      writeFile(controllerFile, controllerJava),
      writeFile(templatePath, templateContent)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    const doc = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, templateContent);
    const diagnostics = validateDocument(doc, index, DEFAULT_SETTINGS);

    // Only unknownProperty on Article should be reported
    const unknownProps = diagnostics.filter((d) => d.code === "unknown-model-property");
    assert.equal(unknownProps.length, 1);
    assert.match(unknownProps[0].message, /unknownProperty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexes Spring @ControllerAdvice global model attributes across templates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-advice-"));
  const java = path.join(root, "src", "main", "java", "demo");
  const templates = path.join(root, "src", "main", "resources", "templates");
  const adviceFile = path.join(java, "GlobalAdvice.java");
  const templatePath = path.join(templates, "page.html");

  const adviceJava = `package demo;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ModelAttribute;

public class CurrentUser {
  public String username;
  public String email;
}

@ControllerAdvice
public class GlobalAdvice {
  @ModelAttribute("currentUser")
  public CurrentUser getCurrentUser() {
    return new CurrentUser();
  }
}
`;
  const templateContent = `<p th:text="\${currentUser.username}"></p>
<p th:text="\${currentUser.invalidField}"></p>
`;

  try {
    await Promise.all([
      mkdir(java, { recursive: true }),
      mkdir(templates, { recursive: true })
    ]);
    await Promise.all([
      writeFile(adviceFile, adviceJava),
      writeFile(templatePath, templateContent)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    const doc = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, templateContent);
    const diagnostics = validateDocument(doc, index, DEFAULT_SETTINGS);

    // currentUser.username is valid; currentUser.invalidField is reported
    const unknownProps = diagnostics.filter((d) => d.code === "unknown-model-property");
    assert.equal(unknownProps.length, 1);
    assert.match(unknownProps[0].message, /invalidField/);

    // Navigation on username
    const usernameOffset = templateContent.indexOf("username");
    const definition = provideDefinition(doc, doc.positionAt(usernameOffset + 1), index);
    assert.ok(definition, "Should navigate to CurrentUser.username");
    assert.equal(definition.uri, pathToFileURL(adviceFile).toString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexes multiple returned views in controller handlers for navigation and code lenses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-multi-views-"));
  const java = path.join(root, "src", "main", "java", "demo");
  const templates = path.join(root, "src", "main", "resources", "templates");
  const controllerFile = path.join(java, "MultiViewController.java");
  const successTemplate = path.join(templates, "success.html");

  const controllerJava = `package demo;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class MultiViewController {
  @GetMapping("/flow")
  public String flow(boolean ok) {
    if (ok) {
      return "success";
    }
    return "error";
  }
}
`;

  try {
    await Promise.all([
      mkdir(java, { recursive: true }),
      mkdir(templates, { recursive: true })
    ]);
    await Promise.all([
      writeFile(controllerFile, controllerJava),
      writeFile(successTemplate, "<h1>Success</h1>")
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    // Check that handlers match both returned views
    const successHandlers = index.getHandlersForTemplate("success");
    const errorHandlers = index.getHandlersForTemplate("error");
    assert.equal(successHandlers.length, 1);
    assert.equal(errorHandlers.length, 1);
    assert.equal(successHandlers[0].name, "flow");
    assert.equal(errorHandlers[0].name, "flow");

    // Check CodeLenses generated for the controller
    const javaDoc = TextDocument.create(pathToFileURL(controllerFile).toString(), "java", 1, controllerJava);
    const lenses = provideCodeLenses(javaDoc, index);
    assert.ok(lenses.some((l) => l.command?.title.includes("success.html")), "Expected CodeLens for success.html");
    assert.ok(lenses.some((l) => l.command?.title.includes("error.html")), "Expected CodeLens for missing error.html");

    // validateJavaDocument should report error.html as missing, but not success.html
    const javaDiagnostics = validateJavaDocument(javaDoc, index);
    assert.equal(javaDiagnostics.length, 1);
    assert.match(javaDiagnostics[0].message, /error\.html/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports Spring Beans @Service and @Component in SpEL expressions with navigation, hover and completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-spring-beans-"));
  const java = path.join(root, "src", "main", "java", "demo");
  const templates = path.join(root, "src", "main", "resources", "templates");
  const serviceFile = path.join(java, "SecurityService.java");
  const templatePath = path.join(templates, "secure.html");

  const serviceJava = `package demo;
import org.springframework.stereotype.Service;

@Service("authz")
public class SecurityService {
  public boolean hasPermission(String role) {
    return true;
  }
}
`;
  const templateContent = `<div th:if="\${@authz.hasPermission('ADMIN')}">Admin Only</div>
<div th:if="\${@authz.invalidMethod()}">Broken</div>
`;

  try {
    await Promise.all([
      mkdir(java, { recursive: true }),
      mkdir(templates, { recursive: true })
    ]);
    await Promise.all([
      writeFile(serviceFile, serviceJava),
      writeFile(templatePath, templateContent)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    assert.ok(index.findSpringBean("authz"), "Spring bean @authz should be indexed");

    const doc = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, templateContent);
    const diagnostics = validateDocument(doc, index, DEFAULT_SETTINGS);

    // @authz.hasPermission is valid; @authz.invalidMethod is reported
    const unknownProps = diagnostics.filter((d) => d.code === "unknown-model-property");
    assert.equal(unknownProps.length, 1);
    assert.match(unknownProps[0].message, /invalidMethod/);

    // Navigation on @authz jumps to SecurityService
    const authzOffset = templateContent.indexOf("@authz");
    const beanDef = provideDefinition(doc, doc.positionAt(authzOffset + 2), index);
    assert.ok(beanDef, "Should navigate to Spring Bean @authz");
    assert.equal(beanDef.uri, pathToFileURL(serviceFile).toString());

    // Navigation on hasPermission jumps to method definition
    const methodOffset = templateContent.indexOf("hasPermission");
    const methodDef = provideDefinition(doc, doc.positionAt(methodOffset + 2), index);
    assert.ok(methodDef, "Should navigate to SecurityService.hasPermission");
    assert.equal(methodDef.uri, pathToFileURL(serviceFile).toString());

    // Hover on @authz shows Spring bean details
    const beanHover = provideHover(doc, doc.positionAt(authzOffset + 2), index);
    assert.ok(beanHover, "Hover on @authz should return bean info");
    assert.match(beanHover.contents.value, /Spring Bean/);

    // Completion on ${@ offers @authz
    const completions = provideCompletions(doc, doc.positionAt(authzOffset + 1), index);
    assert.ok(completions.some((c: any) => c.label === "@authz"), "Completion should suggest @authz");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates extended execution objects #arrays, #bools, #authentication, #strings without false positives", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-exec-objs-"));
  const templates = path.join(root, "src", "main", "resources", "templates");
  const templatePath = path.join(templates, "exec.html");

  const templateContent = `<p th:if="\${#arrays.length({'a', 'b'}) > 0}">Array</p>
<p th:if="\${#bools.isTrue(true)}">Bool</p>
<p th:text="\${#authentication.getName()}">User</p>
<p th:text="\${#strings.substringAfter('hello-world', '-')}">World</p>
<p th:text="\${#arrays.invalidMethod()}">Broken</p>
`;

  try {
    await mkdir(templates, { recursive: true });
    await writeFile(templatePath, templateContent);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    const doc = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, templateContent);
    const diagnostics = validateDocument(doc, index, DEFAULT_SETTINGS);

    // Only #arrays.invalidMethod should be flagged
    const unknownProps = diagnostics.filter((d) => d.code === "unknown-model-property");
    assert.equal(unknownProps.length, 1);
    assert.match(unknownProps[0].message, /invalidMethod/);

    // Hover on #arrays shows its description
    const arraysOffset = templateContent.indexOf("#arrays");
    const hover = provideHover(doc, doc.positionAt(arraysOffset + 1), index);
    assert.ok(hover, "Hover on #arrays should return doc");
    assert.match(hover.contents.value, /array objects/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports Thymeleaf Layout Dialect layout:decorate and layout:fragment with navigation and references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-layout-"));
  const templates = path.join(root, "src", "main", "resources", "templates");
  const layoutPath = path.join(templates, "layouts", "base.html");
  const pagePath = path.join(templates, "home.html");

  const layoutContent = `<!DOCTYPE html>
<html>
<body>
  <div layout:fragment="content">Base Content</div>
</body>
</html>`;

  const pageContent = `<!DOCTYPE html>
<html layout:decorate="layouts/base">
<body>
  <div layout:fragment="content">Home Custom Content</div>
  <div layout:decorate="missing/layout"></div>
</body>
</html>`;

  try {
    await mkdir(path.join(templates, "layouts"), { recursive: true });
    await Promise.all([
      writeFile(layoutPath, layoutContent),
      writeFile(pagePath, pageContent)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);

    const pageDoc = TextDocument.create(pathToFileURL(pagePath).toString(), "html", 1, pageContent);
    const diagnostics = validateDocument(pageDoc, index, DEFAULT_SETTINGS);

    // Missing layout should be reported
    const missingTemplates = diagnostics.filter((d) => d.code === "missing-template");
    assert.equal(missingTemplates.length, 1);
    assert.match(missingTemplates[0].message, /missing\/layout/);

    // Navigation on layout:decorate="layouts/base" jumps to base.html
    const layoutRefOffset = pageContent.indexOf("layouts/base");
    const definition = provideDefinition(pageDoc, pageDoc.positionAt(layoutRefOffset + 2), index);
    assert.ok(definition, "Should navigate to layouts/base.html");
    assert.equal(definition.uri, pathToFileURL(layoutPath).toString());

    // Fragment content is indexed on base.html
    const baseTemplate = index.findTemplate("layouts/base");
    assert.ok(baseTemplate, "base template should be indexed");
    assert.ok(baseTemplate.fragments.some((f) => f.name === "content"), "Fragment 'content' should be indexed");

    // References on 'content' in home.html finds definition in base.html
    const fragOffset = pageContent.indexOf("content");
    const refs = provideReferences(pageDoc, pageDoc.positionAt(fragOffset + 1), index);
    assert.ok(refs.length >= 1, "Should find references for fragment 'content'");
    assert.ok(refs.some((r) => r.uri === pathToFileURL(layoutPath).toString()), "References should include base.html");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates undefined variables and provides quick fixes", async () => {
  const fixture = await createFixture();
  try {
    const invalidTemplate = `<div th:text="\${nonExistentVar}"></div>
<span th:text="\${usr.displayName}"></span>
<p th:text="\${user.displayName}"></p>
<div th:with="localA = 123"><span th:text="\${localA}"></span></div>
<div th:fragment="card(title, icon)"><span th:text="\${title}"></span></div>
<span th:text="\${param.query}"></span>
<span th:text="\${#strings.toUpperCase(user.displayName)}"></span>`;

    const doc = TextDocument.create(fixture.templateUri, "html", 1, invalidTemplate);
    const diagnostics = validateDocument(doc, fixture.index, DEFAULT_SETTINGS);

    const undefinedVarDiags = diagnostics.filter((d) => d.code === "undefined-variable");
    assert.equal(undefinedVarDiags.length, 2, "Should report exactly 2 undefined variables: nonExistentVar and usr");
    assert.ok(undefinedVarDiags.some((d) => d.message.includes("'nonExistentVar'")));
    assert.ok(undefinedVarDiags.some((d) => d.message.includes("'usr'")));

    // Quick fixes for 'usr' (which is close to 'user')
    const usrDiag = undefinedVarDiags.find((d) => d.message.includes("'usr'"))!;
    const actions = provideCodeActions(doc, usrDiag.range, [usrDiag], fixture.index);
    assert.ok(actions.some((a) => a.title === "Replace with 'user'"), "Should suggest replacement with 'user'");
    assert.ok(actions.some((a) => a.title.includes("@thymesVar id=\"usr\"")), "Should offer adding @thymesVar");

    // Setting undefinedVariables=false disables these warnings
    const disabledDiags = validateDocument(doc, fixture.index, {
      ...DEFAULT_SETTINGS,
      validation: { ...DEFAULT_SETTINGS.validation, undefinedVariables: false }
    });
    assert.equal(disabledDiags.filter((d) => d.code === "undefined-variable").length, 0);

    // String literals like CSS classes must never be reported as undefined variables
    const ternaryTemplate = `<a th:class="\${user != null ? 'btn btn-outline btn-info btn-active' : 'btn btn-outline btn-info'}"></a>`;
    const ternaryDoc = TextDocument.create(fixture.templateUri, "html", 2, ternaryTemplate);
    const ternaryDiags = validateDocument(ternaryDoc, fixture.index, DEFAULT_SETTINGS);
    assert.deepEqual(ternaryDiags.filter((d) => d.code === "undefined-variable"), []);
  } finally {
    await fixture.dispose();
  }
});

test("navigates to local variable declarations, selection methods, and Java ModelAndView", async () => {
  const fixture = await createFixture();
  try {
    const templateWithLocal = `<div th:each="item : \${ps}">
  <span th:text="\${item.title}"></span>
</div>
<div th:with="discount = 0.2">
  <span th:text="\${discount}"></span>
</div>
<div th:object="\${ps}">
  <span th:text="*{isFirst()}"></span>
</div>`;

    const doc = TextDocument.create(fixture.templateUri, "html", 1, templateWithLocal);

    // 1. F12 on 'item' inside ${item.title} navigates to th:each="item : ${ps}"
    const itemOffset = templateWithLocal.indexOf("item.title");
    const itemDef = provideDefinition(doc, doc.positionAt(itemOffset), fixture.index);
    assert.ok(itemDef, "Definition for item should be found");
    assert.equal(itemDef.uri, fixture.templateUri, "Should navigate within the same HTML template");
    const eachItemOffset = templateWithLocal.indexOf("item : ");
    assert.deepEqual(itemDef.range.start, doc.positionAt(eachItemOffset));

    // 2. F12 on 'discount' inside ${discount} navigates to th:with="discount = 0.2"
    const discountUsage = templateWithLocal.lastIndexOf("discount");
    const discountDef = provideDefinition(doc, doc.positionAt(discountUsage), fixture.index);
    assert.ok(discountDef, "Definition for discount should be found");
    assert.equal(discountDef.uri, fixture.templateUri);
    const withOffset = templateWithLocal.indexOf("discount =");
    assert.deepEqual(discountDef.range.start, doc.positionAt(withOffset));

    // 3. F12 on 'isFirst' inside *{isFirst()} navigates to Java method
    const isFirstOffset = templateWithLocal.indexOf("isFirst");
    const isFirstDef = provideDefinition(doc, doc.positionAt(isFirstOffset), fixture.index);
    assert.ok(isFirstDef, "Definition for isFirst() should be found on selected object");

    // 4. Navigation from Java ModelAndView to template
    const javaDoc = TextDocument.create(
      pathToFileURL(fixture.controllerPath).toString(),
      "java",
      1,
      `package demo;
class MyCtrl {
  ModelAndView test() {
    return new ModelAndView("users/list");
  }
}`
    );
    const viewOffset = javaDoc.getText().indexOf("users/list");
    const viewDef = provideDefinition(javaDoc, javaDoc.positionAt(viewOffset + 2), fixture.index);
    assert.ok(viewDef, "Should navigate from ModelAndView to template");
    assert.equal(viewDef.uri, fixture.templateUri);
  } finally {
    await fixture.dispose();
  }
});

async function createFixture(): Promise<{
  readonly index: ProjectIndex;
  readonly root: string;
  readonly template: string;
  readonly templateUri: string;
  readonly controller: string;
  readonly controllerPath: string;
  readonly modelPath: string;
  readonly adminPath: string;
  readonly postPath: string;
  readonly messagesPath: string;
  readonly dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-lsp-"));
  const templatePath = path.join(root, "src", "main", "resources", "templates", "users", "list.html");
  const controllerPath = path.join(root, "src", "main", "java", "demo", "UserController.java");
  const modelPath = path.join(root, "src", "main", "java", "demo", "UserForm.java");
  const adminPath = path.join(root, "src", "main", "java", "demo", "AdminForm.java");
  const postPath = path.join(root, "src", "main", "java", "demo", "Post.java");
  const messagesPath = path.join(root, "src", "main", "resources", "messages.properties");
  const fragmentPath = path.join(root, "src", "main", "resources", "templates", "fragments", "header.html");
  const template = `<p th:text="\${user.displayName}"></p>
<a th:href="@{/users/{id}(id=\${user.id})}">Users</a>
<span th:text="\${ps.isFirst()}"></span>
<tr th:each="p: \${ps}">
  <td th:text="\${p.id}">#Id</td>
  <td th:text="\${p.title}">TITLE</td>
  <td th:text="\${p.excerpt}">EXCERPT</td>
  <td th:text="\${p.status}">STATUS</td>
  <td th:text="\${p.createdAt}">CREATED_AT</td>
  <td th:text="\${p.updatedAt}">UPDATED_AT</td>
</tr>
<div th:replace="~{fragments/header :: nav}"></div>`;
  const controller = `package demo;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.RequestMapping;
@Controller
@RequestMapping("/users")
class UserController {
  record Foo(String bar, int total) {}
  private PostService postService;
  private PostRepository postRepository;
  @GetMapping("/{id}")
  String list(@ModelAttribute("user") UserForm user, Model model) {
    var ps = postService.findAll();
    model.addAttribute("ps", ps);
    model.addAttribute("repoPosts", postRepository.findAll());
    model.addAttribute("foo", new Foo("aze", 10));
    return "users/list";
  }
}`;
  const model = `package demo;
class UserForm {
  private String displayName;
  private String id;
}`;
  const admin = `package demo;
class AdminForm extends UserForm {
  private String role;
  public String getRole() { return role; }
}`;
  const post = `package demo;
class Post {
  private Long id;
  private String title;
  private String excerpt;
  private String status;
  private String createdAt;
  private String updatedAt;
}`;
  const postService = `package demo;
class PostService {
  Page<Post> findAll() { return null; }
}`;
  const postRepository = `package demo;
interface PostRepository extends PostRepositoryBase<Post> {}
interface PostRepositoryBase<T> {
  java.util.List<T> findAll();
}`;
  const messages = `welcome.title=Welcome to Thymeleaf
nav.home=Home Page
`;

  await Promise.all([
    mkdir(path.dirname(templatePath), { recursive: true }),
    mkdir(path.dirname(controllerPath), { recursive: true }),
    mkdir(path.dirname(fragmentPath), { recursive: true })
  ]);
  await Promise.all([
    writeFile(templatePath, template),
    writeFile(controllerPath, controller),
    writeFile(modelPath, model),
    writeFile(adminPath, admin),
    writeFile(postPath, post),
    writeFile(messagesPath, messages),
    writeFile(path.join(path.dirname(postPath), "PostService.java"), postService),
    writeFile(path.join(path.dirname(postPath), "PostRepository.java"), postRepository),
    writeFile(fragmentPath, `<nav th:fragment="nav">Navigation</nav>`)
  ]);

  const index = new ProjectIndex();
  await index.refresh([pathToFileURL(root).toString()]);
  return {
    index,
    root,
    template,
    templateUri: pathToFileURL(templatePath).toString(),
    controller,
    controllerPath,
    modelPath,
    adminPath,
    postPath,
    messagesPath,
    dispose: () => rm(root, { recursive: true, force: true })
  };
}
