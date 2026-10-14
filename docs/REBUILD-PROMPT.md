# Prompt: AI Research Assistant – Neubau (Greenfield)

> Dieser Prompt ist so geschrieben, dass eine KI, die das alte Projekt **nicht kennt**,
> das System komplett neu aufbauen kann – sauber modularisiert, keine Datei über 1.000 Zeilen.

---

## DER PROMPT (kopieren ab hier)

---

Du bist ein erfahrener Frontend-Architekt und Senior-Entwickler. Baue eine produktionsreife,
**komplett clientseitige Web-App** namens **„AI Research Assistant"** neu (Greenfield, kein Legacy-Code).
Die App ist ein KI-gestützter Forschungsassistent mit Chat, Tool-Orchestrierung (Agent-Loop),
visuellem Workflow-Builder, Scheduler und lokaler Persistenz. Es gibt **keinen eigenen Server** –
API-Keys liegen nur im Browser, alle Daten in IndexedDB.

### 0. Harte Architektur-Regeln (verhandelbar: nein)

1. **Keine Datei darf länger als 1.000 Zeilen sein.** Zielgröße: 200–500 Zeilen.
   Dies ist die Kernanforderung: Das Vorgängerprojekt war unwartbar, weil drei Dateien
   explodiert sind (Tool-Registry ~4.000, Provider ~1.400, Chat-Agent ~1.400 Zeilen).
   Baue von Anfang an so, dass das strukturell unmöglich ist (s. Aufteilung unten).
2. **Harte Grenze pro Datei:** Wenn du merkst, dass eine Datei Richtung 800 Zeilen wächst,
   musst du sie vorher teilen und die Grenze begründen können.
3. Eine Funktion/Klasse hat eine einzige Verantwortung. Querschnittslogik (Parsing,
   Formatting, Validierung) landet in reinen, testbaren Helper-Modulen ohne DOM-/Netzwerk-Zugriff.
4. Keine zirkulären Imports. Dienste kennen keine UI; UI kennt keine Provider-Details.
5. Alles öffentlich Nachnutzbare ist typisiert (TypeScript strict) und Unit-testbar (Vitest).
6. Füge eine CI-Prüfung hinzu (Skript `check:file-size` oder Vitest-Test), die den Build
   failing macht, wenn irgendeine Quelldatei > 1.000 Zeilen hat. Nur so bleibt die Regel haltbar.

### 1. Tech-Stack (fix)

- Vite + React 18 + TypeScript (strict)
- Tailwind CSS 4
- Zustand für globalen State (kein Prop-Drilling durch Context-Klassen)
- Dexie (IndexedDB) für Persistenz
- Zod für Schema-Validierung
- @xyflow/react (React Flow) + @dnd-kit für den Workflow-Builder
- Recharts für Charts, lucide-react für Icons, date-fns, uuid, framer-motion, canvas-confetti
- Vitest + @testing-library/react für Tests

### 2. Verzeichnungsstruktur (Pflicht-Vorgabe)

