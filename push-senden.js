// Verschickt die Benachrichtigungen des Familienplaners über GitHub Actions:
//  • MODE=morning  (stündlich, .github/workflows/morgen.yml): Morgen-Nachricht + offene Tausch-Anfragen
//  • MODE=requests (sofort, .github/workflows/anfrage.yml, von der App angestoßen): nur Tausch-Anfragen
// Die Berechnung „Was steht heute an?“ stammt aus index.html (Abschnitte @core-start/@core-end),
// damit App und Nachricht nie auseinanderlaufen.
'use strict';
const fs = require('fs');
const vm = require('vm');
const webpush = require('web-push');

const MODE = process.env.MODE || 'morning';
const FORCE = process.env.FORCE === 'true';   // manueller Testlauf: Morgen-Nachricht sofort an alle
const FAMILY_CODE = process.env.FAMILY_CODE;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const FIRST_HOUR = 5, LAST_HOUR = 22;         // in der App wählbare Uhrzeiten
const MAX_DELAY_HOURS = 3;                    // verspätete Läufe holen höchstens so viel nach
const REQUEST_MAX_AGE = 2 * 864e5;            // ältere Tausch-Anfragen werden nicht mehr zugestellt

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadCore(){
  const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  const code = [...html.matchAll(/\/\* @core-start[\s\S]*?\*\/([\s\S]*?)\/\* @core-end \*\//g)].map(m => m[1]).join('\n');
  const ctx = vm.createContext({state: null});
  vm.runInContext(code, ctx);
  // const-Werte sind keine Eigenschaften des Kontexts – daher explizit herausreichen
  const api = vm.runInContext('({today, VAPID_PUBLIC, buildDigest, fmt})', ctx);
  return {...api, setState: s => { ctx.state = s; }};
}

// Verbindungscode aus der App (Link mit #join=… oder nur der Code)
function decodeFamilyCode(code){
  const s = code.trim().replace(/^.*join=/, '').replace(/-/g, '+').replace(/_/g, '/');
  const d = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  if (!d.c || !d.c.databaseURL || !d.f) throw new Error('FAMILY_CODE ist ungültig.');
  return {config: d.c, family: d.f};
}

// Anonym bei Firebase anmelden (wie die App) und Zugriff auf die Familien-Daten bereitstellen
async function connect(config, family){
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${config.apiKey}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({returnSecureToken: true}),
  });
  const auth = await res.json();
  if (!auth.idToken) throw new Error('Anmeldung bei Firebase fehlgeschlagen: ' + (auth.error && auth.error.message));
  const base = `${config.databaseURL.replace(/\/$/, '')}/families/${family}`;
  const q = `.json?auth=${auth.idToken}`;
  return {
    async get(){
      const data = await (await fetch(base + q)).json();
      if (data && data.error) throw new Error('Datenbank: ' + data.error);
      return data || {};
    },
    patch: (path, obj) => fetch(`${base}/${path}${q}`, {method: 'PATCH', body: JSON.stringify(obj)}),
    remove: path => fetch(`${base}/${path}${q}`, {method: 'DELETE'}),
  };
}

// Nachricht an ein Gerät; abgelaufene Anmeldungen werden entfernt
async function send(db, id, dev, payload){
  try {
    await webpush.sendNotification(dev.sub, JSON.stringify(payload), {TTL: 4 * 3600, urgency: 'high'});
    return true;
  } catch(e){
    if (e.statusCode === 404 || e.statusCode === 410){
      await db.remove(`push/${id}`);
      console.log('Ein abgelaufenes Gerät wurde entfernt (Benachrichtigung dort neu einschalten).');
    } else {
      console.error('Senden fehlgeschlagen:', e.statusCode || '', e.body || e.message);
    }
    return false;
  }
}
async function sendToPerson(db, data, person, payload){
  let n = 0;
  for (const [id, dev] of Object.entries(data.push || {})){
    if (dev && dev.sub && dev.person === person && await send(db, id, dev, payload)) n++;
  }
  return n;
}

