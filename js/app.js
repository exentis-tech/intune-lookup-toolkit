import { Graph } from './graph.js';
import * as L from './lookups.js';
import { ResultsTable } from './table.js';
import { createDemoTenant } from './mock.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 2600);
}

const options = (obj, selected) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');

// ---------------------------------------------------------------- tools

const TOOLS = {
  devices: {
    tab: 'Devices',
    label: 'Device names, serial numbers or IDs',
    placeholder: 'LAPTOP-0042\n5CG1234ABC\n0e2959f2-946f-4b20-a3d4-d7679b8e899d\nLAPTOP-0007\tjane.doe@contoso.com',
    help: 'One per line. Any mix works: device names, serial numbers, Entra device IDs, Entra object IDs or Intune device IDs. Add a second column (paste two columns from Excel, or use , or ;) with the user or serial to pick the right device when a name is duplicated.',
    side: `
      <label>Input type <select name="type">${options(L.DEVICE_TYPES, 'auto')}</select></label>
      <fieldset><legend>Results</legend>
        <div class="radio-row">
          <label class="check"><input type="radio" name="mode" value="best" checked> Best match per input</label>
          <label class="check"><input type="radio" name="mode" value="all"> Every match</label>
        </div>
      </fieldset>
      <label class="check"><input type="checkbox" name="withUser"> Add primary user details (country, usage location, department)</label>`,
    opts: f => ({ type: f.type.value, mode: f.querySelector('[name=mode]:checked').value, withUser: f.withUser.checked }),
    run: (g, items, o, p) => L.resolveDevices(g, items, o, p),
    title: o => (o.mode === 'all' ? 'Devices — every match' : 'Devices'),
  },
  users: {
    tab: 'Users',
    label: 'Users',
    placeholder: 'jane.doe@contoso.com\npaul.martin@contoso.fr\nOmar Haddad',
    help: 'One per line: UPN, email address, display name or object ID.',
    side: `
      <label>Show <select name="mode">${options(L.USER_MODES, 'details')}</select></label>
      <p class="hint">“Their Intune devices” lists devices where the user is the primary user, with Intune, Entra device and Entra object IDs.</p>`,
    opts: f => ({ mode: f.mode.value }),
    run: (g, items, o, p) => L.resolveUsers(g, items, o, p),
    title: o => (o.mode === 'devices' ? 'User devices' : 'Users'),
  },
  groups: {
    tab: 'Groups',
    label: 'Groups',
    placeholder: 'SG-All-Staff\nSG-Pilot-Ring',
    help: 'One per line: group display name or object ID. Members of several groups appear once, with all their source groups.',
    side: `
      <label>Members <select name="members">${options(L.GROUP_MEMBER_TYPES, 'users')}</select></label>
      <label class="check"><input type="checkbox" name="transitive" checked> Include members of nested groups</label>`,
    opts: f => ({ members: f.members.value, transitive: f.transitive.checked }),
    run: (g, items, o, p) => L.resolveGroupMembers(g, items, o, p),
    title: () => 'Group members',
  },
};

const SEND_TARGETS = [
  { key: 'devices', label: 'Devices lookup' },
  { key: 'users', label: 'Users lookup' },
  { key: 'groups', label: 'Groups lookup' },
];

const S = { graph: null, demo: null, tab: 'devices', tables: {}, busy: null };

// ---------------------------------------------------------------- boot

async function init() {
  buildTools();
  $('#demoBtn').onclick = () => startDemo();
  $('#fileInput').addEventListener('change', onFile);
  const backend = await detectBackend();
  if (backend) return start(backend, null);
  $('#start').hidden = false;
}

async function detectBackend() {
  if (location.protocol === 'file:') {
    $('#startError').textContent = 'Opened from disk. Start server.ps1 and use the address it prints.';
    return null;
  }
  try {
    const res = await fetch('api/session', { cache: 'no-store' });
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      if (j && j.error) $('#startError').textContent = `Local server: ${j.error.message}`;
      return null;
    }
    return j && j.mode === 'app' && j.sessionToken ? j : null;
  } catch {
    return null;
  }
}

