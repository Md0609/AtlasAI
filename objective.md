# 🎯 objective.md — Atlas AI

> **Brújula del proyecto.** Este archivo dice *hacia dónde* va Atlas. Las incidencias de GitHub
> son la cola de trabajo; este archivo decide qué entra en ella y en qué orden.
> `README.md` y `docs/adr/` describen lo construido (Fase 1 — *Ground truth*); aquí se dice qué
> falta para que se **entienda**.

Última revisión: 2026-10-21

---

## 1. Hito actual: **UI/UX sencilla de leer e intuitiva**

El motor ya calcula bien (decimal, tests dorados, procedencia, porción desconocida explícita).
Lo que falla es la lectura: hoy, tras entrar, el usuario ve pestañas con tablas de números
crudos y tiene que sacar él solo las conclusiones.

**Prueba del minuto:** alguien que importa su CSV entiende **en menos de 1 minuto**, sin ayuda:

```
 ¿Cuánto tengo?  →  ¿Dónde está concentrado?  →  ¿Cómo le ha ido?  →  ¿Qué no sabemos?
   (valor)            (exposición)                (rendimiento)        (porción desconocida)
```

### 🔍 Diagnóstico (crítica de diseño sobre `apps/web/src/App.tsx`)

| Hallazgo | Gravedad | Dirección |
|---|---|---|
| Al abrir una cartera no hay respuesta, solo pestañas y tablas | 🔴 | Pestaña **Resumen** por defecto con 4 cifras y una frase en lenguaje llano |
| Exposición y rendimiento solo en tablas | 🔴 | Gráficos primero, tabla plegable debajo |
| Términos técnicos sin explicar (TWR, MWR, HHI, N efectivo, *look-through*) | 🟡 | Tooltip/glosario en cada término |
| Todo en un `App.tsx` de ~450 líneas | 🟡 | Separar por funcionalidad antes de rediseñar |
| Pestañas sin `role="tablist"`/`aria-selected`, sin foco visible | 🟡 | Accesibilidad de teclado y lector de pantalla |
| Errores `problem+json` mostrados como texto técnico | 🟡 | Mensaje humano + `trace_id` copiable |
| ✅ La porción desconocida tiene fila propia y hay procedencia | — | **Mantener**: es el valor diferencial; mostrarla mejor, nunca esconderla |

### ✅ Definición de terminado

- [ ] Todos los pasos de la hoja de ruta en ✅.
- [ ] `npm test` y `npm run build` en verde.
- [ ] Cada vista tiene estado vacío, de carga y de error.
- [ ] Ancho de 360 px sin scroll horizontal; contraste AA; todo usable con teclado.
- [ ] Capturas antes/después en `docs/screenshots/` para cada pantalla rediseñada.

---

## 2. 🧭 Hoja de ruta (en orden — una PR por paso)

| ID | Paso | Hecho cuando | Estado |
|---|---|---|---|
| AT-1 | Trocear la web | `apps/web/src/features/{auth,portfolios,summary,positions,exposure,performance,import}/` + `components/`; cero cambio visual; tests de render con Testing Library (dependencia justificada) | ⬜ |
| AT-2 | Sistema visual | Tokens claro/oscuro, `Button`, `Badge`, `EmptyState`, `Spinner`, `Toast`, `ThemeToggle` (ver §4); formateadores únicos de dinero, % y fechas | ⬜ |
| AT-3 | Pestaña **Resumen** | 4 KPI (valor total, rentabilidad del periodo, mayor posición %, % desconocido) + 1–2 frases generadas **de forma determinista** desde la respuesta del motor (sin LLM) | ⬜ |
| AT-4 | Exposición visual | Barras horizontales ordenadas (top 8 + "Otros"); "Desconocido" siempre aparte y con su propio estilo; tabla plegable. "Otros" se suma con aritmética decimal (`@atlas/domain`), nunca con `Number` (ver §6) | ⬜ |
| AT-5 | Rendimiento visual | Con lo que la API ya devuelve (`PerformanceResponse`): TWR, MWR, drawdown máximo y actual y descomposición local vs divisa en gráfico; TWR y MWR explicados en una línea cada uno. **Sin serie temporal** (la API no la ofrece, ver §5) | ⬜ |
| AT-6 | Importar CSV en 3 pasos | Subir → mapear (vista previa de 5 filas, columnas detectadas) → confirmar con errores por fila; volver atrás sin perder el mapeo | ⬜ |
| AT-7 | Estados y errores | Vacío/carga/error en todas las vistas; errores con título humano y `trace_id` copiable | ⬜ |
| AT-8 | Accesibilidad y móvil | Pestañas ARIA, foco visible, navegación con teclado, 360 px, contraste AA | ⬜ |
| AT-9 | Glosario | Tooltip en TWR, MWR, HHI, N efectivo, *look-through*, porción desconocida, procedencia | ⬜ |
| AT-10 | Procedencia legible | "¿De dónde sale este número?" plegable con versión del motor, hash de entrada y metodología | ⬜ |

