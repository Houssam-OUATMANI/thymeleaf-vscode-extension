export interface ThymeleafAttribute {
  readonly name: string;
  readonly description: string;
  readonly value: string;
}

export const THYMELEAF_ATTRIBUTES: readonly ThymeleafAttribute[] = [
  { name: "th:text", description: "Set escaped element text.", value: "${expression}" },
  { name: "th:utext", description: "Set unescaped element text.", value: "${expression}" },
  { name: "th:if", description: "Render the element when the condition is true.", value: "${condition}" },
  { name: "th:unless", description: "Render the element when the condition is false.", value: "${condition}" },
  { name: "th:each", description: "Iterate over a collection.", value: "${item} : ${items}" },
  { name: "th:with", description: "Define local variables.", value: "name=${value}" },
  { name: "th:object", description: "Select the form or selection object.", value: "${object}" },
  { name: "th:field", description: "Bind a form field to the selected object.", value: "*{property}" },
  { name: "th:href", description: "Set a context-aware link.", value: "@{/path}" },
  { name: "th:src", description: "Set a context-aware resource URL.", value: "@{/path}" },
  { name: "th:action", description: "Set a context-aware form action.", value: "@{/path}" },
  { name: "th:value", description: "Set an element value.", value: "${expression}" },
  { name: "th:classappend", description: "Append a CSS class.", value: "${expression}" },
  { name: "th:attr", description: "Set one or more attributes.", value: "name=${value}" },
  { name: "th:attrappend", description: "Append to one or more attributes.", value: "name=${value}" },
  { name: "th:attrprepend", description: "Prepend to one or more attributes.", value: "name=${value}" },
  { name: "th:checked", description: "Set the checked state of an element.", value: "${condition}" },
  { name: "th:disabled", description: "Set the disabled state of an element.", value: "${condition}" },
  { name: "th:selected", description: "Set the selected state of an option.", value: "${condition}" },
  { name: "th:class", description: "Set the element CSS classes.", value: "${expression}" },
  { name: "th:style", description: "Set the element inline style.", value: "${expression}" },
  { name: "th:title", description: "Set the element title.", value: "${expression}" },
  { name: "th:alt-title", description: "Set both alt and title attributes.", value: "${expression}" },
  { name: "th:id", description: "Set the element id.", value: "${expression}" },
  { name: "th:name", description: "Set the element name.", value: "${expression}" },
  { name: "th:lang", description: "Set the element language.", value: "${expression}" },
  { name: "th:target", description: "Set the element target.", value: "${expression}" },
  { name: "th:rel", description: "Set the element relationship.", value: "${expression}" },
  { name: "th:method", description: "Set the form submission method.", value: "${expression}" },
  { name: "th:accept", description: "Set accepted file types.", value: "${expression}" },
  { name: "th:accept-charset", description: "Set accepted form character encodings.", value: "${expression}" },
  { name: "th:accesskey", description: "Set the element access key.", value: "${expression}" },
  { name: "th:async", description: "Set asynchronous script loading.", value: "${condition}" },
  { name: "th:autocomplete", description: "Set the autocomplete mode.", value: "${expression}" },
  { name: "th:autofocus", description: "Set the autofocus state.", value: "${condition}" },
  { name: "th:autoplay", description: "Set media autoplay.", value: "${condition}" },
  { name: "th:charset", description: "Set the resource character encoding.", value: "${expression}" },
  { name: "th:cite", description: "Set the citation URL.", value: "@{/path}" },
  { name: "th:cols", description: "Set the number of text columns.", value: "${expression}" },
  { name: "th:colspan", description: "Set the table column span.", value: "${expression}" },
  { name: "th:content", description: "Set the element content metadata.", value: "${expression}" },
  { name: "th:contenteditable", description: "Set whether the element is editable.", value: "${condition}" },
  { name: "th:controls", description: "Set media controls visibility.", value: "${condition}" },
  { name: "th:coords", description: "Set image-map coordinates.", value: "${expression}" },
  { name: "th:crossorigin", description: "Set the CORS mode.", value: "${expression}" },
  { name: "th:data", description: "Set a data attribute.", value: "${expression}" },
  { name: "th:datetime", description: "Set the date and time value.", value: "${expression}" },
  { name: "th:defer", description: "Set deferred script loading.", value: "${condition}" },
  { name: "th:draggable", description: "Set whether the element is draggable.", value: "${condition}" },
  { name: "th:form", description: "Associate the element with a form.", value: "${expression}" },
  { name: "th:formaction", description: "Set the form submission URL.", value: "@{/path}" },
  { name: "th:formenctype", description: "Set the form submission encoding.", value: "${expression}" },
  { name: "th:formmethod", description: "Set the form submission method.", value: "${expression}" },
  { name: "th:formnovalidate", description: "Disable form validation on submit.", value: "${condition}" },
  { name: "th:formtarget", description: "Set the form submission target.", value: "${expression}" },
  { name: "th:headers", description: "Set related table header ids.", value: "${expression}" },
  { name: "th:height", description: "Set the element height.", value: "${expression}" },
  { name: "th:hidden", description: "Set element visibility.", value: "${condition}" },
  { name: "th:hreflang", description: "Set the linked resource language.", value: "${expression}" },
  { name: "th:label", description: "Set the element label.", value: "${expression}" },
  { name: "th:max", description: "Set the maximum value.", value: "${expression}" },
  { name: "th:maxlength", description: "Set the maximum text length.", value: "${expression}" },
  { name: "th:media", description: "Set the media query.", value: "${expression}" },
  { name: "th:min", description: "Set the minimum value.", value: "${expression}" },
  { name: "th:minlength", description: "Set the minimum text length.", value: "${expression}" },
  { name: "th:multiple", description: "Set whether multiple values are allowed.", value: "${condition}" },
  { name: "th:novalidate", description: "Disable form validation.", value: "${condition}" },
  { name: "th:open", description: "Set whether the details element is open.", value: "${condition}" },
  { name: "th:pattern", description: "Set the input validation pattern.", value: "${expression}" },
  { name: "th:placeholder", description: "Set the input placeholder.", value: "${expression}" },
  { name: "th:poster", description: "Set the media poster image.", value: "@{/path}" },
  { name: "th:preload", description: "Set the media preload behavior.", value: "${expression}" },
  { name: "th:readonly", description: "Set whether the element is read-only.", value: "${condition}" },
  { name: "th:required", description: "Set whether the field is required.", value: "${condition}" },
  { name: "th:rows", description: "Set the number of text rows.", value: "${expression}" },
  { name: "th:rowspan", description: "Set the table row span.", value: "${expression}" },
  { name: "th:scope", description: "Set the table header scope.", value: "${expression}" },
  { name: "th:size", description: "Set the element size.", value: "${expression}" },
  { name: "th:sizes", description: "Set responsive image sizes.", value: "${expression}" },
  { name: "th:span", description: "Set the element span.", value: "${expression}" },
  { name: "th:spellcheck", description: "Set spellchecking behavior.", value: "${condition}" },
  { name: "th:srcset", description: "Set responsive image sources.", value: "${expression}" },
  { name: "th:srclang", description: "Set the text-track language.", value: "${expression}" },
  { name: "th:start", description: "Set the starting list number.", value: "${expression}" },
  { name: "th:step", description: "Set the input step.", value: "${expression}" },
  { name: "th:tabindex", description: "Set the tab order.", value: "${expression}" },
  { name: "th:wrap", description: "Set the text wrapping mode.", value: "${expression}" },
  { name: "th:role", description: "Set the accessibility role.", value: "${expression}" },
  { name: "th:dir", description: "Set the text direction.", value: "${expression}" },
  { name: "th:xml:lang", description: "Set the XML language.", value: "${expression}" },
  { name: "th:inline", description: "Enable inlining for the selected mode.", value: "text" },
  { name: "th:remove", description: "Remove the element or selected attributes.", value: "tag" },
  { name: "th:include", description: "Include a template fragment.", value: "~{template :: fragment}" },
  { name: "th:block", description: "Declare a block container.", value: "" },
  { name: "th:assert", description: "Assert one or more conditions.", value: "${condition}" },
  { name: "th:insert", description: "Insert a template fragment inside the element.", value: "~{template :: fragment}" },
  { name: "th:replace", description: "Replace the element with a template fragment.", value: "~{template :: fragment}" },
  { name: "th:fragment", description: "Declare a reusable template fragment.", value: "name" },
  { name: "th:case", description: "Define a case in a switch block.", value: "${expression}" },
  { name: "th:switch", description: "Select a case based on an expression.", value: "${expression}" },
  { name: "th:errors", description: "Render validation errors for a field.", value: "field" }
];

