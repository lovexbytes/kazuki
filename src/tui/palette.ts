// Palette
// =======
// The terminal's colors, dark or light as the terminal says it is
// (OpenTUI asks it), and the syntax style its markdown, code and diffs
// are drawn in. The look follows theme.ts's: what the machine wrote
// (tool calls, results) sits on the raised fill, muted; what a person
// says is framed by an accent bar; Kazuki's answer is bare; thinking
// is faint and italic.

import { RGBA, SyntaxStyle, type ThemeTokenStyle } from "@opentui/core";

// Types
// =====

export type Palette = {
  bg      : RGBA; // the page
  raised  : RGBA; // a tool's, a user message's fill
  sunk    : RGBA; // a fill inside a raised one (a result, the input)
  border  : RGBA;
  text    : RGBA;
  muted   : RGBA;
  faint   : RGBA;
  accent  : RGBA; // the user's bar, the prompt, a link
  agent   : RGBA; // an agent's report, its tab
  ok      : RGBA;
  warn    : RGBA;
  error   : RGBA;
  added   : RGBA; // a diff's lines added, dropped: their fill
  removed : RGBA;
  addedFg : RGBA;
  removedFg: RGBA;
  syntax  : Record<string, RGBA>;
};

// Constants
// =========

const hex = (x: string) => RGBA.fromHex(x);

export const DARK: Palette = {
  bg       : hex("#0f1115"),
  raised   : hex("#171a21"),
  sunk     : hex("#1d212a"),
  border   : hex("#2a2f3a"),
  text     : hex("#e6e8ee"),
  muted    : hex("#9aa1b1"),
  faint    : hex("#646b7a"),
  accent   : hex("#7aa2f7"),
  agent    : hex("#bb9af7"),
  ok       : hex("#9ece6a"),
  warn     : hex("#e0af68"),
  error    : hex("#f7768e"),
  added    : hex("#1d2b22"),
  removed  : hex("#2e1d22"),
  addedFg  : hex("#9ece6a"),
  removedFg: hex("#f7768e"),
  syntax   : {
    keyword : hex("#bb9af7"),
    string  : hex("#9ece6a"),
    number  : hex("#ff9e64"),
    func    : hex("#7aa2f7"),
    type    : hex("#2ac3de"),
    comment : hex("#5c6370"),
    op      : hex("#89ddff"),
    variable: hex("#c0caf5"),
    punct   : hex("#9aa5ce"),
  },
};

export const LIGHT: Palette = {
  bg       : hex("#fbfbfc"),
  raised   : hex("#f0f1f4"),
  sunk     : hex("#e6e8ec"),
  border   : hex("#d5d8de"),
  text     : hex("#1f2329"),
  muted    : hex("#5d6470"),
  faint    : hex("#8b919c"),
  accent   : hex("#2f62d8"),
  agent    : hex("#7a46c4"),
  ok       : hex("#3d7f2a"),
  warn     : hex("#9a6400"),
  error    : hex("#c4314b"),
  added    : hex("#e3f3e0"),
  removed  : hex("#f9e1e4"),
  addedFg  : hex("#2d6a1f"),
  removedFg: hex("#b02a42"),
  syntax   : {
    keyword : hex("#8239c4"),
    string  : hex("#3d7f2a"),
    number  : hex("#b35a00"),
    func    : hex("#2f62d8"),
    type    : hex("#0b7e8f"),
    comment : hex("#8b919c"),
    op      : hex("#20699c"),
    variable: hex("#1f2329"),
    punct   : hex("#5d6470"),
  },
};

// Syntax
// ======

// the style of markdown and code in a palette; owner: the renderer's
// scene, which frees it
export function syntax_of(p: Palette, owner: any): SyntaxStyle {
  const s = p.syntax;
  const rules: ThemeTokenStyle[] = [
    rule(["default"], p.text),
    rule(["comment", "comment.documentation"], s.comment, { italic: true }),
    rule(["string", "symbol", "character", "character.special"], s.string),
    rule(["number", "boolean", "constant", "float"], s.number),
    rule(["keyword", "keyword.return", "keyword.conditional", "keyword.repeat", "keyword.import", "keyword.export", "keyword.modifier", "keyword.exception", "keyword.directive"], s.keyword),
    rule(["keyword.function", "function", "function.method", "function.call", "function.method.call", "constructor"], s.func),
    rule(["type", "type.definition", "module", "class", "namespace", "keyword.type"], s.type),
    rule(["operator", "keyword.operator", "punctuation.special", "tag.delimiter"], s.op),
    rule(["variable", "variable.parameter", "property", "parameter", "field", "variable.member"], s.variable),
    rule(["punctuation", "punctuation.bracket", "punctuation.delimiter"], s.punct),
    rule(["variable.builtin", "type.builtin", "function.builtin", "constant.builtin"], p.error),
    rule(["tag", "attribute"], p.warn),
    rule(["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"], p.accent, { bold: true }),
    rule(["markup.heading.1"], p.accent, { bold: true, underline: true }),
    rule(["markup.bold", "markup.strong"], p.text, { bold: true }),
    rule(["markup.italic"], p.text, { italic: true }),
    rule(["markup.list"], p.accent),
    rule(["markup.quote"], p.muted, { italic: true }),
    rule(["markup.raw", "markup.raw.block"], s.string),
    rule(["markup.raw.inline"], s.number, { background: p.raised }),
    rule(["markup.link", "markup.link.url", "string.special", "string.special.url"], p.accent, { underline: true }),
    rule(["markup.link.label", "label"], p.accent),
    rule(["markup.strikethrough", "markup.list.unchecked"], p.faint),
    rule(["markup.list.checked"], p.ok),
    rule(["diff.plus"], p.addedFg, { background: p.added }),
    rule(["diff.minus"], p.removedFg, { background: p.removed }),
  ];
  return SyntaxStyle.fromTheme(rules, owner);
}

function rule(scope: string[], foreground: RGBA, style: Omit<ThemeTokenStyle["style"], "foreground"> = {}): ThemeTokenStyle {
  return { scope, style: { foreground, ...style } };
}

// a file's type by its name, for its syntax ("": none known)
export function filetype(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", md: "markdown", py: "python", rs: "rust", go: "go", zig: "zig", c: "c", h: "c",
    cpp: "cpp", cc: "cpp", hpp: "cpp", java: "java", rb: "ruby", sh: "bash", bash: "bash", zsh: "bash",
    css: "css", html: "html", yml: "yaml", yaml: "yaml", toml: "toml", swift: "swift", sql: "sql",
  };
  return types[ext] ?? "";
}
