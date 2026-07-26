/**
 * Page snapshot contract for the browser agent: the readable text of the current
 * page plus a numbered list of its interactive elements. The agent acts by ref —
 * "click [12]", "type into [3]" — and every action returns a fresh snapshot so
 * refs always match the live DOM.
 *
 * Pure (no Playwright import): the in-page script is built here as a string and
 * evaluated by the server session, so formatting and the script builder are
 * unit-testable without a browser. Grounded in the MVP `web-browse/snapshot.ts`.
 */

export const MAX_SNAPSHOT_TEXT_CHARS = 8_000;
export const MAX_SNAPSHOT_ELEMENTS = 80;

/** How many links {@link buildLinksScript} collects before it stops walking. */
export const MAX_PAGE_LINKS = 150;
/** Bounds on one collected link's text, so a chatty page can't blow up a result. */
const MAX_LINK_TITLE_CHARS = 200;
const MAX_LINK_SNIPPET_CHARS = 400;
/** Ancestors folded into a link's group signature (see {@link PageLink.group}). */
const GROUP_SIGNATURE_DEPTH = 3;

/** Attribute name used to bind numbered refs to DOM elements between calls. */
export const REF_ATTR = "data-agent-ref";

export interface SnapshotElement {
  ref: number;
  role: string;
  name: string;
  /** Absolute destination for links (empty for non-links). */
  href: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: SnapshotElement[];
}

/**
 * One outbound link with the text around it — the raw material for reading a
 * list-shaped page (search results, an index, a feed) as data rather than prose.
 * Deliberately generic: no notion of a "search result" exists at this layer.
 */
export interface PageLink {
  /** Absolute http(s) destination. */
  url: string;
  /** The link's own visible text. */
  title: string;
  /** Text of the nearest enclosing block that says more than the link itself. */
  snippet: string;
  /**
   * Signature of the link's position in the DOM — the tag+class chain of its
   * nearest ancestors. Links sharing a signature are the *same kind of thing*
   * repeated: the rows of a list, the items of a feed, the results of a search.
   * A one-off (a promo, a nav item, a footer link) shares its signature with
   * nothing. Callers use it to tell a page's list apart from its chrome without
   * knowing anything about the site.
   */
  group: string;
  /**
   * Whether the link sits inside the page's main content region (`<main>` or
   * `role="main"`) — the standard way a document marks "this is the content, the
   * rest is chrome". The complement of it is menus, banners, and promos.
   */
  inMain: boolean;
}

/**
 * In-page snapshot code as a STRING passed verbatim to `page.evaluate`. Passing
 * a function would be re-serialized via `Function.prototype.toString` after the
 * build rewrites nested helpers with `__name(...)` wrappers that don't exist in
 * the browser — throwing `ReferenceError: __name is not defined`. A string is
 * evaluated as-is, immune to the build transform.
 */
export function buildSnapshotScript(attr: string, limit: number): string {
  return `(() => {
    var attr = ${JSON.stringify(attr)};
    var limit = ${Number(limit)};
    var selector = "a[href], button, input, textarea, select, [role=button], [role=link], [onclick], summary, [contenteditable=true]";
    function isVisible(el) {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      var style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    function accessibleName(el) {
      var aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      var placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();
      var value = el.value;
      if (typeof value === "string" && value.trim()) return value.trim();
      var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) return text;
      var titleAttr = el.getAttribute("title");
      return titleAttr && titleAttr.trim() ? titleAttr.trim() : "";
    }
    function roleOf(el) {
      var explicit = el.getAttribute("role");
      if (explicit && explicit.trim()) return explicit.trim();
      var tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "input") return (el.getAttribute("type") || "text").toLowerCase();
      return tag;
    }
    var prior = document.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < prior.length; i++) prior[i].removeAttribute(attr);
    var out = [];
    var ref = 0;
    var nodes = document.querySelectorAll(selector);
    for (var j = 0; j < nodes.length; j++) {
      if (out.length >= limit) break;
      var el = nodes[j];
      if (!isVisible(el)) continue;
      ref += 1;
      el.setAttribute(attr, String(ref));
      var href = el.tagName === "A" && el.href ? String(el.href).slice(0, 300) : "";
      out.push({ ref: ref, role: roleOf(el), name: accessibleName(el).slice(0, 120), href: href });
    }
    var body = document.body ? document.body.innerText : "";
    return { text: body || "", elements: out };
  })()`;
}

