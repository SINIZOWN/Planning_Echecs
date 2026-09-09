/**
 * Rappels quotidiens — Planning Échecs
 *
 * Lit le planning de Neal et Kevin depuis Supabase (nouveau format "events" v3 :
 * chaque séance a sa propre date YYYY-MM-DD, ses liens et ses notes), sélectionne
 * les séances dont la date correspond à la date du jour à Bruxelles, et envoie
 * un e-mail récapitulatif à chaque personne.
 *
 * Aucune séance ce jour-là pour quelqu'un  ->  pas d'e-mail pour cette personne.
 *
 * Variables d'environnement (toutes optionnelles sauf SMTP_PASS) :
 *   SMTP_HOST        (def. smtp.gmail.com)
 *   SMTP_PORT        (def. 465)
 *   SMTP_SECURE      (def. true ; "false" pour STARTTLS sur le port 587)
 *   SMTP_USER        (def. = MAIL_FROM)
 *   SMTP_PASS        (requis — mot de passe d'application Gmail)
 *   MAIL_FROM        (def. sinizown@gmail.com)
 *   MAIL_TO_NEAL     (def. neal.toussaint@live.fr)
 *   MAIL_TO_KEVIN    (def. kevin.degeyter@outlook.com)
 *   SUPABASE_URL     (def. valeur publique du site)
 *   SUPABASE_ANON_KEY(def. valeur publique du site)
 *   REMINDER_DATE    (YYYY-MM-DD — force la date, sinon "aujourd'hui à Bruxelles")
 *   DRY_RUN          ("1" — n'envoie rien, affiche les e-mails dans la console)
 *
 * Usage : node scripts/send-reminders.js [--date=YYYY-MM-DD] [--dry-run]
 */

import nodemailer from 'nodemailer';

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://hzhcqlnfzhzeacxlwply.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6aGNxbG5memh6ZWFjeGx3cGx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5Mzg5NDcsImV4cCI6MjEwNDUxNDk0N30.25ZgG9jc8n0Y82s_nondnO6SL51CAfpWV2DjQOzLHSY';

const MAIL_FROM = process.env.MAIL_FROM || 'sinizown@gmail.com';

const RECIPIENTS = [
  { plan: 'neal', name: 'Neal', email: process.env.MAIL_TO_NEAL || 'neal.toussaint@live.fr' },
  { plan: 'kevin', name: 'Kevin', email: process.env.MAIL_TO_KEVIN || 'kevin.degeyter@outlook.com' },
];

const CAT_LABEL = {
  tactique: 'Tactique',
  finales: 'Finales',
  strategie: 'Stratégie',
  parties: 'Parties',
  bonus: 'Bonus fun',
};
const CAT_COLOR = {
  tactique: '#c1502e',
  finales: '#3d7ab5',
  strategie: '#4f8f5c',
  parties: '#9370b0',
  bonus: '#d9668c',
};

