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
 * Bucle de agente multi-paso.
 * Sigue llamando a Qwen mientras pida herramientas, hasta que dé una
 * respuesta final en lenguaje natural (o se agote MAX_ITERATIONS).
 */
export async function runAgent(
    userMessage: string,
    deps: AgentDeps,
    history: Message[] = []
): Promise<string> {
    const messages: Message[] = [...history, { role: 'user', content: userMessage }];

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

        // Sin tool_calls => Qwen ya tiene respuesta final
        if (!toolCalls || toolCalls.length === 0) {
            return response.message.content ?? '';
        }

        console.log(`🛠️  Paso ${i + 1}: Qwen pidió ${toolCalls.length} herramienta(s).`);

        for (const call of toolCalls) {
            const name = call.function.name;
            const executor = deps.registry.get(name);
            let resultText: string;

            if (!executor) {
                resultText = `Error: la herramienta "${name}" no existe en el hub.`;
            } else {
                try {
                    console.log(`   → Ejecutando ${name}`);
                    resultText = await executor(call.function.arguments);
                } catch (err: any) {
                    resultText = `Error ejecutando "${name}": ${err?.message ?? err}`;
                }
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
