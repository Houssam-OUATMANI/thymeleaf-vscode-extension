export interface HtmlAttribute {
  readonly name: string;
  readonly description: string;
  readonly isBoolean?: boolean;
}

export const GLOBAL_HTML_ATTRIBUTES: readonly HtmlAttribute[] = [
  { name: "class", description: "CSS class list of the element." },
  { name: "id", description: "Unique identifier of the element across the document." },
  { name: "style", description: "Inline CSS styles applied directly to the element." },
  { name: "title", description: "Advisory information, usually displayed as a tooltip." },
  { name: "dir", description: "Text directionality ('ltr', 'rtl', 'auto')." },
  { name: "lang", description: "Language of the element content." },
  { name: "hidden", description: "Specifies that the element is hidden from view.", isBoolean: true },
  { name: "tabindex", description: "Tab order / focus navigation order of the element." },
  { name: "accesskey", description: "Keyboard shortcut key to focus or activate the element." },
  { name: "contenteditable", description: "Specifies whether the element content is editable." },
  { name: "draggable", description: "Specifies whether the element is draggable ('true', 'false')." },
  { name: "spellcheck", description: "Specifies whether spellchecking is enabled ('true', 'false')." },
  { name: "translate", description: "Specifies whether element content should be translated." },
  { name: "role", description: "ARIA role defining the element's accessibility purpose." },
  { name: "slot", description: "Assigns a slot name in a shadow DOM." },
  { name: "part", description: "Exposes shadow DOM element for styling from outside." },
  { name: "autofocus", description: "Automatically focuses the element when page loads.", isBoolean: true },
  { name: "inert", description: "Disables interaction and hides element from accessibility.", isBoolean: true },
  { name: "popover", description: "Designates the element as a popover." },
  { name: "nonce", description: "Cryptographic nonce used by Content Security Policy." },
  // Common ARIA attributes
  { name: "aria-label", description: "Accessible label string for the element." },
  { name: "aria-labelledby", description: "IDs of elements that label this element." },
  { name: "aria-describedby", description: "IDs of elements that describe this element." },
  { name: "aria-hidden", description: "Hides element from accessibility trees.", isBoolean: true },
  { name: "aria-expanded", description: "Indicates whether a collapsible region is expanded." },
  { name: "aria-checked", description: "Current checked state ('true', 'false', 'mixed')." },
  { name: "aria-disabled", description: "Indicates that the element is perceivable but disabled." },
  { name: "aria-selected", description: "Indicates whether the element is selected." },
  { name: "aria-controls", description: "IDs of elements controlled by this element." },
  { name: "aria-live", description: "Live region announcement level ('off', 'polite', 'assertive')." },
  { name: "aria-current", description: "Indicates current item in a set ('page', 'step', etc.)." },
  { name: "aria-haspopup", description: "Indicates availability and type of interactive popup." },
  { name: "aria-invalid", description: "Indicates that the entered value is invalid." },
  { name: "aria-required", description: "Indicates that user input is required.", isBoolean: true }
];

export const COMMON_EVENT_ATTRIBUTES: readonly HtmlAttribute[] = [
  { name: "onclick", description: "Fires on a mouse click." },
  { name: "ondblclick", description: "Fires on a mouse double-click." },
  { name: "onchange", description: "Fires when element value has been committed." },
  { name: "onsubmit", description: "Fires when a form is submitted." },
  { name: "onreset", description: "Fires when a form is reset." },
  { name: "oninput", description: "Fires immediately when the value is modified." },
  { name: "onkeydown", description: "Fires when a key is pressed down." },
  { name: "onkeyup", description: "Fires when a key is released." },
  { name: "onkeypress", description: "Fires when a key is pressed." },
  { name: "onfocus", description: "Fires when the element gains focus." },
  { name: "onblur", description: "Fires when the element loses focus." },
  { name: "onmouseover", description: "Fires when mouse pointer enters the element." },
  { name: "onmouseout", description: "Fires when mouse pointer leaves the element." },
  { name: "onmouseenter", description: "Fires when mouse pointer enters the element." },
  { name: "onmouseleave", description: "Fires when mouse pointer leaves the element." },
  { name: "onscroll", description: "Fires when element scroll position changes." },
  { name: "onload", description: "Fires when the element has finished loading." },
  { name: "onerror", description: "Fires when an error occurs loading the resource." }
];

