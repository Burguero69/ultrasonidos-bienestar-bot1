// Ultrasonidos Bienestar — bot WhatsApp Business + Messenger
// Un solo cerebro, dos canales. Base de datos: Google Sheets.
// Agenda real: "AGENDA PERSONAL - ULTRASONIDOS BIENESTAR" (NO modificar su
// estructura; el bot solo lee huecos y escribe citas en filas Disponibles).
// Servicios/Respuestas/Horarios: hoja auxiliar "Ultrasonidos Bienestar — Bot".
// Solo se usan datos de prueba hasta que Miguel autorice el pase a producción.

const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AGENDA_SHEET_ID = process.env.SHEETS_AGENDA_ID; // AGENDA PERSONAL - ULTRASONIDOS BIENESTAR
const INFO_SHEET_ID = process.env.SHEETS_INFO_ID; // Ultrasonidos Bienestar — Bot
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_VERIFY = process.env.WHATSAPP_VERIFY_TOKEN || 'ultrasonidos-bienestar-verify';
const MS_TOKEN = process.env.MESSENGER_PAGE_TOKEN;
const MS_VERIFY = process.env.MESSENGER_VERIFY_TOKEN || 'ultrasonidos-bienestar-verify';

// ---------- Google Sheets + Calendar ----------
let sheets = null;
let calendar = null;
function getClients() {
  if (sheets) return { sheets, calendar };
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar',
    ],
  });
  sheets = google.sheets({ version: 'v4', auth });
  calendar = google.calendar({ version: 'v3', auth });
  return { sheets, calendar };
}

async function readTab(spreadsheetId, tab, range = 'A:Z') {
  const { sheets: s } = getClients();
  const res = await s.spreadsheets.values.get({ spreadsheetId, range: `${tab}!${range}` });
  return res.data.values || [];
}

async function updateCells(spreadsheetId, tab, range, values) {
  const { sheets: s } = getClients();
  await s.spreadsheets.values.update({
    spreadsheetId, range: `${tab}!${range}`,
    valueInputOption: 'USER_ENTERED', requestBody: { values },
  });
}

// ---------- Agenda ----------
// Pestañas mensuales: "AGENDA 2026-11". Fila 3: encabezados.
// Columnas: A Fecha | B Hora | C Paciente | D Teléfono | E Edad | F Sexo |
// G Medio de agendamiento | H Disponibilidad | I Llegada | J ID Calendar
const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };

function parseFecha(text) {
  // Acepta "12 nov", "12/11", "12 de noviembre", "mañana"
  const t = (text || '').toLowerCase().trim();
  const now = new Date();
  if (t.includes('mañana')) {
    const d = new Date(now); d.setDate(d.getDate() + 1);
    return { dia: d.getDate(), mes: d.getMonth() + 1, anio: d.getFullYear() };
  }
  const m1 = t.match(/(\d{1,2})\s*(?:de\s+)?([a-záéíóú]+)/);
  if (m1 && MESES[m1[2].slice(0, 3)]) return { dia: +m1[1], mes: MESES[m1[2].slice(0, 3)], anio: now.getFullYear() };
  const m2 = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m2) return { dia: +m2[1], mes: +m2[2], anio: m2[3] ? +m2[3] : now.getFullYear() };
  return null;
}

function tabDe(fecha) {
  return `AGENDA ${fecha.anio}-${String(fecha.mes).padStart(2, '0')}`;
}

function fechaTexto(fecha) {
  return `${String(fecha.dia).padStart(2, '0')}/${String(fecha.mes).padStart(2, '0')}/${fecha.anio}`;
}

// Devuelve las filas de la pestaña del mes con su número de fila real (1-based)
async function filasAgenda(fecha) {
  const rows = await readTab(AGENDA_SHEET_ID, tabDe(fecha), 'A4:J1000');
  return rows.map((r, i) => ({ fila: i + 4, fecha: r[0] || '', hora: r[1] || '', paciente: r[2] || '', disponibilidad: r[7] || '' }));
}

async function huecosLibres(fecha) {
  const filas = await filasAgenda(fecha);
  const dia = fechaTexto(fecha);
  return filas.filter((f) => f.fecha.includes(dia) && f.disponibilidad.toLowerCase() === 'disponible');
}

