/**
 * CommonMark boundary-aware text streaming (inspired by T3 Code splitBufferedAssistantText).
 * Parses buffered text and only flushes text when it hits clean boundaries:
 * - blank lines
 * - code fences closing
 * - list item starts
 * - section headers
 *
 * Prevents layout shifts and broken rendering of partial markdown in UI/WebSockets.
 */

export interface SplitResult {
  flushable: string;
  remainder: string;
  flushText: string;
  remainingText: string;
}

export interface MarkdownStreamFilterOptions {
  minIntervalMs?: number;
  clock?: () => number;
}

export interface MarkdownStreamFilter {
  push(chunk: string): string;
  flush(force?: boolean): string;
  finish(): string;
  getBuffer(): string;
  reset(): void;
  transform(source: AsyncIterable<string>): AsyncGenerator<string, void, unknown>;
}

interface TextLine {
  start: number;
  end: number;
  lineEnd: number;
  content: string;
  hasNewline: boolean;
}

function getLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const start = i;
    while (i < len && text[i] !== '\n' && text[i] !== '\r') {
      i++;
    }
    const end = i;
    let lineEnd = i;
    let hasNewline = false;

    if (i < len && text[i] === '\r') {
      i++;
      lineEnd = i;
      hasNewline = true;
    }
    if (i < len && text[i] === '\n') {
      i++;
      lineEnd = i;
      hasNewline = true;
    }

    lines.push({
      start,
      end,
      lineEnd,
      content: text.slice(start, end),
      hasNewline,
    });
  }

  return lines;
}

const REGEX_CODE_FENCE_OPEN = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/;
const REGEX_HEADING = /^[ ]{0,3}#{1,6}[ \t]+.*$/;
const REGEX_LIST_ITEM = /^[ ]{0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+.*$/;
const REGEX_THEMATIC_BREAK = /^[ ]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const REGEX_BLOCKQUOTE = /^[ ]{0,3}>[ \t]+.*$/;
const REGEX_BLANK_LINE = /^[ \t]*$/;

/**
 * Splits text into a flushable portion (at clean markdown boundaries) and remainder.
 */
export function splitBufferedAssistantText(text: string): SplitResult {
  if (!text) {
    return {
      flushable: '',
      remainder: '',
      flushText: '',
      remainingText: '',
    };
  }

  const lines = getLines(text);
  let inCodeBlock = false;
  let fenceChar = '';
  let fenceLen = 0;
  const boundaries: number[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (inCodeBlock) {
      // Check for closing fence: same fenceChar, at least fenceLen count, only optional spaces
      const trimmed = line.content.trimStart();
      const leadingSpaces = line.content.length - trimmed.length;

      if (leadingSpaces <= 3 && line.hasNewline) {
        let count = 0;
        let charIdx = 0;
        while (charIdx < trimmed.length && trimmed[charIdx] === fenceChar) {
          count++;
          charIdx++;
        }
        const rest = trimmed.slice(charIdx).trim();
        if (count >= fenceLen && rest.length === 0) {
          inCodeBlock = false;
          boundaries.push(line.lineEnd);
          continue;
        }
      }
      // Still inside code block: no boundaries can occur inside
      continue;
    }

    // Outside code block
    const fenceMatch = line.content.match(REGEX_CODE_FENCE_OPEN);
    if (fenceMatch) {
      if (line.hasNewline) {
        inCodeBlock = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
      }
      // If code fence starts, boundary could be right before the code fence if preceding content exists
      if (line.start > 0) {
        boundaries.push(line.start);
      }
      continue;
    }

    // Blank line
    if (REGEX_BLANK_LINE.test(line.content) && line.hasNewline) {
      boundaries.push(line.lineEnd);
      continue;
    }

    // Section header
    if (REGEX_HEADING.test(line.content)) {
      if (line.start > 0) {
        boundaries.push(line.start);
      }
      if (line.hasNewline) {
        boundaries.push(line.lineEnd);
      }
      continue;
    }

    // List item start
    if (REGEX_LIST_ITEM.test(line.content)) {
      if (line.start > 0) {
        boundaries.push(line.start);
      }
      if (line.hasNewline) {
        boundaries.push(line.lineEnd);
      }
      continue;
    }

    // Thematic break
    if (REGEX_THEMATIC_BREAK.test(line.content) && line.hasNewline) {
      boundaries.push(line.lineEnd);
      continue;
    }

    // Blockquote
    if (REGEX_BLOCKQUOTE.test(line.content)) {
      if (line.start > 0) {
        boundaries.push(line.start);
      }
      if (line.hasNewline) {
        boundaries.push(line.lineEnd);
      }
      continue;
    }
  }

  const validBoundaries = boundaries.filter((b) => b > 0 && b <= text.length);
  const boundaryIndex = validBoundaries.length > 0 ? Math.max(...validBoundaries) : 0;

  const flushable = text.slice(0, boundaryIndex);
  const remainder = text.slice(boundaryIndex);

  return {
    flushable,
    remainder,
    flushText: flushable,
    remainingText: remainder,
  };
}

/**
 * Creates a stream filter with boundary splitting and optional throttling (default 400ms).
 */
export function createMarkdownStreamFilter(
  options?: MarkdownStreamFilterOptions
): MarkdownStreamFilter {
  const minIntervalMs = options?.minIntervalMs ?? 400;
  const clock = options?.clock ?? (() => Date.now());

  let buffer = '';
  let lastFlushTime: number | null = null;

  function tryFlush(force: boolean = false): string {
    if (force) {
      const out = buffer;
      buffer = '';
      lastFlushTime = clock();
      return out;
    }

    const { flushable, remainder } = splitBufferedAssistantText(buffer);
    if (flushable.length > 0) {
      buffer = remainder;
      lastFlushTime = clock();
      return flushable;
    }
    return '';
  }

  const filter: MarkdownStreamFilter = {
    push(chunk: string): string {
      buffer += chunk;
      const now = clock();

      if (minIntervalMs <= 0 || lastFlushTime === null || now - lastFlushTime >= minIntervalMs) {
        return tryFlush(false);
      }

      return '';
    },

    flush(force: boolean = false): string {
      return tryFlush(force);
    },

    finish(): string {
      return tryFlush(true);
    },

    getBuffer(): string {
      return buffer;
    },

    reset(): void {
      buffer = '';
      lastFlushTime = null;
    },

    async *transform(source: AsyncIterable<string>): AsyncGenerator<string, void, unknown> {
      for await (const chunk of source) {
        const flushed = filter.push(chunk);
        if (flushed) yield flushed;
      }
      const rest = filter.finish();
      if (rest) yield rest;
    },
  };

  return filter;
}
