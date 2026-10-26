# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Report undefined variables in Thymeleaf expressions (`undefined-variable` diagnostics) when variables are not declared in Spring controllers, `@ControllerAdvice`, `@thymesVar` directives, local loop/with scopes, Spring Beans, or built-in execution objects.
- Add Quick Fixes for undefined variables: typo suggestions (`Did you mean '...'?`) using Levenshtein distance and quick action to add `<!--/*@thymesVar*/-->` directive.
- Add configuration `thymeleaf.validation.undefinedVariables` (defaults to `true`).
- Recognize parameterized fragment variables (`th:fragment="name(arg1, arg2)"` and `layout:fragment`) in enclosing local scope.
- Recognize additional Thymeleaf execution objects (`#fields`, `#messages`, `#uris`, `#temporals`, `#locale`, `#ctx`, `#request`, `#response`, `#session`) and implicit servlet objects (`param`, `session`, `application`).
- Complete "Go to Definition" (F12) for local loop variables (`th:each`), local scoped variables (`th:with`), and parameterized fragment arguments (`th:fragment`), jumping straight to their declaration in the HTML template.
- Support Go to Definition for root methods on selected objects (`*{isFirst()}`) in selection expressions.
- Support Go to Definition from Spring controller `new ModelAndView("viewName")` and `setViewName("viewName")` to Thymeleaf templates.
- Support bidirectional Go to Definition on `layout:fragment` between child templates and layout parent definitions.

## [0.7.0] - 2026-10-21

### Added

- Support `@ControllerAdvice` global model attributes — attributes added via `@ModelAttribute` in advice classes are now available across all templates for completion, hover, navigation, and validation.
- Support multiple returned views in controller handlers — handlers that return multiple view names (via arrays, conditionals, or `viewTargets`) now generate code lenses and gutter decorations for each resolved view, with diagnostics and quick fixes per target.
- Support Spring Beans (`@Service`, `@Component`, `@Repository`) in SpEL expressions — `@beanName.property` references complete, navigate to their Java declaration, display hover documentation, and report unknown properties.
- Expand built-in Thymeleaf execution objects — `#arrays`, `#bools`, `#objects`, `#authentication`, `#authorization`, `#vars`, `#root`, and others are now recognized and exempt from unknown-property diagnostics.
- Support Thymeleaf Layout Dialect — `layout:decorate` template references are validated and navigable; `layout:fragment` definitions are indexed and available for cross-template fragment navigation and references.

## [0.6.0] - 2026-10-19

### Added


- Add syntax highlighting and Java navigation for model variables and Java types declared in `@thymesVar` HTML comments.
- Add syntax highlighting for Thymeleaf inline expressions and Java-backed properties and methods.
- Support navigation to Java methods with nested arguments, including inherited methods.

### Improved

- Resolve generic `@thymesVar` collection types and expose their element properties and methods in completions.
- Sort completion suggestions alphabetically and preselect the first suggestion, using native VS Code item kinds for variables, properties, and methods.

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
