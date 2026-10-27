// Lookup logic for devices, users and groups. Read-only: every call is a Graph GET.
// Each lookup returns { columns, rows, notes } for the results table.

import { pool } from './graph.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

export const isGuid = v => GUID_RE.test(String(v || '').trim());
const odata = v => String(v).replace(/'/g, "''");
const filter = expr => `$filter=${encodeURIComponent(expr)}`;
const lc = v => String(v || '').toLowerCase();
const plural = (n, one) => `${n} ${n === 1 ? one : one + 's'}`;
const validAad = v => (isGuid(v) && lc(v) !== EMPTY_GUID ? lc(v) : null);

const MD_SELECT = 'id,deviceName,serialNumber,azureADDeviceId,userPrincipalName,userDisplayName,emailAddress,managedDeviceOwnerType,operatingSystem,osVersion,complianceState,managementState,deviceRegistrationState,lastSyncDateTime,enrolledDateTime,model,manufacturer';
const ED_SELECT = 'id,deviceId,displayName,accountEnabled,operatingSystem,operatingSystemVersion,trustType,approximateLastSignInDateTime,registrationDateTime';
const US_SELECT = 'id,displayName,userPrincipalName,mail,accountEnabled,country,usageLocation,city,officeLocation,department,jobTitle,companyName,employeeId,onPremisesSamAccountName,createdDateTime';

// ------------------------------------------------------------------ input

// A first line that is only a column name (as in your CSV files) is skipped.
const HEADER_RE = /^(device ?names?|serial ?(numbers?)?|device ?ids?|device ?object ?ids?|object ?ids?|azure ?ad ?device ?ids?|entra ?(device|object) ?ids?|intune ?(managed ?)?device ?ids?|managed ?device ?ids?|e-?mails?|e-?mail ?address(es)?|upns?|user ?principal ?names?|users?|user ?upns?|primary ?user( ?e-?mail)?|mail|groups?|group ?(names?|ids?)|names?|ids?|input( ?value)?)$/i;

/**
 * Parse pasted text (one item per line). A second column (tab, ; or ,) is kept as a hint,
 * e.g. "LAPTOP-01<TAB>jane@contoso.com" or "LAPTOP-01,SN12345".
 * @returns {{ items: {value:string, hint:string}[], duplicates: number, header: string|null }}
 */
export function parseInput(text) {
  const items = [];
  const seen = new Set();
  let duplicates = 0;
  let header = null;
  let first = true;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : line.includes(',') ? ',' : null;
    const cells = (sep ? line.split(sep) : [line]).map(c => c.trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"').trim());
    const value = cells[0] || '';
    const hint = cells[1] || '';
    if (first) {
      first = false;
      if (HEADER_RE.test(value) && (!hint || HEADER_RE.test(hint) || /^(user|serial|e-?mail|upn|primary)/i.test(hint))) { header = line; continue; }
    }
    if (!value) continue;
    const key = lc(value) + '|' + lc(hint);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    items.push({ value, hint });
  }
  return { items, duplicates, header };
}

/** Minimal CSV parser (quotes, commas or semicolons). Returns rows of cells. */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

// ------------------------------------------------------------------ helpers

async function collect(graph, result) {
  if (!result || result.status !== 200 || !result.body) return [];
  const body = result.body;
  const items = Array.isArray(body.value) ? [...body.value] : [body];
  if (body['@odata.nextLink']) items.push(...(await graph.getAll(body['@odata.nextLink'])));
  return items;
}

function errText(result) {
  if (!result) return 'No response';
  const msg = result.body && result.body.error && result.body.error.message;
  return `HTTP ${result.status}${msg ? ': ' + msg : ''}`;
}

const isManaged = d => !d.managementState || d.managementState === 'managed';
const time = v => (v ? Date.parse(v) || 0 : 0);

// ------------------------------------------------------------------ devices

export const DEVICE_TYPES = {
  auto: 'Auto-detect',
  name: 'Device name',
  serial: 'Serial number',
  entraDeviceId: 'Entra device ID (azureADDeviceId)',
  entraObjectId: 'Entra object ID',
  intuneId: 'Intune device ID',
};

export const DEVICE_STATUS = {
  'Valid': 'Entra object linked to an actively managed Intune device',
  'Valid · duplicates': 'Several valid matches; the best one is shown (see Matches / Note)',
  'Not managed': 'Intune record exists but is not actively managed (retire/wipe pending, etc.)',
  'Entra only': 'Entra device without an Intune record',
  'Intune only': 'Intune device without a matching Entra object',
  'Not found': 'Nothing in Entra ID or Intune matches this input',
  'Invalid input': 'The value is not valid for the chosen input type',
  'Error': 'A Graph call failed for this input',
};

const USER_COLS = [
  { key: 'userCountry', label: 'User country' },
  { key: 'userUsageLocation', label: 'User usage location' },
  { key: 'userDepartment', label: 'User department' },
  { key: 'userOffice', label: 'User office', hidden: true },
  { key: 'userCity', label: 'User city', hidden: true },
  { key: 'userJobTitle', label: 'User job title', hidden: true },
];

export function deviceColumns(withUser, withHint = false) {
  return [
    { key: 'input', label: 'Input' },
    { key: 'hint', label: 'Hint', hidden: !withHint },
    { key: 'status', label: 'Status', status: true },
    { key: 'matches', label: 'Matches', num: true },
    { key: 'deviceName', label: 'Device name' },
    { key: 'entraObjectId', label: 'Entra object ID', id: true },
    { key: 'entraDeviceId', label: 'Entra device ID', id: true },
    { key: 'intuneDeviceId', label: 'Intune device ID', id: true },
    { key: 'serialNumber', label: 'Serial number', mono: true },
    { key: 'primaryUser', label: 'Primary user' },
    { key: 'userName', label: 'User name', hidden: true },
    { key: 'ownership', label: 'Ownership' },
    { key: 'os', label: 'OS' },
    { key: 'osVersion', label: 'OS version' },
    { key: 'compliance', label: 'Compliance' },
    { key: 'managementState', label: 'Management state', hidden: true },
    { key: 'registrationState', label: 'Registration state', hidden: true },
    { key: 'lastCheckIn', label: 'Last check-in', date: true },
    { key: 'enrolled', label: 'Enrolled', date: true, hidden: true },
    { key: 'model', label: 'Model', hidden: true },
    { key: 'manufacturer', label: 'Manufacturer', hidden: true },
    { key: 'entraEnabled', label: 'Entra enabled', hidden: true },
    { key: 'trustType', label: 'Join type', hidden: true },
    { key: 'entraLastSignIn', label: 'Entra last sign-in', date: true, hidden: true },
    ...(withUser ? USER_COLS : []),
    { key: 'foundBy', label: 'Found by', hidden: true },
    { key: 'note', label: 'Note' },
  ];
}

function deviceQueries(value, type) {
  const v = odata(value);
  const md = (expr) => `/deviceManagement/managedDevices?${filter(expr)}&$select=${MD_SELECT}`;
  const ed = (expr) => `/devices?${filter(expr)}&$select=${ED_SELECT}`;
  const Q = {
    I_name: ['Intune name', md(`deviceName eq '${v}'`)],
    E_name: ['Entra name', ed(`displayName eq '${v}'`)],
    I_serial: ['Serial number', md(`serialNumber eq '${v}'`)],
    E_did: ['Entra device ID', ed(`deviceId eq '${v}'`)],
    I_aad: ['Intune azureADDeviceId', md(`azureADDeviceId eq '${v}'`)],
    E_oid: ['Entra object ID', `/devices/${encodeURIComponent(value)}?$select=${ED_SELECT}`],
    I_id: ['Intune device ID', `/deviceManagement/managedDevices/${encodeURIComponent(value)}?$select=${MD_SELECT}`],
  };
  const kinds = {
    text: ['I_name', 'E_name', 'I_serial'],
    name: ['I_name', 'E_name'],
    serial: ['I_serial'],
    guid: ['E_oid', 'E_did', 'I_id', 'I_aad'],
    entraDeviceId: ['E_did', 'I_aad'],
    entraObjectId: ['E_oid'],
    intuneId: ['I_id'],
  }[type];
  return kinds.map(k => ({ kind: k, label: Q[k][0], url: Q[k][1] }));
}

function scoreRecord(r, hint) {
  let score = 0;
  const why = [];
  const h = lc(hint);
  if (h) {
    if (r.intune && lc(r.intune.serialNumber) === h) { score += 1000; why.push('serial matches hint'); }
    if (r.intune && (lc(r.intune.userPrincipalName) === h || lc(r.intune.emailAddress) === h)) { score += 1000; why.push('primary user matches hint'); }
  }
  if (r.intune && isManaged(r.intune)) { score += 400; }
  if (r.intune && r.entra) score += 200;
  if (r.entra && r.entra.accountEnabled !== false) score += 50;
  return { score, why };
}

function recordStatus(r) {
  if (r.intune && r.entra) return isManaged(r.intune) ? 'Valid' : 'Not managed';
  if (r.intune) return isManaged(r.intune) ? 'Intune only' : 'Not managed';
  return 'Entra only';
}

function deviceRow(base, r, user) {
  const i = r.intune || {};
  const e = r.entra || {};
  const row = {
    ...base,
    deviceName: i.deviceName || e.displayName || '',
    entraObjectId: e.id || '',
    entraDeviceId: e.deviceId || validAad(i.azureADDeviceId) || '',
    intuneDeviceId: i.id || '',
    serialNumber: i.serialNumber || '',
    primaryUser: i.userPrincipalName || '',
    userName: i.userDisplayName || '',
    ownership: i.managedDeviceOwnerType || '',
    os: i.operatingSystem || e.operatingSystem || '',
    osVersion: i.osVersion || e.operatingSystemVersion || '',
    compliance: i.complianceState || '',
    managementState: i.managementState || '',
    registrationState: i.deviceRegistrationState || '',
    lastCheckIn: i.lastSyncDateTime || '',
    enrolled: i.enrolledDateTime || '',
    model: i.model || '',
    manufacturer: i.manufacturer || '',
    entraEnabled: r.entra ? String(e.accountEnabled !== false) : '',
    trustType: e.trustType || '',
    entraLastSignIn: e.approximateLastSignInDateTime || '',
  };
  if (user !== undefined) {
    const u = user || {};
    Object.assign(row, {
      userCountry: u.country || '', userUsageLocation: u.usageLocation || '', userDepartment: u.department || '',
      userOffice: u.officeLocation || '', userCity: u.city || '', userJobTitle: u.jobTitle || '',
    });
  }
  return row;
}

/**
 * Resolve devices from names, serial numbers or any of their IDs.
 * @param {import('./graph.js').Graph} graph
 * @param {{value:string, hint:string}[]} items
 * @param {{ type?: string, mode?: 'best'|'all', withUser?: boolean }} opts
 * @param {(stage:string, done:number, total:number) => void} progress
 */
export async function resolveDevices(graph, items, { type = 'auto', mode = 'best', withUser = false } = {}, progress = () => {}) {
  const plans = items.map((it, i) => ({ it, i, intune: new Map(), entra: new Map(), via: new Set(), errors: [] }));
  const reqs = [];
  const meta = new Map();
  for (const p of plans) {
    const v = p.it.value.trim();
    const t = type === 'auto' ? (isGuid(v) ? 'guid' : 'text') : type;
    if (['guid', 'entraDeviceId', 'entraObjectId', 'intuneId'].includes(t) && !isGuid(v)) { p.invalid = 'Not a valid ID (GUID)'; continue; }
    for (const q of deviceQueries(v, t)) {
      const id = `${p.i}|${q.kind}`;
      reqs.push({ id, url: q.url });
      meta.set(id, { p, ...q });
    }
  }

  // Stage 1: direct lookups
  const res1 = await graph.batch(reqs, { onProgress: (d, t) => progress('Looking up devices', d, t) });
  const entraByDid = new Map();
  const intuneByAad = new Map();
  const remember = (map, key, obj) => { if (!key) return; if (!map.has(key)) map.set(key, new Map()); map.get(key).set(obj.id, obj); };
  for (const [id, m] of meta) {
    const r = res1.get(id);
    if (!r) { m.p.errors.push(`${m.label}: no response`); continue; }
    if (r.status === 404 && /_(oid|id)$/.test(m.kind)) continue;
    if (r.status === 400 && /_(oid|id)$/.test(m.kind)) continue; // malformed ID for that object type
    if (r.status !== 200) { m.p.errors.push(`${m.label}: ${errText(r)}`); continue; }
    const found = await collect(graph, r);
    for (const obj of found) {
      if (m.kind.startsWith('I_')) { m.p.intune.set(obj.id, obj); remember(intuneByAad, validAad(obj.azureADDeviceId), obj); }
      else { m.p.entra.set(obj.id, obj); remember(entraByDid, lc(obj.deviceId), obj); }
      m.p.via.add(m.label);
    }
  }

  // Stage 2: follow the Intune <-> Entra link (azureADDeviceId = deviceId)
  const needE = new Set(), needI = new Set();
  for (const p of plans) {
    for (const d of p.intune.values()) { const a = validAad(d.azureADDeviceId); if (a && !entraByDid.has(a)) needE.add(a); }
    for (const e of p.entra.values()) { const a = lc(e.deviceId); if (a && !intuneByAad.has(a)) needI.add(a); }
  }
  const reqs2 = [
    ...[...needE].map(a => ({ id: 'E|' + a, url: `/devices?${filter(`deviceId eq '${a}'`)}&$select=${ED_SELECT}` })),
    ...[...needI].map(a => ({ id: 'I|' + a, url: `/deviceManagement/managedDevices?${filter(`azureADDeviceId eq '${a}'`)}&$select=${MD_SELECT}` })),
  ];
  if (reqs2.length) {
    const res2 = await graph.batch(reqs2, { onProgress: (d, t) => progress('Linking Entra and Intune records', d, t) });
    for (const a of needE) { entraByDid.set(a, new Map()); for (const o of await collect(graph, res2.get('E|' + a))) entraByDid.get(a).set(o.id, o); }
    for (const a of needI) { intuneByAad.set(a, new Map()); for (const o of await collect(graph, res2.get('I|' + a))) intuneByAad.get(a).set(o.id, o); }
  }

  // Build candidate records per input
  for (const p of plans) {
    const recs = new Map();
    const add = (intune, entra) => recs.set(`${intune ? intune.id : '-'}|${entra ? entra.id : '-'}`, { intune, entra });
    const usedEntra = new Set();
    for (const d of p.intune.values()) {
      const a = validAad(d.azureADDeviceId);
      const es = a && entraByDid.get(a) ? [...entraByDid.get(a).values()] : [];
      if (es.length) es.forEach(e => { add(d, e); usedEntra.add(e.id); });
      else add(d, null);
    }
    for (const e of p.entra.values()) {
      if (usedEntra.has(e.id)) continue;
      const ds = intuneByAad.get(lc(e.deviceId)) ? [...intuneByAad.get(lc(e.deviceId)).values()] : [];
      if (ds.length) ds.forEach(d => add(d, e));
      else add(null, e);
    }
    p.records = [...recs.values()].map(r => ({ ...r, ...scoreRecord(r, p.it.hint), status: recordStatus(r) }))
      .sort((a, b) => b.score - a.score
        || time(b.intune && b.intune.lastSyncDateTime) - time(a.intune && a.intune.lastSyncDateTime)
        || time(b.entra && b.entra.approximateLastSignInDateTime) - time(a.entra && a.entra.approximateLastSignInDateTime));
  }

  // Stage 3 (optional): primary user details
  let users = null;
  if (withUser) {
    const upns = new Set();
    for (const p of plans) {
      const recs = mode === 'all' ? p.records || [] : (p.records || []).slice(0, 1);
      for (const r of recs) if (r.intune && r.intune.userPrincipalName) upns.add(lc(r.intune.userPrincipalName));
    }
    users = new Map();
    if (upns.size) {
      const res3 = await graph.batch([...upns].map(u => ({ id: u, url: `/users/${encodeURIComponent(u)}?$select=${US_SELECT}` })),
        { onProgress: (d, t) => progress('Reading primary users', d, t) });
      for (const u of upns) { const r = res3.get(u); users.set(u, r && r.status === 200 ? r.body : null); }
    }
  }
  const userOf = r => (users ? (r.intune && r.intune.userPrincipalName ? users.get(lc(r.intune.userPrincipalName)) || null : null) : undefined);

  // Rows
  const rows = [];
  for (const p of plans) {
    const base = { input: p.it.value, hint: p.it.hint, foundBy: [...p.via].join(', ') };
    if (p.invalid) { rows.push(deviceRow({ ...base, status: 'Invalid input', matches: 0, note: p.invalid }, {}, withUser ? null : undefined)); continue; }
    const recs = p.records || [];
    if (!recs.length) {
      rows.push(deviceRow({ ...base, status: p.errors.length ? 'Error' : 'Not found', matches: 0, note: p.errors.join(' | ') }, {}, withUser ? null : undefined));
      continue;
    }
    const valid = recs.filter(r => r.status === 'Valid');
    if (mode === 'all') {
      recs.forEach((r, k) => rows.push(deviceRow({
        ...base, status: r.status, matches: recs.length,
        note: [recs.length > 1 ? `Match ${k + 1} of ${recs.length}${k === 0 ? ' (best)' : ''}` : '', ...r.why, ...p.errors].filter(Boolean).join('; '),
      }, r, userOf(r))));
      continue;
    }
    const best = recs[0];
    let status = best.status;
    const note = [...best.why];
    if (p.it.hint && !best.why.length) note.push(`hint "${p.it.hint}" matched no record`);
    if (status === 'Valid' && valid.length > 1) {
      status = 'Valid · duplicates';
      note.unshift(best.why.length ? `best of ${valid.length} valid matches` : `newest of ${valid.length} valid matches — add a user or serial hint to choose`);
    } else if (recs.length > 1) {
      note.unshift(`best of ${recs.length} records`);
    }
    if (p.errors.length) note.push(...p.errors);
    rows.push(deviceRow({ ...base, status, matches: recs.length, note: note.join('; ') }, best, userOf(best)));
  }
  return { columns: deviceColumns(withUser, items.some(it => it.hint)), rows, statusHelp: DEVICE_STATUS };
}

// ------------------------------------------------------------------ users

export const USER_MODES = { details: 'User details & location', devices: 'Their Intune devices' };

export const USER_STATUS = {
  'Found': 'User found',
  'Disabled': 'User found, account disabled',
  'Multiple users': 'More than one user matches this input',
  'No devices': 'User found but has no Intune devices as primary user',
  'Not found': 'No user matches this input',
  'Error': 'A Graph call failed for this input',
};

function userQuery(value) {
  const v = value.trim();
  if (isGuid(v)) return `/users/${v}?$select=${US_SELECT}`;
  const q = odata(v);
  const expr = v.includes('@') ? `userPrincipalName eq '${q}' or mail eq '${q}'` : `displayName eq '${q}'`;
  return `/users?${filter(expr)}&$select=${US_SELECT}`;
}

const userFields = u => ({
  displayName: u.displayName || '', upn: u.userPrincipalName || '', mail: u.mail || '', objectId: u.id || '',
  accountEnabled: u.accountEnabled === undefined ? '' : String(u.accountEnabled), country: u.country || '',
  usageLocation: u.usageLocation || '', city: u.city || '', office: u.officeLocation || '', department: u.department || '',
  jobTitle: u.jobTitle || '', company: u.companyName || '', employeeId: u.employeeId || '',
  samAccountName: u.onPremisesSamAccountName || '', created: u.createdDateTime || '',
});

export function userColumns(mode) {
  if (mode === 'devices') {
    return [
      { key: 'input', label: 'Input' },
      { key: 'status', label: 'Status', status: true },
      { key: 'displayName', label: 'User' },
      { key: 'upn', label: 'UPN' },
      { key: 'deviceName', label: 'Device name' },
      { key: 'entraObjectId', label: 'Entra object ID', id: true },
      { key: 'entraDeviceId', label: 'Entra device ID', id: true },
      { key: 'intuneDeviceId', label: 'Intune device ID', id: true },
      { key: 'serialNumber', label: 'Serial number', mono: true },
      { key: 'ownership', label: 'Ownership' },
      { key: 'os', label: 'OS' },
      { key: 'osVersion', label: 'OS version' },
      { key: 'compliance', label: 'Compliance' },
      { key: 'lastCheckIn', label: 'Last check-in', date: true },
      { key: 'model', label: 'Model', hidden: true },
      { key: 'country', label: 'Country', hidden: true },
      { key: 'usageLocation', label: 'Usage location', hidden: true },
      { key: 'note', label: 'Note', hidden: true },
    ];
  }
  return [
    { key: 'input', label: 'Input' },
    { key: 'status', label: 'Status', status: true },
    { key: 'displayName', label: 'Display name' },
    { key: 'upn', label: 'UPN' },
    { key: 'mail', label: 'Mail' },
    { key: 'objectId', label: 'Object ID', id: true },
    { key: 'country', label: 'Country' },
    { key: 'usageLocation', label: 'Usage location' },
    { key: 'city', label: 'City' },
    { key: 'office', label: 'Office', hidden: true },
    { key: 'department', label: 'Department' },
    { key: 'jobTitle', label: 'Job title', hidden: true },
    { key: 'company', label: 'Company', hidden: true },
    { key: 'employeeId', label: 'Employee ID', hidden: true },
    { key: 'samAccountName', label: 'SAM account', hidden: true },
    { key: 'accountEnabled', label: 'Enabled', hidden: true },
    { key: 'created', label: 'Created', date: true, hidden: true },
    { key: 'note', label: 'Note', hidden: true },
  ];
}

/**
 * Look up users by UPN, mail, display name or object ID; optionally list their Intune devices.
 */
export async function resolveUsers(graph, items, { mode = 'details' } = {}, progress = () => {}) {
  const res = await graph.batch(items.map((it, i) => ({ id: String(i), url: userQuery(it.value) })),
    { onProgress: (d, t) => progress('Looking up users', d, t) });
  const found = [];
  for (let i = 0; i < items.length; i++) {
    const r = res.get(String(i));
    if (!r || (r.status !== 200 && r.status !== 404)) { found.push({ it: items[i], error: errText(r), users: [] }); continue; }
    found.push({ it: items[i], users: r.status === 404 ? [] : await collect(graph, r) });
  }

  const rows = [];
  if (mode !== 'devices') {
    for (const f of found) {
      const base = { input: f.it.value };
      if (f.error) { rows.push({ ...base, status: 'Error', note: f.error }); continue; }
      if (!f.users.length) { rows.push({ ...base, status: 'Not found' }); continue; }
      for (const u of f.users) {
        const status = f.users.length > 1 ? 'Multiple users' : u.accountEnabled === false ? 'Disabled' : 'Found';
        rows.push({ ...base, status, ...userFields(u) });
      }
    }
    return { columns: userColumns(mode), rows, statusHelp: USER_STATUS };
  }

  // Devices: managed devices whose primary user is this user
  const single = found.filter(f => f.users.length === 1);
  const upns = [...new Set(single.map(f => lc(f.users[0].userPrincipalName)).filter(Boolean))];
  const res2 = await graph.batch(upns.map(u => ({
    id: u, url: `/deviceManagement/managedDevices?${filter(`userPrincipalName eq '${odata(u)}'`)}&$select=${MD_SELECT}`,
  })), { onProgress: (d, t) => progress('Reading their devices', d, t) });
  const devicesOf = new Map();
  for (const u of upns) {
    const r = res2.get(u);
    devicesOf.set(u, r && r.status === 200 ? await collect(graph, r) : { error: errText(r) });
  }
  // Entra object IDs for those devices
  const aads = new Set();
  for (const ds of devicesOf.values()) if (Array.isArray(ds)) ds.forEach(d => { const a = validAad(d.azureADDeviceId); if (a) aads.add(a); });
  const res3 = await graph.batch([...aads].map(a => ({ id: a, url: `/devices?${filter(`deviceId eq '${a}'`)}&$select=id,deviceId` })),
    { onProgress: (d, t) => progress('Resolving Entra object IDs', d, t) });
  const objOf = new Map();
  for (const a of aads) { const list = await collect(graph, res3.get(a)); if (list[0]) objOf.set(a, list[0].id); }

  for (const f of found) {
    const base = { input: f.it.value };
    if (f.error) { rows.push({ ...base, status: 'Error', note: f.error }); continue; }
    if (!f.users.length) { rows.push({ ...base, status: 'Not found' }); continue; }
    if (f.users.length > 1) {
      f.users.forEach(u => rows.push({ ...base, status: 'Multiple users', displayName: u.displayName, upn: u.userPrincipalName, note: 'Use the UPN to pick one' }));
      continue;
    }
    const u = f.users[0];
    const uf = { displayName: u.displayName || '', upn: u.userPrincipalName || '', country: u.country || '', usageLocation: u.usageLocation || '' };
    const ds = devicesOf.get(lc(u.userPrincipalName));
    if (!Array.isArray(ds)) { rows.push({ ...base, ...uf, status: 'Error', note: ds ? ds.error : 'No UPN' }); continue; }
    if (!ds.length) { rows.push({ ...base, ...uf, status: 'No devices' }); continue; }
    for (const d of ds.sort((a, b) => time(b.lastSyncDateTime) - time(a.lastSyncDateTime))) {
      const a = validAad(d.azureADDeviceId);
      rows.push({
        ...base, ...uf, status: u.accountEnabled === false ? 'Disabled' : 'Found',
        deviceName: d.deviceName || '', entraObjectId: (a && objOf.get(a)) || '', entraDeviceId: a || '', intuneDeviceId: d.id,
        serialNumber: d.serialNumber || '', ownership: d.managedDeviceOwnerType || '', os: d.operatingSystem || '',
        osVersion: d.osVersion || '', compliance: d.complianceState || '', lastCheckIn: d.lastSyncDateTime || '', model: d.model || '',
      });
    }
  }
  return { columns: userColumns(mode), rows, statusHelp: USER_STATUS };
}

// ------------------------------------------------------------------ groups

export const GROUP_MEMBER_TYPES = { users: 'Users', devices: 'Devices', all: 'Users and devices' };

export const GROUP_STATUS = {
  'Enabled': 'Account / device is enabled',
  'Disabled': 'Account / device is disabled',
};

export function groupColumns() {
  return [
    { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status', status: true },
    { key: 'displayName', label: 'Name' },
    { key: 'mail', label: 'Mail' },
    { key: 'upn', label: 'UPN' },
    { key: 'emailOrUpn', label: 'Email or UPN' },
    { key: 'objectId', label: 'Object ID', id: true },
    { key: 'entraDeviceId', label: 'Entra device ID', id: true, hidden: true },
    { key: 'os', label: 'OS', hidden: true },
    { key: 'country', label: 'Country', hidden: true },
    { key: 'usageLocation', label: 'Usage location', hidden: true },
    { key: 'department', label: 'Department', hidden: true },
    { key: 'sourceGroups', label: 'Source groups' },
  ];
}

/**
 * List the (transitive) members of groups given by name or object ID, de-duplicated.
 */
export async function resolveGroupMembers(graph, items, { members = 'users', transitive = true } = {}, progress = () => {}) {
  const sel = 'id,displayName,groupTypes,securityEnabled,mailEnabled,membershipRule';
  const res = await graph.batch(items.map((it, i) => ({
    id: String(i),
    url: isGuid(it.value) ? `/groups/${it.value.trim()}?$select=${sel}` : `/groups?${filter(`displayName eq '${odata(it.value.trim())}'`)}&$select=${sel}`,
  })), { onProgress: (d, t) => progress('Finding groups', d, t) });

  const notes = [];
  const groups = [];
  for (let i = 0; i < items.length; i++) {
    const r = res.get(String(i));
    if (r && r.status === 404) { notes.push(`Group not found: ${items[i].value}`); continue; }
    if (!r || r.status !== 200) { notes.push(`${items[i].value}: ${errText(r)}`); continue; }
    const gs = await collect(graph, r);
    if (!gs.length) notes.push(`Group not found: ${items[i].value}`);
    if (gs.length > 1) notes.push(`${gs.length} groups are named "${items[i].value}" — all of them were included`);
    groups.push(...gs);
  }
  const uniqueGroups = [...new Map(groups.map(g => [g.id, g])).values()];

  const rel = transitive ? 'transitiveMembers' : 'members';
  const casts = members === 'all' ? ['user', 'device'] : [members === 'devices' ? 'device' : 'user'];
  const byId = new Map();
  let done = 0;
  const counts = new Map();
  await pool(uniqueGroups, 3, async g => {
    for (const cast of casts) {
      const select = cast === 'user' ? 'id,displayName,mail,userPrincipalName,accountEnabled,country,usageLocation,department' : 'id,deviceId,displayName,accountEnabled,operatingSystem';
      let list;
      try {
        list = await graph.getAll(`/groups/${g.id}/${rel}/microsoft.graph.${cast}?$select=${select}&$top=999&$count=true`,
          { headers: { ConsistencyLevel: 'eventual' } });
      } catch (e) {
        if (e.cancelled) throw e;
        notes.push(`${g.displayName}: could not read ${cast} members (${e.status || ''} ${e.message})`);
        continue;
      }
      counts.set(g.id, (counts.get(g.id) || 0) + list.length);
      for (const m of list) {
        const prev = byId.get(m.id);
        if (prev) { prev.groups.add(g.displayName); continue; }
        byId.set(m.id, { m, cast, groups: new Set([g.displayName]) });
      }
    }
    progress('Reading members', ++done, uniqueGroups.length);
  });
  for (const g of [...uniqueGroups].reverse()) {
    notes.unshift(`${g.displayName}${(g.groupTypes || []).includes('DynamicMembership') ? ' (dynamic)' : ''}: ${plural(counts.get(g.id) || 0, 'member')}`);
  }

  const rows = [...byId.values()].map(({ m, cast, groups: gs }) => cast === 'user' ? {
    type: 'User', status: m.accountEnabled === false ? 'Disabled' : 'Enabled', displayName: m.displayName || '',
    mail: m.mail || '', upn: m.userPrincipalName || '', emailOrUpn: m.mail || m.userPrincipalName || '', objectId: m.id,
    country: m.country || '', usageLocation: m.usageLocation || '', department: m.department || '', sourceGroups: [...gs].sort().join(' | '),
  } : {
    type: 'Device', status: m.accountEnabled === false ? 'Disabled' : 'Enabled', displayName: m.displayName || '',
    objectId: m.id, entraDeviceId: m.deviceId || '', os: m.operatingSystem || '', sourceGroups: [...gs].sort().join(' | '),
  }).sort((a, b) => a.type.localeCompare(b.type) || a.displayName.localeCompare(b.displayName));

  return { columns: groupColumns(), rows, notes, statusHelp: GROUP_STATUS, groupsFound: uniqueGroups.length };
}
