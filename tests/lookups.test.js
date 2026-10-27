// Unit tests for input parsing and the device / user / group lookups, against the demo tenant.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../js/graph.js';
import { createDemoTenant } from '../js/mock.js';
import { parseInput, parseCsv, isGuid, resolveDevices, resolveUsers, resolveGroupMembers } from '../js/lookups.js';
import { formatValues } from '../js/table.js';

const setup = () => { const t = createDemoTenant(); return { t, g: new Graph({ mock: t }) }; };
const byInput = rows => Object.fromEntries(rows.map(r => [r.input, r]));

test('parseInput: header, comments, duplicates, hint column', () => {
  const p = parseInput('DeviceName\n# note\nPC-1\n\npc-1\nPC-2\tjane@contoso.com\n"PC-3";SN123\nPC-4,SN9');
  assert.equal(p.header, 'DeviceName');
  assert.equal(p.duplicates, 1);
  assert.deepEqual(p.items, [
    { value: 'PC-1', hint: '' },
    { value: 'PC-2', hint: 'jane@contoso.com' },
    { value: 'PC-3', hint: 'SN123' },
    { value: 'PC-4', hint: 'SN9' },
  ]);
  assert.equal(parseInput('Email\njane@contoso.com').items.length, 1);
  assert.equal(parseInput('DeviceName,PrimaryUserEmail\nPC-1,a@b.c').items[0].hint, 'a@b.c');
  assert.equal(parseInput('LAPTOP-01').header, null);
});

test('parseCsv handles quotes, semicolons and BOM', () => {
  assert.deepEqual(parseCsv('﻿"DeviceID","Note"\r\n"a","x, y"\n"b","say ""hi"""\n'), [['DeviceID', 'Note'], ['a', 'x, y'], ['b', 'say "hi"']]);
  assert.deepEqual(parseCsv('A;B\n1;2'), [['A', 'B'], ['1', '2']]);
});

test('isGuid', () => {
  assert.ok(isGuid('0e2959f2-946f-4b20-a3d4-d7679b8e899d'));
  assert.ok(!isGuid('CTS-LT-0001'));
});

test('copy formats', () => {
  assert.equal(formatValues(['a', "b'c"], 'quoted'), "'a','b''c'");
  assert.equal(formatValues(['a', 'b'], 'comma'), 'a, b');
  assert.equal(formatValues(['a', 'b'], 'lines'), 'a\nb');
});

test('devices: every status from mixed input', async () => {
  const { t, g } = setup();
  const r = await resolveDevices(g, parseInput(t.samples.devices).items, { withUser: true });
  const R = byInput(r.rows);
  assert.equal(R['CTS-LT-0001'].status, 'Valid');
  assert.match(R['CTS-LT-0001'].entraObjectId, /^[0-9a-f-]{36}$/);
  assert.match(R['CTS-LT-0001'].intuneDeviceId, /^[0-9a-f-]{36}$/);
  assert.ok(R['CTS-LT-0001'].userCountry, 'primary user country added');
  assert.equal(R['CTS-LT-0007'].status, 'Valid', 'stale duplicates lose to the managed record');
  assert.equal(R['CTS-LT-0007'].matches, 3);
  assert.equal(R['CTS-LT-0007'].managementState, 'managed');
  assert.equal(R['KIOSK-LOBBY'].status, 'Valid · duplicates');
  assert.equal(R['CTS-LT-0042'].status, 'Entra only');
  assert.equal(R['CTS-LT-0050'].status, 'Not managed');
  assert.equal(R['Android_Pixel_Omar'].status, 'Intune only');
  assert.equal(R["Jane's iPhone"].status, 'Valid', 'apostrophes are escaped');
  assert.equal(R['NOT-A-DEVICE'].status, 'Not found');
  // serial number and each kind of GUID resolve to a device
  const others = r.rows.filter(x => !/^(CTS|KIOSK|Android|Jane|NOT)/.test(x.input));
  assert.equal(others.length, 4);
  for (const x of others) assert.equal(x.status, 'Valid', x.input);
});

