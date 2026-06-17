import { Ollama } from 'ollama';
import aiConfig from '../../config/ai-config.json';

const config = aiConfig.Ollama;

// Inicializamos el cliente apuntando a tu servidor 5.78.193.124
export const ollamaClient = new Ollama({ host: config.BaseUrl });

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