export const testTools = [
    {
        name: "get_user_info",
        description: "Obtiene la información de un usuario desde una base de datos pública.",
        parameters: {
            type: "object",
            properties: {
                userId: {
                    type: "number",
                    description: "El ID del usuario que se desea buscar (ejemplo: 1, 2, 3... hasta 10)"
                }
            },
            required: ["userId"]
        },
        execute: async (args: any) => {
            // Si la IA no manda un ID por alguna razón, usamos el 1 por defecto
            const id = args?.userId || 1; 
            try {
                const response = await fetch(`https://jsonplaceholder.typicode.com/users/${id}`);
                if (!response.ok) throw new Error("No se pudo conectar a la API pública");
                
                const data = await response.json();
                return { 
                    content: [{ 
                        type: "text", 
                        text: `Nombre: ${data.name}\nEmail: ${data.email}\nCiudad: ${data.address.city}\nCompañía: ${data.company.name}` 
                    }] 
                };
            } catch (error: any) {
                return { content: [{ type: "text", text: `Error: ${error.message}` }] };
            }
        }
    }
];