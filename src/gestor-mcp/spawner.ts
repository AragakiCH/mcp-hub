import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const spawnExternalMCP = async (command: string, args: string[], envVars: Record<string, string> = {}) => {
    console.log(`⏳ Iniciando conexión con MCP externo: ${command} ${args.join(' ')}`);
    
    // El transporte stdio ejecuta el comando en la terminal y se comunica por ahí
    const transport = new StdioClientTransport({
        command,
        args,
        env: { ...(process.env as Record<string, string>), ...envVars } // <-- Casteo corregido
    });

    // Creamos el cliente que "hablará" con el servidor externo
    const client = new Client(
        { name: "mcp-hub-client", version: "1.0.0" },
        { capabilities: {} }
    );

    await client.connect(transport);
    console.log(`✅ MCP externo conectado con éxito.`);
    return client;
};