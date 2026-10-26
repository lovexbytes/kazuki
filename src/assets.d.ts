// The files Bun imports whole: `with { type: "file" }` gives the path
// the file is served from, `with { type: "text" }` its text
declare module "*.md" { const text: string; export default text; }
declare module "*.swift" { const text: string; export default text; }
declare module "*.sh" { const path: string; export default path; }
declare module "*.svg" { const path: string; export default path; }
declare module "*.jpg" { const path: string; export default path; }
declare module "*.png" { const path: string; export default path; }
declare module "*.css" { const path: string; export default path; }
declare module "*/app.js" { const path: string; export default path; }
