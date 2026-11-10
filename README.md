# clockify-horas

Registra en Clockify una lista de tickets con sus horas a partir de un archivo `.csv` o `.json`.

Requiere Node 22.18 o superior (corre TypeScript directo, sin compilar).

## 1. Conectar tu cuenta (una sola vez)

Hay dos formas. Usa una sola.

**Navegador (sin API key).** Abre un Chrome aparte donde inicias sesión en Clockify como siempre (también con Google). La sesión queda guardada en `~/.config/clockify-horas/navegador` y después el programa llena el formulario del Time Tracker por ti: descripción, tarea, horas, fecha y ADD.

```bash
npm run login-navegador
npm run preferencias -- --proyecto "Automatización de Procesos" --tarea "Client Work" --inicio-jornada 08:00
```

**API key.** Más rápido y no depende de cómo se vea la página. `npm run login` abre la página donde generas la key, la pegas en la terminal y queda guardada en `~/.config/clockify-horas/sesion.json`.

Si hiciste `npm run login`, `registrar` usa la API; si no, usa el navegador. Puedes forzarlo con `--api` o `--navegador`.

## 2. Preparar la lista

Una fila por ticket. Puedes armarla en Excel o Google Sheets y exportarla como CSV (acepta `,` o `;` como separador).

| Columna | Obligatoria | Ejemplos |
| --- | --- | --- |
| `fecha` | sí | `2026-11-10`, `10/11/2026`, `hoy`, `ayer`, `2026-11-10..2026-11-14` |
| `ticket` | sí | `CONEP-101 Alertas regulatorias` |
| `horas` | sí | `2`, `1.5`, `1:30`, `45m` |
| `inicio` | no | `09:00`, `14:30`, `2:30 pm` |
| `proyecto` | no | nombre del proyecto en Clockify (si falta, usa el de por defecto) |
| `descripcion` | no | se agrega al ticket: `CONEP-101 Alertas regulatorias — Filtros` |
| `tarea` | no | nombre de la tarea dentro del proyecto |
| `etiquetas` | no | `frontend\|bug` |
| `facturable` | no | `sí` / `no` |

- Un **rango de fechas** crea la misma entrada en cada día de lunes a viernes del rango.
- Las filas **sin `inicio`** se acomodan solas en orden, desde el inicio de tu jornada en Clockify (o `--inicio-jornada`), saltando el almuerzo (12:00–13:00) y las horas que ya tengas registradas. Si una fila no cabe antes del almuerzo, se parte en dos entradas.
- Las filas **con `inicio`** se registran a esa hora exacta.

Mira [ejemplo.csv](ejemplo.csv). También puedes usar JSON con las mismas columnas:

```json
[{ "fecha": "2026-11-10", "ticket": "CONEP-101 Alertas", "horas": 3 }]
```

## 3. Registrar

```bash
npm run registrar -- horas.csv --prueba   # muestra el horario sin tocar nada
npm run registrar -- horas.csv --ensayo   # (navegador) llena la primera entrada sin guardarla
npm run registrar -- horas.csv            # muestra el horario, pide confirmación y registra
npm run registrar -- horas.csv --ver      # (navegador) igual, viendo la ventana de Chrome
```

En modo navegador, cada entrada se revisa antes de pulsar ADD (descripción, tarea, horas, fecha y duración) y al final se comprueba que todas aparezcan en Clockify. Si algo no cuadra se detiene y deja una captura en `error-clockify.png`. Las columnas `etiquetas` y `facturable` solo funcionan con API key; en el navegador se usa lo que el proyecto tenga por defecto.

Antes de enviar, el comando consulta lo que ya tienes en Clockify esos días. Si una fila ya está registrada (mismo ticket, día y proyecto), la salta, así que correr el mismo archivo dos veces no duplica horas.

Si una fila con `inicio` choca con otra entrada, o no cabe en el día, no se envía nada hasta que la corrijas (o uses `--permitir-solapes`).

Otras opciones: `npm run ayuda`.

## Límite del plan gratuito (solo API key)

En el plan gratuito, Clockify permite 30 llamadas a la API por hora en todo el workspace. Cada corrida usa unas 2–4 llamadas de consulta más una por entrada. Si se llega al límite, el comando se detiene; vuelve a correrlo más tarde y continúa donde quedó.

## Pruebas

```bash
npm install
npm test
npm run typecheck
```
