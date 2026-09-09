# Rappels quotidiens par e-mail

`send-reminders.js` lit le planning de Neal et Kevin dans Supabase (table `plans`,
lignes `neal` / `kevin`, format **`events`** : chaque séance a sa propre date
`YYYY-MM-DD`, ses `links` et ses `notes`), garde les séances dont la date est
**celle du jour à Bruxelles**, et envoie un e-mail récapitulatif à chacun.

Pas de séance ce jour-là pour quelqu'un → pas d'e-mail pour cette personne.

## Lancer en local

```bash
npm install
# simulation (n'envoie rien) :
DRY_RUN=1 node scripts/send-reminders.js
# tester une date précise :
node scripts/send-reminders.js --date=2026-09-15 --dry-run
# envoi réel :
SMTP_PASS="mot-de-passe-application-gmail" node scripts/send-reminders.js
```

## Automatisation (GitHub Actions)

`.github/workflows/reminders.yml` tourne tous les jours à `06:00 UTC`
(≈ 7h/8h à Bruxelles) et peut être lancé à la main (`workflow_dispatch`,
avec une date de test optionnelle).

### Secrets à définir dans le dépôt

`Settings → Secrets and variables → Actions`

| Secret | Obligatoire | Défaut si absent |
| --- | --- | --- |
| `SMTP_PASS` | **oui** | — (mot de passe d'application Gmail de `sinizown@gmail.com`) |
| `SMTP_USER` | non | `MAIL_FROM` |
| `MAIL_FROM` | non | `sinizown@gmail.com` |
| `MAIL_TO_NEAL` | non | `toussaintneal@live.fr` |
| `MAIL_TO_KEVIN` | non | `kevin.degeyter@outlook.com` |
| `SUPABASE_URL` | non | valeur publique du site |
| `SUPABASE_ANON_KEY` | non | valeur publique du site |

> Gmail : créer un **mot de passe d'application** (compte Google → Sécurité →
> validation en 2 étapes → Mots de passe des applications). Le mot de passe
> normal ne fonctionne pas en SMTP.

Pour un autre fournisseur SMTP (Brevo, OVH…), surcharger `SMTP_HOST`,
`SMTP_PORT` et `SMTP_SECURE` (`false` pour STARTTLS sur le port 587).