export interface SecurityAttribute {
  readonly name: string;
  readonly description: string;
  readonly value: string;
}

export const SEC_ATTRIBUTES: readonly SecurityAttribute[] = [
  {
    name: "sec:authorize",
    description:
      "Renders the element only if the Spring Security authorization expression (SpEL) evaluates to true.\n\n" +
      "**Examples**: hasRole('ROLE_ADMIN'), isAuthenticated(), hasAnyRole('ROLE_USER','ROLE_ADMIN')",
    value: "hasRole('ROLE_USER')",
  },
  {
    name: "sec:authorize-expr",
    description:
      "Evaluates the Spring Security SpEL authorization expression and renders the element only when it is true.\n\n" +
      "**Examples**: hasRole('ROLE_ADMIN'), hasAuthority('SCOPE_read')",
    value: "hasRole('ROLE_ADMIN')",
  },
  {
    name: "sec:authorize-url",
    description:
      "Renders the element only if the current user is authorized to access the given URL (uses Spring Security web security rules).\n\n" +
      "**Example**: sec:authorize-url=\"/admin\"",
    value: "/admin",
  },
  {
    name: "sec:authorize-acl",
    description:
      "Renders the element only if the current user has the specified ACL permission on the given domain object.\n\n" +
    "**Format**: domainObject :: permission - e.g. sec:authorize-acl=\"${report} :: 'WRITE'\"",
    value: "${object} :: 'WRITE'",
  },
  {
    name: "sec:authentication",
    description:
      "Outputs a property of the current Spring Security Authentication object.\n\n" +
      "**Common values**: name, principal, principal.username, authorities, credentials, details",
    value: "name",
  },
];

