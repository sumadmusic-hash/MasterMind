import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../services/provider', () => ({ callProvider: vi.fn() }));
vi.mock('../services/database', () => ({ saveChatSession: vi.fn().mockResolvedValue(undefined), addLog: vi.fn().mockResolvedValue(undefined) }));
import { callProvider } from '../services/provider';
import { ChatOrchestrator } from '../services/chat';
const mockedCall = vi.mocked(callProvider);
const settings: any = { primaryModel: { provider: 'groq', modelId: 'test-model' }, maxToolSteps: 10 };
const sseCall = (id: string, name: string, args: any) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
it('dbg dedup', async () => {
  let i = 0;
  const steps = [ { toolCalls: [sseCall('c1','calculator',{expression:'2+2'})] }, { toolCalls: [sseCall('c2','calculator',{expression:'2+2'})] }, { content: 'Fertig.' } ];
  mockedCall.mockReset();
  mockedCall.mockImplementation(async (_s,_m,_t,cb:any)=>{ const st=steps[Math.min(i,steps.length-1)]; i++; for(const tc of st.toolCalls??[]) cb?.onToolCall?.(tc); if(st.content) cb?.onToken?.(st.content); cb?.onComplete?.(st.content??'',{totalTokens:10}); return {content:st.content??'',usage:{totalTokens:10,promptTokens:5,completionTokens:5,cachedInputTokens:0},model:'test-model',provider:'groq'}; });
  await new ChatOrchestrator().sendMessage(settings, { id:'s1', title:'t', messages:[{id:'m1',role:'user',content:'Wieviel Mitarbeiter hat Lidl?',timestamp:Date.now()}], createdAt:0, updatedAt:0 }, undefined, { onToken:()=>{},onToolCall:()=>{},onToolResult:()=>{},onComplete:()=>{},onError:(e:any)=>console.log('ERRCB',e),onStatus:()=>{} } as any);
  console.log('CALLS:', mockedCall.mock.calls.length);
  for (let n=0;n<mockedCall.mock.calls.length;n++){
    const msgs = mockedCall.mock.calls[n][1] as any[];
    console.log(`--- call ${n} tools=${mockedCall.mock.calls[n][2]!==undefined}`);
    for (const m of msgs.slice(-6)) console.log(m.role, typeof m.content==='string'? m.content.slice(0,140): JSON.stringify(m).slice(0,140));
  }
}, 30000);
