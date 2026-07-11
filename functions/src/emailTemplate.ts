// Branded magic-link email — matches the "campfire" visual identity used
// across the site (cream background, black-outlined white card, orange
// accent, hard offset shadow). Email clients strip <style> blocks and don't
// support flexbox/grid, so everything here is inline-styled, table-based
// layout — the safe subset for broad client compatibility (Gmail, Outlook,
// Apple Mail).

interface MagicLinkEmailCopy {
  preheader: string
  eyebrow: string
  headline: string
  body: string
  cta: string
  expiryNote: string
  footer: string
}

const COPY: Record<'en' | 'fr', Record<'signup' | 'login', MagicLinkEmailCopy>> = {
  en: {
    signup: {
      preheader: 'Click below to finish creating your account.',
      eyebrow: "📚 YEZI'S KNOWLEDGE HUB",
      headline: 'Welcome — confirm your email',
      body: "Click the button below to finish signing up. This link signs you in directly, no password needed.",
      cta: 'Confirm & sign in',
      expiryNote: 'This link expires in 1 hour and can only be used once. If you didn\'t request this, you can safely ignore this email.',
      footer: "Yezi's Knowledge Hub · yezihub.com",
    },
    login: {
      preheader: 'Click below to sign in.',
      eyebrow: "📚 YEZI'S KNOWLEDGE HUB",
      headline: 'Your sign-in link',
      body: 'Click the button below to sign back in. No password needed.',
      cta: 'Sign in',
      expiryNote: 'This link expires in 1 hour and can only be used once. If you didn\'t request this, you can safely ignore this email.',
      footer: "Yezi's Knowledge Hub · yezihub.com",
    },
  },
  fr: {
    signup: {
      preheader: 'Cliquez ci-dessous pour terminer la création de votre compte.',
      eyebrow: '📚 LE HUB DE CONNAISSANCES DE YEZI',
      headline: 'Bienvenue — confirmez votre e-mail',
      body: "Cliquez sur le bouton ci-dessous pour terminer votre inscription. Ce lien vous connecte directement, aucun mot de passe requis.",
      cta: 'Confirmer et se connecter',
      expiryNote: "Ce lien expire dans 1 heure et ne peut être utilisé qu'une seule fois. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.",
      footer: 'Le Hub de connaissances de Yezi · yezihub.com',
    },
    login: {
      preheader: 'Cliquez ci-dessous pour vous connecter.',
      eyebrow: '📚 LE HUB DE CONNAISSANCES DE YEZI',
      headline: 'Votre lien de connexion',
      body: 'Cliquez sur le bouton ci-dessous pour vous reconnecter. Aucun mot de passe requis.',
      cta: 'Se connecter',
      expiryNote: "Ce lien expire dans 1 heure et ne peut être utilisé qu'une seule fois. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.",
      footer: 'Le Hub de connaissances de Yezi · yezihub.com',
    },
  },
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildMagicLinkEmail(opts: {
  link: string
  lang: 'en' | 'fr'
  mode: 'signup' | 'login'
  name?: string
}): { subject: string; html: string; text: string } {
  const copy = COPY[opts.lang][opts.mode]
  const link = escapeHtml(opts.link)
  const greeting = opts.name ? (opts.lang === 'fr' ? `Bonjour ${escapeHtml(opts.name)},` : `Hi ${escapeHtml(opts.name)},`) : ''

  const subject = opts.mode === 'signup'
    ? (opts.lang === 'fr' ? 'Confirmez votre e-mail — Le Hub de Yezi' : 'Confirm your email — Yezi\'s Knowledge Hub')
    : (opts.lang === 'fr' ? 'Votre lien de connexion — Le Hub de Yezi' : 'Your sign-in link — Yezi\'s Knowledge Hub')

  const html = `<!DOCTYPE html>
<html lang="${opts.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#fbeee0;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(copy.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fbeee0;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
<tr><td style="background-color:#ffffff;border:2px solid #1c1814;border-radius:18px;padding:36px 32px 30px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="font-size:12px;font-weight:700;letter-spacing:.06em;color:#cf7d28;margin:0 0 18px;">${copy.eyebrow}</div>
  <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;font-weight:800;color:#1c1814;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">${escapeHtml(copy.headline)}</h1>
  ${greeting ? `<p style="margin:0 0 10px;font-size:15px;color:#1c1814;">${greeting}</p>` : ''}
  <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#4a423a;">${escapeHtml(copy.body)}</p>
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:99px;background-color:#e8943a;border:2px solid #1c1814;">
    <a href="${link}" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(copy.cta)} →</a>
  </td></tr></table>
  <p style="margin:28px 0 0;font-size:12px;line-height:1.5;color:#8a7d70;">${escapeHtml(copy.expiryNote)}</p>
</td></tr>
</table>
<p style="margin:18px 0 0;font-size:11px;color:#b3a596;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">${escapeHtml(copy.footer)}</p>
</td></tr>
</table>
</body>
</html>`

  const text = `${greeting ? greeting + '\n\n' : ''}${copy.body}\n\n${opts.link}\n\n${copy.expiryNote}\n\n${copy.footer}`

  return { subject, html, text }
}
