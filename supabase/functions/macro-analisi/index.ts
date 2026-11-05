// Trading Journal Pro — Analisi macro + avvisi notizie (Supabase Edge Function "macro-analisi")
//
// Azioni (campo "action" nel corpo della richiesta):
//   "analisi"    (predefinita) analisi macro sull'oro, condivisa tra gli utenti, rigenerata al massimo ogni 30 min
//   "avvisi"     ultimi avvisi delle 24 ore
//   "vapid"      chiave pubblica per le notifiche push
//   "iscrivi"    salva l'iscrizione push di questo dispositivo      { sub }
//   "disiscrivi" la rimuove                                         { endpoint }
//   "controlla"  sorveglianza: la chiama il job pianificato ogni 15 minuti (24/5). Promemoria prima delle news
//                ad alto impatto, dato effettivo appena uscito, notizie dell'ultimo momento → notifica push.
//                Si può chiamare quante volte si vuole: lavora al massimo una volta ogni 12 minuti.
//
// Segreti (Edge Functions → Secrets) — basta UNA chiave AI:
//   GEMINI_API_KEY     GRATIS (aistudio.google.com) — se c'è, si usa Gemini con ricerca Google
//   ANTHROPIC_API_KEY  a pagamento — usata solo se manca GEMINI_API_KEY (solo per l'analisi, non per la sorveglianza)
//   FRED_API_KEY       facoltativo, gratis (fred.stlouisfed.org)
//   MACRO_MODEL        facoltativo — predefinito gemini-2.5-flash
// Le chiavi per le notifiche push vengono create da sole al primo utilizzo e salvate nel database.

import webpush from 'npm:web-push@3.6.7';

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const FRED_KEY = Deno.env.get('FRED_API_KEY') ?? '';
const PROVIDER = GEMINI_KEY ? 'gemini' : 'claude';
const MODEL = Deno.env.get('MACRO_MODEL') || (PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'claude-sonnet-5-5');

const FRESH_MS = 3 * 60 * 60 * 1000;   // sotto le 3 ore si usa l'analisi salvata
const MIN_FORCE_MS = 30 * 60 * 1000;   // mai più di un'analisi ogni 30 minuti
const CHECK_EVERY_MS = 12 * 60 * 1000; // sorveglianza: al massimo una volta ogni 12 minuti
const REMIND_MIN = 20;                 // promemoria se una news ad alto impatto esce entro 20 minuti
const MAX_SEARCHES = 5;                // solo per Claude

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// ---------- database (chiave di servizio: gli utenti non accedono mai direttamente a queste tabelle) ----------
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
async function db(method: string, path: string, body?: unknown, prefer?: string): Promise<any> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers: prefer ? { ...H, Prefer: prefer } : H, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) {
    const m = t.match(/relation "public\.(tj_\w+)" does not exist|Could not find the table 'public\.(tj_\w+)'/);
    throw new Error(m ? `Tabella ${m[1] || m[2]} mancante: esegui di nuovo lo script macro.sql su Supabase.` : `Errore database: ${t.slice(0, 200)}`);
  }
  return t ? JSON.parse(t) : null;
}
async function cfgGet(key: string): Promise<any> {
  const rows = await db('GET', `tj_config?select=value&key=eq.${encodeURIComponent(key)}`);
  return rows && rows[0] ? rows[0].value : null;
}
async function cfgSet(key: string, value: unknown): Promise<void> {
  await db('POST', 'tj_config?on_conflict=key', { key, value }, 'resolution=merge-duplicates,return=minimal');
}

async function currentUser(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? String(u.id) : null;
}

