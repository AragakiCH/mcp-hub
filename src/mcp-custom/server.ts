import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { testTools } from "./tools/test-tools";

export const createCustomMCPServer = () => {
    const server = new Server({
        name: "mi-mcp-interno",
        version: "1.0.0"
    }, {
        capabilities: { tools: {} }
    });

    const allTools = [...testTools];

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: allTools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.parameters
            }))
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = allTools.find(t => t.name === request.params.name);
        if (tool) {
            // Aquí le pasamos los argumentos que la IA decidió usar
            return await tool.execute(request.params.arguments);
        }
        throw new Error("Herramienta no encontrada");
    });

    return server;
};