// ---------- Estado de conversación en memoria (para producción usar Redis/DB) ----------
const sessions = new Map(); // senderId -> { step, servicio, fecha, hora, fila, nombre, canal }
function session(id) {
  if (!sessions.has(id)) sessions.set(id, { step: 'inicio' });
  return sessions.get(id);
}

// Ubicación de Ultrasonidos Bienestar (Super Plaza Miramontes, 19.30951, -99.12461)
// El bot manda la ubicación como pin nativo, no como enlace, para que no salga
// la vista previa con imagen del enlace de Google Maps.
const UBICACION = {
  lat: 19.30951,
  lon: -99.12461,
  name: 'Ultrasonidos Bienestar',
  address: 'Canal de Miramontes 2053, Super Plaza Miramontes, Coyoacán, 04920 CDMX',
};

// ---------- Envío de mensajes (texto + imagen opcional + ubicación opcional) ----------
async function sendWhatsApp(to, text, imageUrl, location) {
  const base = `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`;
  const headers = { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' };
  if (imageUrl) {
    await fetch(base, { method: 'POST', headers, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption: text } }) });
  } else {
    // preview_url: false evita la vista previa con imagen de cualquier enlace
    await fetch(base, { method: 'POST', headers, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }) });
  }
  if (location) {
    await fetch(base, { method: 'POST', headers, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'location', location: { latitude: location.lat, longitude: location.lon, name: location.name, address: location.address } }) });
  }
}

async function sendMessenger(to, text, imageUrl, location) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${MS_TOKEN}`;
  const message = imageUrl
    ? { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } }
    : { text };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: to }, message }) });
  if (!res.ok) console.error('Messenger send error:', await res.text());
  if (imageUrl && text) {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: to }, message: { text } }) });
  }
  if (location) {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: to }, message: { attachment: { type: 'location', payload: { coordinates: { lat: location.lat, long: location.lon } } } } }) });
  }
}

// ---------- Interruptor de encendido/apagado (pestaña Config en la hoja) ----------
// El bot revisa la celda B1 ("Bot activo: SÍ/NO") en cada mensaje, con caché de 60 s.
// Si está en NO, el bot no contesta como asistente, solo avisa que está en pausa.
// Si la hoja no se puede leer, el bot sigue activo (no se apaga por un error).
let configCache = { activo: true, ts: 0 };
async function botActivo() {
  if (Date.now() - configCache.ts < 60000) return configCache.activo;
  try {
    const rows = await readTab(INFO_SHEET_ID, 'Config', 'A1:B5');
    const row = rows.find((r) => (r[0] || '').toLowerCase().includes('activo'));
    const valor = (row?.[1] || 'SÍ').trim().toUpperCase();
    configCache = { activo: valor.startsWith('S'), ts: Date.now() };
  } catch (e) { console.error('Config read error:', e.message); configCache = { activo: true, ts: Date.now() }; }
  return configCache.activo;
}

async function mensajePausa() {
  try {
    const rows = await readTab(INFO_SHEET_ID, 'Config', 'A1:B5');
    const row = rows.find((r) => (r[0] || '').toLowerCase().includes('apagado'));
    if (row?.[1]) return row[1];
  } catch (e) { /* mensaje por defecto */ }
  return 'Hola 👋 Por el momento el asistente automático está en pausa. En un momento te atiende una persona de recepción. 🙂';
}

// ---------- Lógica del bot (igual para los dos canales) ----------
const MENU = `Hola, bienvenido a Ultrasonidos Bienestar 👋

¿En qué te ayudo?