function startDemo() {
  const demo = createDemoTenant();
  start(demo.session, demo);
}

function start(session, demo) {
  S.demo = demo;
  S.graph = new Graph({ mock: demo, backend: demo ? null : session });
  $('#start').hidden = true;
  $('#workspace').hidden = false;
  $('#roBadge').hidden = false;
  $('#who').innerHTML = `<span title="${esc(session.applicationId || '')}"><b>${esc(session.appDisplayName || 'App registration')}</b> · ${esc(session.tenantLabel || session.tenantId || '')}</span>`
    + (demo ? '<button class="btn small ghost" type="button" id="leaveDemo">Leave demo</button>' : '');
  if (demo) $('#leaveDemo').onclick = () => location.reload();
  const banner = $('#banner');
  banner.hidden = !demo && !missingPerms(session).length;
  banner.textContent = demo
    ? 'Demo tenant — fictitious data held in this tab. Use “Load sample” on each tool.'
    : `The app registration is missing: ${missingPerms(session).join(', ')}. Some lookups will fail — see README.`;
  $$('[data-sample]').forEach(b => { b.hidden = !demo; });
  switchTab('devices');
}

function missingPerms(session) {
  const roles = new Set(session.roles || []);
  if (!session.roles) return [];
  const need = {
    'DeviceManagementManagedDevices.Read.All': ['DeviceManagementManagedDevices.ReadWrite.All'],
    'Device.Read.All': ['Directory.Read.All', 'Directory.ReadWrite.All', 'Device.ReadWrite.All'],
    'User.Read.All': ['Directory.Read.All', 'Directory.ReadWrite.All', 'User.ReadWrite.All'],
    'GroupMember.Read.All': ['Group.Read.All', 'Group.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All'],
  };
  return Object.entries(need).filter(([k, alts]) => !roles.has(k) && !alts.some(a => roles.has(a))).map(([k]) => k);
}

// ---------------------------------------------------------------- UI

function buildTools() {
  $('#tabs').innerHTML = Object.entries(TOOLS).map(([k, t]) => `<button role="tab" type="button" data-tab="${k}" aria-selected="false">${esc(t.tab)}</button>`).join('');
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); });
  $('#tools').innerHTML = Object.entries(TOOLS).map(([k, t]) => `
    <div class="tool" data-tool="${k}" hidden>
      <form class="panel" data-form="${k}" autocomplete="off">
        <div class="input-grid">
          <div class="input-main">
            <label for="in-${k}">${esc(t.label)} <span class="muted">— paste a list, or drop a CSV file here</span></label>
            <textarea id="in-${k}" name="input" spellcheck="false" placeholder="${esc(t.placeholder)}"></textarea>
            <div class="input-meta" data-meta></div>
            <p class="hint">${esc(t.help)} <kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs.</p>
          </div>
          <div class="input-side">
            ${t.side}
            <div class="row">
              <button class="btn primary" type="submit" data-run>Run lookup</button>
              <button class="btn" type="button" data-csv>Load CSV…</button>
              <button class="btn ghost" type="button" data-clear>Clear</button>
              <button class="btn ghost" type="button" data-sample hidden>Load sample</button>
            </div>
          </div>
        </div>
        <div class="progress-wrap" data-progress hidden>
          <div class="progress"><i></i></div>
          <button class="btn small" type="button" data-cancel>Cancel</button>
          <div class="sub" data-stage></div>
        </div>
      </form>
      <div class="results" data-results></div>
    </div>`).join('');

  for (const k of Object.keys(TOOLS)) {
    const box = $(`[data-tool="${k}"]`);
    const form = $('form', box);
    S.tables[k] = new ResultsTable($('[data-results]', box), { id: k, toast, targets: SEND_TARGETS, onSend: sendTo });
    form.addEventListener('submit', e => { e.preventDefault(); run(k); });
    form.input.addEventListener('input', () => updateMeta(k));
    form.input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(k); } });
    $('[data-clear]', box).onclick = () => { form.input.value = ''; updateMeta(k); form.input.focus(); };
    $('[data-csv]', box).onclick = () => { S.csvTarget = k; $('#fileInput').click(); };
    $('[data-sample]', box).onclick = () => { form.input.value = S.demo.samples[k]; updateMeta(k); };
    $('[data-cancel]', box).onclick = () => { if (S.graph) S.graph.cancelled = true; };
    // drag & drop a CSV / text file onto the input
    const ta = form.input;
    ta.addEventListener('dragover', e => { e.preventDefault(); ta.classList.add('drop'); });
    ta.addEventListener('dragleave', () => ta.classList.remove('drop'));
    ta.addEventListener('drop', e => {
      e.preventDefault();
      ta.classList.remove('drop');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) { S.csvTarget = k; readFile(f); }
    });
  }
}

