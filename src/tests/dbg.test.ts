import { it, expect } from 'vitest';
import { toolRegistry } from '../services/tools';
it('dbg', async () => {
  const r: any = await toolRegistry.execute({ id:'t', toolId:'stock_price', toolName:'stock_price', arguments:{ticker:'dax'}, timestamp: Date.now() });
  console.log('RESULT', JSON.stringify(r).slice(0,600));
}, 30000);