## 3. ✔️ Checklist de UI/UX (en cada PR que toque la web)

| Dimensión | Pregunta que debe responder "sí" |
|---|---|
| Primera impresión | ¿Lo primero que se ve responde a "¿cuánto tengo y cómo va?"? |
| Usabilidad | ¿El flujo principal (crear cartera → importar → ver resumen) se hace sin instrucciones? |
| Jerarquía | Cifra grande → gráfico → detalle. ¿Se cumple? |
| Consistencia | ¿Solo tokens y componentes de `components/`? ¿Mismo formato de números en todas partes? |
| Accesibilidad | ¿AA, teclado, `aria-*` en pestañas y gráficos con alternativa textual? |
| Honestidad | ¿La porción desconocida sigue visible y no se reparte? |

## 4. ♻️ Código reutilizable de otros repos (copiar, no enlazar)

| De | Qué | Para |
|---|---|---|
| `AuditFroge/src/index.css` | Variables de color claro/oscuro (tokens) | AT-2 (adaptar a CSS plano: aquí no hay Tailwind) |
| `AuditFroge/src/components/ui/{Button,Badge,EmptyState,Spinner,Toast,ThemeToggle}.tsx` | Componentes base (React 19 → comprobar en React 18) | AT-2 / AT-7 — **ojo**: usan clases Tailwind; reescribir las clases a CSS plano |
| `AuditFroge/src/components/report/ReportCharts.tsx` | Patrón de gráficos con `recharts` | AT-4 / AT-5 |
| `AuditFroge/src/contexts/ThemeContext.tsx` | Cambio de tema persistido | AT-2 |

## 5. 🚫 Fuera de alcance ahora

Nuevas métricas del motor (incluida una serie temporal de valor/rentabilidad para un gráfico de
evolución: exige ampliar motor y API, y es decisión del autor), proveedores de datos reales, Fase 2 del blueprint, app móvil,
internacionalización (se mantiene el idioma actual de la interfaz), cualquier LLM en la web.

## 6. 🔒 Reglas que no se negocian

- **El cliente no calcula métricas**: muestra lo que da la API (cadenas decimales). Formatear sí, recalcular no. La única excepción es **agrupar para presentación** (p. ej. sumar los pesos de "Otros"), siempre con aritmética decimal y nunca con `Number`/coma flotante.
- La porción desconocida **nunca** se redistribuye ni se oculta.
- La procedencia sigue accesible desde cada cifra.
- Los tests dorados del motor no se tocan para "hacer pasar" un cambio de UI.

---

## 7. 🤖 Cómo usan este archivo las tareas programadas

| Tarea | Qué hace con este archivo |
|---|---|
| **Repository Portfolio Auditor** (domingos) | Además de bugs, propone **1–2 incidencias del siguiente paso ⬜**, con `claude-candidate` + `objective` y `Objetivo: AT-N` |
| **Autonomous Repository Maintainer** (L/X/V) | Prioriza según el orden de abajo; al completar un paso marca su casilla aquí en la misma PR y adjunta captura |
| **PR Reviewer** | Comprueba las reglas del §6, la checklist del §3 y el "Hecho cuando" del paso |

> Entorno: los tests de integración necesitan PostgreSQL 16 (ver README). Si no está disponible,
> ejecutar al menos los tests que no lo necesitan y **decirlo en el informe**.

**Orden de prioridad:** 🔴 P0 (seguridad, cálculo erróneo, auth) → 🧭 siguiente paso de la hoja
de ruta → 🟡 otros bugs demostrados → ⚪ mejoras sueltas (solo si no hay nada más).
Una mejora que ni sirve a la hoja de ruta ni arregla un bug **no se propone**.