```
src/
├── types/                     # reine Typen & Zod-Schemas, nach Domäne getrennt
│   ├── tool.ts                # ToolDefinition, ToolCategory, ToolCall, ToolResult
│   ├── chat.ts                # ChatSession, ChatMessage, TurnState
│   ├── workflow.ts            # WorkflowDefinition, Node, Edge
│   ├── provider.ts            # ProviderConfig, ProviderMessage, ModelSlot
│   └── index.ts               # Re-Exports
├── services/
│   ├── db/                    # Dexie: pro Tabelle/domain eine Datei
│   │   ├── schema.ts          # AppDatabase-Klasse + Versionen
│   │   ├── chats.ts           # CRUD chatSessions
│   │   ├── settings.ts        # CRUD settings
│   │   ├── workflows.ts       # CRUD workflows
│   │   ├── logs.ts            # logs + tokenUsage
│   │   ├── memories.ts        # user-memory-Tabelle
│   │   ├── portfolio.ts       # positions + timeseriesCache
│   │   └── scheduler.ts       # scheduledJobs + scheduledRuns
│   ├── providers/             # Adapter-Pattern, EIN Adapter pro Provider
│   │   ├── types.ts           # ProviderAdapter-Interface
│   │   ├── openai-compatible.ts # gemeinsame Basis (SSE-Streaming, Fehler-Mapping)
│   │   ├── groq.ts
│   │   ├── openrouter.ts
│   │   ├── gemini.ts          # eigenes Message-Format + Modell-Rename-Map
│   │   ├── lmstudio.ts        # localhost, optionale API-Key-Prüfung
│   │   ├── registry.ts        # Provider -> Adapter, Endpoint-/Key-Auflösung
│   │   ├── modelCatalog.ts    # Modelle je Provider, veraltete IDs -> Nachfolger
│   │   ├── refusal.ts         # detectRefusal (EN+DE), EmptyResponseError etc.
│   │   └── errors.ts          # AuthProviderError, RateLimitError, … + isAuthError
│   ├── agent/                 # der Chat-Orchestrator, in kleine Schritte zerlegt
│   │   ├── orchestrator.ts    # sendMessage / resumeTurn / abort (nur Koordination!)
│   │   ├── agentLoop.ts       # die Loop: Modell->ToolCalls->Ausführung->zurück
│   │   ├── promptBuilder.ts   # System-Prompt, ProviderMessages bauen
│   │   ├── contextManager.ts  # History-Truncation auf Tokenbudget, Tool-Results droppen
│   │   ├── toolDispatcher.ts  # Ausführung, Timeout, Permissions, Dedup-Cache
│   │   ├── resultCompactor.ts # compactToolData (Strings/Arrays kappen, URLs erhalten)
│   │   ├── fallback.ts        # Modell-Failover inkl. Übernahme des Arbeitszustands
│   │   ├── interruption.ts    # persistInterruptedTurn / seedInterruptedProgress
│   │   └── streaming.ts       # Streaming-Callbacks an die UI
│   ├── tools/                 # NICHT alles in eine Datei! Siehe Abschnitt 3.
│   ├── tpm/                   # Token-per-Minute-Budgetmanager (reservieren/freigeben)
│   ├── workflow/              # WorkflowEngine: Validierung (DAG, Zyklen), Execution
│   ├── scheduler/             # Cron-artige Spec parsen/beschreiben, Tick-Loop
│   └── shared/                # reine Helpers: csv.ts, jsonpath.ts, stats.ts,
│                              # formatNumber.ts (deutsch Mio./Mrd.), dates.ts, fetch.ts
├── store/
│   ├── useAppStore.ts         # Settings, Session-State
│   └── useChatStore.ts        # laufender Turn, Streaming-Text, Tool-Anzeigen
├── components/                # kleine UI-Bausteine (< 300 Zeilen each)
│   ├── chat/                  # MessageList, MessageBubble, ToolCallCard, SourceList, …
│   ├── charts/                # ChartRenderer + chart_spec-Auswertung
│   ├── workflow/              # Editor, Nodes, Palette, AI-Generierungs-Dialog
│   └── layout/                # Nav, Shell
├── pages/                     # nur Seiten-Komposition, Logik in Hooks/Dienste
│   ├── ChatPage.tsx           # dünn! < 250 Zeilen, Hooks aus components/chat/hooks
│   ├── ResearchPage.tsx
│   ├── ToolsPage.tsx
│   ├── WorkflowPage.tsx
│   └── SettingsPage.tsx
└── tests/                     # unit + integration, benannt nach Modul
```

### 3. Tool-System (das Herzstück – hier ist das Alte explodiert)

Ein **Tool = ein Ordner/ein Modul mit Selbstbeschreibung + Implementierung**. Registry und
Registrierung sind getrennt von den Tools selbst:

```
services/tools/
├── registry.ts          # ToolRegistry-Klasse: register/get/execute/near-miss-Resolve (~150 Zln)
├── definitions.ts       # ToolDefinition-Typ-Reexports, Kategorie-Enum
├── relevance.ts         # selectRelevantTools(query): Stichwort-basierte Auswahl + Core-Set
├── validation.ts        # coerceToolArguments, validateToolArguments (Zod)
├── guard.ts             # ScheduledRun-Guard für schreibende Tools, Execution-Origin
├── index.ts             # registriert alle Gruppen (Import side-effect), hält < 100 Zeilen
└── groups/
    ├── search/          # ddgWebSearch.ts, urlFetch.ts, articleExtractor.ts
    ├── news/            # webz.ts, gnews.ts, rssParser.ts (je API EIGENE Datei)
    ├── finance/         # stockPrice.ts, stockAnalysis.ts, currencyConvert.ts,
    │                    # macroSeries.ts (FRED/Eurostat), economicCalendar.ts,
    │                    # portfolioOverview.ts, portfolioUpdate.ts
    ├── data/            # dataFilter.ts, textSummarize.ts, generateReport.ts,
    │                    # chartSpec.ts, exportFile.ts, importFile.ts, calculator.ts
    ├── knowledge/       # companyLookup.ts (Wikipedia), translateText.ts, weatherLookup.ts
    ├── memory/          # memorySave.ts, memoryRecall.ts, memoryForget.ts
    └── automation/      # scheduleCreate.ts, scheduleList.ts, scheduleRemove.ts
```

