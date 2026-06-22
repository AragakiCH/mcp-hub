import { Ollama } from 'ollama';
import { Agent, fetch as undiciFetch } from 'undici';
import aiConfig from '../../config/ai-config.json';

const config = aiConfig.Ollama;

// Un modelo 14b remoto, con 28 tools en contexto, puede tardar varios minutos
// en devolver las primeras cabeceras (carga del modelo + primer token).
// Desactivamos los timeouts de cabeceras/cuerpo para que /chat no se corte.
const longTimeoutAgent = new Agent({
    connectTimeout: 30_000, // 30s para abrir el socket (si no, el host no responde)
    headersTimeout: 0,      // 0 = sin límite para recibir cabeceras
    bodyTimeout: 0          // 0 = sin límite para recibir el cuerpo
});

const longTimeoutFetch = ((input: any, init: any = {}) =>
    undiciFetch(input, { ...init, dispatcher: longTimeoutAgent })) as unknown as typeof fetch;

// Inicializamos el cliente apuntando a tu servidor 5.78.193.124
export const ollamaClient = new Ollama({
    host: config.BaseUrl,
    fetch: longTimeoutFetch
});

export const askQwen = async (prompt: string, tools: any[]) => {
    try {
        const response = await ollamaClient.chat({
            model: config.Model,
            messages: [{ role: 'user', content: prompt }],
            tools: tools, // Le pasamos las herramientas de los MCPs
            options: {
                temperature: config.Temperature,
                num_predict: config.MaxTokens
            }
        });

        return response.message;
    } catch (error) {
        console.error("Error comunicándose con Qwen:", error);
        throw error;
    }
};
