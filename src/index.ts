import 'dotenv/config'; // Carga las variables del archivo .env
import { Message } from 'ollama';
import { createCustomMCPServer } from './mcp-custom/server';
import { ollamaClient } from './orquestador/ollamaClient';
import { testTools } from './mcp-custom/tools/test-tools';
import { spawnExternalMCP } from './gestor-mcp/spawner';
import aiConfig from '../config/ai-config.json';

async function main() {
    console.log("🚀 Iniciando MCP Hub...");

    // ==========================================
    // 1. Herramientas Internas (Tus APIs/Node)
    // ==========================================
    const customServer = createCustomMCPServer();
    const internalTools = [...testTools].map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));
    console.log("✅ Herramientas internas cargadas.");

    // ==========================================
    // 2. Herramientas Externas (DuckDuckGo Search)
    // ==========================================
    // Usamos el MCP comunitario de DuckDuckGo (100% gratuito, sin API Keys)
    const ddgClient = await spawnExternalMCP("npx", ["-y", "duckduckgo-mcp-server"]);
    const ddgToolsResponse = await ddgClient.listTools();
    const ddgTools = ddgToolsResponse.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
    }));

    // ==========================================
    // 3. Herramientas Externas (Filesystem)
    // ==========================================
    const fsClient = await spawnExternalMCP("npx", [
        "-y", 
        "@modelcontextprotocol/server-filesystem", 
        "D:/proyecto psi/mcp-hub" // Le damos acceso estrictamente a esta carpeta
    ]);
    const fsToolsResponse = await fsClient.listTools();
    const fsTools = fsToolsResponse.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
    }));

    // ==========================================
    // 4. Unificamos el arsenal completo para Qwen
    // ==========================================
    const availableTools = [...internalTools, ...ddgTools, ...fsTools];

    // Prueba de Búsqueda Web: Le pedimos a Qwen que investigue en internet
// Prueba de Filesystem: Le pedimos a Qwen que explore tu disco duro
    const prompt = "Usa la herramienta para listar los archivos del directorio D:/proyecto psi/mcp-hub y dime exactamente qué archivos ves.";    
    console.log(`\n🗣️ Usuario: ${prompt}`);
    
    try {
        const messages: Message[] = [{ role: 'user', content: prompt }];

        // PRIMERA VUELTA
        const response = await ollamaClient.chat({
            model: aiConfig.Ollama.Model,
            messages: messages,
            tools: availableTools,
            options: { temperature: aiConfig.Ollama.Temperature, num_predict: aiConfig.Ollama.MaxTokens }
        });

        messages.push(response.message);

        if (response.message.tool_calls && response.message.tool_calls.length > 0) {
            console.log("\n🛠️ Qwen ejecutando herramientas...");
            
            for (const toolCall of response.message.tool_calls) {
                console.log(`- Usando: ${toolCall.function.name}`);
                let toolResultText = "";
                
                // ENRUTADOR DE HERRAMIENTAS
                if (internalTools.find(t => t.function.name === toolCall.function.name)) {
                    // Es una herramienta interna
                    const internalTool = [...testTools].find(t => t.name === toolCall.function.name);
                    const result = await internalTool!.execute(toolCall.function.arguments);
                    toolResultText = result.content[0].text;
                } 
                else if (fsTools.find(t => t.function.name === toolCall.function.name)) {
                    // Es una herramienta del Filesystem MCP
                    const result = await fsClient.callTool({
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments as Record<string, unknown>
                    });
                    toolResultText = (result as any).content[0].text; 
                } 
                else if (ddgTools.find(t => t.function.name === toolCall.function.name)) {
                    // Es una herramienta del DuckDuckGo MCP
                    const result = await ddgClient.callTool({
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments as Record<string, unknown>
                    });
                    toolResultText = (result as any).content[0].text; 
                }

                messages.push({ role: 'tool', content: toolResultText });
            }

            // SEGUNDA VUELTA
            console.log("🔄 Procesando resultados...\n");
            const finalResponse = await ollamaClient.chat({ model: aiConfig.Ollama.Model, messages: messages });
            console.log(`🤖 Qwen:\n${finalResponse.message.content}`);

        } else {
            console.log(`🤖 Qwen: ${response.message.content}`);
        }

    } catch (error) {
        console.error("❌ Error:", error);
    }
}

main().catch(console.error);