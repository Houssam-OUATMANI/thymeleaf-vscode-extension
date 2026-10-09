# Changelog

All notable changes to this project are documented in this file.

## [0.5.0] - 2026-10-09

### Added

- Complete standard HTML attributes with global and element-specific suggestions in HTML templates.
- Report unknown Thymeleaf attributes and suggest likely corrections.
- Validate model properties in Thymeleaf expressions against indexed Java model types.

### Improved

- Improve Java indexing and model-type inference for Thymeleaf completion and validation, including `var` values initialized with literals, collection factories, and resolvable static factory methods.
- Complete Java-backed model properties for inferred JDK types such as `String`, `Instant`, and `LocalDateTime`.

## [0.4.0] - 2026-10-07

### Added

- Add code lenses to navigate between Spring controller handlers, Thymeleaf templates, and referenced fragments.
- Add gutter markers for controller mappings, templates, and Thymeleaf fragments.
- Add quick fixes to declare unresolved model properties with a `thymesVar` directive or create a missing message key in a message bundle.

### Improved

- Detect unresolved properties in nested model expressions and recognize additional `sec:*` and `layout:*` attributes.
- Improve Thymeleaf expression parsing and completion.

### Notes

- README screenshots are linked from the repository and are not included in the extension package.

## [0.3.1] - 2026-10-06

### Added

- Add README screenshots showing completion, Java-backed model support, and quick fixes.

### Notes

- Screenshots are linked from the repository and are not included in the VSIX package.

## [0.3.0] - 2026-10-06

### Added

- Support HTML5 `data-th-*` attribute aliases for Thymeleaf completion, navigation, diagnostics, and syntax highlighting.

### Notes

- Java source indexing refreshes when files are saved. With VS Code Auto Save enabled, Java changes are indexed automatically as they are saved.

## [0.2.0] - 2026-10-04

### Added

- Go to Type Definition from Thymeleaf model properties and model variables.
- Go to Definition, hover information, and completion for uniquely resolved no-argument Java and JDK methods, including inherited dependency-interface members exposed by JDTLS.
- Contextual completion for `*{...}` selection expressions using the enclosing `th:object`.
- Trigger Thymeleaf attribute completion after whitespace and replace partial attribute prefixes precisely.
- Infer model collection types from `List.of`, `Set.of`, `Collection.of`, and `Arrays.asList` controller expressions.
- Resolve overloaded generic repository methods by argument count and preserve class type parameters across Spring Data inheritance.
- Keep completion and navigation responsive while editing templates by updating their in-memory index without rebuilding the whole workspace on every change.

### Fixed

- The language server no longer crashes during startup when registering workspace-folder change handling.
- Nested model-property navigation and hover now resolve the exact member under the cursor.
- Multi-root indexing retains all templates and refuses ambiguous template/type names instead of selecting an arbitrary root.
- Message bundles now parse Java `.properties` whitespace separators, escapes, Unicode escapes, continued lines, and last-definition-wins duplicate keys.
- Workspace-folder changes refresh the index; index refreshes are serialized to avoid overlapping rebuilds.
- Same-named views in separate workspace roots retain separate Spring model inference and Java navigation.
- Open template edits update fragments and Thymeleaf variable directives immediately; closing a template restores its indexed disk content.

## [0.1.0] - 2026-10-03

### Added

- Thymeleaf-aware completion, syntax highlighting, snippets, hover information, and semantic coloring in HTML templates.
- Java and Thymeleaf navigation for model attributes and properties, Spring routes, view names, templates, and fragments.
- Diagnostics for malformed expressions, unknown attributes, unresolved model properties, missing routes, templates, fragments, and message keys.
- Quick fixes for unclosed expressions and common Thymeleaf attribute and model-property misspellings.
- Java model indexing for common Spring MVC controllers, `Model.addAttribute`, `@ModelAttribute`, Java fields, getters, records, and common generic collection types.
- JDTLS integration for Java project classpath and external type symbol resolution.
- Coordinated rename edits for supported Java model properties and their Thymeleaf references.
- Configurable template locations and validation settings.

### Notes

- Java model and Spring handler association uses source analysis and does not cover all runtime behavior or the full SpEL language.
- Compiler-backed type enrichment requires the `redhat.java` language server in standard mode.
