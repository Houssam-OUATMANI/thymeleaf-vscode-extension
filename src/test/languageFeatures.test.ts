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
  validateDocument
} from "../server/features/diagnosticsProvider";
import { provideCompletions } from "../server/features/completionProvider";
import {
  provideSemanticTokens,
  SEMANTIC_TOKEN_TYPES
} from "../server/features/semanticTokensProvider";
import {
  provideDefinition,
  provideHover,
  provideReferences,
  prepareThymeleafRename,
  provideThymeleafRenameEdits
} from "../server/features/navigationProvider";
import { ProjectIndex } from "../server/projectIndex";

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

test("uses compiler-resolved classpath symbols for Thymeleaf model completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thymeleaf-compiler-types-"));
  const templateRoot = path.join(root, "src", "main", "resources", "templates");
  const javaRoot = path.join(root, "src", "main", "java", "demo");
  const templatePath = path.join(templateRoot, "remote.html");
  const controllerPath = path.join(javaRoot, "RemoteController.java");
  const template = `<span th:text="\${remote.}"></span>`;
  try {
    await Promise.all([
      mkdir(templateRoot, { recursive: true }),
      mkdir(javaRoot, { recursive: true })
    ]);
    await Promise.all([
      writeFile(templatePath, template),
      writeFile(controllerPath, `package demo;
@Controller class RemoteController {
  @GetMapping
  String index(Model model) {
    model.addAttribute("remote", new RemoteDto());
    return "remote";
  }
}`)
    ]);

    const index = new ProjectIndex();
    await index.refresh([pathToFileURL(root).toString()]);
    assert.ok(index.unresolvedJavaTypeReferences.some(({ typeName }) => typeName === "RemoteDto"));
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
    }]);

    assert.equal(
      index.findProperty("RemotePage<RemoteDto>", "content")?.typeName,
      "List<RemoteDto>"
    );
    const document = TextDocument.create(pathToFileURL(templatePath).toString(), "html", 1, template);
    const completions = provideCompletions(
      document,
      document.positionAt(template.indexOf("remote.") + "remote.".length),
      index
    );
    assert.ok(completions.some(({ label }) => label === "displayName"));
    assert.ok(completions.some(({ label }) => label === "alias"));
  } finally {
    await rm(root, { recursive: true, force: true });
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

    const brokenTemplate = `<p th:text="\${user.badName}"></p><tr th:each="p: \${ps}"><td th:text="\${p.badName}"></td></tr><p th:tex="text"></p><div th:replace="~{missing :: absent}"></div><a th:href="@{/missing}"></a><a th:href="@{/missing.css}"></a><link rel="stylesheet" th:href="@{/css/bundle.css}">`;
    const brokenDocument = TextDocument.create(fixture.templateUri, "html", 2, brokenTemplate);
    const diagnostics = validateDocument(brokenDocument, fixture.index, DEFAULT_SETTINGS);
    assert.ok(diagnostics.some(({ code }) => code === "unknown-attribute"));
    assert.ok(diagnostics.some(({ code }) => code === "unknown-model-property"));
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
  @GetMapping("/{id}")
  String list(@ModelAttribute("user") UserForm user, Model model) {
    var ps = postService.findAll();
    model.addAttribute("ps", ps);
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
