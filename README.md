# AI Research Assistant

A modular, extensible AI-powered research web application with chat, tool orchestration, workflow building, and multi-provider support.

## Features

### Core Capabilities
- **Chat Interface**: Full conversational AI with streaming responses, tool call visibility, and source citations
- **Multi-Provider Support**: Groq and OpenRouter with 7 configurable model slots (primary + 6 fallbacks)
- **Automatic Fallback**: Intelligent failover between models on errors, rate limits, server issues — or content refusals (detected in English and German replies; the fallback model takes over the same conversation with its full working state)
- **Resume Interrupted Turns („Fortsetzen")**: If a turn is interrupted (all models refused, or an infrastructure error occurred mid-task), completed steps, tool calls and tool results are persisted; the „Fortsetzen" button continues exactly where the run stopped instead of restarting it
- **Token Budget Management (TPM)**: Server-side token-per-minute control with reservation system for parallel requests
- **Token-Efficient Prompting**: Compressed system prompt (rules only, no tool list — schemas are sent via the API `tools` parameter), strict output caps (≤300 words, ≤3 tool calls per turn) and a fixed response template to keep answer quality while cutting prompt/completion tokens
- **Context Window Guard**: History is truncated to the newest messages that fit a 24k-token prompt budget; stale tool results from earlier turns are dropped, current-turn tool results are never lost
- **Compact Tool Outputs**: Tool results fed back to the model are compacted (strings capped at 200 chars, arrays at 8 items, URLs preserved for citations); duplicate tool calls within a turn return a cached-skip note instead of re-executing
- **Tool Registry**: Modular tools with validation, permissions, timeouts, and data limits
- **Workflow Builder**: Visual drag-and-drop editor (React Flow) for creating reusable research workflows
- **AI Tool Generation**: Describe workflows in natural language, AI generates the structure
- **Research & Analysis**: News search, company lookup, stock prices, and data filtering
- **Persistent Storage**: IndexedDB via Dexie for all data (chats, workflows, settings, logs)

### Built-in Tools
| Tool | Category | Description |
|------|----------|-------------|
| Web Search | Data Source | Search the web for current information |
| News Search | Data Source | Find recent news articles with timestamps |
| Company Lookup | Data Source | Look up company info and ticker symbols |
| Stock Price | Data Source | Get current and historical stock data |
| Data Filter | Filter | Filter, sort, and deduplicate data |
| Text Summarizer | AI Extraction | Extractive text summarization |
| Report Generator | Report | Create structured reports |
| URL Fetch | Data Source | Fetch and extract web page content |

### Security
- API keys stored locally, never sent to the client from "server"
- URL validation with SSRF protection (blocks internal IPs)
- Tool permission system
- Strict timeouts and data size limits
- No unbounded loops or automatic retries without limits
- Schema validation for all tool inputs/outputs

## Architecture

```
src/
├── types/          # Shared TypeScript types and Zod schemas
├── services/       # Business logic layer
│   ├── provider.ts    # AI provider adapters (Groq, OpenRouter)
│   ├── tpm.ts         # Token-per-minute budget manager
│   ├── tools.ts       # Tool registry and implementations
│   ├── chat.ts        # Chat orchestrator with agent loop
│   ├── workflow.ts    # Workflow engine with validation
│   └── database.ts    # IndexedDB persistence (Dexie)
├── store/          # React context for global state
├── pages/          # Page components
│   ├── ChatPage.tsx      # Main chat interface
│   ├── ResearchPage.tsx  # Research & analysis
│   ├── ToolsPage.tsx     # Tool management & testing
│   ├── WorkflowPage.tsx  # Visual workflow editor
│   └── SettingsPage.tsx  # Configuration
├── tests/          # Vitest test suites
└── App.tsx         # Main app with navigation
```

## Setup

### Prerequisites
- Node.js 18+
- Groq API key (https://console.groq.com)
- OpenRouter API key (https://openrouter.ai) - optional

### Installation
```bash
npm install
```

### Development
```bash
npm run dev
```

### Build
```bash
npm run build
```

### Run Tests
```bash
npx vitest run
```

## Configuration

### First-Time Setup
1. Open the application
2. Navigate to **Settings**
3. Enter your Groq API key (required) and/or OpenRouter API key
4. Click **Test** to verify the connection
5. Select your preferred models for primary and fallback slots

### Model Configuration
- **Primary Model**: The main model used for all requests
- **Fallback 1–6**: Tried in order when the previous model fails (rate limit, error, timeout). All fallback slots are optional.

Each slot can independently select provider and model.

### Token Budget
- **Global TPM Limit**: Maximum tokens per rolling 60-second window
- **Max Tokens per Request**: Maximum output tokens per single call
- **Max Tool Steps**: Maximum tool invocations per user request
- Budget is shared across all chats, parallel requests, and workflow executions

### Reducing Token Consumption (app-side levers)
The app already implements the main cost levers — no quality regression, since citations, fact/analysis separation and the fixed response template are preserved:

| Measure | Where | Effect |
|---------|-------|--------|
| Compressed system prompt (rules only; tool list removed because schemas go via the API `tools` parameter) | `src/services/chat.ts` → `SYSTEM_PROMPT` | −30–50 % prompt tokens |
| Hard caps per turn: ≤300 words output, ≤3 tool calls, forced answer template | `SYSTEM_PROMPT` sections 1 & 4 | −20 % completion tokens |
| History truncation to a 24k-token prompt budget + dropping stale tool messages from earlier turns | `ChatOrchestrator.buildProviderMessages` / `fitToContextWindow` | −15–40 % in long sessions |
| Tool-output compaction before results re-enter the prompt (200-char strings, 8-item arrays, URLs kept intact) | `src/services/tools.ts` → `compactToolData` | −25 % tool-result tokens |
| Duplicate tool-call dedup within a turn (cached-skip note instead of re-execution) | agent loop (`seenToolSignatures`) | avoids repeated search/fetch tokens |
| Per-tool parameter limits enforced via the prompt (`maxResults: 3`, `url_fetch maxLength: 2000` + article selector, `text_summarize maxLength: 80`) | `SYSTEM_PROMPT` section 2 | bounds raw data in context |
| Streaming + early stop on TPM-budget pressure (wait-or-stop with status feedback) | `src/services/tpm.ts`, `provider.ts` (`onBudgetWait`) | prevents over-limit spend |

Further optional reductions: lower the tool defaults in `src/services/tools.ts` (e.g. `web_search.maxResults` 10→2, `url_fetch.maxLength` 6000→1500, `text_summarize.maxLength` 100→60) — each roughly halves that tool's contribution; embedding-based retrieval instead of full-text search would cut the largest share but requires new infrastructure. When tightening limits, validate against a golden-set evaluation to catch quality regressions, and consider collapsible "Details" in the UI so shorter answers still feel complete.

## Usage

### Chat
Type your research question in natural language. The AI will:
1. Understand your intent
2. Select appropriate tools
3. Execute tools and gather data
4. Synthesize results with sources
5. Present findings with citations

Example queries:
- "What are the latest news about NVIDIA?"
- "Compare AAPL and MSFT stock performance this week"
- "Research the AI industry and summarize key trends"

### Research Page
Direct access to research tools:
- Enter a topic, company name, or ticker
- Get news, company info, and stock data in one view
- Filter by result type

### Tool Workshop
- Browse all available tools
- View schemas, permissions, and capabilities
- Test tools with custom inputs
- Enable/disable tools

### Workflow Builder
1. Create a new workflow or describe it in natural language
2. Add tool nodes from the sidebar
3. Connect nodes by dragging between handles
4. Validate the workflow structure
5. Test with sample data
6. Save and approve for use

Approved workflows become available as tools in the chat.

## Data Providers

### Search & News
Uses DuckDuckGo Instant Answer API (free, no key required).

### Stock Data
Uses Yahoo Finance chart API (free, delayed 15-20 minutes).
**Note**: Not suitable for trading decisions.

### Extending Data Sources
Add new tools to `src/services/tools.ts` following the existing pattern:
```typescript
toolRegistry.register({
  id: 'my_tool',
  name: 'My Tool',
  description: '...',
  category: 'data_source',
  inputSchema: { type: 'object', properties: {...} },
  outputSchema: { type: 'object', properties: {...} },
  version: '1.0.0',
  enabled: true,
  permissions: ['network'],
  maxDuration: 10000,
  maxDataSize: 50000,
  builtin: true,
}, async (args) => {
  // Implementation
  return { result: '...' };
});
```

## Testing

Tests are organized by module:
- `tools.test.ts` - Tool registry and execution
- `tpm.test.ts` - Token budget management
- `workflow.test.ts` - Workflow validation and execution
- `provider.test.ts` - Provider configuration

Run all tests:
```bash
npx vitest run
```

## Known Limitations

1. **Search API**: DuckDuckGo API has limited results compared to commercial search APIs
2. **Stock Data**: Yahoo Finance API may be rate-limited; data is delayed
3. **No Real Backend**: Currently runs entirely in the browser; API keys are stored in IndexedDB
4. **Workflow Execution**: Complex workflows with branching are not yet fully supported
5. **Streaming**: Tool call streaming depends on provider support

## Future Extensions

- [ ] Real backend server with proper API key encryption
- [ ] Additional search providers (SerpAPI, Tavily, Bing)
- [ ] Financial data providers (Alpha Vantage, Finnhub)
- [ ] Workflow branching and conditional logic
- [ ] AI-generated code execution in sandboxed environment
- [ ] Multi-user support with authentication
- [ ] Export/import workflows and configurations
- [ ] Custom tool creation via AI code generation

## License

MIT
