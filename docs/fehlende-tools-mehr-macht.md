# Analyse & Plan: Welche Tools braucht die KI, um mehr Macht zu haben?

**Stand:** 13.10.2026 · **Bezugscode:** `src/services/tools.ts` (ToolRegistry, 16 registrierte Tools), `src/services/database.ts` (Dexie), `src/services/workflow.ts`, `src/services/chat.ts`
**Auslöser:** Chat-Antwort des Modells (`groq/qwen/qwen3.8-27b`, 3339 Tokens) über eigene Lücken im Toolkit. Dieses Dokument prüft diese Selbsteinschätzung gegen den Ist-Code und leitet einen Umsetzungsplan ab.

---

## 1. Kernaussage (TL;DR)

> Die vom Modell genannte Tool-Liste ist **richtig in der Richtung, aber teilweise irreführend im Detail**: Einige „fehlende" Tools existieren bereits oder sind teilabgedeckt (`economic_calendar` ≈ Finanzkalender, `data_filter` + `generate_report` ≈ leichte Datenanalyse/Export). Der eigentliche Engpass ist nicht die Tool-*Anzahl*, sondern dass der Agent **zustandslos, ereignis-getrieben und rein fragend** ist: kein persistenter Nutzer-Kontext, keine Zeitreihen-Historie, kein Scheduler, keine echte Ausführungsumgebung.
>
> **Priorität 1** daher: `user_memory` + `macro_data` + `scheduler` (drei Dexie-Tabellen plus drei Tools — geschlossener Datenspeicher, komplett clientseitig machbar).
> **Priorität 2:** `chart_generator` + Datei-/PDF-Export + OCR.
> **Prinzipien-gesteuert:** Kein `eval`/KI-geschriebener Code im Browser (API-Keys liegen im selben Origin, siehe `docs/ai-eigene-tools-analyse.md`); „Python-Power" nur als geprüfte Primitive-Bausteine oder optional via Pyodide/WebWorker-Sandbox.

---

## 2. Abgleich: Behauptete Lücke vs. tatsächlicher Stand im Code

| # | Vom Modell gefordert | Tatsächlicher Status in dieser App | Evidence |
|---|---|---|---|
| 1 | `code_interpreter` / Python | ❌ **Fehlt.** Nur `calculator` (ausdrucksbasiert) und `data_filter` (map/filter/sort auf JSON). Keine Schleifen, Regressionen, Simulationen. | `tools.ts` L. 1154, 1896 |
| 2 | `file_read` / `file_write` | ⚠️ **Halb.** `generate_report` erzeugt Report-Text (In-App), aber kein echter CSV/Excel/PDF-Export und kein Einlesen von Nutzerdateien. | `tools.ts` L. 2014 |
| 3 | `browser` (JS-Rendering + Login) | ⚠️ **Teilabdeckung.** `url_fetch` nutzt Fallback-Ketten (`r.jina.ai`, `microlink`) — damit kann JS-gerenderte Seiten *fremder Dienste* gerendert werden; eigener Headless-Browser mit Login existiert nicht (und wäre clientseitig ohne Backend nicht sicher baubar). SSRF-Schutz vorhanden, Domain-Allowlist fehlt. | `tools.ts` L. 2058 ff., 2158 ff. |
| 4 | `image_analysis` (OCR) | ❌ **Fehlt komplett.** Kein Bild-/Screenshot-Eingang im Chat-Toolset. Tesseract.js wäre lauffähig im WebWorker. | Registry-Durchsicht |
| 5 | `portfolio_tracking` | ❌ **Fehlt.** Einzelereignisse `stock_price`/`stock_analysis` existieren, aber keine Watchlist-Tabelle, keine Positionen, keine Performance über Zeit. | `database.ts` (nur chatSessions, settings, workflows, logs, tokenUsage) |
| 6 | `macro_data` (FRED/Bundesbank/Eurostat) | ❌ **Fehlt.** `economic_calendar` liefert *Kalender/Events*, keine historischen Zeitreihen. | `tools.ts` L. 856 |
| 7 | `earnings_calendar` / `filings` | ⚠️ **Teilabdeckung.** `company_lookup` + `stock_*` holen Yahoo-Metadaten; kein dedizierter Earnings-/Filings-Kalender (10-K/10-Q via SEC EDGAR fehlt). | `tools.ts` L. 1427, 1724, 1811 |
| 8 | `cron` / `scheduler` | ❌ **Fehlt.** App hat keinerlei zeitgesteuerte Ausführung; WorkflowEngine läuft nur interaktiv. | `workflow.ts`, AppContext |
| 9 | `user_memory` | ❌ **Fehlt.** Dexie speichert Sessions/Settings, aber kein Präferenzen-/Positionen-/Watchlist-Gedächtnis, das dem System-Prompt beigefügt wird. | `database.ts` |
| 10 | `multi_agent` / Delegation | ⚠️ **Ansatz da.** Workflows (Node/Edge-DAG) können sequenziell mehrere Tool-/LLM-Schritte orchestrieren; echte *parallele* Research-Stränge mit eigenem Kontext fehlen. | `workflow.ts` |
| 11 | `chart_generator` | ❌ **Fehlt.** Ergebnisse sind Tabellen/Text; keine Plotly/Mermaid/SVG-Ausgabe im Chat. | `chat.ts` Rendering |
| 12 | `email` / `webhook` | ❌ **Fehlt.** Kein Ausgangskanal (Slack/Mail/Webhook). Clientseitig nur Webhook per `fetch` realistisch (CORS beachten). | Registry-Durchsicht |

