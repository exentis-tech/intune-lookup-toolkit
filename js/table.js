// Results table: status chips, filter, sort, column picker, selection, copy, export, send-to.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');

export function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d) || d.getUTCFullYear() < 1980) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const STATUS_TONE = {
  'Valid': 'ok', 'Found': 'ok', 'Enabled': 'ok',
  'Valid · duplicates': 'warn', 'Not managed': 'warn', 'Entra only': 'warn', 'Intune only': 'warn',
  'Multiple users': 'warn', 'No devices': 'info', 'Disabled': 'muted',
  'Not found': 'bad', 'Invalid input': 'bad', 'Error': 'bad',
};

export const COPY_FORMATS = {
  lines: 'One per line',
  comma: 'Comma-separated',
  quoted: "Quoted ('a','b')",
  dquoted: 'Double-quoted ("a","b")',
};

export function formatValues(values, format) {
  switch (format) {
    case 'comma': return values.join(', ');
    case 'quoted': return values.map(v => `'${String(v).replace(/'/g, "''")}'`).join(',');
    case 'dquoted': return values.map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(',');
    default: return values.join('\n');
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const RENDER_LIMIT = 500;

export class ResultsTable {
  /**
   * @param {HTMLElement} root
   * @param {object} o
   * @param {string} o.id           storage key for column choices
   * @param {(msg:string, err?:boolean) => void} o.toast
   * @param {{key:string,label:string}[]} o.targets   tools results can be sent to
   * @param {(target:string, values:string[]) => void} o.onSend
   */
  constructor(root, { id, toast, targets, onSend }) {
    this.root = root;
    this.id = id;
    this.toast = toast;
    this.targets = targets;
    this.onSend = onSend;
    this.columns = [];
    this.rows = [];
    this.notes = [];
    this.statusHelp = {};
    this.reset();
    root.addEventListener('click', e => this.onClick(e));
    root.addEventListener('change', e => this.onChange(e));
    root.addEventListener('input', e => { if (e.target.matches('[data-filter]')) { this.filter = e.target.value; this.renderBody(); } });
  }

  reset() {
    this.sort = null;
    this.filter = '';
    this.statusFilter = new Set();
    this.selected = new Set();
    this.showAll = false;
  }

  setData({ columns, rows, notes = [], statusHelp = {} }, title = '') {
    this.columns = columns;
    this.rows = rows.map((r, i) => ({ ...r, _i: i }));
    this.notes = notes;
    this.statusHelp = statusHelp;
    this.title = title;
    this.reset();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('ilt.cols.' + this.id) || 'null'); } catch { saved = null; }
    this.hidden = new Set(saved && saved.sig === this.signature() ? saved.hidden : columns.filter(c => c.hidden).map(c => c.key));
    this.copyCol = (columns.find(c => c.id && !this.hidden.has(c.key)) || columns.find(c => !c.status && c.key !== 'input') || columns[0]).key;
    this.render();
  }

  signature() { return this.columns.map(c => c.key).join(','); }

  saveColumns() {
    try { localStorage.setItem('ilt.cols.' + this.id, JSON.stringify({ sig: this.signature(), hidden: [...this.hidden] })); } catch { /* storage blocked */ }
  }

  visibleColumns() { return this.columns.filter(c => !this.hidden.has(c.key)); }

  display(row, col) {
    const v = row[col.key];
    if (col.date) return fmtDate(v);
    return v == null ? '' : String(v);
  }

  /** Rows after status chips, text filter and sort. */
  filteredRows() {
    const f = this.filter.trim().toLowerCase();
    const cols = this.visibleColumns();
    let out = this.rows.filter(r =>
      (!this.statusFilter.size || this.statusFilter.has(r.status)) &&
      (!f || cols.some(c => this.display(r, c).toLowerCase().includes(f))));
    if (this.sort) {
      const col = this.columns.find(c => c.key === this.sort.key);
      const dir = this.sort.dir;
      out = [...out].sort((a, b) => {
        const x = col.num ? Number(a[col.key] || 0) : this.display(a, col);
        const y = col.num ? Number(b[col.key] || 0) : this.display(b, col);
        return (col.num ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })) * dir;
      });
    }
    return out;
  }

  /** Rows that copy / export / send act on: the selection if any, otherwise every filtered row. */
  scopeRows() {
    const rows = this.filteredRows();
    const sel = rows.filter(r => this.selected.has(r._i));
    return sel.length ? sel : rows;
  }

  scopeLabel() {
    const rows = this.filteredRows();
    const sel = rows.filter(r => this.selected.has(r._i)).length;
    return sel ? `${sel} selected row${sel === 1 ? '' : 's'}` : `${rows.length === this.rows.length ? 'all' : 'the'} ${rows.length} shown row${rows.length === 1 ? '' : 's'}`;
  }

  columnValues(key, { unique = true } = {}) {
    const col = this.columns.find(c => c.key === key);
    const vals = this.scopeRows().map(r => this.display(r, col)).filter(v => v !== '');
    return unique ? [...new Set(vals)] : vals;
  }

  // ---------------------------------------------------------------- render

  render() {
    if (!this.rows.length && !this.notes.length) { this.root.innerHTML = ''; return; }
    const counts = {};
    for (const r of this.rows) counts[r.status] = (counts[r.status] || 0) + 1;
    const statuses = Object.keys(counts);
    const chips = statuses.length > 1 || this.statusFilter.size ? `<div class="chips status-chips">
      <button type="button" class="chip-btn ${this.statusFilter.size ? '' : 'on'}" data-status="">All <b>${this.rows.length}</b></button>
      ${statuses.map(s => `<button type="button" class="chip-btn tone-${STATUS_TONE[s] || 'muted'} ${this.statusFilter.has(s) ? 'on' : ''}" data-status="${esc(s)}" title="${esc(this.statusHelp[s] || '')}">${esc(s)} <b>${counts[s]}</b></button>`).join('')}
    </div>` : '';
    const notes = this.notes.length ? `<div class="notes">${this.notes.map(n => `<span>${esc(n)}</span>`).join('')}</div>` : '';
    const colOptions = this.columns.map(c => `<option value="${esc(c.key)}" ${c.key === this.copyCol ? 'selected' : ''}>${esc(c.label)}</option>`).join('');

    this.root.innerHTML = `
      <div class="results-head">
        <h2>${esc(this.title)} <span class="muted">${this.rows.length} row${this.rows.length === 1 ? '' : 's'}</span></h2>
        ${notes}
      </div>
      ${chips}
      <div class="results-tools">
        <input type="search" data-filter placeholder="Filter rows…" value="${esc(this.filter)}" aria-label="Filter rows">
        <details class="menu" data-colmenu>
          <summary class="btn ghost">Columns</summary>
          <div class="menu-body">
            ${this.columns.map(c => `<label class="check"><input type="checkbox" data-col="${esc(c.key)}" ${this.hidden.has(c.key) ? '' : 'checked'}> ${esc(c.label)}</label>`).join('')}
          </div>
        </details>
        <span class="sep"></span>
        <label class="inline-label">Column <select data-copycol>${colOptions}</select></label>
        <select data-copyfmt aria-label="Copy format">${Object.entries(COPY_FORMATS).map(([k, v]) => `<option value="${k}" ${k === (this.copyFmt || 'lines') ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <button type="button" class="btn primary" data-act="copycol">Copy values</button>
        <select data-sendto aria-label="Send to">
          <option value="">Send to…</option>
          ${this.targets.map(t => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join('')}
        </select>
        <span class="grow"></span>
        <button type="button" class="btn" data-act="copytable" title="Tab-separated, pastes straight into Excel">Copy table</button>
        <button type="button" class="btn" data-act="csv">Export CSV</button>
      </div>
      <p class="scope" data-scope></p>
      <div class="table-wrap"><table>
        <thead data-head></thead>
        <tbody data-body></tbody>
      </table></div>
      <div data-more></div>`;
    this.renderBody();
  }

  renderBody() {
    const cols = this.visibleColumns();
    const rows = this.filteredRows();
    const shown = this.showAll ? rows : rows.slice(0, RENDER_LIMIT);
    const allSel = rows.length > 0 && rows.every(r => this.selected.has(r._i));
    const head = this.root.querySelector('[data-head]');
    if (!head) return;
    head.innerHTML = `<tr><th class="sel"><input type="checkbox" data-selall ${allSel ? 'checked' : ''} aria-label="Select all shown rows"></th>${cols.map(c => {
      const s = this.sort && this.sort.key === c.key ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : '';
      return `<th class="${c.num ? 'num' : ''}"><span class="th"><button type="button" class="sort" data-sort="${esc(c.key)}">${esc(c.label)}${s}</button><button type="button" class="copy-col" data-copy="${esc(c.key)}" title="Copy unique values of this column">⧉</button></span></th>`;
    }).join('')}</tr>`;
    this.root.querySelector('[data-body]').innerHTML = shown.map(r => `<tr class="${this.selected.has(r._i) ? 'selected' : ''}">
      <td class="sel"><input type="checkbox" data-row="${r._i}" ${this.selected.has(r._i) ? 'checked' : ''} aria-label="Select row"></td>
      ${cols.map(c => {
        const v = this.display(r, c);
        if (c.status) return `<td><span class="chip tone-${STATUS_TONE[v] || 'muted'}" title="${esc(this.statusHelp[v] || '')}">${esc(v)}</span></td>`;
        return `<td class="${c.id || c.mono ? 'mono' : ''} ${c.num ? 'num' : ''} ${v ? 'copyable' : ''}" ${v ? `data-cell="${esc(c.key)}"` : ''}>${esc(v)}</td>`;
      }).join('')}
    </tr>`).join('') || `<tr><td colspan="${cols.length + 1}" class="empty">No rows match the filter.</td></tr>`;
    this.root.querySelector('[data-more]').innerHTML = rows.length > shown.length
      ? `<div class="more">Showing ${shown.length} of ${rows.length} rows (copy and export include all of them). <button type="button" class="btn small" data-act="showall">Show all</button></div>` : '';
    this.root.querySelector('[data-scope]').textContent = `Copy, export and send use ${this.scopeLabel()}. Click any cell to copy it.`;
  }

  // ---------------------------------------------------------------- actions

  async copyColumn(key) {
    const col = this.columns.find(c => c.key === key);
    const vals = this.columnValues(key);
    if (!vals.length) return this.toast(`No ${col.label} values to copy.`);
    const ok = await copyText(formatValues(vals, this.copyFmt || 'lines'));
    this.toast(ok ? `Copied ${vals.length} unique ${col.label} value${vals.length === 1 ? '' : 's'}.` : 'Copy failed — your browser blocked the clipboard.', !ok);
  }

  tableText(sep, cellFn) {
    const cols = this.visibleColumns();
    const lines = [cols.map(c => cellFn(c.label)).join(sep)];
    for (const r of this.scopeRows()) lines.push(cols.map(c => cellFn(this.display(r, c))).join(sep));
    return lines.join('\r\n');
  }

  async copyTable() {
    const text = this.tableText('\t', v => String(v).replace(/[\t\r\n]+/g, ' '));
    const ok = await copyText(text);
    this.toast(ok ? `Copied ${this.scopeRows().length} rows — paste into Excel.` : 'Copy failed.', !ok);
  }

  exportCsv() {
    const text = '﻿' + this.tableText(',', csvCell);
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `${this.id}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  onClick(e) {
    const t = e.target;
    if (t.matches('[data-row]')) {
      // Shift-click selects the range from the last clicked row.
      const i = Number(t.dataset.row);
      const order = this.filteredRows().map(r => r._i);
      if (e.shiftKey && this.lastRow != null && order.includes(this.lastRow)) {
        const [a, b] = [order.indexOf(this.lastRow), order.indexOf(i)].sort((x, y) => x - y);
        order.slice(a, b + 1).forEach(k => (t.checked ? this.selected.add(k) : this.selected.delete(k)));
      } else {
        t.checked ? this.selected.add(i) : this.selected.delete(i);
      }
      this.lastRow = i;
      return this.renderBody();
    }
    const status = t.closest('[data-status]');
    if (status) {
      const s = status.dataset.status;
      if (!s) this.statusFilter.clear();
      else if (this.statusFilter.has(s)) this.statusFilter.delete(s);
      else if (e.ctrlKey || e.metaKey || e.shiftKey) this.statusFilter.add(s);
      else this.statusFilter = new Set([s]);
      this.selected.clear();
      return this.render();
    }
    const sort = t.closest('[data-sort]');
    if (sort) {
      const key = sort.dataset.sort;
      this.sort = this.sort && this.sort.key === key ? (this.sort.dir > 0 ? { key, dir: -1 } : null) : { key, dir: 1 };
      return this.renderBody();
    }
    const copy = t.closest('[data-copy]');
    if (copy) return this.copyColumn(copy.dataset.copy);
    const act = t.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'copycol') return this.copyColumn(this.copyCol);
      if (act.dataset.act === 'copytable') return this.copyTable();
      if (act.dataset.act === 'csv') return this.exportCsv();
      if (act.dataset.act === 'showall') { this.showAll = true; return this.renderBody(); }
    }
    const cell = t.closest('[data-cell]');
    if (cell && !String(window.getSelection && window.getSelection()).trim()) {
      copyText(cell.textContent).then(ok => this.toast(ok ? `Copied ${cell.textContent}` : 'Copy failed.', !ok));
    }
    // close the column menu when clicking elsewhere
    const menu = this.root.querySelector('[data-colmenu]');
    if (menu && menu.open && !t.closest('[data-colmenu]')) menu.open = false;
  }

  onChange(e) {
    const t = e.target;
    if (t.matches('[data-col]')) {
      t.checked ? this.hidden.delete(t.dataset.col) : this.hidden.add(t.dataset.col);
      this.saveColumns();
      return this.renderBody();
    }
    if (t.matches('[data-copycol]')) { this.copyCol = t.value; return; }
    if (t.matches('[data-copyfmt]')) { this.copyFmt = t.value; return; }
    if (t.matches('[data-sendto]')) {
      const target = t.value;
      t.value = '';
      if (!target) return;
      const vals = this.columnValues(this.copyCol);
      const col = this.columns.find(c => c.key === this.copyCol);
      if (!vals.length) return this.toast(`No ${col.label} values to send.`);
      return this.onSend(target, vals, col.label);
    }
    if (t.matches('[data-selall]')) {
      const rows = this.filteredRows();
      rows.forEach(r => (t.checked ? this.selected.add(r._i) : this.selected.delete(r._i)));
      return this.renderBody();
    }
  }
}