// Tausch-Anfragen: neue an die gefragte Person, Antworten zurück an die fragende Person
async function processRequests(db, data, core){
  const name = k => (data.people && data.people[k] && data.people[k].name) || '';
  const day = d => core.fmt(d, {weekday: 'short', day: 'numeric', month: 'numeric'});
  let n = 0;
  for (const [id, r] of Object.entries(data.requests || {})){
    if (!r || Date.now() - (r.at || 0) > REQUEST_MAX_AGE) continue;
    if (r.status === 'open' && !r.notified){
      await db.patch(`requests/${id}`, {notified: true});   // zuerst markieren, damit parallele Läufe nicht doppelt senden
      n += await sendToPerson(db, data, r.to, {
        title: '🙋 Kannst du übernehmen?',
        body: `${name(r.from)} fragt: „${r.title}“ (${day(r.date)})`,
        url: `./?req=${id}`, req: id, tag: 'req-' + id,
      });
    } else if ((r.status === 'yes' || r.status === 'no') && !r.answerNotified){
      await db.patch(`requests/${id}`, {answerNotified: true});
      n += await sendToPerson(db, data, r.from, {
        title: r.status === 'yes' ? '✅ Tausch angenommen' : '❌ Tausch abgelehnt',
        body: `${name(r.to)} ${r.status === 'yes' ? 'übernimmt' : 'kann leider nicht'}: „${r.title}“ (${day(r.date)})`,
        url: './?view=day', tag: 'req-' + id,
      });
    }
  }
  if (n) console.log(`${n} Nachricht(en) zu Tausch-Anfragen verschickt.`);
}

async function morning(db, core){
  // Geplant ist der Lauf kurz vor der vollen Stunde – bis dahin warten.
  const now = new Date();
  let hour = now.getHours();
  if (!FORCE && now.getMinutes() >= 40){
    hour = (hour + 1) % 24;
    const wait = ((60 - now.getMinutes()) * 60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    console.log(`Warte ${Math.round(wait / 1000)} s bis ${hour}:00 Uhr.`);
    await sleep(wait);
  }
  if (!FORCE && (hour < FIRST_HOUR || hour > LAST_HOUR + MAX_DELAY_HOURS)){
    console.log(`${hour}:00 Uhr – keine Morgen-Nachrichten vorgesehen.`);
    return;
  }
  const data = await db.get();   // nach dem Warten frisch lesen
  if (!data.push){ console.log('Kein Gerät hat Benachrichtigungen eingeschaltet.'); return; }
  core.setState({...data, tasks: Object.values(data.tasks || {}).filter(t => t && t.freq)});
  const today = core.today();

  let sent = 0;
  for (const [id, dev] of Object.entries(data.push)){
    if (!dev || !dev.sub) continue;
    const due = FORCE || (dev.last !== today && dev.hour <= hour && hour - dev.hour <= MAX_DELAY_HOURS);
    if (!due) continue;
    const msg = core.buildDigest(dev.person, today);   // null = Pause, heute keine Nachricht
    if (msg && await send(db, id, dev, {...msg, url: './?view=day'})) sent++;
    // Testläufe zählen nicht – sonst fiele die echte Nachricht heute aus
    if (!FORCE) await db.patch(`push/${id}`, {last: today});
  }
  console.log(`${sent} Morgen-Nachricht(en) verschickt.`);
}

async function main(){
  if (!FAMILY_CODE || !VAPID_PRIVATE_KEY) throw new Error('Die Secrets FAMILY_CODE und VAPID_PRIVATE_KEY fehlen.');
  const {config, family} = decodeFamilyCode(FAMILY_CODE);
  const core = loadCore();
  webpush.setVapidDetails(`https://github.com/${process.env.GITHUB_REPOSITORY || ''}`, core.VAPID_PUBLIC, VAPID_PRIVATE_KEY);
  const db = await connect(config, family);

  // Tausch-Anfragen immer zuerst – im stündlichen Lauf als Rückfallebene ohne GitHub-Schlüssel
  await processRequests(db, await db.get(), core);
  if (MODE === 'morning') await morning(db, core);
}

main().catch(e => { console.error(e.message); process.exit(1); });