// ---------- orari ----------
function partsIn(tz: string, d: Date) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { wd: g('weekday'), y: +g('year'), mo: +g('month'), d: +g('day'), h: +g('hour'), mi: +g('minute') };
}
const romeFmt = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const romeHM = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
const nyHM = new Intl.DateTimeFormat('it-IT', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

// mercato dell'oro aperto: da domenica 18:00 a venerdì 17:00, ora di New York
function marketOpen(now = new Date()): boolean {
  const ny = partsIn('America/New_York', now);
  if (ny.wd === 'Sat') return false;
  if (ny.wd === 'Fri' && ny.h >= 17) return false;
  if (ny.wd === 'Sun' && ny.h < 18) return false;
  return true;
}
// orario di New York di oggi convertito in ora italiana (gestisce da solo l'ora legale dei due paesi)
function nyToRome(h: number, m = 0): string {
  const now = new Date(), ny = partsIn('America/New_York', now);
  let guess = Date.UTC(ny.y, ny.mo - 1, ny.d, h, m);
  for (let i = 0; i < 2; i++) { const p = partsIn('America/New_York', new Date(guess)); guess += ((h - p.h) * 60 + (m - p.mi)) * 60000; }
  return romeHM.format(new Date(guess));
}
// candele H4 nella griglia CRT classica (giornata che apre alle 17:00 NY: H4 alle 17, 21, 01, 05, 09, 13 NY)
const H4_STARTS = [17, 21, 1, 5, 9, 13];
function h4Grid(): string {
  return H4_STARTS.map((s) => `H4 ${String(s).padStart(2, '0')}:00 NY = ${nyToRome(s)}-${nyToRome((s + 4) % 24)} ora italiana`).join('\n')
    + `\nCandela Daily: apre alle 17:00 NY = ${nyToRome(17)} ora italiana`;
}
function h4Of(d: Date): string {
  const ny = partsIn('America/New_York', d);
  const start = (17 + Math.floor(((ny.h - 17 + 24) % 24) / 4) * 4) % 24;
  return `H4 delle ${String(start).padStart(2, '0')}:00 NY (${nyToRome(start)} ora italiana)`;
}
function sessions(): string {
  return [
    `Asia: ${nyToRome(20)}-${nyToRome(0)} (20:00-00:00 NY)`,
    `London killzone: ${nyToRome(2)}-${nyToRome(5)} (02:00-05:00 NY)`,
    `New York AM killzone: ${nyToRome(7)}-${nyToRome(10)} (07:00-10:00 NY)`,
    `Uscita dati USA principali: ${nyToRome(8, 30)} (08:30 NY), ISM/fiducia ${nyToRome(10)} (10:00 NY)`,
    `London close: ${nyToRome(10)}-${nyToRome(12)} (10:00-12:00 NY)`,
  ].join('\n');
}

// ---------- dati ----------
async function calendarRaw(): Promise<any[] | null> {
  const cached = await cfgGet('calendario').catch(() => null);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000 && Array.isArray(cached.rows)) return cached.rows;
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'TradingJournalPro/1.0' } });
    if (!r.ok) return cached?.rows ?? null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return cached?.rows ?? null;
    await cfgSet('calendario', { at: Date.now(), rows }).catch(() => {});
    return rows;
  } catch {
    return cached?.rows ?? null;
  }
}
function relevant(e: any): boolean { return (e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium')) || e.impact === 'High'; }
function fmtEvent(e: any) {
  const d = new Date(e.date), ok = !isNaN(d.getTime());
  return {
    evento: e.title, valuta: e.country, impatto: e.impact === 'High' ? 'alto' : 'medio',
    ora_roma: ok ? romeFmt.format(d) : e.date, ora_new_york: ok ? nyHM.format(d) : '',
    previsione: e.forecast || '', precedente: e.previous || '', passato: ok ? d.getTime() < Date.now() : null,
  };
}
async function calendar(): Promise<any[] | { errore: string }> {
  const rows = await calendarRaw();
  return rows ? rows.filter(relevant).map(fmtEvent) : { errore: 'calendario ForexFactory non disponibile: cerca gli eventi sul web' };
}

const FRED_SERIES: [string, string][] = [
  ['DGS10', 'Rendimento Treasury 10 anni (%)'],
  ['DFII10', 'Rendimento reale 10 anni, TIPS (%)'],
  ['T10YIE', 'Inflazione attesa 10 anni, breakeven (%)'],
  ['DGS2', 'Rendimento Treasury 2 anni (%)'],
  ['DFEDTARU', 'Tasso Fed, limite superiore (%)'],
  ['DTWEXBGS', 'Indice dollaro ampio Fed (non è il DXY)'],
];
async function fred(): Promise<any[] | { errore: string }> {
  if (!FRED_KEY) return { errore: 'FRED_API_KEY non impostata: cerca i valori sul web' };
  return await Promise.all(FRED_SERIES.map(async ([id, label]) => {
    try {
      const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=15`);
      if (!r.ok) return { serie: id, nome: label, errore: `HTTP ${r.status}` };
      const obs = ((await r.json()).observations || []).filter((o: any) => o.value !== '.' && o.value !== '');
      if (!obs.length) return { serie: id, nome: label, errore: 'nessun dato' };
      const last = Number(obs[0].value), prev = obs[5] ? Number(obs[5].value) : null;
      return { serie: id, nome: label, valore: last, data: obs[0].date, variazione_5_giorni: prev == null ? null : Math.round((last - prev) * 1000) / 1000 };
    } catch (err) {
      return { serie: id, nome: label, errore: (err as Error).message };
    }
  }));
}
async function recentAlerts(hours = 24): Promise<any[]> {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  return await db('GET', `tj_alerts?select=id,created_at,kind,impatto,titolo,testo,direzione,url&created_at=gte.${since}&order=created_at.desc&limit=40`).catch(() => []);
}

// ---------- AI ----------
const CONTESTO = `IL TUO LAVORO, PRIMA DI TUTTO: aiutare il trader a LEGGERE e CAPIRE la situazione macroeconomica. Non devi solo dire cosa succede: devi spiegare perché succede, come i fatti sono collegati tra loro e cosa significano per l'oro, in modo che lui impari a ragionarci da solo. La macro è il cuore di ogni tua risposta; tutto il resto è secondario.

CHI LEGGE: un trader italiano di oro (XAUUSD) intraday, che usa il DXY come filtro di correlazione inversa e lavora su un conto prop firm con limiti di perdita giornaliera stretti: per lui è vitale sapere QUANDO il mercato può diventare violento e PERCHÉ. Non è un economista: spiega i concetti in modo semplice, senza dare per scontato il gergo (se usi un termine tecnico, spiegalo in poche parole).

COME RAGIONA L'ORO (usalo sempre):
- Rendimenti reali USA (TIPS) su → oro giù; giù → oro su. È il fattore principale.
- Dollaro/DXY su → oro di solito giù (correlazione inversa, che a volte si rompe in fasi di paura).
- Fed più restrittiva del previsto (meno tagli, tassi alti più a lungo) → rendimenti e dollaro su → oro giù. Fed più accomodante → oro su.
- Inflazione sopra le attese: nel breve fa salire i rendimenti e scendere l'oro; se il mercato teme inflazione fuori controllo l'oro può salire come protezione.
- Dati su lavoro e crescita forti → oro giù; deboli → oro su (più tagli attesi).
- Guerre, attacchi, crisi bancarie, shock politici, dazi → domanda di bene rifugio, oro su (spesso con picchi rapidi e poi ritracciamenti).
- Acquisti delle banche centrali (Cina/PBoC, India, Polonia, Turchia...), flussi negli ETF, domanda fisica asiatica: supporto di fondo.
- Liquidazioni forzate nei crolli azionari possono far scendere anche l'oro nel brevissimo.
REGOLE:
- Verifica sempre i fatti recenti con la ricerca Google; non inventare MAI numeri, date o dichiarazioni. Se un dato non lo trovi scrivi "non disponibile".
- Spiega ogni punto con la catena causa → effetto, in italiano semplice e concreto, con i numeri trovati.
- Orari sempre in ora italiana, con New York tra parentesi.
- Non dare entrate, stop o target: il tuo lavoro è il contesto macro, i rischi e il tempismo.

COLLEGAMENTO CON IL GRAFICO (secondario: viene DOPO la lettura macro e non la sostituisce). Il trader usa la CRT (Candle Range Theory):
- Si prende il range (massimo-minimo) di una candela di riferimento su timeframe alto: Daily, H4 o H1.
- La candela successiva va a prendere la liquidità oltre il massimo o il minimo di quel range (sweep/manipolazione) e poi CHIUDE di nuovo dentro il range: è il segnale che il prezzo può andare verso il lato opposto del range (distribuzione).
- Se invece chiude fuori dal range con forza, la CRT è fallita: è una rottura vera e il movimento continua.
- Le news ad alto impatto sono la causa più frequente degli sweep. Uno sweep provocato da una news CONTRO il bias macro ha più probabilità di rientrare nel range (CRT valida); uno sweep nella direzione del bias macro ha più probabilità di rompere e continuare (CRT fallita).
- Le candele H4 che contengono una news importante sono quelle dove la manipolazione è più violenta: è utile sapere in anticipo quali sono e quale range di riferimento rischiano di spazzare.
- Usa TradingView sul fuso di New York; la griglia H4 di riferimento è quella CRT classica (17, 21, 01, 05, 09, 13 NY).`;

const SYSTEM_ANALISI = `Sei l'analista macroeconomico e insegnante di fiducia di un trader di oro. ${CONTESTO}

OGNI VOLTA controlla con la ricerca, in quest'ordine:
1. Fed: tassi attuali, data del prossimo FOMC, probabilità di taglio/rialzo (CME FedWatch), ultimi discorsi di Powell/membri Fed e il loro tono.
2. Rendimenti USA a 2 e 10 anni e rendimento reale a 10 anni: livello e direzione della settimana.
3. DXY: livello e tendenza.
4. Dati usciti negli ultimi giorni (CPI, PCE, NFP, disoccupazione, ISM, PMI, vendite al dettaglio, richieste di sussidi) con valore effettivo contro previsione.
5. Geopolitica, dazi, crisi, elezioni: cosa sta succedendo ADESSO che può muovere i beni rifugio.
6. Notizie specifiche sull'oro: prezzo attuale e range recente, banche centrali, ETF, Cina/India.
7. Sentiment di rischio: azionario USA, VIX, petrolio.

La risposta finale deve contenere SOLO un oggetto JSON tra <json> e </json> (niente citazioni o markdown dentro), con questa forma:
{
  "bias": "rialzista" | "ribassista" | "neutrale",
  "forza": 1 | 2 | 3,
  "titolo": "frase breve che riassume la situazione",
  "sintesi": "5-7 frasi: quadro generale, perché, e cosa conta di più in questo momento",
  "da_capire": "4-6 frasi: il concetto macro più importante di questo momento spiegato in modo semplice, come a uno studente (es. perché i rendimenti reali contano per l'oro, cosa significa un FOMC 'hawkish', perché il dato sul lavoro muove il dollaro), collegato ai fatti di oggi",
  "cambiamenti": "cosa è cambiato rispetto all'analisi precedente (se fornita) e perché; altrimenti stringa vuota",
  "fed": { "tasso_attuale": "...", "prossimo_fomc": "data", "probabilita": "es. 70% pausa, 30% taglio 25pb", "tono": "breve descrizione" },
  "fattori": [ { "nome": "...", "direzione": "rialzista" | "ribassista" | "neutrale", "spiegazione": "2-3 frasi con i numeri" } ],
  "oggi": {
    "sessioni": [ { "sessione": "Londra", "orario": "09:00-12:00", "cosa_aspettarsi": "volatilità attesa, eventi, rischi" } ],
    "da_guardare": [ "cose concrete da controllare oggi, es. reazione del DXY al dato delle 14:30" ]
  },
  "crt": {
    "range_chiave": "quale range conta di più oggi (Daily di ieri, una H4 precisa, H1) e perché, in base a news e sessioni",
    "candele_con_news": [ { "candela": "H4 09:00 NY (15:00-19:00 ora italiana)", "news": "evento e orario", "rischio": "quale lato del range precedente rischia lo sweep e come lo spinge la news" } ],
    "lettura": "3-5 frasi: con questo bias macro, uno sweep sopra il massimo è più probabile che rientri o che rompa? E uno sotto il minimo? Quando la CRT è più affidabile oggi e quando conviene stare fuori"
  },
  "eventi": [ { "quando": "gio 06/11 14:30 (08:30 NY)", "evento": "...", "impatto": "alto" | "medio", "previsione": "...", "precedente": "...", "effettivo": "valore o stringa vuota se non è uscito", "scenari": "oro se sopra le attese / se sotto" } ],
  "finestre_rischio": [ "giorno e orario: motivo, cosa fare (es. niente nuove entrate)" ],
  "cosa_cambierebbe": "quali notizie o dati ribalterebbero lo scenario",
  "fonti_chiave": [ { "titolo": "...", "url": "https://..." } ]
}
Ordine di importanza: prima sintesi, fattori, Fed ed eventi spiegati bene; la parte "crt" è solo il collegamento finale con il grafico. "crt.candele_con_news": solo le candele H4 di oggi e domani che contengono news ad alto impatto. "fattori": da 5 a 8 voci (rendimenti reali, dollaro/DXY, Fed, inflazione, lavoro/crescita, geopolitica, banche centrali/flussi, sentiment). "oggi.sessioni": le sessioni ancora da venire oggi (se è sera, quelle di domani). "eventi": massimo 10, prima i prossimi; quelli passati solo se hanno mosso il mercato.`;

const SYSTEM_SORVEGLIANZA = `Sei il sistema di allerta notizie di un desk di trading sull'oro. ${CONTESTO}

Il tuo compito ora è SOLO trovare cose NUOVE delle ultime 1-2 ore che possono muovere oro o dollaro e che i trader devono sapere subito:
- dati macro appena usciti (valore effettivo contro previsione, reazione probabile dell'oro e se lo sweep provocato va con o contro il bias macro);
- dichiarazioni a sorpresa di Fed, Tesoro USA, Casa Bianca, BCE, BoJ, PBoC;
- eventi geopolitici (attacchi, escalation, cessate il fuoco), dazi e sanzioni, crisi bancarie o di mercato, notizie di rottura sull'oro;
- movimenti violenti già in corso su oro, DXY o rendimenti.
NON segnalare: notizie già presenti nell'elenco "avvisi già inviati" (anche se scritte in modo diverso), commenti e previsioni di analisti, notizie vecchie, cose a basso impatto. Se non c'è niente di davvero nuovo e rilevante, restituisci una lista vuota: è la risposta normale.

Rispondi SOLO con JSON tra <json> e </json>:
{ "avvisi": [ { "chiave": "identificativo breve e stabile della notizia, es. nfp-2026-11-07 o iran-attacco-israele-2026-11-05", "impatto": "alto" | "medio", "titolo": "max 70 caratteri", "testo": "max 240 caratteri: cosa è successo con i numeri, PERCHÉ conta per l'oro (catena causa → effetto in breve) e cosa fare (es. attendere che si calmi lo spread)", "direzione_oro": "rialzista" | "ribassista" | "incerta", "url": "fonte" } ] }`;

type AiResult = { analysis: any; rawText: string; sources: { titolo: string; url: string }[]; usage: any };

function parseJson(text: string): any {
  const m = text.match(/<json>([\s\S]*?)<\/json>/) || text.match(/(\{[\s\S]*\})/);
  if (!m) return null;
  const body = m[1].replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(body); } catch { return null; }
}

async function askGemini(system: string, prompt: string, maxTokens = 12000): Promise<AiResult> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens },
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const m = j?.error?.message || `HTTP ${r.status}`;
    throw new Error(r.status === 400 && /API key/i.test(m) ? 'Chiave GEMINI_API_KEY non valida.' : r.status === 429 ? 'Limite gratuito di Gemini raggiunto per ora, riprova più tardi.' : `Errore Gemini: ${m}`);
  }
  const cand = j?.candidates?.[0];
  const rawText = (cand?.content?.parts || []).filter((p: any) => typeof p.text === 'string' && !p.thought).map((p: any) => p.text).join('');
  if (!rawText) throw new Error(`Gemini non ha restituito testo (motivo: ${cand?.finishReason || 'sconosciuto'}).`);
  const analysis = parseJson(rawText);
  const seen = new Set<string>(); const sources: { titolo: string; url: string }[] = [];
  for (const c of cand?.groundingMetadata?.groundingChunks || []) {
    const u = c?.web?.uri; if (u && !seen.has(u)) { seen.add(u); sources.push({ titolo: c.web.title || u, url: u }); }
  }
  return { analysis, rawText: analysis ? '' : rawText.slice(0, 6000), sources: sources.slice(0, 15), usage: j?.usageMetadata ?? null };
}

async function askClaude(system: string, prompt: string, maxTokens = 6000): Promise<AiResult> {
  const messages: any[] = [{ role: 'user', content: prompt }];
  const all: any[] = []; let usage: any = null;
  for (let i = 0; i < 4; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }] }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(r.status === 401 ? 'Chiave ANTHROPIC_API_KEY non valida.' : `Errore Claude: ${j?.error?.message || 'HTTP ' + r.status}`);
    usage = j.usage; all.push(...(j.content || []));
    if (j.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: j.content }); continue; }
    break;
  }
  const rawText = all.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const analysis = parseJson(rawText);
  const seen = new Set<string>(); const sources: { titolo: string; url: string }[] = [];
  for (const b of all) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const it of b.content) if (it.url && !seen.has(it.url)) { seen.add(it.url); sources.push({ titolo: it.title || it.url, url: it.url }); }
  return { analysis, rawText: analysis ? '' : rawText.slice(0, 6000), sources: sources.slice(0, 15), usage };
}
const askAI = (system: string, prompt: string, maxTokens?: number) => PROVIDER === 'gemini' ? askGemini(system, prompt, maxTokens) : askClaude(system, prompt, maxTokens);

// ---------- notifiche push ----------
async function vapid(): Promise<{ publicKey: string; privateKey: string }> {
  let v = await cfgGet('vapid');
  if (!v?.publicKey) {
    const k = webpush.generateVAPIDKeys();
    await db('POST', 'tj_config?on_conflict=key', { key: 'vapid', value: k }, 'resolution=ignore-duplicates,return=minimal');
    v = await cfgGet('vapid');   // se due richieste arrivano insieme vince la prima chiave salvata
  }
  return v;
}
async function pushSubject(): Promise<string> {
  return (await cfgGet('push_subject').catch(() => null)) || 'mailto:avvisi@example.com';
}
async function sendPush(payload: { title: string; body: string; tag: string; url: string }): Promise<{ sent: number; removed: number }> {
  const subs = await db('GET', 'tj_push?select=endpoint,sub');
  if (!subs?.length) return { sent: 0, removed: 0 };
  const v = await vapid();
  webpush.setVapidDetails(await pushSubject(), v.publicKey, v.privateKey);
  let sent = 0, removed = 0;
  await Promise.all(subs.map(async (s: any) => {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }); sent++; }
    catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) { removed++; await db('DELETE', `tj_push?endpoint=eq.${encodeURIComponent(s.endpoint)}`).catch(() => {}); }
      else console.error('push fallita', err?.statusCode, err?.body);
    }
  }));
  return { sent, removed };
}
// salva l'avviso solo se è nuovo (stessa chiave = già inviato) e manda la notifica
async function alert(a: { dedup: string; kind: string; impatto: string; titolo: string; testo: string; direzione?: string; url?: string }): Promise<boolean> {
  const rows = await db('POST', 'tj_alerts?on_conflict=dedup', [a], 'resolution=ignore-duplicates,return=representation');
  if (!rows?.length) return false;
  const icon = a.kind === 'promemoria' ? '⏰' : a.impatto === 'alto' ? '🔴' : '🟠';
  const dir = a.direzione === 'rialzista' ? ' · oro ▲' : a.direzione === 'ribassista' ? ' · oro ▼' : '';
  await sendPush({ title: `${icon} ${a.titolo}`.slice(0, 90), body: (a.testo + dir).slice(0, 260), tag: a.dedup, url: './#/macro' });
  return true;
}
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);

// ---------- azioni ----------
async function doAnalisi(force: boolean) {
  const last = (await db('GET', 'tj_macro?select=id,created_at,report&order=created_at.desc&limit=1'))?.[0] ?? null;
  const alerts = await recentAlerts(24);
  const age = last ? Date.now() - new Date(last.created_at).getTime() : Infinity;
  // dopo una notizia ad alto impatto l'analisi salvata è superata
  const staleByNews = !!last && alerts.some((a) => a.impatto === 'alto' && a.kind !== 'promemoria' && new Date(a.created_at).getTime() > new Date(last.created_at).getTime());
  if (last && (age < MIN_FORCE_MS || (!force && !staleByNews && age < FRESH_MS))) {
    return { ...last.report, cached: true, limited: force && age < MIN_FORCE_MS, created_at: last.created_at, avvisi: alerts };
  }
  if (!GEMINI_KEY && !ANTHROPIC_KEY) throw new Error('Nessuna chiave AI impostata: aggiungi GEMINI_API_KEY (gratis) nei segreti della funzione.');
  const [cal, rates] = await Promise.all([calendar(), fred()]);
  const prev = last?.report?.analysis;
  const prompt = `Data e ora attuali: ${romeFmt.format(new Date())} ora italiana (${new Date().toISOString()} UTC). Mercato dell'oro ${marketOpen() ? 'APERTO' : 'CHIUSO (weekend)'}.
Orari di oggi delle sessioni in ora italiana:
${sessions()}

Griglia delle candele H4 di oggi (CRT):
${h4Grid()}

Calendario economico della settimana (ForexFactory, eventi USD medio/alto impatto e tutti quelli ad alto impatto):
${JSON.stringify(cal)}

Dati FRED:
${JSON.stringify(rates)}

Avvisi di notizie inviati nelle ultime 24 ore:
${JSON.stringify(alerts.map((a) => ({ ora: romeFmt.format(new Date(a.created_at)), titolo: a.titolo, testo: a.testo })))}

Analisi precedente${last ? ' (' + romeFmt.format(new Date(last.created_at)) + ')' : ''}:
${prev ? JSON.stringify({ bias: prev.bias, forza: prev.forza, titolo: prev.titolo, sintesi: prev.sintesi }) : 'nessuna'}

Fai le ricerche della tua lista e restituisci il JSON.`;
  const res = await askAI(SYSTEM_ANALISI, prompt);
  const report = { generated_at: new Date().toISOString(), model: MODEL, analysis: res.analysis, raw_text: res.rawText, sources: res.sources, inputs: { calendario: cal, dati_fred: rates }, usage: res.usage };
  if (res.analysis) await db('POST', 'tj_macro', { report }, 'return=minimal');
  return { ...report, cached: false, created_at: report.generated_at, avvisi: alerts };
}

async function doControlla() {
  if (!marketOpen()) return { stato: 'mercato chiuso' };
  const lastRun = await cfgGet('ultimo_controllo');
  if (lastRun && Date.now() - lastRun.at < CHECK_EVERY_MS) return { stato: 'controllo recente, salto' };
  await cfgSet('ultimo_controllo', { at: Date.now() });

  const out: any = { promemoria: 0, avvisi: 0 };
  const rows = (await calendarRaw()) ?? [];
  const now = Date.now();

  // 1. promemoria prima delle news ad alto impatto sul dollaro (senza AI)
  for (const e of rows) {
    if (e.impact !== 'High' || e.country !== 'USD') continue;
    const t = new Date(e.date).getTime(); if (isNaN(t)) continue;
    const min = (t - now) / 60000;
    if (min > 0 && min <= REMIND_MIN) {
      const prev = [e.forecast && `previsione ${e.forecast}`, e.previous && `precedente ${e.previous}`].filter(Boolean).join(' · ');
      const ok = await alert({
        dedup: `pre:${slug(e.title)}:${e.date}`, kind: 'promemoria', impatto: 'alto',
        titolo: `Tra ${Math.round(min)} min: ${e.title} (USD)`,
        testo: `Alle ${romeHM.format(new Date(t))} (${nyHM.format(new Date(t))} NY), dentro la ${h4Of(new Date(t))}: possibile sweep del range della H4 precedente. ${prev ? prev + '. ' : ''}Spread alti: proteggi le posizioni e non aprirne di nuove a ridosso.`,
      });
      if (ok) out.promemoria++;
    }
  }

  // 2. dati appena usciti + notizie dell'ultimo momento (AI con ricerca)
  if (!GEMINI_KEY) return { ...out, nota: 'sorveglianza notizie attiva solo con GEMINI_API_KEY' };
  const justOut = rows.filter((e: any) => { const t = new Date(e.date).getTime(); return relevant(e) && t <= now && now - t <= 75 * 60000; }).map(fmtEvent);
  const next = rows.filter((e: any) => { const t = new Date(e.date).getTime(); return relevant(e) && t > now && t - now <= 3 * 3600000; }).map(fmtEvent);
  const sent = await recentAlerts(36);
  const prompt = `Ora attuale: ${romeFmt.format(new Date())} ora italiana (${new Date().toISOString()} UTC).
Eventi del calendario usciti negli ultimi 75 minuti (cerca il valore EFFETTIVO e, se è diverso dalle attese, crea un avviso con chiave "dato-<evento>-<data>"):
${JSON.stringify(justOut)}
Eventi in arrivo nelle prossime 3 ore (solo contesto, i promemoria li invio io):
${JSON.stringify(next)}
Avvisi già inviati (NON ripeterli):
${JSON.stringify(sent.map((a) => ({ titolo: a.titolo, ora: romeFmt.format(new Date(a.created_at)) })))}

Cerca le ultime notizie su: oro/gold price news, Fed, Treasury yields, dollar index, e notizie geopolitiche o di mercato di rottura delle ultime 2 ore. Poi restituisci il JSON.`;
  const res = await askAI(SYSTEM_SORVEGLIANZA, prompt, 6000);
  const list = Array.isArray(res.analysis?.avvisi) ? res.analysis.avvisi : [];
  for (const a of list.slice(0, 4)) {
    if (!a || !a.titolo || !['alto', 'medio'].includes(a.impatto)) continue;
    const url = typeof a.url === 'string' && /^https?:\/\//.test(a.url) ? a.url : (res.sources[0]?.url ?? null);
    const ok = await alert({ dedup: 'news:' + slug(a.chiave || a.titolo), kind: 'notizia', impatto: a.impatto, titolo: String(a.titolo).slice(0, 90), testo: String(a.testo || '').slice(0, 300), direzione: a.direzione_oro, url: url ?? undefined });
    if (ok) out.avvisi++;
  }
  return out;
}

// notifica di prova subito dopo l'attivazione, così si vede che funziona
async function pushTest(sub: any) {
  const v = await vapid();
  webpush.setVapidDetails(await pushSubject(), v.publicKey, v.privateKey);
  await webpush.sendNotification(sub, JSON.stringify({ title: '✅ Avvisi attivi', body: 'Riceverai qui i promemoria prima delle news ad alto impatto e le notizie che possono muovere l\'oro.', tag: 'test', url: './#/macro' }), { TTL: 600 }).catch((e: any) => console.error('push di prova', e?.statusCode));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Metodo non consentito' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action || 'analisi';

    if (action === 'controlla') return json(await doControlla());   // job pianificato: lavora al massimo 1 volta ogni 12 minuti

    const uid = await currentUser(req);
    if (!uid) return json({ error: 'Accesso richiesto: entra con il tuo account del journal.' }, 401);

    if (action === 'analisi') return json(await doAnalisi(!!body.force));
    if (action === 'avvisi') return json({ avvisi: await recentAlerts(24) });
    if (action === 'vapid') return json({ publicKey: (await vapid()).publicKey });
    if (action === 'iscrivi') {
      const sub = body.sub;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: 'Iscrizione non valida.' }, 400);
      await db('POST', 'tj_push?on_conflict=endpoint', { endpoint: sub.endpoint, user_id: uid, sub }, 'resolution=merge-duplicates,return=minimal');
      const origin = req.headers.get('Origin');
      if (origin && /^https:\/\//.test(origin) && !(await cfgGet('push_subject'))) await cfgSet('push_subject', origin);
      if (body.test) await pushTest(sub);
      return json({ ok: true });
    }
    if (action === 'disiscrivi') {
      if (typeof body.endpoint === 'string') await db('DELETE', `tj_push?endpoint=eq.${encodeURIComponent(body.endpoint)}&user_id=eq.${uid}`);
      return json({ ok: true });
    }
    return json({ error: 'Azione sconosciuta' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message || 'Errore interno' }, 500);
  }
});
