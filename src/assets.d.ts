// The files Bun imports whole: `with { type: "text" }` gives their text
declare module "*.md" {
  const text: string
  export default text
}
declare module "*.swift" {
  const text: string
  export default text
}