test('devices: a hint picks the right duplicate', async () => {
  const { g } = setup();
  const plain = await resolveDevices(g, parseInput('KIOSK-LOBBY\tKIOSK-LOBBY').items, { mode: 'all' });
  assert.equal(plain.rows.length, 2);
  const serial = plain.rows[1].serialNumber;
  const r = await resolveDevices(g, [{ value: 'KIOSK-LOBBY', hint: serial }]);
  assert.equal(r.rows[0].serialNumber, serial);
  assert.equal(r.rows[0].status, 'Valid · duplicates');
  assert.match(r.rows[0].note, /serial matches hint/);
});

test('devices: forced input type and invalid GUID', async () => {
  const { g } = setup();
  const r = await resolveDevices(g, [{ value: 'CTS-LT-0001', hint: '' }], { type: 'entraObjectId' });
  assert.equal(r.rows[0].status, 'Invalid input');
  const s = await resolveDevices(g, [{ value: 'CTS-LT-0001', hint: '' }], { type: 'serial' });
  assert.equal(s.rows[0].status, 'Not found', 'a name is not a serial number');
});

test('devices: every-match mode lists all records', async () => {
  const { g } = setup();
  const r = await resolveDevices(g, [{ value: 'CTS-LT-0007', hint: '' }], { mode: 'all' });
  assert.deepEqual(r.rows.map(x => x.status), ['Valid', 'Not managed', 'Entra only']);
});

test('users: details by UPN, mail, display name, object ID', async () => {
  const { t, g } = setup();
  const r = await resolveUsers(g, parseInput(t.samples.users).items, { mode: 'details' });
  const R = byInput(r.rows);
  assert.equal(R['jane.doe@contoso.com'].country, 'France');
  assert.equal(R['paul.martin@contoso.fr'].upn, 'paul.martin@contoso.com', 'found by mail');
  assert.equal(R['Omar Haddad'].usageLocation, 'TN', 'found by display name');
  assert.equal(R['leo.rossi@contoso.com'].status, 'Disabled');
  assert.equal(R['ghost@contoso.com'].status, 'Not found');
  assert.equal(r.rows.filter(x => x.status === 'Found').length, 4);
});

test('users: their devices with Entra object IDs', async () => {
  const { g } = setup();
  const r = await resolveUsers(g, parseInput('jane.doe@contoso.com\nghost@contoso.com').items, { mode: 'devices' });
  const jane = r.rows.filter(x => x.input === 'jane.doe@contoso.com');
  assert.ok(jane.length >= 2);
  assert.ok(jane.some(x => x.deviceName === "Jane's iPhone"));
  for (const x of jane) assert.match(x.entraObjectId, /^[0-9a-f-]{36}$/);
  assert.equal(r.rows.find(x => x.input === 'ghost@contoso.com').status, 'Not found');
});

test('groups: transitive members, de-duplicated with source groups', async () => {
  const { t, g } = setup();
  const r = await resolveGroupMembers(g, parseInput(t.samples.groups).items, { members: 'all', transitive: true });
  const omar = r.rows.find(x => x.displayName === 'Omar Haddad');
  assert.equal(omar.sourceGroups, 'SG-All-Staff | SG-Pilot-Ring', 'nested + direct membership merged');
  assert.equal(r.rows.filter(x => x.displayName === 'Omar Haddad').length, 1);
  assert.ok(r.rows.some(x => x.type === 'Device'));
  assert.ok(r.notes.some(n => /not found: SG-Missing/.test(n)));
  const direct = await resolveGroupMembers(g, parseInput('SG-All-Staff').items, { members: 'users', transitive: false });
  assert.ok(!direct.rows.some(x => x.displayName === 'Omar Haddad'), 'nested members excluded when not transitive');
});

test('large input is batched and survives throttling', async () => {
  const { g } = setup();
  const items = Array.from({ length: 120 }, (_, i) => ({ value: `CTS-LT-${String((i % 30) + 1).padStart(4, '0')}-x${i}`, hint: '' }));
  const r = await resolveDevices(g, items);
  assert.equal(r.rows.length, 120);
  assert.ok(r.rows.every(x => x.status === 'Not found'));
});
