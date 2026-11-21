// Fast CSV parser, byte-exact equivalent to csv-reader 1.0.0 (design v4, Carbon C1-C6).
// Module scope holds only constants and pure functions; all mutable state lives in run(input).
import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-turbofan');

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// C5: exact-capacity PACKED_ELEMENTS rows. Switch literals for the generator widths
// (8..18); a push('') fallback for any other width. Trailing slots pre-filled ''.
function allocRow(w) {
  switch (w) {
    case 8: return ['', '', '', '', '', '', '', ''];
    case 9: return ['', '', '', '', '', '', '', '', ''];
    case 10: return ['', '', '', '', '', '', '', '', '', ''];
    case 11: return ['', '', '', '', '', '', '', '', '', '', ''];
    case 12: return ['', '', '', '', '', '', '', '', '', '', '', ''];
    case 13: return ['', '', '', '', '', '', '', '', '', '', '', '', ''];
    case 14: return ['', '', '', '', '', '', '', '', '', '', '', '', '', ''];
    case 15: return ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
    case 16: return ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
    case 17: return ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
    case 18: return ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
    default: { const a = []; for (let i = 0; i < w; i++) a.push(''); return a; }
  }
}

// C2: pure-JS CRLF normalization of [a, b) (replaces /\r\n?/g -> '\n'), accumulating
// the number of resulting '\n' into s.lineDelta. Only called when a CR is proven inside.
function normalizeCRLF(text, a, b, s) {
  let out = '';
  let cur = a;
  while (cur < b) {
    const r = text.indexOf('\r', cur);
    if (r < 0 || r >= b) {
      for (let i = cur; i < b; i++) if (text.charCodeAt(i) === 10) s.lineDelta += 1;
      out += text.slice(cur, b);
      break;
    }
    for (let i = cur; i < r; i++) if (text.charCodeAt(i) === 10) s.lineDelta += 1;
    out += text.slice(cur, r) + '\n';
    s.lineDelta += 1;
    cur = (r + 1 < b && text.charCodeAt(r + 1) === 10) ? r + 2 : r + 1;
  }
  return out;
}

// C2/N2: segment [a, b) into a quoted value, using only cached cursors to decide
// whether a CR/LF scan is needed. No unbounded indexOf on the whole text.
function segmentSlow(s, a, b) {
  if (s.nextCR < a) { s.nextCR = s.text.indexOf('\r', a); if (s.nextCR < 0) s.nextCR = s.n; }
  if (s.nextLF < a) { s.nextLF = s.text.indexOf('\n', a); if (s.nextLF < 0) s.nextLF = s.n; }
  if (s.nextCR >= b && s.nextLF >= b) return s.text.slice(a, b);
  if (s.nextCR >= b) {
    const seg = s.text.slice(a, b);
    for (let i = 0; i < seg.length; i++) if (seg.charCodeAt(i) === 10) s.lineDelta += 1;
    return seg;
  }
  return normalizeCRLF(s.text, a, b, s);
}

// C2/Rule5: unquoted scan onto initValue, scalar s.ended / s.added return channel.
function readUnquotedSlow(s, initValue) {
  const text = s.text;
  const n = s.n;
  let value = initValue;
  let added = 0;
  for (;;) {
    if (s.nextComma < s.pos) { s.nextComma = text.indexOf(',', s.pos); if (s.nextComma < 0) s.nextComma = n; }
    if (s.nextLF < s.pos) { s.nextLF = text.indexOf('\n', s.pos); if (s.nextLF < 0) s.nextLF = n; }
    if (s.nextCR < s.pos) { s.nextCR = text.indexOf('\r', s.pos); if (s.nextCR < 0) s.nextCR = n; }
    let k = s.nextComma < s.nextLF ? s.nextComma : s.nextLF;
    if (s.nextCR < k) k = s.nextCR;
    if (k > s.pos) {
      value = value.length === 0 ? text.slice(s.pos, k) : value + text.slice(s.pos, k);
      added += k - s.pos;
    }
    if (k === n) { s.pos = n; s.ended = END; s.added = added; return value; }
    const c = text.charCodeAt(k);
    if (c === 44) { s.pos = k + 1; s.ended = COMMA; s.added = added; return value; }
    if (c === 10) { s.pos = k + 1; s.line += 1; s.ended = LINE_BREAK; s.added = added; return value; }
    if (text.charCodeAt(k + 1) === 10) { s.pos = k + 2; s.line += 1; s.ended = LINE_BREAK; s.added = added; return value; }
    s.errors.push({ code: 'stray_cr', line: s.recordLine, row: s.recordRow });
    s.pos = k + 1;
  }
}