1️⃣ Ver servicio y precio
2️⃣ Agendar una cita
3️⃣ Horarios y ubicación
4️⃣ Preparación para el estudio
5️⃣ Hablar con una persona`;

async function leerServicios() {
  const rows = await readTab(INFO_SHEET_ID, 'Servicios', 'A2:D');
  return rows.filter((r) => r[0]).map((r) => ({ nombre: r[0], precio: r[1] || '', incluye: r[2] || '', imagen: r[3] || '' }));
}

async function faq(lower) {
  try {
    const rows = await readTab(INFO_SHEET_ID, 'Respuestas', 'A2:C');
    for (const [keys, answer, imagen] of rows) {
      if (!keys || !answer) continue;
      if (keys.split(',').some((k) => lower.includes(k.trim().toLowerCase()))) return { answer, imagen: imagen || '' };
    }
  } catch (e) { console.error('FAQ read error:', e.message); }
  return null;
}

async function handleMessage(senderId, text, send, canal) {
  if (!(await botActivo())) {
    return send(await mensajePausa());
  }
  const clean = (text || '').trim();
  const lower = clean.toLowerCase();
  const st = session(senderId);
  st.canal = canal;

  if (/humano|persona|asesor|recepci[oó]n/.test(lower)) {
    st.step = 'inicio';
    return send('Claro, te paso con recepción. En un momento te atiende una persona. ¿Me dejas tu nombre mientras tanto? 🙂');
  }

  switch (st.step) {
    case 'inicio': {
      if (clean === '1' || /servicio|precio|costo|cu[aá]nto/.test(lower)) {
        try {
          const servs = await leerServicios();
          if (!servs.length) return send('Te comparto los servicios en un momento.');
          const precio = servs[0].precio;
          const imagen = servs[0].imagen;
          let secciones = '';
          for (const s of servs) {
            const sexo = /mujer/i.test(s.nombre) ? 'Mujer' : /hombre/i.test(s.nombre) ? 'Hombre' : s.nombre;
            const items = s.incluye.split(',').map((x) => x.trim()).filter(Boolean);
            secciones += `\n${sexo}:\n` + items.map((i) => `🔶 ${i}`).join('\n') + '\n';
          }
          return send(`🩺 Nuestro servicio\n\n📦 Paquete ultrasonido abdominal\n\n💲 Cuota de recuperación: ${precio}\n\n✅ Incluye:${secciones}\n¿Quieres agendar? Escribe 2️⃣`, imagen);
        } catch (e) { console.error(e.message); return send('Tuve un problema al consultar el servicio, ¿me escribes en un momento?'); }
      }
      if (clean === '2' || /agendar|cita|reservar/.test(lower)) {
        st.step = 'fecha';
        return send('¿Para qué fecha quieres tu cita? Por ejemplo: 12 nov');
      }
      if (clean === '3' || /horario|ubicaci[oó]n|d[oó]nde/.test(lower)) {
        try {
          const rows = await readTab(INFO_SHEET_ID, 'Horarios', 'A2:C');
          const list = rows.filter((r) => r[0]).map((r) => `• ${r[0]}: ${r[1] || ''}`).join('\n');
          const ubi = await faq('ubicación');
          return send(`Nuestros horarios:\n\n${list}\n\n${ubi ? ubi.answer : ''}`, ubi ? ubi.imagen : '', UBICACION);
        } catch (e) { console.error(e.message); return send(MENU); }
      }
      if (clean === '4' || /preparaci[oó]n|ayuno|indicaciones/.test(lower)) {
        const prep = await faq('preparación');
        if (prep) return send(prep.answer, prep.imagen);
        return send(MENU);
      }
      if (clean === '5') return send('Claro, te paso con recepción. En un momento te atiende una persona 🙂');
      const found = await faq(lower);
      if (found) return send(found.answer, found.imagen, /ubicaci|direcci|d[oó]nde est/.test(lower) ? UBICACION : undefined);
      return send(MENU);
    }
    case 'fecha': {
      const fecha = parseFecha(clean);
      if (!fecha) return send('No entendí la fecha 😅 ¿Me la das como "12 nov" o "12/11"?');
      st.fecha = fecha;
      try {
        const libres = await huecosLibres(fecha);
        if (!libres.length) {
          st.step = 'inicio';
          return send(`Para el ${fechaTexto(fecha)} ya no hay horarios disponibles 😕 ¿Te acomoda otro día?`);
        }
        st.huecos = libres;
        st.step = 'hora';
        return send(`Horarios disponibles el ${fechaTexto(fecha)}:\n${libres.map((h, i) => `${i + 1}. ${h.hora}`).join('\n')}\n\nEscribe el número de la hora que quieres.`);
      } catch (e) { console.error(e.message); return send('Tuve un problema al revisar la agenda, ¿me escribes en un momento?'); }
    }
    case 'hora': {
      const idx = parseInt(clean, 10) - 1;
      const elegido = (st.huecos || [])[idx] || (st.huecos || []).find((h) => h.hora === clean);
      if (!elegido) return send('Esa opción no la vi 😅 Escribe el número de la hora de la lista.');
      st.hora = elegido.hora;
      st.fila = elegido.fila;
      st.step = 'nombre';
      return send(`Anotado: ${fechaTexto(st.fecha)} a las ${st.hora}. ¿Me das tu nombre completo para registrar la cita?`);
    }
    case 'nombre': {
      st.nombre = clean;
      st.step = 'inicio';
      try {
        const servs = await leerServicios();
        const servicio = (servs[0]?.nombre || 'Paquete ultrasonido abdominal').replace(/\s*\(.*?\)\s*/, '');
        const tab = tabDe(st.fecha);
        // Escribir en la fila del hueco: Paciente (C), Teléfono (D), Medio (G), Disponibilidad (H)
        await updateCells(AGENDA_SHEET_ID, tab, `C${st.fila}:D${st.fila}`, [[st.nombre, senderId]]);
        await updateCells(AGENDA_SHEET_ID, tab, `G${st.fila}:H${st.fila}`, [[st.canal === 'whatsapp' ? 'WhatsApp' : 'Facebook', 'Ocupado']]);
        // Crear evento en Google Calendar y guardar su ID en la columna J
        try {
          const { calendar: cal } = getClients();
          const [hh, mm] = st.hora.split(':').map(Number);
          const start = new Date(st.fecha.anio, st.fecha.mes - 1, st.fecha.dia, hh, mm || 0);
          const end = new Date(start.getTime() + 20 * 60000);
          const ev = await cal.events.insert({
            calendarId: 'primary',
            requestBody: {
              summary: `Ultrasonido — ${st.nombre}`,
              description: `${servicio}. Agendado por ${st.canal}.`,
              start: { dateTime: start.toISOString(), timeZone: 'America/Mexico_City' },
              end: { dateTime: end.toISOString(), timeZone: 'America/Mexico_City' },
            },
          });
          if (ev.data.id) await updateCells(AGENDA_SHEET_ID, tab, `J${st.fila}`, [[ev.data.id]]);
        } catch (e) { console.error('Calendar insert error:', e.message); }
      } catch (e) { console.error('Agenda write error:', e.message); }
      sessions.delete(senderId);
      try {
        const servs = await leerServicios();
        const s = servs[0];
        const prep = await faq('preparación');
        return send(`✅ ¡Listo! Tu cita quedó registrada\n\n📦 ${servicio}\n📅 ${fechaTexto(st.fecha)} a las ${st.hora}\n👤 ${st.nombre}\n\n${prep ? prep.answer : ''}`, s ? s.imagen : '');
      } catch (e) { return send(`¡Listo! ✅ Tu cita quedó registrada para el ${fechaTexto(st.fecha)} a las ${st.hora}.`); }
    }
    default:
      st.step = 'inicio';
      return send(MENU);
  }
}

// Servir las imágenes del bot (paquete, preparación, ubicación...) en /images
app.use('/images', express.static('images'));

// ---------- Webhooks ----------
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WA_VERIFY) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg?.type === 'text') await handleMessage(msg.from, msg.text.body, (t, img, loc) => sendWhatsApp(msg.from, t, img, loc), 'whatsapp');
  } catch (e) { console.error(e); }
});

app.get('/webhook/messenger', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === MS_VERIFY) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook/messenger', async (req, res) => {
  res.sendStatus(200);
  try {
    const events = req.body?.entry?.flatMap((e) => e.messaging || []) || [];
    for (const ev of events) {
      if (ev.message?.text) await handleMessage(ev.sender.id, ev.message.text, (t, img, loc) => sendMessenger(ev.sender.id, t, img, loc), 'messenger');
    }
  } catch (e) { console.error(e); }
});

app.get('/health', (req, res) => res.json({ ok: true, negocio: 'Ultrasonidos Bienestar' }));

// Estado del interruptor (para verificar desde el navegador si el bot está activo)
app.get('/estado', async (req, res) => res.json({ negocio: 'Ultrasonidos Bienestar', activo: await botActivo() }));

app.listen(PORT, () => console.log(`Bot Ultrasonidos Bienestar en puerto ${PORT}`));
