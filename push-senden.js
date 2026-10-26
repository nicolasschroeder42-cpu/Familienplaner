// Verschickt die Morgen-Benachrichtigungen. Läuft stündlich über GitHub Actions
// (.github/workflows/morgen.yml) und nutzt dieselbe Berechnungslogik wie die App:
// die mit @core-start/@core-end markierten Abschnitte aus index.html.
'use strict';
const fs = require('fs');
const vm = require('vm');
const webpush = require('web-push');

const FORCE = process.env.FORCE === 'true';   // manueller Testlauf: sofort an alle senden
const FAMILY_CODE = process.env.FAMILY_CODE;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const FIRST_HOUR = 5, LAST_HOUR = 22;         // in der App wählbare Uhrzeiten
const MAX_DELAY_HOURS = 3;                    // verspätete Läufe holen höchstens so viel nach

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadCore(){
  const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  const code = [...html.matchAll(/\/\* @core-start[\s\S]*?\*\/([\s\S]*?)\/\* @core-end \*\//g)].map(m => m[1]).join('\n');
  const ctx = vm.createContext({state: null});
  vm.runInContext(code, ctx);
  // const-Werte sind keine Eigenschaften des Kontexts – daher explizit herausreichen
  const api = vm.runInContext('({today, VAPID_PUBLIC, buildDigest})', ctx);
  return {...api, setState: s => { ctx.state = s; }};
}

// Verbindungscode aus der App (Link mit #join=… oder nur der Code)
function decodeFamilyCode(code){
  const s = code.trim().replace(/^.*join=/, '').replace(/-/g, '+').replace(/_/g, '/');
  const d = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  if (!d.c || !d.c.databaseURL || !d.f) throw new Error('FAMILY_CODE ist ungültig.');
  return {config: d.c, family: d.f};
}

async function main(){
  if (!FAMILY_CODE || !VAPID_PRIVATE_KEY) throw new Error('Die Secrets FAMILY_CODE und VAPID_PRIVATE_KEY fehlen.');
  const {config, family} = decodeFamilyCode(FAMILY_CODE);
  const core = loadCore();

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
    console.log(`${hour}:00 Uhr – keine Benachrichtigungen vorgesehen.`);
    return;
  }

  // Anonym bei Firebase anmelden (wie die App) und Familien-Daten lesen
  const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${config.apiKey}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({returnSecureToken: true}),
  });
  const auth = await authRes.json();
  if (!auth.idToken) throw new Error('Anmeldung bei Firebase fehlgeschlagen: ' + (auth.error && auth.error.message));
  const base = `${config.databaseURL.replace(/\/$/, '')}/families/${family}`;
  const q = `.json?auth=${auth.idToken}`;
  const data = await (await fetch(base + q)).json();
  if (data && data.error) throw new Error('Datenbank: ' + data.error);
  if (!data || !data.push){ console.log('Kein Gerät hat Benachrichtigungen eingeschaltet.'); return; }

  core.setState({
    people: data.people || {},
    tasks: Object.values(data.tasks || {}).filter(t => t && t.freq),
    done: data.done || {},
    overrides: data.overrides || {},
  });
  const today = core.today();
  webpush.setVapidDetails(`https://github.com/${process.env.GITHUB_REPOSITORY || ''}`, core.VAPID_PUBLIC, VAPID_PRIVATE_KEY);

  let sent = 0;
  for (const [id, dev] of Object.entries(data.push)){
    if (!dev || !dev.sub) continue;
    const due = FORCE || (dev.last !== today && dev.hour <= hour && hour - dev.hour <= MAX_DELAY_HOURS);
    if (!due) continue;
    const msg = core.buildDigest(dev.person, today);
    try {
      await webpush.sendNotification(dev.sub, JSON.stringify({...msg, url: './?view=day'}), {TTL: 4 * 3600, urgency: 'high'});
      sent++;
      // Testläufe zählen nicht – sonst fiele die echte Nachricht heute aus
      if (!FORCE) await fetch(`${base}/push/${id}${q}`, {method: 'PATCH', body: JSON.stringify({last: today})});
    } catch(e){
      if (e.statusCode === 404 || e.statusCode === 410){
        await fetch(`${base}/push/${id}${q}`, {method: 'DELETE'});
        console.log('Ein abgelaufenes Gerät wurde entfernt (Benachrichtigung dort neu einschalten).');
      } else {
        console.error('Senden fehlgeschlagen:', e.statusCode || '', e.body || e.message);
      }
    }
  }
  console.log(`${sent} Benachrichtigung(en) verschickt.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