**Registrierte Tools heute (16):** `web_search`, `news_search`, `webz_news`, `webz_top_news`, `weather_lookup`, `economic_calendar`, `translate_text`, `calculator`, `currency_convert`, `company_lookup`, `stock_price`, `stock_analysis`, `data_filter`, `text_summarize`, `generate_report`, `url_fetch`.

**Bewertung der Modell-Priorisierung:** Die Reihenfolge des Chats (1. code_interpreter, 2. file_read/write, 3. macro+earnings, 4. scheduler) ist plausibel für eine Server-App. Für **diese clientseitige App** ist sie suboptimal: `code_interpreter` ist der teuerste und riskanteste Punkt (Sandbox!), während `user_memory`/`macro_data`/`scheduler` mit vorhandener Infrastruktur (Dexie, ToolRegistry, WorkflowEngine) in Tagen machbar sind und den größten Nutzensprung bringen („Frage-Antwort" → „Service").

---

## 3. Umsetzungsplan (Phasen)

### Phase 1 — Gedächtnis & Datenbasis (größter Hebel, geringstes Risiko)
1. **`user_memory` (Tool + Tabelle)**
   - Neue Dexie-Tabelle `memories: 'id, category, updatedAt'` (category: `preference | position | watchlist | fact`).
   - Tools `memory_save` / `memory_recall` (Permissions: `[]`, keine Network-Calls).
   - `chat.ts`: relevante Memories automatisch in den System-Prompt injizieren (Token-Budget z. B. 500).
2. **`macro_data`**
   - Tool `macro_series`: FRED-CSV-Endpoint (`fredgraph.csv`, API-Key optional), Bundesbank-STATIS / Eurostat-API als Second Source; Output: kompakte Zeitreihe + Basisstatistik via `compactToolData`.
   - Zwischenspeicherung in neuer Tabelle `timeseriesCache` ( TTL 24 h → spart Rate-Limits/Tokens).
3. **`portfolio_tracking`**
   - Tabelle `positions: 'id, ticker, quantity, purchasePrice, createdAt'`; Tool `portfolio_update` (Schreibzugriff nur lokal) + Auswertung über bestehendes `stock_price`.

