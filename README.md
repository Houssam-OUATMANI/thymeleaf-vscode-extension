# Thymeleaf Integration for VS Code

Thymeleaf editing support for Visual Studio Code, powered by a dedicated Language Server Protocol (LSP) server.

## Features

- Prioritized Thymeleaf-aware completion for attributes, expressions, model properties, `th:each` variables, templates, fragments, and controller routes, including on manual completion requests.
- Go to Definition between Java model attributes/properties and their Thymeleaf expressions.
- Rename Java model fields/record components together with compiler-resolved Java references and exact Thymeleaf property occurrences.
- Go to Definition between controller routes and Thymeleaf links.
- Go to Definition between controller view names and template files.
- Go to Definition between fragment references and fragment declarations.
- Diagnostics for malformed expressions, unknown attributes, missing templates/fragments/routes, and resolvable model properties.
- Quick fixes for missing closing braces and common misspellings of Thymeleaf attributes.
- Hover information and references for indexed model properties and routes.
- Thymeleaf syntax highlighting injected into VS Code's HTML grammar, with semantic coloring for model properties and methods resolved from Java model types.
- Thymeleaf snippets as an optional editing convenience.

## Project structure

```text
src/
  client/extension.ts           VS Code Language Client startup and document sync
  server/server.ts              LSP lifecycle, indexing, and protocol handlers
  server/projectIndex.ts        Project-wide template, controller, and model index
  server/javaIndexer.ts         Spring route and Java model source indexing
  server/features/              Separate LSP completion, navigation, diagnostics, and shared helpers
  thymeleaf/                    Thymeleaf attribute metadata and expression analysis
  test/                         Node.js unit tests
syntaxes/                       TextMate grammar injections
snippets/                       Thymeleaf editor snippets
.vscode/                        Extension Development Host and build task
```

The VS Code client is intentionally thin. Project analysis and editor features live in the LSP server so they can be tested independently and extended without coupling parsing to VS Code APIs.

## Requirements

Open a workspace folder containing Thymeleaf templates. Spring Boot's conventional template directory is indexed by default. The extension depends on `redhat.java` for JDTLS-backed Java symbol and classpath resolution; if its compiler API is unavailable, existing source-based features continue in a logged source-only fallback mode.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `thymeleaf.templateLocations` | `["src/main/resources/templates"]` | Template directories relative to each workspace folder. |
| `thymeleaf.validation.unclosedExpressions` | `true` | Report malformed or unclosed Thymeleaf expressions in `th:*` attributes. |
| `thymeleaf.validation.unknownAttributes` | `true` | Report unknown Thymeleaf attributes and suggest close matches. |
| `thymeleaf.validation.unknownModelProperties` | `true` | Check properties when the model type can be resolved from indexed Java sources. |

Template names in Thymeleaf expressions are resolved relative to each configured template directory and omit the `.html` extension. For example, `~{fragments/header :: navigation}` resolves to `fragments/header.html`.

The server watches Java and HTML file changes and rebuilds its project index automatically. Template locations can be configured in settings.

## Development

```sh
npm install
npm test
```

Press F5 in VS Code to launch the Extension Development Host.
`npm run compile` type-checks the sources and bundles the LSP client and server. `npm run watch` rebuilds the bundles as you edit.

## Current scope

The semantic index recognizes common Spring MVC `@Controller` / `@RestController` handlers using `@RequestMapping` and the composed HTTP mapping annotations, static view-name returns, model values supplied through `Model.addAttribute` (including constructor expressions, local variables, and simple service method calls), `@ModelAttribute`, and Java fields/getters/record components, including nested types. Spring infrastructure and scalar handler parameters are not treated as view-model attributes. When multiple handlers serve the same view with incompatible types for an attribute, that attribute is left unresolved rather than assigned an arbitrary type. With the Java extension's standard language server active, unresolved source type references are resolved through JDTLS definitions and document symbols using the project's actual runtime classpath; those dependency symbols feed completion, diagnostics, navigation, semantic coloring, and basic generic type-argument substitution. Rename combines JDTLS Java references with precisely ranged Thymeleaf property references. The source parser still indexes Spring handler/model wiring and serves as a fallback; this is not yet a full replacement of the Java compiler's semantic model for all Java syntax, generic bounds/substitution, inherited dependency members, or SpEL. Dynamic Spring mappings and complex SpEL remain future work.