// C1/C2/Rule5: quoted field state machine; scalar s.ended return channel.
function readQuotedSlow(s) {
  const text = s.text;
  const n = s.n;
  const open = s.pos;
  const openLine = s.line;
  s.pos = open + 1; // D2
  let value = '';
  s.lineDelta = 0;
  for (;;) {
    if (s.nextQuote < s.pos) { s.nextQuote = text.indexOf('"', s.pos); if (s.nextQuote < 0) s.nextQuote = n; }
    const j = s.nextQuote;
    if (j === n) {
      // N1: mandatory cursor reset on unterminated_quote, plus D6 value/line rollback.
      s.pos = open + 1;
      s.line = openLine;
      s.nextLF = s.nextQuote = s.nextCR = s.nextComma = -1;
      s.errors.push({ code: 'unterminated_quote', line: s.recordLine, row: s.recordRow });
      return readUnquotedSlow(s, '"');
    }
    if (text.charCodeAt(j + 1) === 34) {
      const seg = segmentSlow(s, s.pos, j);
      value = value.length === 0 ? seg + '"' : value + seg + '"';
      s.pos = j + 2;
      continue;
    }
    const seg = segmentSlow(s, s.pos, j);
    value = value.length === 0 ? seg : value + seg;
    s.line += s.lineDelta; // D6: commit accumulated line breaks only on close
    const after = j + 1;
    s.pos = after;
    if (after >= n) { s.ended = END; return value; }
    const c = text.charCodeAt(after);
    if (c === 44) { s.pos = after + 1; s.ended = COMMA; return value; }
    if (c === 10) { s.pos = after + 1; s.line += 1; s.ended = LINE_BREAK; return value; }
    if (c === 13 && text.charCodeAt(after + 1) === 10) { s.pos = after + 2; s.line += 1; s.ended = LINE_BREAK; return value; }
    const junk = readUnquotedSlow(s, value);
    if (s.added > 0) s.errors.push({ code: 'quote_junk', line: s.recordLine, row: s.recordRow });
    return junk;
  }
}

// C1/C3: sync the hot-loop scalars into s, read one slow field, and on COMMA
// refresh the line cursors (a multiline quoted field moves pos to a later line).
function readSlowFieldAndSync(s, isQuoted, pos, line, nextLF, nextQuote, nextCR, nextComma, recordLine, recordRow) {
  s.pos = pos; s.line = line; s.nextLF = nextLF; s.nextQuote = nextQuote;
  s.nextCR = nextCR; s.nextComma = nextComma; s.recordLine = recordLine; s.recordRow = recordRow;
  const val = isQuoted ? readQuotedSlow(s) : readUnquotedSlow(s, '');
  if (s.ended === COMMA) {
    if (s.nextLF < s.pos) { s.nextLF = s.text.indexOf('\n', s.pos); if (s.nextLF < 0) s.nextLF = s.n; }
    if (s.nextCR < s.pos) { s.nextCR = s.text.indexOf('\r', s.pos); if (s.nextCR < 0) s.nextCR = s.n; }
  }
  return val;
}

// C3: read the fields beyond `width` for a long row, then record the long_row error.
function finishLongRow(s, pos, line, nextLF, nextQuote, nextCR, nextComma, recordLine, recordRow) {
  s.pos = pos; s.line = line; s.nextLF = nextLF; s.nextQuote = nextQuote;
  s.nextCR = nextCR; s.nextComma = nextComma; s.recordLine = recordLine; s.recordRow = recordRow;
  const extra = [];
  do {
    const q = s.text.charCodeAt(s.pos) === 34;
    extra.push(q ? readQuotedSlow(s) : readUnquotedSlow(s, ''));
  } while (s.ended === COMMA);
  s.errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra });
}

// C3: find the first valid record (width setter). Handles header assignment and any
// leading blank / stray-cr-only lines. Returns null at EOF with no valid record.
function readFirstValidRecord(s, header, rows) {
  const text = s.text;
  const n = s.n;
  while (s.pos < n) {
    if (s.nextLF < s.pos) { s.nextLF = text.indexOf('\n', s.pos); if (s.nextLF < 0) s.nextLF = n; }
    const nl = s.nextLF;
    let end = nl;
    if (nl < n && end > s.pos && text.charCodeAt(end - 1) === 13) end -= 1; // D1
    if (end === s.pos) {
      s.line += 1;
      s.pos = nl < n ? nl + 1 : n;
      continue;
    }
    s.recordLine = s.line;
    s.recordRow = header ? null : 0; // D3 / §1.15
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(s.pos) === 34; // D7
      fields.push(quoted ? readQuotedSlow(s) : readUnquotedSlow(s, ''));
    } while (s.ended === COMMA);
    if (fields.length === 1 && fields[0] === '' && !quoted) continue; // §1.8
    if (!header) rows.push(fields);
    return fields;
  }
  return null;
}

