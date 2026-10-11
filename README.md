# AI Research Assistant

A modular, extensible AI-powered research web application with chat, tool orchestration, workflow building, and multi-provider support.

## Features

### Core Capabilities
- **Chat Interface**: Full conversational AI with streaming responses, tool call visibility, and source citations
- **Multi-Provider Support**: Groq and OpenRouter with 3 configurable model slots (primary + 2 fallbacks)
- **Automatic Fallback**: Intelligent failover between models on errors, rate limits, or server issues
- **Token Budget Management (TPM)**: Server-side token-per-minute control with reservation system for parallel requests
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
- **Fallback 1**: Used when primary fails (rate limit, error, timeout)
- **Fallback 2**: Used when both primary and fallback 1 fail

Each slot can independently select provider and model.

### Token Budget
- **Global TPM Limit**: Maximum tokens per rolling 60-second window
- **Max Tokens per Request**: Maximum output tokens per single call
- **Max Tool Steps**: Maximum tool invocations per user request
- Budget is shared across all chats, parallel requests, and workflow executions

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