/* ---------- Helpers ---------- */
function argValue(name) {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

function todayInBrussels() {
  // en-CA -> "YYYY-MM-DD", calé sur le fuseau Europe/Brussels
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Brussels',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function timeStr(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function longFrDate(ymd) {
  // midi pour éviter tout effet de bord de fuseau
  const d = new Date(ymd + 'T12:00:00');
  return d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- Supabase (lecture) ---------- */
async function fetchPlanData(planId) {
  const url = `${SUPABASE_URL}/rest/v1/plans?id=eq.${encodeURIComponent(planId)}&select=data`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase (${planId}) : HTTP ${res.status} ${body}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return { events: [] };
  return rows[0].data || { events: [] };
}

function eventsForDate(planData, ymd) {
  if (Array.isArray(planData.events)) {
    return planData.events
      .filter((e) => e && e.date === ymd)
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }
  // Transition : tant que personne n'a ouvert la nouvelle page, Supabase contient
  // encore l'ancien modèle "semaine type" (sessions/occurrences). On dérive les
  // séances du jour à partir de ce modèle récurrent pour ne pas envoyer un
  // e-mail vide. Dès que le planning est ré-enregistré au format "events",
  // cette branche n'est plus utilisée.
  if (Array.isArray(planData.sessions)) {
    return legacyEventsForDate(planData, ymd);
  }
  return [];
}

function ymdInBrussels(dateLike) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Brussels',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(dateLike));
}

function daysBetweenYmd(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

function legacyEventsForDate(planData, ymd) {
  const settings = planData.settings || {};
  const totalWeeks = settings.totalWeeks || 15;
  const startYmd = settings.startDateISO ? ymdInBrussels(settings.startDateISO) : null;
  if (!startYmd) return [];

  const offset = daysBetweenYmd(ymd, startYmd);
  if (offset < 0) return [];
  const week = Math.floor(offset / 7) + 1;
  if (week > totalWeeks) return [];

  const dow = (new Date(ymd + 'T12:00:00').getDay() + 6) % 7; // lundi = 0
  const occ = planData.occurrences || {};
  return planData.sessions
    .filter((s) => s && s.day === dow)
    .map((s) => {
      const o = occ[`${week}_${s.id}`] || {};
      return {
        date: ymd,
        start: s.start,
        dur: s.dur,
        cat: s.cat,
        theme: s.theme,
        notes: '',
        links: [],
        status: o.status ?? null,
        comment: o.comment || '',
        rating: o.rating || 0,
      };
    })
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/* ---------- Rendu e-mail ---------- */
function buildEmail(recipient, ymd, events) {
  const dateLabel = longFrDate(ymd);
  const subject = `♟️ Tes séances d'échecs — ${dateLabel} (${events.length} séance${events.length > 1 ? 's' : ''})`;

  /* --- version texte --- */
  const textLines = [
    `Bonjour ${recipient.name},`,
    ``,
    `Au programme le ${dateLabel} :`,
    ``,
  ];
  events.forEach((e) => {
    const cat = CAT_LABEL[e.cat] || e.cat || '';
    const range = `${timeStr(e.start)}–${timeStr((e.start || 0) + (e.dur || 0))}`;
    const done = e.status === 'done' ? '  [déjà fait ✓]' : e.status === 'missed' ? '  [marqué non fait]' : '';
    textLines.push(`${range}  ${cat ? '[' + cat + '] ' : ''}${e.theme || 'Séance'}${done}`);
    if (e.notes) textLines.push(`    ${e.notes}`);
    (e.links || []).forEach((l) => {
      if (l && l.url) textLines.push(`    → ${l.label ? l.label + ' : ' : ''}${l.url}`);
    });
    if (e.comment) textLines.push(`    Note perso : ${e.comment}`);
    textLines.push('');
  });
  textLines.push('Bon travail !');
  const text = textLines.join('\n');

  /* --- version HTML --- */
  const cards = events
    .map((e) => {
      const cat = CAT_LABEL[e.cat] || e.cat || '';
      const color = CAT_COLOR[e.cat] || '#c79a4b';
      const range = `${timeStr(e.start)}–${timeStr((e.start || 0) + (e.dur || 0))}`;
      const done =
        e.status === 'done'
          ? ' <span style="color:#4f8f5c;font-weight:600;">✓ déjà fait</span>'
          : e.status === 'missed'
          ? ' <span style="color:#c1502e;font-weight:600;">non fait</span>'
          : '';
      const links = (e.links || [])
        .filter((l) => l && l.url)
        .map(
          (l) =>
            `<a href="${escapeHtml(l.url)}" style="display:inline-block;margin:4px 6px 0 0;padding:3px 8px;font-size:12px;border:1px solid #d8d2c4;border-radius:5px;color:#8a6d2f;text-decoration:none;">🔗 ${escapeHtml(l.label || l.url)}</a>`
        )
        .join('');
      return `
        <tr>
          <td style="padding:12px 14px;border-left:4px solid ${color};background:#faf7ef;border-radius:8px;">
            <div style="font-size:13px;font-weight:700;color:#2f2216;">${escapeHtml(range)}
              <span style="font-weight:500;color:#8a7a5c;text-transform:uppercase;font-size:11px;letter-spacing:.04em;">&nbsp;&nbsp;${escapeHtml(cat)}</span>${done}
            </div>
            <div style="font-size:14px;color:#2f2216;margin-top:3px;">${escapeHtml(e.theme || 'Séance')}</div>
            ${e.notes ? `<div style="font-size:12.5px;color:#6b5f47;margin-top:5px;line-height:1.45;">${escapeHtml(e.notes)}</div>` : ''}
            ${e.comment ? `<div style="font-size:12px;color:#8a6d2f;margin-top:4px;font-style:italic;">💬 ${escapeHtml(e.comment)}</div>` : ''}
            ${links ? `<div style="margin-top:6px;">${links}</div>` : ''}
          </td>
        </tr>
        <tr><td style="height:8px;line-height:8px;">&nbsp;</td></tr>`;
    })
    .join('');

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:8px;">
    <p style="font-size:14px;color:#2f2216;">Bonjour ${escapeHtml(recipient.name)},</p>
    <p style="font-size:14px;color:#2f2216;">Au programme le <strong>${escapeHtml(dateLabel)}</strong> :</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${cards}</table>
    <p style="font-size:13px;color:#8a7a5c;">Bon travail ! — <em>Planning Échecs</em></p>
  </div>`;

  return { subject, text, html };
}

/* ---------- Transport SMTP ---------- */
function buildTransport() {
  const user = process.env.SMTP_USER || MAIL_FROM;
  const pass = process.env.SMTP_PASS;
  if (!pass && !DRY_RUN) {
    throw new Error('SMTP_PASS manquant (mot de passe d\'application Gmail). Utilise DRY_RUN=1 pour tester sans envoyer.');
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || 'true') !== 'false',
    auth: { user, pass },
  });
}

/* ---------- Main ---------- */
async function main() {
  const ymd = process.env.REMINDER_DATE || argValue('date') || todayInBrussels();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error(`Date invalide : "${ymd}" (attendu YYYY-MM-DD)`);
  }
  console.log(`Rappels pour le ${ymd} (fuseau Europe/Brussels)${DRY_RUN ? ' — DRY RUN' : ''}`);

  const transport = DRY_RUN ? null : buildTransport();
  let sent = 0;
  let empty = 0;

  for (const r of RECIPIENTS) {
    let planData;
    try {
      planData = await fetchPlanData(r.plan);
    } catch (err) {
      console.error(`[${r.name}] échec de lecture Supabase : ${err.message}`);
      throw err;
    }

    const events = eventsForDate(planData, ymd);
    if (events.length === 0) {
      console.log(`[${r.name}] aucune séance le ${ymd} — pas d'e-mail.`);
      empty++;
      continue;
    }

    const { subject, text, html } = buildEmail(r, ymd, events);

    if (DRY_RUN) {
      console.log(`\n===== ${r.name} <${r.email}> =====`);
      console.log(`Sujet : ${subject}`);
      console.log(text);
      sent++;
      continue;
    }

    await transport.sendMail({ from: MAIL_FROM, to: r.email, subject, text, html });
    console.log(`[${r.name}] e-mail envoyé à ${r.email} — ${events.length} séance(s).`);
    sent++;
  }

  console.log(`\nTerminé : ${sent} e-mail(s)${DRY_RUN ? ' (simulés)' : ''}, ${empty} destinataire(s) sans séance.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