// C4: unified monomorphic hot loop. Hot cursors are unboxed Smi locals; only the
// ~1.5% slow fields call into the top-level helpers.
function parseBody(text, n, width, rows, errors, s) {
  let pos = s.pos, line = s.line, nextLF = s.nextLF, nextQuote = s.nextQuote, nextCR = s.nextCR, nextComma = s.nextComma;
  while (pos < n) {
    if (nextLF < pos) { nextLF = text.indexOf('\n', pos); if (nextLF < 0) nextLF = n; }
    let nl = nextLF;
    let end = nl;
    if (nl < n && end > pos && text.charCodeAt(end - 1) === 13) end -= 1; // D1
    if (end === pos) { line += 1; pos = nl < n ? nl + 1 : n; continue; } // §1.3
    const recordLine = line;
    const recordRow = rows.length; // D3: monomorphic Smi (header handled in readFirstValidRecord)
    if (nextCR < pos) { nextCR = text.indexOf('\r', pos); if (nextCR < 0) nextCR = n; }
    let r = nextCR;
    const fields = allocRow(width);
    let col = 0;
    let ended = COMMA;
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        // Branch 1: quoted field.
        quoted = true;
        const p1 = pos + 1; // D2
        if (nextQuote < p1) { nextQuote = text.indexOf('"', p1); if (nextQuote < 0) nextQuote = n; }
        const j = nextQuote;
        if (j < end && r >= j) {
          const after = j + 1;
          if (after === end) {
            fields[col++] = text.slice(p1, j);
            if (nl < n) { pos = nl + 1; line += 1; ended = LINE_BREAK; } else { pos = n; ended = END; }
            break;
          }
          if (text.charCodeAt(after) === 44) {
            fields[col++] = text.slice(p1, j);
            pos = after + 1;
            ended = COMMA;
            continue;
          }
        }
        fields[col++] = readSlowFieldAndSync(s, true, pos, line, nextLF, nextQuote, r, nextComma, recordLine, recordRow);
        pos = s.pos; line = s.line; nextLF = s.nextLF; nextQuote = s.nextQuote; nextCR = s.nextCR; nextComma = s.nextComma; ended = s.ended;
        if (ended === COMMA) {
          nl = nextLF;
          end = nl < n && nl > pos && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
          r = nextCR;
        }
      } else if (r >= end) {
        // Branch 2: unquoted field with no CR on this line (99.6% of unquoted).
        quoted = false;
        if (nextComma < pos) { nextComma = text.indexOf(',', pos); if (nextComma < 0) nextComma = n; }
        const cPos = nextComma;
        if (cPos < end) {
          fields[col++] = text.slice(pos, cPos);
          pos = cPos + 1;
          ended = COMMA;
        } else {
          fields[col++] = text.slice(pos, end);
          if (nl < n) { pos = nl + 1; line += 1; ended = LINE_BREAK; } else { pos = n; ended = END; }
          break;
        }
      } else {
        // Branch 3: unquoted field on a line with a stray CR.
        quoted = false;
        fields[col++] = readSlowFieldAndSync(s, false, pos, line, nextLF, nextQuote, r, nextComma, recordLine, recordRow);
        pos = s.pos; line = s.line; nextLF = s.nextLF; nextQuote = s.nextQuote; nextCR = s.nextCR; nextComma = s.nextComma; ended = s.ended;
        if (ended === COMMA) {
          nl = nextLF;
          end = nl < n && nl > pos && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
          r = nextCR;
        }
      }
    } while (ended === COMMA && col < width);

    // Post-loop row finalization (§1.8, §1.11, §1.12).
    if (ended === COMMA) {
      finishLongRow(s, pos, line, nextLF, nextQuote, nextCR, nextComma, recordLine, recordRow);
      pos = s.pos; line = s.line; nextLF = s.nextLF; nextQuote = s.nextQuote; nextCR = s.nextCR; nextComma = s.nextComma;
    } else if (col < width) {
      if (col === 1 && !quoted && fields[0] === '') continue; // §1.8
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: col });
    } else if (width === 1 && !quoted && fields[0] === '') {
      continue; // §1.8 for single-column CSVs
    }
    rows.push(fields);
  }
}

// C1/C3/N4: entry point. Fresh state per call; no cross-case state.
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const rows = [];
  const errors = [];
  const s = {
    text, n,
    pos: text.charCodeAt(0) === 0xFEFF ? 1 : 0,
    line: 1,
    recordLine: 1,
    recordRow: null,
    nextLF: -1,
    nextQuote: -1,
    nextCR: -1,
    nextComma: -1,
    lineDelta: 0,
    ended: 0,
    added: 0,
    errors,
  };
  const first = readFirstValidRecord(s, header, rows);
  if (first === null) return { columns: header ? [] : null, rows, errors };
  const width = first.length;
  const columnsOut = header ? first : null;
  if (s.pos < n) parseBody(text, n, width, rows, errors, s);
  return { columns: columnsOut, rows, errors };
}
