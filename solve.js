// Fast CSV parser, byte-exact equivalent to csv-reader 1.0.0 (design v3).
// run(input) is pure: every mutable state lives in run()'s own scope.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const columns = null;
  let columnsOut = columns;
  const rows = [];
  const errors = [];
  let width = -1;

  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;
  const n = text.length;

  let recordLine = 1;
  let recordRow = null;

  // Monotone cursors: first occurrence of the char at index >= pos, or n if none.
  // Stale (< pos) cursors are refreshed on use; only the unterminated-quote
  // rollback resets them (once per whole text at most).
  let nextLF = -1;
  let nextQuote = -1;
  let nextCR = -1;
  let nextComma = -1;

  // Accumulated line breaks inside a quoted field, committed only on close.
  let lineDelta = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  function refreshLF() {
    if (nextLF < pos) {
      nextLF = text.indexOf('\n', pos);
      if (nextLF < 0) nextLF = n;
    }
  }
  function refreshQuote() {
    if (nextQuote < pos) {
      nextQuote = text.indexOf('"', pos);
      if (nextQuote < 0) nextQuote = n;
    }
  }
  function refreshCR() {
    if (nextCR < pos) {
      nextCR = text.indexOf('\r', pos);
      if (nextCR < 0) nextCR = n;
    }
  }
  function refreshComma() {
    if (nextComma < pos) {
      nextComma = text.indexOf(',', pos);
      if (nextComma < 0) nextComma = n;
    }
  }

  // Fold [a, b) into the quoted value (via lineDelta), using only cursors to
  // decide whether the segment contains CR/LF. No unbounded indexOf on text.
  function segment(a, b) {
    refreshCR();
    refreshLF();
    if (nextCR >= b && nextLF >= b) {
      return text.slice(a, b);
    }
    if (nextCR >= b && nextLF < b) {
      const seg = text.slice(a, b);
      for (let i = 0; i < seg.length; i++) if (seg.charCodeAt(i) === 10) lineDelta += 1;
      return seg;
    }
    const seg = text.slice(a, b).replace(/\r\n?/g, '\n');
    for (let i = 0; i < seg.length; i++) if (seg.charCodeAt(i) === 10) lineDelta += 1;
    return seg;
  }

  // Scan an unquoted field onto initValue. Returns {value, ended, added}.
  function readUnquoted(initValue) {
    let value = initValue;
    let added = 0;
    while (true) {
      refreshComma();
      refreshLF();
      refreshCR();
      let k = nextComma < nextLF ? nextComma : nextLF;
      if (nextCR < k) k = nextCR;

      if (k > pos) {
        value = value.length === 0 ? text.slice(pos, k) : value + text.slice(pos, k);
        added += k - pos;
      }
      if (k === n) {
        pos = n;
        return { value, ended: END, added };
      }
      const c = text.charCodeAt(k);
      if (c === 44) {
        pos = k + 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        pos = k + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // c === 13
      if (text.charCodeAt(k + 1) === 10) {
        pos = k + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      error('stray_cr');
      pos = k + 1;
    }
  }

  // Scan a quoted field whose opening quote sits at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos = open + 1;
    let value = '';
    lineDelta = 0;
    while (true) {
      refreshQuote();
      const j = nextQuote;
      if (j === n) {
        // Unterminated: discard accumulated value and line increments,
        // roll back pos and reset all cursors, then re-read as unquoted.
        pos = open + 1;
        line = openLine;
        nextLF = nextQuote = nextCR = nextComma = -1;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(j + 1) === 34) {
        value += segment(pos, j);
        value += '"';
        pos = j + 2;
        continue;
      }
      value += segment(pos, j);
      line += lineDelta;
      pos = j + 1;
      if (pos >= n) return { value, ended: END };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      const junk = readUnquoted(value);
      if (junk.added > 0) error('quote_junk');
      return junk;
    }
  }

  while (pos < n) {
    refreshLF();
    const nl = nextLF;
    let end = nl;
    if (nl < n && end > pos && text.charCodeAt(end - 1) === 13) end -= 1;
    if (end === pos) {
      line += 1;
      pos = nl < n ? nl + 1 : n;
      continue;
    }

    recordLine = line;
    recordRow = header && columnsOut === null ? null : rows.length;

    refreshQuote();
    refreshCR();
    const q = nextQuote;
    const r = nextCR;
    const hasQuote = q < end;
    const hasCR = r < end;

    let fields;
    let quoted;
    if (!hasQuote && !hasCR) {
      fields = text.slice(pos, end).split(',');
      quoted = false;
      line += 1;
      pos = nl < n ? nl + 1 : n;
    } else {
      fields = [];
      let field;
      do {
        quoted = text.charCodeAt(pos) === 34;
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
    }

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    if (width < 0) width = fields.length;
    if (header && columnsOut === null) {
      columnsOut = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columnsOut ?? []) : null, rows, errors };
}
