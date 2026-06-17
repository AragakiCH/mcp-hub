export const opcuaTools = [
    {
        name: "discover_opcua_endpoints",
        description: "Llama a la API local para descubrir los endpoints de OPC UA disponibles en la red industrial.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            try {
                const response = await fetch("http://127.0.0.1:58109/api-websocket-rx/api/opcua/discover");
                if (!response.ok) throw new Error("Error en la ruta de la API al intentar el descubrimiento.");
                
                const data = await response.text();
                return { content: [{ type: "text", text: `Nodos y endpoints descubiertos: ${data}` }] };
            } catch (error: any) {
                return { content: [{ type: "text", text: `Error de conexión OPC UA: ${error.message}` }] };
            }
        }
    }
];