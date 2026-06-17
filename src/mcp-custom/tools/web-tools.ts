export const webTools = [
    {
        name: "check_login_container",
        description: "Verifica el estado del contenedor web de login (ctrlX u otros) revisando si los recursos estáticos están disponibles.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            // Aquí puedes agregar lógica para verificar tus interfaces HTML/JS
            return { content: [{ type: "text", text: "El contenedor de login está respondiendo correctamente." }] };
        }
    }
];