Regeln:
- Jede Datei enthält **maximal 1–2 eng verwandte Tools** (Definition + execute-Funktion).
- Gemeinsame Infrastruktur einer API (Proxy-Kaskade, CORS-Fallbacks, Mapping auf das
  Einheits-Schema `Source {title,url,snippet,date,source}`) wohnt in derselben Gruppe,
  aber in eigener Datei (z. B. `news/webzClient.ts`).
- `registry.ts` und die Gruppen dürfen sich nicht gegenseitig importieren; `index.ts`
  verdrahtet. Keine zirkulären Abhängigkeiten (der alte Code hatte einen Zyklus
  tools↔scheduler, gelöst durch duplizierten Validator – das soll sauber über
  `shared/scheduleSpec.ts` gehen).
- ToolDefinition-Felder: `id, name, description, category, inputSchema (JSON Schema via
  Zod), outputSchema, version, enabled, permissions[], maxDuration, maxDataSize, builtin`.
- Schreibende/zustandsändernde Tools prüfen den Execution-Origin (`user` vs `scheduled`)
  über den Guard.

Aktuell sollen **31 Tools** existieren (Namen = `snake_case`-IDs, wie gehabt):
`ddg_web_search`, `web_search`, `url_fetch`, `news_search`, `webz_news`, `webz_top_news`,
`gnews_search`, `gnews_top_headlines`, `company_lookup`, `stock_price`, `stock_analysis`,
`currency_convert`, `macro_series`, `economic_calendar`, `portfolio_overview`,
`portfolio_update`, `data_filter`, `text_summarize`, `generate_report`, `chart_spec`,
`export_file`, `import_file`, `calculator`, `translate_text`, `weather_lookup`,
`memory_save`, `memory_recall`, `memory_forget`, `schedule_create`, `schedule_list`,
`schedule_remove`.
Near-Miss-Auflösung umbenannter/legacy IDs (z. B. `weather` → `weather_lookup`) muss bleiben.

### 4. Provider-Schicht

- Adapter-Pattern: `callProvider(config, messages, tools, onChunk)` routet über
  `registry.ts` zum Adapter. Groq/OpenRouter/LM Studio nutzen OpenAI-kompatibles
  Chat-Completions-API mit SSE-Streaming; Gemini nutzt ein eigenes Contents-Format
  (`toGeminiContents`) und eigene Streaming-Parsing — beides gekapselt in `gemini.ts`.
- **7 Modell-Slots**: 1 Primär + 6 Fallbacks, je Slot frei wählbarer Provider.
  Failover bei Rate-Limit (429), Serverfehler (5xx), Timeout, Auth-Fehler und
  **Content-Refusals** (in DE und EN erkennbar). Bei Fallback übernimmt das nächste
  Modell den vollen Arbeitszustand der Unterhaltung.
- **Modell-Katalog mit Deprecation-Mapping**: Anbieter (v. a. Google) entfernen alte
  Modell-IDs (z. B. `gemini-2.5-flash` → HTTP 404); vor jeder Anfrage wird eine
  gespeicherte Alt-ID automatisch auf den Nachfolger gemappt. Katalog und Map in
  `modelCatalog.ts`, 404-Handler in `gemini.ts`.
- LM Studio: Default `http://localhost:1234/v1`, konfigurierbare Base-URL,
  Modell-Listung via `/models`, „Cold Start" eines lokalen Modells braucht Nutzer-OK.
- Auth-Fehler werden als eigenständiger Fehlertyp geworfen (nicht als generischer
  Netzwerkfehler versteckt), damit die UI gezielt nach API-Key fragen kann.

### 5. Agent-Loop & Token-Ökonomie (Verhalten ist Pflicht)

- System-Prompt **komprimiert**: nur Regeln, keine Tool-Liste (Schemas gehen über das
  API-`tools`-Parameter-Feld). Antwort-Vorgaben: ≤ 300 Wörter, ≤ 3 Tool-Calls pro Turn.
- **Relevanzselektion statt Vollkatalog**: Der volle Tool-Katalog kostet gemessen ~7k
  Prompt-Tokens pro Anfrage. Pro Turn werden nur stichwort-relevante Tools gesendet,
  plus festes Core-Set (`ddg_web_search`, `url_fetch`). Erdachte Tool-IDs führen zur
  bestehenden „not found"-Fehlermeldung.
