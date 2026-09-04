import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";

const SERVER_INFO = { name: "taskwindow", version: "0.1.0" };

/**
 * Stateless Streamable-HTTP MCP endpoint: every POST /mcp request gets a fresh
 * server+transport pair. No session state — any MCP client that speaks
 * Streamable HTTP can hit it.
 */
export function createMcpRequestHandler({ bridge, logger = console }) {
  return async function handleMcpRequest(req, res, parsedBody) {
    const server = new McpServer(SERVER_INFO);
    registerTools(server, { bridge, logger });
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
