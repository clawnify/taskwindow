import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

/**
 * Stateless Streamable-HTTP MCP endpoint: every POST /mcp request gets a fresh
 * server+transport pair. No session state — any MCP client that speaks
 * Streamable HTTP can hit it.
 */
export function createMcpRequestHandler({ bridge, version, updates = null, logger = console }) {
  return async function handleMcpRequest(req, res, parsedBody) {
    const server = new McpServer({ name: "taskwindow", version });
    registerTools(server, { bridge, version, updates, logger });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  };
}
