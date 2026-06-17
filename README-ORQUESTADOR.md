# MCP Hub — Orquestador

Servicio HTTP que corre junto a Qwen. Lanza los MCPs por **stdio**, ejecuta el
bucle de agente y expone un solo endpoint `POST /chat`. Tu WPF solo hace un POST.

```
[WPF / C#] --HTTP--> [server.ts + Qwen + MCPs]
   POST /chat              |-- stdio --> DuckDuckGo MCP
                           |-- stdio --> Filesystem MCP
                           |-- interno -> test / OPC UA / web
```

## 1. Instalar (una sola vez)

Falta `@types/express`. Desde la carpeta del proyecto:

```bash
npm install
```

## 2. Configurar

Edita `.env`:

- `PORT` — puerto del orquestador (default 3000).
- `FS_ROOT` — carpeta a la que el Filesystem MCP tendrá acceso **en el servidor**.

El modelo y la URL de Qwen siguen en `config/ai-config.json`
(`http://5.78.193.124:11434`, `qwen2.5:14b`).

## 3. Arrancar

```bash
npm start
```

Deberías ver las herramientas cargarse y:
`🌐 Orquestador escuchando en http://0.0.0.0:3000`

> El demo viejo de un solo tiro sigue disponible con `npm run demo`.

## 4. Probar

**Ver qué herramientas cargó:**
```bash
curl http://localhost:3000/health
```

**Mandar un mensaje (curl / Linux / Git Bash):**
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Lista los archivos del directorio y dime qué ves\"}"
```

**PowerShell (Windows):**
```powershell
Invoke-RestMethod -Uri http://localhost:3000/chat -Method Post `
  -ContentType "application/json" `
  -Body '{"message": "Busca en internet qué es OPC UA y resúmelo"}'
```

Respuesta: `{ "reply": "..." }`

## 5. Llamarlo desde tu WPF (C#)

```csharp
using System.Net.Http;
using System.Net.Http.Json;

public class HubClient
{
    private static readonly HttpClient http = new HttpClient
    {
        // Si el servidor es remoto, pon su IP en vez de localhost
        BaseAddress = new Uri("http://localhost:3000/"),
        Timeout = TimeSpan.FromMinutes(3) // Qwen + tools puede tardar
    };

    public async Task<string> ChatAsync(string mensaje)
    {
        var resp = await http.PostAsJsonAsync("chat", new { message = mensaje });
        resp.EnsureSuccessStatusCode();
        var data = await resp.Content.ReadFromJsonAsync<ChatResponse>();
        return data?.reply ?? "(sin respuesta)";
    }

    private record ChatResponse(string reply);
}
```

Uso:
```csharp
var hub = new HubClient();
string respuesta = await hub.ChatAsync("Lee el README y dime de qué trata");
```

## Herramientas incluidas

Al arrancar, el hub carga:

- **Internas:** `get_user_info`, `discover_opcua_endpoints` (OPC UA), `check_login_container` (web).
- **DuckDuckGo:** búsqueda web.
- **Filesystem:** leer/escribir/listar archivos de `FS_ROOT`.
- **DBHub (ERP):** `execute_sql` contra SQL Server **en solo lectura** (ver abajo).
- **Sequential Thinking:** razonamiento multi-paso para Qwen.
- **Memory:** memoria persistente (grafo de conocimiento).

Opcionales (descomentar en `server.ts`, requieren Python + `uv` en el servidor):
**Fetch**, **Git**, **Time**.

## ⚠️ Seguridad del ERP (importante)

DBHub está configurado en `dbhub.toml` con `readonly = true`, así que Qwen
**no puede** hacer INSERT/UPDATE/DELETE — solo consultas SELECT.

Pero tu DSN usa la cuenta **`sa`** (administrador total). El `readonly` de DBHub
es la única barrera. Lo correcto para producción es crear un **login de solo
lectura** en SQL Server y usar ese en `PSI_DSN`:

```sql
CREATE LOGIN psi_readonly WITH PASSWORD = 'una_clave_fuerte';
USE SistemaclientePSI;
CREATE USER psi_readonly FOR LOGIN psi_readonly;
ALTER ROLE db_datareader ADD MEMBER psi_readonly;  -- solo lectura, toda la BD
```

Luego en `.env`: `PSI_DSN=sqlserver://psi_readonly:una_clave_fuerte@161.132.235.184:51433/SistemaclientePSI?sslmode=require`

Así, aunque algo fallara, la cuenta físicamente no puede modificar datos.
La credencial vive solo en `.env` (no la subas a git).

## Notas

- **`history`** opcional: el body acepta `{ "message": "...", "history": [...] }`
  con mensajes previos en formato Ollama si quieres conversación con memoria.
- **Multi-paso:** el agente encadena hasta 8 herramientas por mensaje
  (`MAX_ITERATIONS` en `agente.ts`).
- **Caveat Qwen:** `qwen2.5:14b` elige bien herramientas en tareas simples; en
  cadenas largas puede fallar. Si necesitas fiabilidad alta, el siguiente paso es
  hacer fallback a Claude API dentro de `runAgent`.
