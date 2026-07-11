import { getFunctions, httpsCallable } from 'firebase/functions'

// Replaces firebase/auth's sendSignInLinkToEmail — routes through the
// sendMagicLinkEmail Cloud Function so the email is sent via Resend with a
// verified domain and a custom branded template, instead of Firebase Auth's
// own unstyled, spam-prone default email.
export async function sendMagicLink(email: string, opts: {
  url?: string
  lang?: 'en' | 'fr'
  name?: string
  mode?: 'signup' | 'login'
}): Promise<void> {
  const fn = httpsCallable(getFunctions(), 'sendMagicLinkEmail')
  await fn({
    email,
    url: opts.url ?? window.location.href,
    lang: opts.lang ?? 'en',
    name: opts.name,
    mode: opts.mode ?? 'signup',
  })
}
