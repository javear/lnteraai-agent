# Forge starter (webapp)

A minimal Next.js (Pages Router, static export) + Tailwind starting point for Forge's "webapp" projects. Trimmed and adapted from [TencentEdgeOne/enterprise-website-template](https://github.com/TencentEdgeOne/enterprise-website-template) (MIT) — Contentful CMS, the blog/careers/case-studies pages, and the stock imagery were removed to keep the starting point small; `@next/swc-wasm-nodejs` + `experimental.useWasmBinary` were added so it builds inside a WebAssembly sandbox that can't run Next's native compiler.
