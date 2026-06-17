import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { spawnExternalMCP } from './gestor-mcp/spawner';
import { testTools } from './mcp-custom/tools/test-tools';
import { opcuaTools } from './mcp-custom/tools/opcua-tools';
import { webTools } from './mcp-custom/tools/web-tools';
import { runAgent, extractText, type AgentDeps, type OllamaTool, type ToolExecutor } from './orquestador/agente';

const PORT = Number(process.env.PORT ?? 3000);
// Carpeta a la que el Filesystem MCP tendrá acceso (en TU servidor)
const FS_ROOT = process.env.FS_ROOT ?? 'D:/proyecto psi/mcp-hub';
// Ruta absoluta al config de DBHub (define la conexión al ERP en modo read-only)
const DBHUB_CONFIG = path.resolve(process.cwd(), 'dbhub.toml');

// Guardamos los clientes MCP para poder cerrarlos al apagar
const mcpClients: Client[] = [];

/**
 * Construye el catálogo de herramientas que verá Qwen y el enrutador
 * que sabe cómo ejecutar cada una. Junta:
 *   - Herramientas internas (test + OPC UA + web)
 *   - DuckDuckGo MCP (stdio)
 *   - Filesystem MCP (stdio)
 */
async function buildTooling(): Promise<AgentDeps> {
    const tools: OllamaTool[] = [];
    const registry = new Map<string, ToolExecutor>();

    // ---- 1. Herramientas internas (tus APIs locales) ----
    const internalTools = [...testTools, ...opcuaTools, ...webTools];
    for (const t of internalTools) {
        tools.push({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
        });
        registry.set(t.name, async (args) => extractText(await t.execute(args)));
    }
    console.log(`✅ ${internalTools.length} herramientas internas (test/OPC UA/web).`);

    // ---- 2. MCPs externos por stdio ----
    const externals = [
        // Búsqueda web
        { command: 'npx', args: ['-y', 'duckduckgo-mcp-server'], label: 'DuckDuckGo' },
        // Acceso a archivos del servidor
        { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', FS_ROOT], label: 'Filesystem' },
        // ERP por SQL Server, SOLO LECTURA (config en dbhub.toml)
        { command: 'npx', args: ['-y', '@bytebase/dbhub', '--transport', 'stdio', '--config', DBHUB_CONFIG], label: 'DBHub (ERP SQL Server · read-only)' },
        // Razonamiento paso a paso (estabiliza a Qwen en cadenas largas)
        { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], label: 'Sequential Thinking' },
        // Memoria persistente (grafo de conocimiento)
        { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], label: 'Memory' }

        // --- Opcionales (requieren Python + uv instalados en el servidor) ---
        // { command: 'uvx', args: ['mcp-server-fetch'], label: 'Fetch' },
        // { command: 'uvx', args: ['mcp-server-git', '--repository', FS_ROOT], label: 'Git' },
        // { command: 'uvx', args: ['mcp-server-time'], label: 'Time' }
    ];

    for (const ext of externals) {
        try {
            const client = await spawnExternalMCP(ext.command, ext.args);
            mcpClients.push(client);

            const list = await client.listTools();
            for (const t of list.tools) {
                tools.push({
                    type: 'function',
                    function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema }
                });
                registry.set(t.name, async (args) =>
                    extractText(await client.callTool({
                        name: t.name,
                        arguments: (args ?? {}) as Record<string, unknown>
                    }))
                );
            }
            console.log(`✅ ${list.tools.length} herramientas de ${ext.label}.`);
        } catch (err: any) {
            // Si un MCP externo falla, seguimos con el resto en vez de tumbar el servidor
            console.error(`⚠️  No se pudo cargar ${ext.label}: ${err?.message ?? err}`);
        }
    }

    return { tools, registry };
}

async function main() {
    console.log('🚀 Iniciando MCP Hub (orquestador HTTP)...');
    const deps = await buildTooling();
    console.log(`🧰 Total: ${deps.tools.length} herramientas listas para Qwen.\n`);

    const app = express();
    app.use(express.json());

    // Salud / diagnóstico: lista las herramientas cargadas
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            toolCount: deps.tools.length,
            tools: deps.tools.map((t) => t.function.name)
        });
    });

    // Único endpoint que tu WPF necesita conocer
    app.post('/chat', async (req, res) => {
        const { message, history } = req.body ?? {};
        if (!message || typeof message !== 'string') {
            res.status(400).json({ error: "Falta el campo 'message' (string)." });
            return;
        }
        try {
            console.log(`\n🗣️  Usuario: ${message}`);
            const reply = await runAgent(message, deps, Array.isArray(history) ? history : []);
            console.log(`🤖 Qwen: ${reply}\n`);
            res.json({ reply });
        } catch (err: any) {
            console.error('❌ Error en /chat:', err);
            res.status(500).json({ error: err?.message ?? 'Error interno' });
        }
    });

    const server = app.listen(PORT, () => {
        console.log(`🌐 Orquestador escuchando en http://0.0.0.0:${PORT}`);
        console.log(`   → POST /chat    body: { "message": "..." }`);
        console.log(`   → GET  /health`);
    });

    // Apagado limpio: cerramos los procesos hijo de los MCPs
    const shutdown = async () => {
        console.log('\n🛑 Apagando orquestador...');
        server.close();
        for (const c of mcpClients) {
            try { await c.close(); } catch { /* ignore */ }
        }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((e) => {
    console.error('💥 Fatal:', e);
    process.exit(1);
});
