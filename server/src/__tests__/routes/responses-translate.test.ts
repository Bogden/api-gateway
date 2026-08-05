import { describe, it, expect } from 'vitest';
import {
  toChatMessages,
  toChatTools,
  toChatToolChoice,
  buildResponseObject,
} from '../../routes/responses.js';

describe('Responses → chat translation (#96)', () => {
  it('maps a plain string input to a single user message', () => {
    expect(toChatMessages({ input: 'hello' } as any)).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  it('prepends instructions as a system message', () => {
    const msgs = toChatMessages({ instructions: 'You are terse.', input: 'hi' } as any);
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('preserves ordered text and canonical input_image parts', () => {
    const msgs = toChatMessages({ input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'before' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: 'after' },
    ] }] } as any);
    expect(msgs).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'before' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'after' },
    ] }]);
  });

  it('accepts the compatibility image_url object shape', () => {
    expect(toChatMessages({ input: [{ type: 'message', role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
    ] }] } as any)[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
    ]);
  });

  it('maps text-only message arrays and developer role to system', () => {
    const msgs = toChatMessages({
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] },
      ],
    } as any);
    expect(msgs).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ab' },
    ]);
  });

  it('rejects malformed and unsupported image shapes loudly', () => {
    expect(() => toChatMessages({ input: [{ type: 'message', role: 'user', content: [
      { type: 'image_url', image_url: 'https://example.com/image.png' },
    ] }] } as any)).toThrow(/image_url/);
    expect(() => toChatMessages({ input: [{ type: 'message', role: 'user', content: [
      { type: 'image' },
    ] }] } as any)).toThrow(/unsupported Responses content part type/);
  });

  it('maps a function_call item to an assistant tool_call', () => {
    const msgs = toChatMessages({
      input: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' }],
    } as any);
    expect(msgs[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
    });
  });

  it('maps a function_call_output item to a tool message', () => {
    const msgs = toChatMessages({
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'sunny' }],
    } as any);
    expect(msgs[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' });
  });

  it('rejects object-shaped function output instead of flattening image-bearing data into text', () => {
    expect(() => toChatMessages({
      input: [{ type: 'function_call_output', call_id: 'call_1', output: { image_url: 'https://example.com/image.png' } }],
    } as any)).toThrow(/function_call_output\.output/);
  });

  it('rejects image-like parts whose type is missing or unrecognized', () => {
    expect(() => toChatMessages({ input: [{ role: 'user', content: [
      { image_url: { url: 'https://example.com/image.png' } },
    ] }] } as any)).toThrow(/image-bearing.*missing/);
    expect(() => toChatMessages({ input: [{ role: 'user', content: [
      { type: 'future_image', source: { data: 'AAAA' } },
    ] }] } as any)).toThrow(/image-bearing.*future_image/);
  });

  it('converts flat Responses tools to nested chat tools', () => {
    const tools = toChatTools([
      { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: true },
    ] as any);
    expect(tools).toEqual([
      { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' }, strict: true } },
    ]);
  });

  it('converts tool_choice forms', () => {
    expect(toChatToolChoice('auto' as any)).toBe('auto');
    expect(toChatToolChoice({ type: 'function', name: 'f' } as any)).toEqual({ type: 'function', function: { name: 'f' } });
    expect(toChatToolChoice(undefined)).toBeUndefined();
  });
});

describe('chat result → Responses object (#96)', () => {
  it('builds a message output item plus usage for text', () => {
    const r = buildResponseObject({ id: 'resp_x', model: 'm', text: 'hi there', toolCalls: [], promptTokens: 5, completionTokens: 2 });
    expect(r.object).toBe('response');
    expect(r.status).toBe('completed');
    expect(r.output_text).toBe('hi there');
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] });
    expect(r.usage).toMatchObject({ input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  });

  it('emits function_call output items for tool calls', () => {
    const r = buildResponseObject({
      id: 'resp_x', model: 'm', text: '',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      promptTokens: 1, completionTokens: 1,
    });
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' });
  });
});