### Phase 2 — Vom Antworten zum Dienen
4. **`scheduler`**
   - Tabelle `scheduledJobs: 'id, cronExpr, workflowId, lastRun, nextRun, enabled'`.
   - Clientseitig: `setTimeout`-Tick beim App-Start + Catch-up-Logik („verpasste Jobs beim nächsten Öffnen ausführen"); klar dokumentierte Einschränkung: Browser muss offen sein. Optional später Notification-API als Alarm.
   - Beispiel-Use-Case aus dem Chat: „jeden Morgen 8 Uhr: EZB + DAX" = Workflow `economic_calendar` + `stock_price` + `generate_report` → Store als Session-Anhang.
5. **`chart_generator`**
   - Tool `render_chart`: Input `{type, series[]}` → Output Mermaid/Plotly-JSON, das `ChatPage` rendert (Chart-Lib lazy importiert, hält Bundle klein). Erlaubte Typen als Enum (kein Arbitrary Code).
6. **Datei-Export/-Import**
   - `export_file`: CSV/JSON/PDF (jsPDF) → Browser-Download; `import_file`: CSV/JSON-Parsing → an `data_filter` andockbar. Permissions: `storage` only.

### Phase 3 — Reichweite & Parallelität
7. **`earnings_calendar` / `filings`**: SEC-EDGAR-Full-Text-API (kostenlos, kein Key) + Earnings-Termine aus `company_lookup`-Erweiterung.
8. **`ocr_image`**: Tesseract.js im WebWorker; Chat-Eingang akzeptiert Bilder (Base64, Größenlimit analog `maxDataSize`).
9. **`webhook_notify`**: POST an vom Nutzer hinterlegte URL (Slack/Discord); Domain-Eingabe durch Nutzer + Bestätigungs-Gate (Human-in-the-Loop, passend zum Review-Gate aus `ai-eigene-tools-analyse.md`).
10. **Multi-Agent light**: WorkflowEngine um parallele Zweige erweitern (Fan-out/Fan-In existiert als Edge-Muster noch nicht); jeder Node behält eigenes Schema — weiterhin deklarativ, kein generierter Code.

### Phase 4 — „Python-Power" nur abgesichert (optional, später)
11. **Statt `eval` von KI-Code:** weitere Mini-Primitive ausbauen (`stats.regress`, `stats.resample`, `math.solve`, `json.path`) — kompositionierbar wie in Variante B des bestehenden Dokuments.
12. **Pyodide-Option:** Wenn echte Berechnungssprache nötig: Pyodide in dediziertem WebWorker + CSP-Header, **kein** Zugriff auf IndexedDB/Origin-Secrets, reiner Daten-IN/Daten-OUT-Kanal, hartes Timeout. Nur nach Security-Review.

---

## 4. Architektur-Regeln für alle neuen Tools

1. **Kein KI-generierter Code wird ausgeführt** — neue Fähigkeiten = deklarativ registrierte Primitives (siehe Grundsatzentscheidung in `docs/ai-eigene-tools-analyse.md`).
2. Jede neue Registry-Phase implementieren: `permissions` tatsächlich erzwingen (Gate in `execute()`), Domain-Allowlist für `network`-Tools, `maxDuration` setzen, Output durch `compactToolData`.
3. Persistenz ausschließlich über Dexie (Versionierung der Stores hochzählen, Migration nicht vergessen).
4. Kosten-/Token-Disziplin: Zeitreihen immer aggregiert/cached zurückgeben; Scheduler-Jobs nutzen bestehendes TPM-Tracking (`tpm.ts`).

---

## 5. Aufwand/Nutzen-Matrix (empfohlene Reihenfolge)

| Tool | Nutzen (Finanz-/News-Research) | Aufwand | Risiko | Rank |
|---|---|---|---|---|
| `user_memory` | hoch (Personalisierung, Kontext) | klein | niedrig | **1** |
| `macro_data` + Cache | hoch (schließt Hauptlücke) | klein–mittel | niedrig | **2** |
| `scheduler` | hoch (Agent → Service) | mittel | mittel (Off-Device-Grenze) | **3** |
| `portfolio_tracking` | mittel–hoch | klein | niedrig | 4 |
| `chart_generator` | mittel | klein | niedrig | 5 |
| `export/import_file` | mittel | klein | niedrig | 6 |
| `earnings/filings` | mittel | klein (EDGAR) | niedrig | 7 |
| `ocr_image` | mittel | mittel | niedrig | 8 |
| `webhook_notify` | mittel | klein | mittel (Exfiltration → Gate!) | 9 |
| Multi-Agent parallel | mittel | mittel | mittel | 10 |
| „code_interpreter" (Primitive-Wege) | hoch, aber teuer | groß | **hoch** (Sandbox/CSP) | 11 |
| Eigener Headless-Browser/Login | hoch | sehr groß (Backend nötig) | hoch | 12 |

**💡 Annahme (übernommen + angepasst aus dem Chat):** Die Bewertung setzt den Finance-/News-Use-Case der App voraus. Bei Coding-Fokus würden Rang 11 und `export_file` nach oben wandern; `macro_data` fiele zurück. Die Abweichung zur Modell-Reihenfolge begründet sich aus der serverlosen Browser-Architektur: was dort „ein Tool-Flag" wäre, ist hier eine Sandbox-Entscheidung.
