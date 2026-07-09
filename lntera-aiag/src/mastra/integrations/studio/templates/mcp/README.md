# Forge starter (MCP server)

A minimal Model Context Protocol server deployed as a Tencent EdgeOne Edge Function — a single HTTP
endpoint (`edge-functions/index.ts`) implementing the MCP JSON-RPC methods (`initialize`,
`tools/list`, `tools/call`) a business assistant needs to discover and call this server's tools. No
build step: EdgeOne runs the TypeScript directly as an edge function.

Replace the example `get_hello_message` tool with one that does something real for the business —
add more the same way (push a new entry onto `TOOLS`).

This starter's architecture (an edge function exposing MCP over HTTP, no server process to run)
follows the same pattern as [TencentEdgeOne/self-hosted-pages-mcp](https://github.com/TencentEdgeOne/self-hosted-pages-mcp);
the code here is an original implementation against the published MCP spec, not copied from that
repo (which carries no license).
