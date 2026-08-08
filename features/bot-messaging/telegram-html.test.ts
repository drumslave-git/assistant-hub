import { describe, expect, it } from "vitest";

import { renderTelegramHtml } from "./telegram-html";

describe("renderTelegramHtml", () => {
  it("escapes plain text with HTML-significant characters", () => {
    expect(renderTelegramHtml("a < b && b > c")).toBe("a &lt; b &amp;&amp; b &gt; c");
  });

  it("converts bold, italic and strikethrough", () => {
    expect(renderTelegramHtml("**bold** and *it* and ~~gone~~")).toBe(
      "<b>bold</b> and <i>it</i> and <s>gone</s>",
    );
    expect(renderTelegramHtml("__bold__ and _it_")).toBe("<b>bold</b> and <i>it</i>");
  });

  it("leaves snake_case and star arithmetic literal", () => {
    expect(renderTelegramHtml("use known_users.first_seen_at")).toBe(
      "use known_users.first_seen_at",
    );
    expect(renderTelegramHtml("2*3*4 = 24")).toBe("2*3*4 = 24");
  });

  it("renders inline code with its content escaped, not formatted", () => {
    expect(renderTelegramHtml("run `a < b && **x**` now")).toBe(
      "run <code>a &lt; b &amp;&amp; **x**</code> now",
    );
  });

  it("renders fenced code blocks with a language class", () => {
    expect(renderTelegramHtml('```ts\nconst a = "<x>";\n```')).toBe(
      '<pre><code class="language-ts">const a = "&lt;x&gt;";</code></pre>',
    );
    expect(renderTelegramHtml("```\nplain\n```")).toBe("<pre><code>plain</code></pre>");
  });

  it("closes an unterminated fence at the end of the text", () => {
    expect(renderTelegramHtml("```\nno closing")).toBe("<pre><code>no closing</code></pre>");
  });

  it("converts links and keeps non-http schemes literal", () => {
    expect(renderTelegramHtml("see [docs](https://example.com/a?b=1&c=2)")).toBe(
      'see <a href="https://example.com/a?b=1&amp;c=2">docs</a>',
    );
    expect(renderTelegramHtml("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  });

  it("turns headings into bold lines and bullets into dots", () => {
    expect(renderTelegramHtml("# Title\n- one\n* two")).toBe("<b>Title</b>\n• one\n• two");
  });

  it("groups consecutive quote lines into one blockquote", () => {
    expect(renderTelegramHtml("> first\n> second\nafter")).toBe(
      "<blockquote>first\nsecond</blockquote>\nafter",
    );
  });

  it("collapses runs of blank lines and trims", () => {
    expect(renderTelegramHtml("a\n\n\n\nb  ")).toBe("a\n\nb");
  });

  it("returns markup with every produced tag balanced", () => {
    const html = renderTelegramHtml(
      "# H\n**b** *i* `c` ~~s~~ [l](https://e.com)\n```js\nx\n```\n> q",
    );
    for (const tag of ["b", "i", "code", "s", "a", "pre", "blockquote"]) {
      const opens = html.match(new RegExp(`<${tag}[ >]`, "g"))?.length ?? 0;
      const closes = html.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
      expect(opens, tag).toBe(closes);
    }
  });
});

describe("message citations", () => {
  const links = { baseUrl: "https://t.me/c/1234567890", ids: [13488, 15114, 15115] };

  it("turns every cited id into a link to that message", () => {
    // The shape a person actually asked for (2026-08-07): several messages
    // named in one ordinary sentence, each one tappable.
    const html = renderTelegramHtml(
      "First photo was in #13488, the other two under #15114 and #15115.",
      links,
    );
    expect(html).toBe(
      'First photo was in <a href="https://t.me/c/1234567890/13488">#13488</a>, the other two ' +
        'under <a href="https://t.me/c/1234567890/15114">#15114</a> and ' +
        '<a href="https://t.me/c/1234567890/15115">#15115</a>.',
    );
  });

  it("links a numero-sign citation the same way", () => {
    const html = renderTelegramHtml("see \u211613488", links);
    expect(html).toBe('see <a href="https://t.me/c/1234567890/13488">\u211613488</a>');
  });

  it("leaves an id that is not in the whitelist as plain text", () => {
    // An invented or mistyped id must not become a link to nothing.
    expect(renderTelegramHtml("in #99999", links)).toBe("in #99999");
  });

  it("links nothing when the chat has no per-message URL", () => {
    expect(renderTelegramHtml("in #13488", { baseUrl: null, ids: [13488] })).toBe("in #13488");
  });

  it("links nothing when no options are passed at all", () => {
    expect(renderTelegramHtml("in #13488")).toBe("in #13488");
  });

  it("leaves hashtags and URL fragments alone", () => {
    const html = renderTelegramHtml("#weekend at https://e.com/a#13488", {
      ...links,
      ids: [13488],
    });
    expect(html).not.toContain("<a");
  });

  it("does not touch a citation inside code", () => {
    expect(renderTelegramHtml("`#13488`", links)).toBe("<code>#13488</code>");
  });

  it("does not nest an anchor inside a Markdown link", () => {
    // Telegram rejects nested <a>, which would cost the whole send.
    const html = renderTelegramHtml("[see #13488](https://e.com)", links);
    const opens = html.match(/<a[ >]/g)?.length ?? 0;
    expect(opens).toBe(html.match(/<\/a>/g)?.length ?? 0);
    expect(html).not.toMatch(/<a[^>]*>[^<]*<a/);
  });

  it("still emphasizes text around a citation", () => {
    expect(renderTelegramHtml("**bold** #13488", links)).toBe(
      '<b>bold</b> <a href="https://t.me/c/1234567890/13488">#13488</a>',
    );
  });
});
