// The files Bun imports whole: `with { type: "text" }` gives their text
declare module "*.md" {
  const text: string
  // biome-ignore lint/style/noDefaultExport: a text import has one default export
  export default text
}
declare module "*.swift" {
  const text: string
  // biome-ignore lint/style/noDefaultExport: a text import has one default export
  export default text
}
