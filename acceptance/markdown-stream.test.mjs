import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitBufferedAssistantText,
  createMarkdownStreamFilter,
} from '../dist/core/markdown-stream.js';

test('splitBufferedAssistantText: splits cleanly on blank lines', () => {
  const input = 'First paragraph text.\n\nSecond paragraph text being typed...';
  const res = splitBufferedAssistantText(input);

  assert.equal(res.flushable, 'First paragraph text.\n\n');
  assert.equal(res.remainder, 'Second paragraph text being typed...');
  assert.equal(res.flushText, res.flushable);
  assert.equal(res.remainingText, res.remainder);
});

test('splitBufferedAssistantText: respects section headers', () => {
  const input = '# Main Title\nIntroduction paragraph.';
  const res = splitBufferedAssistantText(input);

  assert.equal(res.flushable, '# Main Title\n');
  assert.equal(res.remainder, 'Introduction paragraph.');

  // Header boundary transition before new section
  const input2 = 'Introduction paragraph.\n## Subsection\nPartial text';
  const res2 = splitBufferedAssistantText(input2);
  assert.equal(res2.flushable, 'Introduction paragraph.\n## Subsection\n');
  assert.equal(res2.remainder, 'Partial text');
});

test('splitBufferedAssistantText: splits list items without breaking rendering', () => {
  const input = 'Instructions:\n- Step 1: Clone repo\n- Step 2: Run build\n- Step 3: P';
  const res = splitBufferedAssistantText(input);

  assert.equal(res.flushable, 'Instructions:\n- Step 1: Clone repo\n- Step 2: Run build\n');
  assert.equal(res.remainder, '- Step 3: P');
});

test('splitBufferedAssistantText: prevents layout shifts by buffering unclosed code fences', () => {
  // Unclosed code block must NOT flush
  const unclosed = 'Intro\n```typescript\nconst a = 10;\nconst b = 20;\n';
  const res1 = splitBufferedAssistantText(unclosed);
  assert.equal(res1.flushable, 'Intro\n');
  assert.equal(res1.remainder, '```typescript\nconst a = 10;\nconst b = 20;\n');

  // Once closing fence arrives with newline, code block flushes completely
  const closed = unclosed + '```\nTrailing text';
  const res2 = splitBufferedAssistantText(closed);
  assert.equal(res2.flushable, 'Intro\n```typescript\nconst a = 10;\nconst b = 20;\n```\n');
  assert.equal(res2.remainder, 'Trailing text');
});

test('splitBufferedAssistantText: returns empty flushable for partial incomplete text', () => {
  const res = splitBufferedAssistantText('Just a single line without any boundary');
  assert.equal(res.flushable, '');
  assert.equal(res.remainder, 'Just a single line without any boundary');
});

test('createMarkdownStreamFilter: enforces 400ms throttling between flushes', () => {
  let virtualTime = 1000;
  const filter = createMarkdownStreamFilter({
    minIntervalMs: 400,
    clock: () => virtualTime,
  });

  // First chunk at t=1000 flushes immediately upon hitting boundary
  const chunk1 = filter.push('# Header 1\n\n');
  assert.equal(chunk1, '# Header 1\n\n');

  // Second chunk at t=1100 (only 100ms later < 400ms): throttled, even with boundary
  virtualTime = 1100;
  const chunk2 = filter.push('Paragraph 1\n\n');
  assert.equal(chunk2, '');
  assert.equal(filter.getBuffer(), 'Paragraph 1\n\n');

  // Third chunk at t=1200: still within 400ms window
  virtualTime = 1200;
  const chunk3 = filter.push('Paragraph 2\n\n');
  assert.equal(chunk3, '');

  // Advance time past 400ms window (t=1401): flushes accumulated boundaries
  virtualTime = 1401;
  const chunk4 = filter.push('Paragraph 3 is being typed');
  assert.equal(chunk4, 'Paragraph 1\n\nParagraph 2\n\n');
  assert.equal(filter.getBuffer(), 'Paragraph 3 is being typed');

  // Finish flushes any trailing partial remainder
  const final = filter.finish();
  assert.equal(final, 'Paragraph 3 is being typed');
  assert.equal(filter.getBuffer(), '');
});

test('createMarkdownStreamFilter: transform streams async iterable cleanly', async () => {
  const filter = createMarkdownStreamFilter({ minIntervalMs: 0 });

  async function* generateTokens() {
    yield 'Here is';
    yield ' a heading\n# Title\n';
    yield 'Body paragraph.\n\n';
    yield 'Unfinished';
  }

  const chunks = [];
  for await (const chunk of filter.transform(generateTokens())) {
    chunks.push(chunk);
  }

  const combined = chunks.join('');
  assert.equal(combined, 'Here is a heading\n# Title\nBody paragraph.\n\nUnfinished');
});
