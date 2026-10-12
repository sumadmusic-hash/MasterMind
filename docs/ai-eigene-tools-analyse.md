# Analyse: Was muss die App ändern, damit die KI eigene Tools schreiben kann?

**Stand:** 12.10.2026 · **Bezugscode:** `src/services/tools.ts` (ToolRegistry), `src/types/index.ts`, `src/services/workflow.ts`, `src/services/chat.ts`

Dieses Dokument fasst eine dreiteilige Konversation zusammen („Was muss die App ändern? → Wie macht man das sicher? → Kann man es mit kleinen Bausteinen machen?“) und überträgt die allgemeinen Architektur-Empfehlungen auf den **konkreten Ist-Zustand dieser App** — einer rein clientseitigen React/Vite-App (TypeScript, Zod, Dexie/IndexedDB, OpenRouter/Groq).

---

## 1. Kernaussage (TL;DR)

> **Die App muss keinen beliebigen, von der KI generierten Code ausführen.**
> Der sichere und in dieser Codebasis realistische Weg ist **Tool-Komposition aus verifizierten Primitiven**: Die KI erzeugt ein deklaratives JSON/YAML-Rezept (DAG bzw. Workflow-Definition), das die bestehende `WorkflowEngine` + `ToolRegistry` mit bestehenden Sandbox-Grenzen (Timeout, Schema-Validierung, SSRF-Schutz, Datenlimits) ausführt. Dynamische Registrierung zur Laufzeit existiert bereits (`toolRegistry.register()`), ihr fehlen nur noch Persistenz, Versionierung und ein Review-Gate.

Empfohlene Priorität: **Variante B (Primitive/Bausteine)** zuerst, Variante A (Code-Generierung in WASM-Sandbox) nur als langfristige Option — im Browser ohne Server ist sie mit vertretbarem Aufwand nicht sicher machbar.

---

## 2. Was die Gesprächsreihe gefordert hat — und was die App schon liefert

Die drei Antworten der KI aus dem Chat forderten u. a.:

| Forderung aus dem Chat | Status in **dieser** App | Evidence im Code |
|---|---|---|
| **Dynamische Tool-Registry zur Laufzeit** | ✅ **Vorhanden.** `ToolRegistry.register(tool, impl)` ist ein Map-basiertes Register, jederzeit aufrufbar — kein statischer Deploy nötig. | `tools.ts` L. 50–57, 197 |
| **Schema-Validator (JSON Schema, keine `any`, unbekannte Params ablehnen)** | ✅ **Vorhanden.** `validateToolArguments()` prüft gegen `inputSchema`: unbekannte Parameter werden explizit abgewiesen (Schutz vor erfundenen LLM-Parametern), Pflicht-Parameter, Typen und Enums geprüft. App nutzt zusätzlich Zod (`package.json`). | `tools.ts` L. 10–47 |
| **Berechtigungssystem (Capabilities)** | ⚠️ **Ansatz vorhanden, aber nicht durchgesetzt.** `ToolDefinition.permissions: string[]` wird pro Tool deklariert (`'network'` oder `[]`), aber nirgends hart erzwungen (kein Gate vor der Ausführung, keine Domain-Allowlist pro Tool). | `types/index.ts` L. 71; Deklarationen ab `tools.ts` L. 255 ff. |
| **Timeouts / Resource-Limits** | ✅ **Vorhanden.** `maxDuration` pro Tool, `Promise.race`-Timeout in `execute()`; `maxDataSize` im Typ definiert; Output-Kompaktierung (`compactToolData`) begrenzt Token-/Datenmenge. ❌ Kein RAM-/CPU-Hartlimit (im Browser ohnehin nur weich möglich). | `tools.ts` L. 153–159, 205–226 |
| **Netzwerk-Sandbox / Egress-Policy** | ⚠️ **Teilweise.** SSRF-Schutz (blockiert interne IPs) bei URL-basierten Tools. ❌ Aber **keine Domain-Allowlist** — jedes Tool mit `network`-Permission kann beliebige externe URLs erreichen. | `tools.ts` L. 1774 ff. |
| **Observability (Logs/Metriken pro Call)** | ✅ **Weitgehend vorhanden.** Jeder `ToolResult` enthält `duration`, `success`, `error`, `timestamp`; Tool-Calls sind im Chat sichtbar und werden persistiert (Dexie). ❌ Kein OpenTelemetry (im Client auch unüblich). | `types/index.ts` L. 94–100 |
| **Versioning / Rollback** | ⚠️ **Nur Feld, keine Funktion.** `version: string` existiert im Typ; Registry hält aber genau **eine** Implementierung pro `id` (`Map.set` überschreibt). Kein Immutable-Versioning, kein Hot-Swap mit Rollback. | `types/index.ts` L. 69; `tools.ts` L. 51–57 |
| **Audit & Human-in-the-Loop (AI schlägt vor → Mensch approved → Deploy)** | ❌ **Fehlt komplett.** README bewirbt „AI Tool Generation“ — diese erzeugt aber nur **Workflow-Strukturen** (Node/Edge-Graphen), kein neues registriertes Tool. Es gibt keinen Draft→Approved→Active-Lebenszyklus. | `workflow.ts`, `WorkflowPage.tsx` |
| **Sandbox für beliebigen Code (WASM/gVisor/Firecracker)** | ❌ **Fehlt — und im reinen Browser-Kontext fehlplatziert.** gVisor/Firecracker brauchen eine Server-Infrastruktur, die diese App nicht hat (alles läuft clientseitig, API-Keys lokal). | Projektlayout (`vite.config.js`, kein Backend) |