/**
 * In-page link collector, as a STRING for the same reason as
 * {@link buildSnapshotScript}. Walks visible anchors in DOM order and, for each,
 * climbs at most four ancestors looking for the nearest block whose text says
 * meaningfully more than the link's own — a result's description, a headline's
 * standfirst — and records the ancestor tag/class chain as the link's
 * {@link PageLink.group}. Structure only: it knows nothing about any particular
 * site, and the class names never have to mean anything or stay stable between
 * pages — only to repeat *within* one page, which is what makes a list a list.
 */
export function buildLinksScript(limit: number): string {
  return `(() => {
    var limit = ${Number(limit)};
    var maxTitle = ${MAX_LINK_TITLE_CHARS};
    var maxSnippet = ${MAX_LINK_SNIPPET_CHARS};
    var groupDepth = ${GROUP_SIGNATURE_DEPTH};
    function clean(value) {
      return (value || "").replace(/\\s+/g, " ").trim();
    }
    function signature(el) {
      var parts = [];
      var node = el.parentElement;
      for (var d = 0; d < groupDepth && node; d++) {
        var classes = (node.getAttribute("class") || "").split(/\\s+/).filter(Boolean).slice(0, 3);
        parts.push(node.tagName.toLowerCase() + (classes.length ? "." + classes.join(".") : ""));
        node = node.parentElement;
      }
      return parts.join(">");
    }
    function inMainRegion(el) {
      var node = el.parentElement;
      while (node) {
        if (node.tagName.toLowerCase() === "main" || node.getAttribute("role") === "main") return true;
        node = node.parentElement;
      }
      return false;
    }
    var out = [];
    var anchors = document.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length && out.length < limit; i++) {
      var a = anchors[i];
      var href = String(a.href || "");
      if (!/^https?:/i.test(href)) continue;
      var rect = a.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      var title = clean(a.textContent);
      if (!title) continue;
      var snippet = "";
      var node = a;
      for (var d = 0; d < 4; d++) {
        node = node.parentElement;
        if (!node) break;
        // innerText is the rendered text, but it comes back empty on pages that
        // defer layout of their list items (Bing's result blocks do); textContent
        // always has it, so fall through rather than lose every description.
        var text = clean(node.innerText || node.textContent);
        if (text.length >= title.length + 40) {
          // Drop the link text itself so the snippet is the *extra* context.
          snippet = clean(text.split(title).join(" "));
          break;
        }
      }
      out.push({
        url: href,
        title: title.slice(0, maxTitle),
        snippet: snippet.slice(0, maxSnippet),
        group: signature(a),
        inMain: inMainRegion(a),
      });
    }
    return out;
  })()`;
}

/** Render a snapshot as the text the agent reads to decide its next action. */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title || "(untitled)"}`,
    "",
    "PAGE TEXT:",
    snapshot.text || "(no visible text)",
  ];
  if (snapshot.elements.length > 0) {
    lines.push("", "INTERACTIVE ELEMENTS (use the number as ref):");
    for (const el of snapshot.elements) {
      const dest = el.href ? ` -> ${el.href}` : "";
      lines.push(`[${el.ref}] ${el.role}${el.name ? ` "${el.name}"` : ""}${dest}`);
    }
  } else {
    lines.push("", "INTERACTIVE ELEMENTS: (none detected)");
  }
  return lines.join("\n");
}
