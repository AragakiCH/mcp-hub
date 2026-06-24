import type { Message } from 'ollama';
import { ollamaClient } from './ollamaClient';
import aiConfig from '../../config/ai-config.json';

// ===== Tipos =====
export interface OllamaTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: any;
    };
}

// Un ejecutor recibe los argumentos que decidió Qwen y devuelve texto plano
export type ToolExecutor = (args: any) => Promise<string>;

export interface AgentDeps {
    tools: OllamaTool[];                 // catálogo que ve Qwen
    registry: Map<string, ToolExecutor>; // nombre -> cómo ejecutarla
}

// Tope de pasos para evitar bucles infinitos si Qwen se enreda
const MAX_ITERATIONS = 8;

/**
 * System prompt: le explica a Qwen quién es y, sobre todo, que SÍ tiene
 * acceso real a las herramientas (MCPs). Sin esto el modelo responde
 * "no tengo acceso a bases de datos" en vez de usar execute_sql.
 */
const SYSTEM_PROMPT = `Eres el asistente del MCP Hub de la empresa. Tienes acceso REAL a herramientas (tools) y DEBES usarlas para responder; nunca digas que no tienes acceso a archivos, internet o bases de datos: úsalos llamando a la herramienta correspondiente.

Base de datos (tool execute_sql):
- Motor: Microsoft SQL Server. Usa SIEMPRE sintaxis T-SQL (por ejemplo TOP N en vez de LIMIT, INFORMATION_SCHEMA para explorar el esquema).
- Base de datos activa: SistemaclientePSI. La conexión ya está hecha; NO uses placeholders como <database_name>, <your_database> ni <table>: escribe nombres reales.
- Es SOLO LECTURA: solo SELECT. Nunca generes INSERT, UPDATE, DELETE, DROP ni ALTER.
- Tablas disponibles: usuarios, cliente, recursos, propuesta_tecnica, comparacion_prov, anteproyecto, proyecto, servicios, items, Proveedores, tareas_proyectos.
- Para listar tablas usa: SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'.
- Para ver columnas de una tabla usa: SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'nombre_tabla'.

Reglas generales:
- Cuando una consulta SQL no devuelva filas, NO inventes ni divagues: revisa tu consulta y reintenta con una correcta antes de rendirte.
- Después de ejecutar herramientas, responde en español, de forma clara y concreta, usando los datos obtenidos.`;

/**
 * Extrae texto de forma segura de cualquier resultado MCP / interno.
 * Soporta { content: [{type:'text', text}] }, strings y objetos arbitrarios.
 */
export function extractText(result: any): string {
    const content = result?.content;
    if (Array.isArray(content)) {
        const text = content
            .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
            .map((c: any) => c.text)
            .join('\n');
        return text || JSON.stringify(result);
    }
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
}

/**
 * Extrae el primer objeto JSON balanceado de un texto a partir de un índice.
 * Maneja llaves anidadas y comillas escapadas. Devuelve el objeto o null.
 */
function extractJsonObject(text: string, fromIndex = 0): any | null {
    const start = text.indexOf('{', fromIndex);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
            }
        }
    }
    return null;
}

/**
 * Rescata una llamada a herramienta que qwen2.5 "fugó" como texto plano
 * (ej: `_icall_duckduckgo_web_search = {"query": "..."}`) en vez de usar el
 * canal estructurado tool_calls. Busca un nombre de herramienta conocido en el
 * texto y el JSON de argumentos más cercano. Devuelve { name, args } o null.
 */
function parseLeakedToolCall(
    content: string,
    registry: Map<string, ToolExecutor>
): { name: string; args: any } | null {
    if (!content) return null;

    // El nombre de herramienta registrado que aparezca primero en el texto
    let best: { name: string; index: number } | null = null;
    for (const name of registry.keys()) {
        const idx = content.indexOf(name);
        if (idx !== -1 && (best === null || idx < best.index)) {
            best = { name, index: idx };
        }
    }
    if (!best) return null;

    // JSON inmediatamente después del nombre (lo más común)
    let obj = extractJsonObject(content, best.index);
    // Si no hubo, probamos cualquier JSON del texto
    if (!obj) obj = extractJsonObject(content, 0);
    if (!obj || typeof obj !== 'object') return null;

    // Formato { name, arguments } o el JSON ya son los argumentos directos
    if (obj.arguments && typeof obj.arguments === 'object') {
        const name = typeof obj.name === 'string' && registry.has(obj.name) ? obj.name : best.name;
        return { name, args: obj.arguments };
    }
    return { name: best.name, args: obj };
}

