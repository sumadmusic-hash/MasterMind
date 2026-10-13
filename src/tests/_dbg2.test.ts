import { it, expect } from 'vitest';
import { toolRegistry } from '/workspace/src/services/tools';
const exec = (toolId: string, args: any) =>
  toolRegistry.execute({ id: 't', toolId, toolName: toolId, arguments: args, timestamp: Date.now() } as any);
it('dbg stock_analysis DAX', async () => {
  const r: any = await exec('stock_analysis', { ticker: 'DAX', period: '1mo' });
  console.log('STOCK_ANALYSIS', JSON.stringify(r).slice(0, 600));
  const n: any = await exec('news_search', { query: 'Deutschland', maxResults: 3 });
  console.log('NEWS', JSON.stringify(n).slice(0, 600));
}, 60000);
