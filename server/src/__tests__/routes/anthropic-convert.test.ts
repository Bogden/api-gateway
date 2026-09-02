import { describe, expect, it } from 'vitest';
import { convertRequest } from '../../routes/anthropic.js';

describe('Anthropic request conversion', () => {
  it('preserves tool-result images and keeps parallel results contiguous', () => {
    const converted = convertRequest({
      model: 'gpt-5.6-luna',
      max_tokens: 128,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/tmp/one.png' } },
            { type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: '/tmp/two.png' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'after both results' },
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [
                { type: 'text', text: 'first image' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
              ],
            },
            {
              type: 'tool_result',
              tool_use_id: 'call_2',
              content: [{ type: 'text', text: 'second result' }],
            },
          ],
        },
      ],
    } as any);

    expect(converted.hasImage).toBe(true);
    expect(converted.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/one.png"}' } },
          { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/two.png"}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: [
          { type: 'text', text: 'first image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'second result' },
      { role: 'user', content: 'after both results' },
    ]);
  });
});