/**
 * Bucle de agente multi-paso.
 * Sigue llamando a Qwen mientras pida herramientas, hasta que dé una
 * respuesta final en lenguaje natural (o se agote MAX_ITERATIONS).
 */
export async function runAgent(
    userMessage: string,
    deps: AgentDeps,
    history: Message[] = []
): Promise<string> {
    // Inyectamos el system prompt solo si el historial no trae ya uno
    const hasSystem = history.some((m) => m.role === 'system');
    const messages: Message[] = [
        ...(hasSystem ? [] : [{ role: 'system', content: SYSTEM_PROMPT } as Message]),
        ...history,
        { role: 'user', content: userMessage }
    ];

    // Firmas (nombre+args) de llamadas que ya fallaron, para que Qwen no
    // repita en cadena la misma herramienta con los mismos argumentos.
    const triedAndFailed = new Set<string>();
    const looksLikeError = (t: string) => /^Error\b|anomaly|too quickly|rate.?limit/i.test(t);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await ollamaClient.chat({
            model: aiConfig.Ollama.Model,
            messages,
            tools: deps.tools,
            options: {
                temperature: aiConfig.Ollama.Temperature,
                num_predict: aiConfig.Ollama.MaxTokens
            }
        });

        messages.push(response.message);

        const toolCalls = response.message.tool_calls;

        // Sin tool_calls estructurados => puede ser la respuesta final, O una
        // llamada que qwen2.5 "fugó" como texto. Intentamos rescatarla.
        if (!toolCalls || toolCalls.length === 0) {
            const leaked = parseLeakedToolCall(response.message.content ?? '', deps.registry);
            if (!leaked) {
                return response.message.content ?? '';
            }

            console.log(`🩹 Paso ${i + 1}: Qwen fugó la llamada como texto; rescatando "${leaked.name}".`);
            const executor = deps.registry.get(leaked.name)!;
            let resultText: string;
            try {
                console.log(`   → Ejecutando ${leaked.name}`);
                resultText = await executor(leaked.args);
            } catch (err: any) {
                resultText = `Error ejecutando "${leaked.name}": ${err?.message ?? err}`;
            }

            const toolMessage: Message = { role: 'tool', content: resultText };
            (toolMessage as any).tool_name = leaked.name;
            messages.push(toolMessage);
            continue; // Volvemos a pedirle a Qwen que redacte con el resultado real
        }

        console.log(`🛠️  Paso ${i + 1}: Qwen pidió ${toolCalls.length} herramienta(s).`);

        for (const call of toolCalls) {
            const name = call.function.name;
            const sig = name + ':' + JSON.stringify(call.function.arguments ?? {});
            const executor = deps.registry.get(name);
            let resultText: string;

            if (!executor) {
                resultText = `Error: la herramienta "${name}" no existe en el hub.`;
            } else if (triedAndFailed.has(sig)) {
                // Ya falló antes con estos mismos argumentos: cortamos el ciclo.
                console.log(`   ⏭️  ${name} ya falló con esos argumentos; no se reintenta.`);
                resultText = `Ya intentaste "${name}" con esos mismos argumentos y falló. No la repitas: responde al usuario con la información que ya tengas, o dile claramente que esa herramienta no está disponible en este momento.`;
            } else {
                try {
                    console.log(`   → Ejecutando ${name}`);
                    resultText = await executor(call.function.arguments);
                } catch (err: any) {
                    resultText = `Error ejecutando "${name}": ${err?.message ?? err}`;
                }
                if (looksLikeError(resultText)) triedAndFailed.add(sig);
            }

            // Devolvemos el resultado a Qwen; tool_name ayuda al modelo a no confundirse
            const toolMessage: Message = { role: 'tool', content: resultText };
            (toolMessage as any).tool_name = name;
            messages.push(toolMessage);
        }
    }

    return 'Se alcanzó el número máximo de pasos sin una respuesta final. ' +
        'La tarea puede ser demasiado compleja para qwen2.5:14b en una sola sesión.';
}