- **Kontextfenster-Guard**: History wird auf ein Budget (~24k Tokens Prompt) trunciert;
  veraltete Tool-Ergebnisse früherer Turns werden entfernt, aktuelle nie.
- **Kompakte Tool-Ergebnisse** an das Modell: Strings ≤ ~150–200 Zeichen, Arrays ≤ 5–8
  Einträge, URLs bleiben für Citations erhalten.
- **Dedup**: identischer Tool-Call im selben Turn → gecachte Antwort + Hinweisnote,
  keine Doppel-Ausführung.
- **Unterbrechen & Fortsetzen**: Wird ein Turn abgebrochen (Refusal aller Modelle oder
  Infra-Fehler), werden abgeschlossene Steps, Tool-Calls und Ergebnisse persistiert;
  ein „Fortsetzen"-Button setzt genau dort wieder auf (nicht neu starten).
- **TPM-Manager**: tokens-per-minute Budget mit Reservierungssystem für parallele
  Requests; Requests warten/queueen statt blind zu feuern; Verbrauch wird pro Request
  in der `tokenUsage`-Tabelle protokolliert.

### 6. Sicherheit (nicht verhandelbar)

- API-Keys nur lokal (IndexedDB), niemals an Dritte außer dem jeweiligen Provider.
- **SSRF-Schutz** bei `url_fetch`/allen externen Fetches: URL-Validierung, Block interner
  IPs/Hostnamen (privateRanges, localhost, link-local), Protokoll-Whitelist http/https.
- Strokte Timeout-, Datenmengen- und Wiederholungslimits; keine ungebundenen Loops.
- Schema-Validierung (Zod) für **alle** Tool-Inputs und -Outputs.
- Berechtigungsmodell pro Tool (`permissions[]`), Write-Guard für Scheduler-Ausführungen.
- **Kein `eval` und kein KI-generierter ausführbarer Code im Client.** KI-"eigene Tools"
  nur als deklarative Rezept-DAGs, die die bestehende WorkflowEngine in der bestehenden
  Sandbox ausführt (Option: dynamische Registrierung geprüfter Kompositionen mit
  Persistenz, Versionierung und Review-Gate).

### 7. Datenmodell (Dexie, IndexedDB)

Tabellen (Version 1 + 2 zusammengeführt, da Greenfield):
`chatSessions(id, updatedAt, createdAt)`, `settings(id)`, `workflows(id, status, updatedAt, createdBy)`,
`logs(id, level, timestamp)`, `tokenUsage(id, provider, timestamp)`,
`memories(id, [category+key], category, key, updatedAt)`, `positions(id, ticker, updatedAt)`,
`timeseriesCache(id, source, seriesId, expiresAt)`, `scheduledJobs(id, enabled, nextRun)`,
`scheduledRuns(id, jobId, startedAt)`.
Settings umfassen: API-Keys je Provider, 7 Modell-Slots, Proxy-Basis-URL(s) für CORS-Probleme,
LM-Studio-Base-URL, TPM-Limits, Tool-Freigaben.

### 8. UI-Seiten

- **ChatPage**: Streaming-Antworten, sichtbare Tool-Calls mit Ergebnissen, Quellen-Citations,
  Abort + „Fortsetzen", Token-Anzeige pro Turn.
- **ResearchPage**: Schnellzugriff auf News/Firma/Aktie/Chart-Auswertung.
- **ToolsPage**: Registry verwalten, Tools einzeln testen (Formular aus inputSchema generiert).
- **WorkflowPage**: React-Flow-Editor (Drag&Drop-Nodes = Tools, Kanten = Datenfluss),
  Validierung (Zyklus-/Typ-Checks), Ausführung, **KI-Tool-Generierung**: natürlichsprachige
  Beschreibung → Workflow-Struktur (deklarativ, s. Sicherheit).
- **SettingsPage**: Provider/Keys mit Verbindungs-„Test"-Button, Modell-Slots, Scheduler-Verwaltung.
- Sprache der UI: Deutsch.

### 9. Bekannte Fallen des Vorgängerprojekts – beim Neubau vermeiden

1. **Monolithische Dateien** (tools.ts 4.060 Zln, provider.ts 1.419, chat.ts 1.389):
   Deshalb ist die Ordner-/Dateiaufteilung in Abschnitten 2–4 verbindlich, plus Datei-Größen-Test.
