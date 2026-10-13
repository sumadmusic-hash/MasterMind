import { describe, it, expect } from 'vitest';
import { toolRegistry } from '../services/tools';

describe('debug', () => {
  it('stock_price DAX', async () => {
    const r: any = await toolRegistry.execute({ id: 't', toolId: 'stock_price', toolName: 'stock_price', arguments: { ticker: 'DAX' }, timestamp: Date.now() });
    console.log('RESULT', JSON.stringify(r).slice(0, 800));
    expect(true).toBe(true);
  }, 60000);
});