**Zwischenfazit:** ~60 % der geforderten Bausteine sind bereits vorhanden (Registry, Validator, Timeouts, Dauerbeobachtung). Die kritischen Lücken sind: **Durchsetzung von Permissions, Egress-Allowlist, Tool-Versionierung, Persistenz dynamischer Tools und ein Freigabe-Workflow.** Genau diese Lücken sind ohne exotische Infrastruktur schließbar.

---

## 3. Warum „KI schreibt eigenen Code“ hier die falsche Abkürzung wäre

Der Chat-Vorschlag „Schema Validator → AST-Lint → WASM-Build (<50 ms Cold Start) → Registry“ setzt eine Build-Pipeline voraus (wasm-pack, Reproducible Builds, cosign-Signaturen). Diese App hat:

- **kein Backend und keine CI** zum Zeitpunkt der Tool-Erzeugung (nutzerseitiger Browser-Tab),
- **keine isolierte Ausführungsumgebung** — `new Function(...)`/`eval` im gleichen JS-Kontext hätte Vollzugriff auf IndexedDB, `localStorage` (API-Keys!) und `fetch`. Das ist exakt das im Chat genannte Restrisiko *Data Exfiltration* — hier sogar mit Secrets im selben Origin.

➡️ **Regel für diese App: Kein von der KI erzeugter Code wird jemals direkt ausgeführt.** Neue „Tools“ sind ausschließlich **Rezepte aus vorhandenen, geprüften Primitiven**.

---

## 4. Zielarchitektur: Tools aus kleinen Bausteinen (Variante B)

### 4.1 Primitive = heutige ToolRegistry-Einträge
Die 14+ eingebauten Tools (`web_search`, `news_search`, `url_fetch`, `data_filter`, `text_summarizer`, …) sind bereits die „Bausteine“. Ergänzend als echte Mini-Primitive ausbauen:

| Primitive | Typ | Capability | Umsetzungsaufwand |
|---|---|---|---|
| `http.get` | Action | network + **Domain-Allowlist pro Tool** | klein (existiert als `url_fetch`) |
| `json.parse` / `json.path` | Transform | — | klein |
| `filter.map.sort` | Transform | — | klein (existiert als `data_filter`) |
| `kv.get/set` | State | storage (namespace-Protection) | klein (Dexie-Tabelle) |
| `crypto.hash` | Crypto | — | klein (WebCrypto) |
| `llm.prompt` | AI | model, Token-Budget | mittel (chat.ts anzapfen) |
| `emit.event` | Output | audit-log only | klein |

### 4.2 KI erzeugt nur ein DAG-Rezept
Genau das vom Chat empfohlene Format — und die App hat dafür fast alles schon: `WorkflowDefinition` (Nodes/Edges, `types/index.ts` L. 113–150) + `workflowEngine.executeWorkflow()` (`workflow.ts` L. 83). Ein Beispiel-Rezept:

```yaml
# KI-Ausgabe: deklarativ, validierbar, versionierbar — kein Code
name: repo_snapshot
steps:
  - id: fetch
    primitive: http.get
    config: { url: "https://api.github.com/repos/{{owner}}/{{repo}}", allowedHost: api.github.com }
  - id: extract
    primitive: json.path
    input: fetch.body
    schema: RepoSchema          # Zod — pflicht, additionalProperties: false
  - id: save
    primitive: kv.set
    input: extract
    config: { key: "repo:{{owner}}/{{repo}}", ttl: 3600 }
permissions: [network:api.github.com, storage:repo_snapshot]
limits: { maxDurationMs: 15000, maxOutputBytes: 32768 }
```

### 4.3 Rezept → echtes Tool: die vier fehlenden Bausteine

1. **`CompiledTool`-Adapter (neu, klein):** Übersetzt ein validiertes Rezept in einen Eintrag, der per bestehendem `toolRegistry.register(compiledDef, args => workflowEngine.execute(rezept, args))` zur Laufzeit angemeldet wird. Nutzt die vorhandene API — keine Umbauten an `execute()`, `getToolDefinitionsForLLM()` oder dem Prompt-Handling in `chat.ts` nötig.
2. **Persistenz (neu):** Tabelle `dynamic_tools` in Dexie (`services/database.ts`): `{ id, version, recipe, status, createdAt, hash }`. Beim App-Start rehydrieren und registrieren. Heute gehen dynamisch registrierte Tools beim Reload verloren.
3. **Immutable Versioning (kleiner Umbau):** Registry von `Map<string, impl>` auf `Map<string, Map<version, impl>>`; `register()` schreibt neue Version, `activate(id, version)` swappt atomar, Rollback = alte Version reaktivieren. Eingebaute Tools bleiben `builtin: true` und sind überschreib-geschützt (Namensraum-Präfix `dyn_` für KI-Tools, um Kollisionen zu vermeiden).
4. **Review-Gate (Statusmaschine):** `draft → validated → pending_approval → active → deprecated`. Validierung = Schema-Check des Rezepts + Policy-Check (nur bekannte Primitive, nur Allowlist-Hosts, Limits ≤ builtin-Maxima). **Aktivierung nur per Klick in `ToolsPage.tsx`** (Human-in-the-Loop aus dem Chat, hier als UI-Button statt GitOps-PR — angemessen für eine Einzelplatz-Client-App). Canary lässt sich abbilden über „Nur in diesem Chat testen“-Modus vor globaler Aktivierung.

### 4.4 Sicherheits-Hardening (aus Antwort 2, auf diese App gemappt)

| Chat-Forderung | Konkret in dieser App |
|---|---|
| Allowlist-Sprache, kein `eval`/`Function`/`require` | **Harte Regel:** Rezept-Interpreter wertet nur JSON aus; String-Felder werden nie kompiliert. ESLint `no-eval`/`no-implied-eval` erzwingen. |
| Deny-by-default Capabilities | `permissions`-Array **durchsetzen**: in `ToolRegistry.execute()` vor `impl()` prüfen; unbekanntes Permission-Flag ⇒ Ausführungsabbruch. Standard: `[]`. |
| Kein direktes Netzwerk, nur Host-Functions mit Egress-Policy | Zentrale `safeFetch(url, allowedHosts)` in `tools.ts` (heutiger SSRF-Check + **Host-Allowlist pro Tool**, gespeichert im Rezept). Alle `network`-Tools umstellen. |
| Secrets Zero-Access | API-Keys liegen in Dexie/localStorage ➡️ Dynamic-Tool-Ausführung bekommt ein **key-less Fetch-Wrapper-Objekt**; nur Host-Funktionen mit Scoping/TTL erhalten Credentials. Nie `window`/Globals ans Rezept übergeben. |
| CPU/RAM/Wall-Time-Limits | Wall-Time via vorhandenes `maxDuration` + `Promise.race`; Datenmenge via `maxDataSize` + `compactToolData`; weicher Schutz: feste Max-Tiefe/Max-Nodes im Interpreter (kein while/Recursion ohne Budget). |
| Unveränderliches Audit-Log | Append-only Dexie-Tabelle `tool_audit`: callId, toolId+version, Input-/Output-Hash (WebCrypto SHA-256), duration, exit-code. |
| Prompt-Injection gegen Generierung | System-Prompt-Templates fixieren; Rezept wird **vor** Registrierung gegen dasselbe Zod-Schema geprüft wie zur Laufzeit; User-Text fließt nur in `{{var}}`-Platzhalter, nie in Strukturfelder. |
| Supply-Chain (cosign/SBOM) | Entfällt weitgehend: keine npm-Dependencies in dynamischen Tools, nur lokale Primitive. Stattdessen: Rezept-Hash im Audit-Log (Integritätsnachweis). |