export const TAG_SPECIFIC_HTML_ATTRIBUTES: Readonly<Record<string, readonly HtmlAttribute[]>> = {
  a: [
    { name: "href", description: "URL destination of the hyperlink." },
    { name: "target", description: "Where to open the linked document ('_blank', '_self', etc.)." },
    { name: "rel", description: "Relationship of linked resource ('noopener', 'noreferrer', etc.)." },
    { name: "download", description: "Instructs browser to download the linked resource." },
    { name: "hreflang", description: "Language of the linked URL." },
    { name: "type", description: "MIME type of the linked resource." },
    { name: "referrerpolicy", description: "Referrer policy when following the link." }
  ],
  form: [
    { name: "action", description: "URL of the server endpoint to process form submission." },
    { name: "method", description: "HTTP method used to submit the form ('get', 'post', 'dialog')." },
    { name: "enctype", description: "MIME type encoding for form submission." },
    { name: "target", description: "Browsing context where to display form response." },
    { name: "novalidate", description: "Disables browser form validation on submit.", isBoolean: true },
    { name: "autocomplete", description: "Browser autofill behavior ('on', 'off')." },
    { name: "name", description: "Name of the form." },
    { name: "accept-charset", description: "Character encodings used for form submission." },
    { name: "rel", description: "Relationship of target resource." }
  ],
  input: [
    { name: "type", description: "Input control type ('text', 'password', 'email', 'number', 'checkbox', 'radio', 'hidden', 'submit', etc.)." },
    { name: "name", description: "Form control name sent with form data." },
    { name: "value", description: "Current value of the input control." },
    { name: "placeholder", description: "Hint text displayed when input is empty." },
    { name: "checked", description: "Specifies that checkbox or radio is selected.", isBoolean: true },
    { name: "disabled", description: "Disables the input control.", isBoolean: true },
    { name: "readonly", description: "Prevents editing by the user.", isBoolean: true },
    { name: "required", description: "Specifies that the field must be filled.", isBoolean: true },
    { name: "pattern", description: "Regular expression pattern that value must match." },
    { name: "min", description: "Minimum value for numeric/date inputs." },
    { name: "max", description: "Maximum value for numeric/date inputs." },
    { name: "step", description: "Step interval for numeric/date inputs." },
    { name: "maxlength", description: "Maximum number of characters allowed." },
    { name: "minlength", description: "Minimum number of characters required." },
    { name: "size", description: "Visual width of the control in characters." },
    { name: "multiple", description: "Allows multiple values (file, email).", isBoolean: true },
    { name: "accept", description: "Allowed file MIME types or extensions for file input." },
    { name: "autocomplete", description: "Browser autofill prediction type." },
    { name: "list", description: "ID of datalist element providing suggestions." },
    { name: "form", description: "ID of the form the input belongs to." },
    { name: "formaction", description: "URL for form submission override." },
    { name: "formenctype", description: "Encoding type override for form submission." },
    { name: "formmethod", description: "HTTP method override for form submission." },
    { name: "formnovalidate", description: "Bypasses validation when clicking this submit control.", isBoolean: true },
    { name: "formtarget", description: "Target context override for form submission." },
    { name: "src", description: "Image source URL for image buttons." },
    { name: "alt", description: "Alternative text for image button." },
    { name: "width", description: "Image button width." },
    { name: "height", description: "Image button height." }
  ],
  button: [
    { name: "type", description: "Button type ('submit', 'button', 'reset')." },
    { name: "name", description: "Name of the button sent with form data." },
    { name: "value", description: "Value of the button sent with form data." },
    { name: "disabled", description: "Disables the button.", isBoolean: true },
    { name: "form", description: "ID of the form the button belongs to." },
    { name: "formaction", description: "URL for form submission override." },
    { name: "formenctype", description: "Encoding type override for form submission." },
    { name: "formmethod", description: "HTTP method override for form submission." },
    { name: "formnovalidate", description: "Bypasses form validation.", isBoolean: true },
    { name: "formtarget", description: "Target browsing context for form submission." }
  ],
  img: [
    { name: "src", description: "Image resource URL." },
    { name: "alt", description: "Alternative text description of the image." },
    { name: "width", description: "Intrinsic width in pixels." },
    { name: "height", description: "Intrinsic height in pixels." },
    { name: "loading", description: "Loading strategy ('lazy', 'eager')." },
    { name: "srcset", description: "Responsive image candidate URLs." },
    { name: "sizes", description: "Responsive source size conditions." },
    { name: "crossorigin", description: "CORS configuration for image fetching." },
    { name: "decoding", description: "Image decoding mode ('async', 'sync', 'auto')." },
    { name: "referrerpolicy", description: "Referrer policy for image request." }
  ],
  textarea: [
    { name: "name", description: "Name of the control sent with form data." },
    { name: "rows", description: "Number of visible text lines." },
    { name: "cols", description: "Visible width in average character widths." },
    { name: "placeholder", description: "Hint text displayed when empty." },
    { name: "disabled", description: "Disables the textarea.", isBoolean: true },
    { name: "readonly", description: "Prevents editing by the user.", isBoolean: true },
    { name: "required", description: "Requires a non-empty value on submit.", isBoolean: true },
    { name: "maxlength", description: "Maximum character length allowed." },
    { name: "minlength", description: "Minimum character length required." },
    { name: "wrap", description: "Text wrapping mode ('soft', 'hard')." },
    { name: "form", description: "ID of the form the textarea belongs to." },
    { name: "autocomplete", description: "Browser autofill prediction type." }
  ],
  select: [
    { name: "name", description: "Name of the control sent with form data." },
    { name: "disabled", description: "Disables the dropdown.", isBoolean: true },
    { name: "multiple", description: "Allows selecting multiple options.", isBoolean: true },
    { name: "required", description: "Requires an option to be selected.", isBoolean: true },
    { name: "size", description: "Number of visible options in list box mode." },
    { name: "form", description: "ID of the form the select belongs to." },
    { name: "autocomplete", description: "Browser autofill prediction type." }
  ],
  option: [
    { name: "value", description: "Value sent to server when selected." },
    { name: "selected", description: "Pre-selects this option.", isBoolean: true },
    { name: "disabled", description: "Disables selection of this option.", isBoolean: true },
    { name: "label", description: "Short label displayed in dropdown." }
  ],
  label: [
    { name: "for", description: "ID of the target form control to bind." },
    { name: "form", description: "ID of the form the label belongs to." }
  ],
  link: [
    { name: "rel", description: "Relationship of linked resource ('stylesheet', 'icon', etc.)." },
    { name: "href", description: "URL of the linked resource." },
    { name: "type", description: "MIME type of resource." },
    { name: "media", description: "Media query for resource." },
    { name: "crossorigin", description: "CORS configuration for resource fetching." },
    { name: "as", description: "Preload content type ('style', 'script', 'font', 'image')." },
    { name: "sizes", description: "Icon size descriptor." },
    { name: "integrity", description: "Subresource Integrity (SRI) cryptographic hash." },
    { name: "hreflang", description: "Language of the linked URL." }
  ],
  script: [
    { name: "src", description: "URL of the external script file." },
    { name: "type", description: "Script type ('text/javascript', 'module', etc.)." },
    { name: "async", description: "Executes script asynchronously.", isBoolean: true },
    { name: "defer", description: "Defers execution until HTML parsing is complete.", isBoolean: true },
    { name: "crossorigin", description: "CORS configuration for script fetching." },
    { name: "integrity", description: "Subresource Integrity hash." },
    { name: "nomodule", description: "Prevents execution in modern ES module browsers.", isBoolean: true }
  ],
  meta: [
    { name: "name", description: "Metadata property name ('viewport', 'description', etc.)." },
    { name: "content", description: "Metadata value." },
    { name: "charset", description: "Character encoding declaration ('UTF-8')." },
    { name: "http-equiv", description: "Simulated HTTP response header." },
    { name: "property", description: "OpenGraph / social media metadata property." }
  ],
  td: [
    { name: "colspan", description: "Number of columns the cell spans." },
    { name: "rowspan", description: "Number of rows the cell spans." },
    { name: "headers", description: "List of related header cell IDs." }
  ],
  th: [
    { name: "colspan", description: "Number of columns the header cell spans." },
    { name: "rowspan", description: "Number of rows the header cell spans." },
    { name: "headers", description: "List of related header cell IDs." },
    { name: "scope", description: "Header scope ('col', 'row', 'colgroup', 'rowgroup')." }
  ],
  table: [
    { name: "border", description: "Table cell border width." }
  ],
  iframe: [
    { name: "src", description: "URL of embedded frame content." },
    { name: "srcdoc", description: "Inline HTML content to embed." },
    { name: "name", description: "Name of the frame for targeting." },
    { name: "width", description: "Width of the iframe in pixels." },
    { name: "height", description: "Height of the iframe in pixels." },
    { name: "sandbox", description: "Security restrictions for the embedded page." },
    { name: "loading", description: "Loading strategy ('lazy', 'eager')." },
    { name: "allow", description: "Permissions policy features allowed." },
    { name: "allowfullscreen", description: "Allows fullscreen display.", isBoolean: true }
  ],
  video: [
    { name: "src", description: "Video resource URL." },
    { name: "controls", description: "Displays browser playback controls.", isBoolean: true },
    { name: "autoplay", description: "Starts playback automatically.", isBoolean: true },
    { name: "loop", description: "Restarts video when playback reaches end.", isBoolean: true },
    { name: "muted", description: "Mutes audio by default.", isBoolean: true },
    { name: "preload", description: "Preloading hint ('none', 'metadata', 'auto')." },
    { name: "poster", description: "Poster preview image URL." },
    { name: "width", description: "Video display width in pixels." },
    { name: "height", description: "Video display height in pixels." },
    { name: "playsinline", description: "Plays video inline on mobile devices.", isBoolean: true }
  ],
  audio: [
    { name: "src", description: "Audio resource URL." },
    { name: "controls", description: "Displays browser playback controls.", isBoolean: true },
    { name: "autoplay", description: "Starts playback automatically.", isBoolean: true },
    { name: "loop", description: "Restarts audio when playback reaches end.", isBoolean: true },
    { name: "muted", description: "Mutes audio by default.", isBoolean: true },
    { name: "preload", description: "Preloading hint ('none', 'metadata', 'auto')." }
  ],
  source: [
    { name: "src", description: "Media resource URL." },
    { name: "srcset", description: "Responsive image source candidates." },
    { name: "type", description: "MIME type of resource." },
    { name: "media", description: "Media query for resource selection." },
    { name: "sizes", description: "Responsive sizes condition." }
  ],
  details: [
    { name: "open", description: "Specifies that details are visible.", isBoolean: true }
  ],
  dialog: [
    { name: "open", description: "Specifies that dialog is open.", isBoolean: true }
  ],
  ol: [
    { name: "start", description: "Starting number of list items." },
    { name: "reversed", description: "Numbers items in reverse order.", isBoolean: true },
    { name: "type", description: "Numbering style ('1', 'a', 'A', 'i', 'I')." }
  ],
  progress: [
    { name: "value", description: "Current numerical completion value." },
    { name: "max", description: "Maximum completion value." }
  ],
  meter: [
    { name: "value", description: "Current value." },
    { name: "min", description: "Minimum numerical value." },
    { name: "max", description: "Maximum numerical value." },
    { name: "low", description: "Lower boundary of low range." },
    { name: "high", description: "Upper boundary of high range." },
    { name: "optimum", description: "Optimum value." }
  ]
};

export function getHtmlAttributesForTag(tagName: string): readonly HtmlAttribute[] {
  const normalizedTag = tagName.toLowerCase();
  const specific = TAG_SPECIFIC_HTML_ATTRIBUTES[normalizedTag] ?? [];
  return [...specific, ...GLOBAL_HTML_ATTRIBUTES, ...COMMON_EVENT_ATTRIBUTES];
}