2. **Zyklische Abhängigkeit tools ↔ scheduler**: Schedule-Spec-Logik wandert nach `shared/`.
3. **Gemini-Modell-404 wegen Deprecated-IDs**: Deprecation-Map gehört zum Provider-Layer,
   nicht in die UI.
4. **Tokenexplosion durch vollen Tool-Katalog in jedem Prompt**: Relevanzselektion + Core-Set
   ist Pflicht, sonst kosten banale Fragen ~20k Tokens.
5. **Duplizierte Tool-Aufrufe im selben Turn** verbrennen Zeit/Geld → Dedup-Cache.
6. **„Failed to fetch" durch CORS bei DuckDuckGo/Webz/GNews**: Proxy-Kaskade (Dev-Proxy →
   konfigurierbare Basis → direkt) und verständliche Fehlermeldungen einbauen.
7. **Abgebrochene Turns waren verloren** → Interruption-Persistence + Resume.
8. **Refusals wurden als Erfolg behandelt** → Refusal-Erkennung löst Fallback aus.
9. **Lokale Modelle (LM Studio) brauchen lange für den ersten Request** → Cold-Start-Ausnahme
   statt Timeout-Fehler.
10. **Ungetesteter Agent-Code**: Für agentLoop, fallback, contextManager, resultCompactor,
    validation, registry, workflow-Validierung und scheduler Parser sind Unit-Tests Pflicht;
    für den Loop ein Integrationstest mit gemocktem Provider (mehrstufige Tool-Kette,
    Resume-Fall, Dedup-Fall).

### 10. Lieferumfang & Qualitätssicherung

- Lauffähiges Vite-Projekt (`npm run dev/build/typecheck/test` + `check:file-size`).
- README mit Setup (Groq-Key nötig; OpenRouter/Gemini optional; LM Studio optional),
  Architekturübersicht und Verweis auf diese Struktur.
- TypeScript strict, keine `any` an Systemgrenzen (Tool-I/O, Provider, DB).
- Vor dem Abschluss: jede Datei mit Zeilenzahl prüfen und die Liste in den PR/Commit schreiben.

Arbeite in dieser Reihenfolge: (1) Grundgerüst + Types + DB, (2) Provider-Layer mit Tests,
(3) Tool-Registry + Gruppen-Tools mit Tests, (4) Agent-Layer, (5) Workflow/Scheduler,
(6) UI-Seiten, (7) Datei-Größen-Audit + Tests grün. Melde nach jedem Schritt kurz Status
und Zeilenzahlen der größten Dateien.

---

## Ende des Prompts

---

## Anhang: Ist-Analyse des alten Projekts (Grundlage des Prompts)

**Projekt:** „AI Research Assistant" – React/Vite/TS-SPA, Multi-Provider-Chat mit
Agent-Loop (31 Tools), Workflow-Builder (React Flow), Scheduler, User-Memory, Portfolio,
Dexie/IndexedDB-Persistenz, TPM-Budget. Kein Backend.

**Größte Dateien (Zeilen, Stand Okt. 2026):**

| Datei | Zeilen | Inhalt |
|---|---|---|
| `src/services/tools.ts` | 4.060 | Registry + Validierung + Relevanz-Selektion + 31 Tool-Implementierungen + CSV/JSONPath/Statistik-Parser + Webz/GNews/DDG-Clients + Artikel-Extraktor |
| `src/services/provider.ts` | 1.419 | 4 Provider (Groq, OpenRouter, Gemini, LM Studio) + Streaming + Refusal + Modellkatalog + Errors |
| `src/services/chat.ts` | 1.389 | `ChatOrchestrator` mit 890-Zeilen-`runAgentLoop` + Kontext-Management + Kompaktierung + Resume |
| `src/pages/ChatPage.tsx` | 706 | Chat-UI |
| `src/pages/SettingsPage.tsx` | 629 | Settings-UI |
| `src/services/tpm.ts` | 399 | Token-Budget |

**Weitere Probleme:** zyklische Abhängigkeit tools↔scheduler (duplizierter Validator als
Workaround), vollkatalog-bedingte Prompt-Tokenkosten (~7k/Anfrage), Gemini-Deprecation-404s
(nur per Rename-Map kompensiert), CORS-Fetch-Fehler brauchten Proxy-Kaskade, veraltete
Debug-Tests (`_dbg/_probe/_inspect`) im Repo. Alle Punkte sind in Abschnitt 9 des Prompts
als „Fallen" verarbeitet.
