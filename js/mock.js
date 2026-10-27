// In-memory demo tenant answering the Graph v1.0 calls this toolkit makes.
// All names and IDs are fictitious. Covers the tricky cases: duplicate names, stale
// Entra objects, retired Intune records, Entra-only and Intune-only devices, nested groups.

let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const hex = n => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const guid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const daysAgo = d => new Date(Date.UTC(2026, 9, 26, 9) - d * 86400000 - Math.floor(rnd() * 36e5)).toISOString();
const serial = () => '5CG' + Array.from({ length: 7 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[Math.floor(rnd() * 34)]).join('');
const EMPTY = '00000000-0000-0000-0000-000000000000';

export function createDemoTenant() {
  seed = 7;
  const users = [];
  const mkUser = (first, last, country, usage, city, dept, extra = {}) => {
    const upn = `${first}.${last}@contoso.com`.toLowerCase().replace(/[^a-z.@]/g, '');
    const u = {
      id: guid(), displayName: `${first} ${last}`, userPrincipalName: upn, mail: upn, accountEnabled: true,
      country, usageLocation: usage, city, officeLocation: `${city} HQ`, department: dept, jobTitle: 'Analyst',
      companyName: 'Contoso', employeeId: String(10000 + users.length), onPremisesSamAccountName: (first[0] + last).toLowerCase().slice(0, 12),
      createdDateTime: daysAgo(900 + Math.floor(rnd() * 900)), ...extra,
    };
    users.push(u);
    return u;
  };
  const U = {
    jane: mkUser('Jane', 'Doe', 'France', 'FR', 'Paris', 'Finance'),
    omar: mkUser('Omar', 'Haddad', 'Tunisia', 'TN', 'Tunis', 'IT'),
    li: mkUser('Li', 'Wang', 'Singapore', 'SG', 'Singapore', 'Research'),
    ana: mkUser('Ana', 'Silva', 'Portugal', 'PT', 'Lisbon', 'Sales'),
    tom: mkUser('Tom', 'Becker', 'Germany', 'DE', 'Berlin', 'Finance'),
    sara: mkUser('Sara', 'Nilsson', 'Sweden', 'SE', 'Stockholm', 'HR'),
    ravi: mkUser('Ravi', 'Kumar', 'India', 'IN', 'Bengaluru', 'IT'),
    emma: mkUser('Emma', 'Brown', 'United Kingdom', 'GB', 'London', 'Legal'),
    yuki: mkUser('Yuki', 'Tanaka', 'Japan', 'JP', 'Tokyo', 'Research'),
    leo: mkUser('Leo', 'Rossi', 'Italy', 'IT', 'Milan', 'Sales', { accountEnabled: false }),
    noor: mkUser('Noor', 'Saleh', 'United Arab Emirates', 'AE', 'Abu Dhabi', 'Operations'),
    paul: mkUser('Paul', 'Martin', 'France', 'FR', 'Lyon', 'Operations', { mail: 'paul.martin@contoso.fr' }),
  };
  const team = Object.values(U);

  const entra = [];
  const intune = [];
  const mkEntra = (name, os, extra = {}) => {
    const e = {
      id: guid(), deviceId: guid(), displayName: name, accountEnabled: true, operatingSystem: os,
      operatingSystemVersion: os === 'Windows' ? '10.0.22631.4317' : '17.6', trustType: os === 'Windows' ? 'AzureAd' : 'Workplace',
      approximateLastSignInDateTime: daysAgo(Math.floor(rnd() * 20)), registrationDateTime: daysAgo(200 + Math.floor(rnd() * 400)), ...extra,
    };
    entra.push(e);
    return e;
  };
  const mkIntune = (name, os, user, e, extra = {}) => {
    const d = {
      id: guid(), deviceName: name, serialNumber: serial(), azureADDeviceId: e ? e.deviceId : EMPTY,
      userPrincipalName: user ? user.userPrincipalName : '', userDisplayName: user ? user.displayName : '', emailAddress: user ? user.mail : '',
      managedDeviceOwnerType: os === 'Android' ? 'personal' : 'company', operatingSystem: os,
      osVersion: os === 'Windows' ? '10.0.22631.4317' : os === 'iOS' ? '17.6.1' : '14',
      complianceState: rnd() > 0.15 ? 'compliant' : 'noncompliant', managementState: 'managed', deviceRegistrationState: 'registered',
      lastSyncDateTime: daysAgo(Math.floor(rnd() * 10)), enrolledDateTime: daysAgo(200 + Math.floor(rnd() * 400)),
      model: os === 'Windows' ? 'EliteBook 840 G9' : os === 'iOS' ? 'iPhone 15' : 'Pixel 8', manufacturer: os === 'Windows' ? 'HP' : os === 'iOS' ? 'Apple' : 'Google',
      ...extra,
    };
    intune.push(d);
    return d;
  };
  const pair = (name, os, user, extra = {}) => { const e = mkEntra(name, os); return { e, d: mkIntune(name, os, user, e, extra) }; };

  // 30 regular laptops
  for (let i = 1; i <= 30; i++) pair(`CTS-LT-${String(i).padStart(4, '0')}`, 'Windows', team[i % team.length]);
  // Re-imaged laptop: a stale Entra object and a retired Intune record share the name with the live one
  mkEntra('CTS-LT-0007', 'Windows', { approximateLastSignInDateTime: daysAgo(240) });
  { const old = mkEntra('CTS-LT-0007', 'Windows', { approximateLastSignInDateTime: daysAgo(400) });
    mkIntune('CTS-LT-0007', 'Windows', U.tom, old, { managementState: 'retirePending', lastSyncDateTime: daysAgo(380) }); }
  // Two live kiosks with the same name
  const k1 = pair('KIOSK-LOBBY', 'Windows', null).e;
  const k2 = pair('KIOSK-LOBBY', 'Windows', null).e;
  // Entra only (never enrolled), Intune only (no Entra object), not managed
  mkEntra('CTS-LT-0042', 'Windows');
  mkIntune('Android_Pixel_Omar', 'Android', U.omar, null);
  { const e = mkEntra('CTS-LT-0050', 'Windows'); mkIntune('CTS-LT-0050', 'Windows', U.ravi, e, { managementState: 'wipePending' }); }
  // Phones (one with an apostrophe in its name)
  pair("Jane's iPhone", 'iOS', U.jane);
  pair('Omar iPhone', 'iOS', U.omar);
  pair('Noor iPhone', 'iOS', U.noor);
  pair('Paul iPhone', 'iOS', U.paul);

  // Groups
  const groups = [];
  const mkGroup = (name, members, extra = {}) => {
    const g = { id: guid(), displayName: name, groupTypes: [], securityEnabled: true, mailEnabled: false, membershipRule: null, _members: members, ...extra };
    groups.push(g);
    return g;
  };
  const finance = mkGroup('SG-Finance', [U.jane.id, U.tom.id]);
  const it = mkGroup('SG-IT', [U.omar.id, U.ravi.id]);
  mkGroup('SG-All-Staff', [finance.id, it.id, U.ana.id, U.sara.id, U.emma.id, U.leo.id, U.noor.id, U.paul.id, U.li.id, U.yuki.id]);
  mkGroup('SG-Kiosks', [k1.id, k2.id]);
  mkGroup('DYN-Windows-Devices', entra.filter(e => e.operatingSystem === 'Windows').map(e => e.id),
    { groupTypes: ['DynamicMembership'], membershipRule: '(device.deviceOSType -eq "Windows")' });
  mkGroup('SG-Pilot-Ring', [U.omar.id, U.li.id, entra[0].id, entra[1].id, entra[2].id]);

  // ---------------------------------------------------------------- query engine
  const json = (status, body, headers) => ({ status, body, headers: headers || {} });
  const err = (status, code, message) => json(status, { error: { code, message } });
  const pub = o => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));

  // Supports: prop eq 'value' [or prop eq 'value' ...]
  function where(list, expr) {
    if (!expr) return list;
    const parts = expr.split(/\s+or\s+/i).map(p => p.match(/^\s*(\w+)\s+eq\s+'((?:[^']|'')*)'\s*$/));
    if (parts.some(p => !p)) return null;
    return list.filter(o => parts.some(([, prop, val]) => String(o[prop] ?? '').toLowerCase() === val.replace(/''/g, "'").toLowerCase()));
  }

  function page(items, q, url) {
    const size = 10;
    const skip = Number(q.get('$skiptoken') || 0);
    const body = { value: items.slice(skip, skip + size).map(pub) };
    if (q.get('$count') === 'true') body['@odata.count'] = items.length;
    if (skip + size < items.length) {
      const next = new URL(url);
      next.searchParams.set('$skiptoken', String(skip + size));
      body['@odata.nextLink'] = next.toString();
    }
    return json(200, body);
  }

  const directory = () => new Map([...users, ...entra, ...groups].map(o => [o.id, o]));

  function membersOf(g, transitive, seen = new Set()) {
    const dir = directory();
    const out = [];
    for (const id of g._members) {
      const o = dir.get(id);
      if (!o || seen.has(id)) continue;
      seen.add(id);
      if (groups.includes(o)) { if (transitive) out.push(...membersOf(o, true, seen)); else out.push(o); }
      else out.push(o);
    }
    return out;
  }

  function handle(method, rawUrl, body) {
    const url = new URL(rawUrl, 'https://graph.microsoft.com');
    const path = decodeURIComponent(url.pathname.replace(/^\/(v1\.0|beta)/, ''));
    const q = url.searchParams;
    let m;

    if (method === 'POST' && path === '/$batch') {
      return json(200, {
        responses: body.requests.map(r => {
          if (rnd() < 0.03) return { id: r.id, status: 429, headers: { 'Retry-After': '1' }, body: { error: { code: 'TooManyRequests', message: 'Throttled' } } };
          const res = handle(r.method || 'GET', 'https://graph.microsoft.com/v1.0/' + r.url, r.body);
          return { id: r.id, status: res.status, headers: res.headers, body: res.body };
        }),
      });
    }
    if (method !== 'GET') return err(405, 'MethodNotAllowed', 'Demo tenant is read-only');

    const collection = (list, label) => {
      const r = where(list, q.get('$filter'));
      return r ? page(r, q, url.toString()) : err(400, 'BadRequest', `Unsupported filter on ${label}`);
    };
    if (path === '/deviceManagement/managedDevices') return collection(intune, 'managedDevices');
    if (path === '/devices') return collection(entra, 'devices');
    if (path === '/users') return collection(users, 'users');
    if (path === '/groups') return collection(groups, 'groups');

    if ((m = path.match(/^\/deviceManagement\/managedDevices\/([^/]+)$/))) {
      const d = intune.find(x => x.id === m[1]);
      return d ? json(200, pub(d)) : err(404, 'ResourceNotFound', 'Not found');
    }
    if ((m = path.match(/^\/devices\/([^/]+)$/))) {
      const e = entra.find(x => x.id === m[1]);
      return e ? json(200, pub(e)) : err(404, 'Request_ResourceNotFound', `Resource '${m[1]}' does not exist.`);
    }
    if ((m = path.match(/^\/users\/([^/]+)$/))) {
      const key = m[1].toLowerCase();
      const u = users.find(x => x.id === key || x.userPrincipalName.toLowerCase() === key);
      return u ? json(200, pub(u)) : err(404, 'Request_ResourceNotFound', `Resource '${m[1]}' does not exist.`);
    }
    if ((m = path.match(/^\/groups\/([^/]+)$/))) {
      const g = groups.find(x => x.id === m[1]);
      return g ? json(200, pub(g)) : err(404, 'Request_ResourceNotFound', `Resource '${m[1]}' does not exist.`);
    }
    if ((m = path.match(/^\/groups\/([^/]+)\/(transitiveMembers|members)\/microsoft\.graph\.(user|device)$/))) {
      const g = groups.find(x => x.id === m[1]);
      if (!g) return err(404, 'Request_ResourceNotFound', 'Group not found');
      const list = membersOf(g, m[2] === 'transitiveMembers').filter(o => (m[3] === 'user' ? users : entra).includes(o));
      return page(list, q, url.toString());
    }
    if (path === '/organization') return json(200, { value: [{ displayName: 'Contoso (demo)', verifiedDomains: [{ name: 'contoso.com', isDefault: true }] }] });
    return err(400, 'BadRequest', `Demo tenant has no route for ${path}`);
  }

  return {
    handle,
    session: { mode: 'demo', tenantLabel: 'contoso.com (demo)', appDisplayName: 'Demo tenant', roles: [] },
    // handy sample inputs for the UI
    samples: {
      devices: [
        'CTS-LT-0001', 'CTS-LT-0007', 'KIOSK-LOBBY', 'CTS-LT-0042', 'CTS-LT-0050', "Jane's iPhone",
        intune[3].serialNumber, entra[5].deviceId, entra[6].id, intune[8].id, 'Android_Pixel_Omar', 'NOT-A-DEVICE',
      ].join('\n'),
      users: ['jane.doe@contoso.com', 'paul.martin@contoso.fr', 'Omar Haddad', 'leo.rossi@contoso.com', 'ghost@contoso.com', U.noor.id].join('\n'),
      groups: ['SG-All-Staff', 'SG-Pilot-Ring', 'SG-Missing'].join('\n'),
    },
  };
}