/** SpEL expression snippets offered as value completions inside sec:authorize / sec:authorize-expr. */
export const SEC_AUTHORIZE_SNIPPETS: ReadonlyArray<{ label: string; snippet: string; detail: string }> = [
  { label: "hasRole()",              snippet: "hasRole('${1:ADMIN}')",                         detail: "User has a specific role" },
  { label: "hasAnyRole()",           snippet: "hasAnyRole('${1:USER}', '${2:ADMIN}')",         detail: "User has any of the listed roles" },
  { label: "hasAuthority()",         snippet: "hasAuthority('${1:SCOPE_read}')",              detail: "User has a specific authority/scope" },
  { label: "hasAnyAuthority()",      snippet: "hasAnyAuthority('${1:SCOPE_read}', '${2:SCOPE_write}')", detail: "User has any of the listed authorities" },
  { label: "hasPermission()",        snippet: "hasPermission(${1:object}, '${2:read}')",       detail: "User has a permission on an object" },
  { label: "hasIpAddress()",         snippet: "hasIpAddress('${1:192.168.1.0/24}')",           detail: "Request comes from the given IP address or range" },
  { label: "isAuthenticated()",      snippet: "isAuthenticated()",                              detail: "User is authenticated (not anonymous)" },
  { label: "isAnonymous()",          snippet: "isAnonymous()",                                  detail: "User is anonymous (not logged in)" },
  { label: "isFullyAuthenticated()", snippet: "isFullyAuthenticated()",                         detail: "User is fully authenticated (not remember-me)" },
  { label: "isRememberMe()",         snippet: "isRememberMe()",                                 detail: "User authenticated via remember-me" },
  { label: "permitAll()",            snippet: "permitAll()",                                    detail: "Always true - allows all users" },
  { label: "denyAll()",              snippet: "denyAll()",                                     detail: "Always false - denies all users" },
  { label: "principal.username",     snippet: "principal.username == '${1:admin}'",             detail: "Match by principal username" },
];

export const SEC_AUTHENTICATION_VALUES: ReadonlyArray<{ label: string; detail: string }> = [
  { label: "name", detail: "Name of the authenticated principal" },
  { label: "principal", detail: "The authenticated principal object" },
  { label: "principal.username", detail: "Username of the authenticated principal" },
  { label: "authorities", detail: "Authorities granted to the current user" },
  { label: "credentials", detail: "Credentials of the current authentication" },
  { label: "details", detail: "Additional authentication details" }
];

export const SEC_AUTHORIZE_URL_VALUES: ReadonlyArray<{ label: string; detail: string }> = [
  { label: "/admin", detail: "Check access to the /admin URL" },
  { label: "GET /admin", detail: "Check access to /admin for GET requests" },
  { label: "POST /admin", detail: "Check access to /admin for POST requests" }
];

export const SEC_AUTHORIZE_ACL_VALUES: ReadonlyArray<{ label: string; detail: string }> = [
  { label: "${object} :: 'READ'", detail: "Check READ permission on a domain object" },
  { label: "${object} :: 'WRITE'", detail: "Check WRITE permission on a domain object" }
];