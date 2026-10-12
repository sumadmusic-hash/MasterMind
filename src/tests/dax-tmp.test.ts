import { describe, it, expect } from 'vitest';
import { toolRegistry } from '../services/tools';

describe('DAX ticker resolution', () => {
  const exec = (toolId: string, args: any) =>
    toolRegistry.execute({ id: 't', toolId, toolName: toolId, arguments: args, timestamp: Date.now() });

  for (const [name, sym] of [['dax','^GDAXI'],['MDAX','^MDAXI'],['SDAX','^SDAXI'],['TecDAX','^TECDAX'],['DivDAX','DT5K.DE']]) {
    it(`stock_price resolves "${name}" -> ${sym}`, async () => {
      const r: any = await exec('stock_price', { ticker: name });
      console.log(name, '->', JSON.stringify(r.data?.ticker), 'price:', r.data?.price, 'err:', r.data?.error);
      expect(r.success).toBe(true);
      expect(r.data.found).toBe(true);
      expect(typeof r.data.price).toBe('number');
    }, 20000);
  }

  it('stock_analysis resolves "DAX kurs" style query and BTC alias', async () => {
    const r: any = await exec('stock_analysis', { ticker: 'Dax 40', period: '1mo' });
    console.log('analysis DAX ->', JSON.stringify(r.data?.ticker), r.data?.metrics?.latestPrice, r.data?.error);
    expect(r.data.found).toBe(true);
    const b: any = await exec('stock_price', { ticker: 'bitcoin' });
    expect(b.data.ticker).toBe('BTC-USD');
  }, 30000);
});