---

## 5. Konkrete Änderungsliste pro Datei

| Datei | Änderung | Größe |
|---|---|---|
| `src/services/tools.ts` | `register()` um Versions-Map + `activate()/rollback()`; Permission-Gate in `execute()`; `safeFetch` mit Host-Allowlist; Namensraum `dyn_*` | M |
| `src/types/index.ts` | `DynamicToolRecipe` (Zod), `status`, `allowedHosts`, `capabilities` in `ToolDefinition` ergänzen | S |
| `src/services/tool-composer.ts` *(neu)* | Rezept-Parser/-Validator, `compileRecipeToTool()` (registriert via bestehender Registry-API), Interpreter-Grenzen | M |
| `src/services/database.ts` | Tabellen `dynamic_tools`, `tool_audit` (append-only); Rehydrierung beim Start | S |
| `src/services/workflow.ts` | `executeWorkflow()` als Ausführungs-Backend für Rezepte nutzbar machen (Input-Binding, Step-Traces) | S |
| `src/pages/ToolsPage.tsx` | „Neues Tool vorschlagen“ (KI-Formular) → Validierungsbericht → **Approve-Button** (Draft/Pending/Active), Versionshistorie + Rollback | M |
| `src/services/chat.ts` | System-Prompt: Abschnitt „Du darfst Tool-Rezepte (JSON) erzeugen, niemals Code“; Tool-Liste zeigt `dyn_*` automatisch (Registry liefert sie schon) | S |
| Tests (`src/tests/tools.test.ts` erweitern) | Unbekannte Primitive ⇒ Reject; Nicht-Allowlist-Host ⇒ Reject; Permission-Gate; Rollback; Rezept-Hash | M |

---

## 6. Risiken & offene Punkte

- **Expressivitätsgrenze:** Schleifen/Rekursion bewusst nur als budgetierte Primitive (`retry(max=3)`, `map_over(items≤N)`) — sonst wieder turing-voll und unsicher (genannter Gap aus dem Chat).
- **Logic Bugs:** KI kann gültige, aber inhaltlich falsche Rezepte bauen → Gegenmittel: Pflicht-Ausgabe eines Testlaufs (`WorkflowTestResult` existiert schon, `types/index.ts` L. 151) **vor** dem Approval-Screen.
- **Determinismus:** `llm.prompt`-Primitive im Rezept bricht Reproduzierbarkeit → Kennzeichnung solcher Tools als „non-deterministic“ im UI.
- **Debugging:** Step-Traces pro Node (bereits in `workflow.ts` angelegt) im Tools-UI anzeigen.
- **Browser-Grenzen:** Keine Prozess-Isolation äquivalent zu gVisor — Restrisiko verbleibt; deshalb erst recht kein beliebiger Code. Falls später ein Backend existiert, ist die WASM-Variante (Antwort 1/2) dort nachrüstbar; die Rezept-Schicht bleibt dann als Frontend unverändert.

---

## 7. Quellen
- [S1] Anthropic „Tool Use“ Architecture Docs
- [S2] WASM Sandbox Patterns (Wasmer, Wasmtime, Spin); Bytecode Alliance „Capability-based Security“
- [S3] OpenTelemetry Instrumentation für Dynamic Plugins; NIST SP 800-204 (Microservice Security)
- [S4] Temporal.io / Dagster – Declarative Dataflow Patterns; LangChain Expression Language (LCEL)
- Lokaler Code: `src/services/tools.ts`, `src/services/workflow.ts`, `src/types/index.ts`, `README.md`