function switchTab(tab) {
  S.tab = tab;
  $$('#tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('[data-tool]').forEach(t => { t.hidden = t.dataset.tool !== tab; });
  const ta = $(`[data-form="${tab}"]`).input;
  setTimeout(() => ta.focus(), 0);
}

function updateMeta(k) {
  const form = $(`[data-form="${k}"]`);
  const { items, duplicates, header } = L.parseInput(form.input.value);
  const hints = items.filter(i => i.hint).length;
  const parts = [];
  if (items.length) parts.push(`<b>${plural(items.length, 'item')}</b>`);
  if (hints) parts.push(`${hints} with a hint`);
  if (duplicates) parts.push(`${plural(duplicates, 'duplicate')} removed`);
  if (header) parts.push(`header “${esc(header)}” skipped`);
  $('[data-meta]', form).innerHTML = parts.join(' · ');
}

function sendTo(target, values, label) {
  const form = $(`[data-form="${target}"]`);
  form.input.value = values.join('\n');
  updateMeta(target);
  switchTab(target);
  toast(`${plural(values.length, label + ' value')} sent to ${TOOLS[target].tab}. Choose options and run.`);
}

async function run(k) {
  if (S.busy) return toast('A lookup is already running.');
  const tool = TOOLS[k];
  const form = $(`[data-form="${k}"]`);
  const { items } = L.parseInput(form.input.value);
  if (!items.length) { toast('Paste at least one value.'); form.input.focus(); return; }
  if (items.length > 5000 && !confirm(`${items.length} items will take a while. Continue?`)) return;
  const opts = tool.opts(form);
  const prog = $('[data-progress]', form);
  const bar = $('.progress > i', prog);
  const stage = $('[data-stage]', prog);
  S.busy = k;
  S.graph.cancelled = false;
  prog.hidden = false;
  bar.style.width = '0';
  $('[data-run]', form).disabled = true;
  const t0 = performance.now();
  try {
    const result = await tool.run(S.graph, items, opts, (s, d, t) => {
      stage.textContent = t ? `${s}… ${d}/${t}` : `${s}…`;
      bar.style.width = t ? `${Math.round((d / t) * 100)}%` : '0';
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    S.tables[k].setData(result, `${tool.title(opts)} · ${plural(items.length, 'input')} · ${secs} s`);
  } catch (e) {
    if (e.cancelled) toast('Lookup cancelled.');
    else {
      console.error(e);
      toast(e.code === 'SessionInvalid' ? 'The local server was restarted. Reload the page.' : `Lookup failed: ${e.message}`, true);
    }
  } finally {
    S.busy = null;
    prog.hidden = true;
    $('[data-run]', form).disabled = false;
  }
}

// ---------------------------------------------------------------- CSV import

function onFile(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) readFile(f);
}

// Column-name patterns used to pre-select the value and hint columns of a CSV.
const GUESS = {
  devices: { value: /(device ?name|serial|device ?id|object ?id|azure ?ad ?device ?id|managed ?device ?id|intune.*id|^name$|input ?value)/i, hint: /(primary ?user|user ?principal|upn|e-?mail|^user|serial)/i },
  users: { value: /(e-?mail|upn|user ?principal|^users?$|^mail$|emailorupn)/i, hint: null },
  groups: { value: /(group|display ?name|^name$|^id$)/i, hint: null },
};

/** Best column for a pattern: matching header with the most non-empty cells. */
function pickColumn(header, rows, re, skip = -1) {
  let best = -1, bestCount = 0;
  header.forEach((h, i) => {
    if (i === skip || !re || !re.test(h)) return;
    const n = rows.slice(1).filter(r => String(r[i] || '').trim()).length;
    if (n > bestCount) { best = i; bestCount = n; }
  });
  return best;
}

async function readFile(file) {
  if (file.size > 20 * 1024 * 1024) return toast('That file is larger than 20 MB.', true);
  const text = await file.text();
  const k = S.csvTarget || S.tab;
  const rows = L.parseCsv(text);
  if (!rows.length) return toast('The file is empty.', true);
  if (rows[0].length === 1) {
    // single column: use as is (header line is skipped automatically)
    const form = $(`[data-form="${k}"]`);
    form.input.value = rows.map(r => r[0]).join('\n');
    updateMeta(k);
    return toast(`Loaded ${plural(rows.length, 'line')} from ${file.name}.`);
  }
  openCsvDialog(k, file.name, rows);
}

function openCsvDialog(k, name, rows) {
  const header = rows[0].map((h, i) => (h || '').trim() || `Column ${i + 1}`);
  const g = GUESS[k];
  const vIdx = Math.max(0, pickColumn(header, rows, g.value));
  const hIdx = pickColumn(header, rows, g.hint, vIdx);
  const dlg = $('#modal');
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'modal';
  form.id = 'modalForm';
  $('#modalForm').replaceWith(form);
  const opt = (sel, none) => (none ? '<option value="-1">— none —</option>' : '') + header.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h)}</option>`).join('');
  form.innerHTML = `
    <h2 id="modalTitle">Load ${esc(name)}</h2>
    <p class="sub">${plural(rows.length, 'row')} · ${plural(header.length, 'column')}</p>
    <div class="opt-grid">
      <label>Value column <select name="v">${opt(vIdx)}</select></label>
      <label>Hint column <span class="muted">(optional)</span><select name="h">${opt(hIdx, true)}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="hasHeader" checked> First row is a header</label>
    <div class="csv-preview" data-preview></div>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="button" class="btn primary" data-go>Use these values</button>
    </div>`;
  const lines = () => {
    const v = Number(form.v.value), h = Number(form.h.value);
    return rows.slice(form.hasHeader.checked ? 1 : 0)
      .map(r => [String(r[v] || '').trim(), h >= 0 ? String(r[h] || '').trim() : ''])
      .filter(([a]) => a)
      .map(([a, b]) => (b ? `${a}\t${b}` : a));
  };
  const preview = () => {
    const l = lines();
    $('[data-preview]', form).textContent = l.slice(0, 6).join('\n') + (l.length > 6 ? `\n… ${l.length - 6} more` : '');
    $('[data-go]', form).textContent = `Use ${plural(l.length, 'value')}`;
  };
  form.addEventListener('input', preview);
  form.addEventListener('submit', e => e.preventDefault());
  preview();
  $('[data-close]', form).onclick = () => dlg.close();
  $('[data-go]', form).onclick = () => {
    const f = $(`[data-form="${k}"]`);
    f.input.value = lines().join('\n');
    updateMeta(k);
    dlg.close();
    switchTab(k);
  };
  if (!dlg.open) dlg.showModal();
}

init();
