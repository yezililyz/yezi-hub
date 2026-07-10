import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, addDoc } from 'firebase/firestore'
import { sendSignInLinkToEmail } from 'firebase/auth'
import { db, auth, ADMIN_EMAIL } from '../firebase'
import { trackSignupStarted, trackMagicLinkSent } from '../analytics'

interface AuthGateModalProps {
  lang: 'en' | 'fr'
  onClose: () => void
  // Called right before the magic link is actually sent, so the caller can
  // stash a "do this after sign-in" flag in localStorage (e.g. which guide
  // to like/save) — mirrors the triggerPrintAfterSignIn pattern in GuideViewer.
  onMagicLinkSent: () => void
}

export default function AuthGateModal({ lang, onClose, onMagicLinkSent }: AuthGateModalProps) {
  const [authMode, setAuthMode] = useState<'signup' | 'login'>('signup')
  const [signupName, setSignupName] = useState('')
  const [signupEmail, setSignupEmail] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  useEffect(() => { trackSignupStarted('like_save') }, [])
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()

  // Redirect admins to the proper admin login instead of the magic-link flow
  function checkAdminEmail(email: string): boolean {
    if (email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      onClose()
      navigate('/admin')
      return true
    }
    return false
  }

  async function handleSignupSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!signupName.trim() || !signupEmail.trim()) return
    if (checkAdminEmail(signupEmail)) return
    setSubmitting(true)
    try {
      await addDoc(collection(db, 'subscribers'), {
        name: signupName.trim(),
        email: signupEmail.trim(),
        guideId: null,
        signedUpAt: new Date().toISOString(),
      })

      localStorage.setItem('emailForSignIn', signupEmail.trim())
      localStorage.setItem('nameForSignIn', signupName.trim())
      onMagicLinkSent()
      trackMagicLinkSent('signup', 'like_save_modal')

      await sendSignInLinkToEmail(auth, signupEmail.trim(), {
        url: window.location.href,
        handleCodeInApp: true,
      })

      setSentTo(signupEmail.trim())
    } catch (err: any) {
      console.error('Failed to send magic link', err)
      alert('Failed to send magic link: ' + (err?.message || err?.code || String(err)))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!loginEmail.trim()) return
    if (checkAdminEmail(loginEmail)) return
    setSubmitting(true)
    try {
      localStorage.setItem('emailForSignIn', loginEmail.trim())
      onMagicLinkSent()
      trackMagicLinkSent('login', 'like_save_modal')

      await sendSignInLinkToEmail(auth, loginEmail.trim(), {
        url: window.location.href,
        handleCodeInApp: true,
      })

      setSentTo(loginEmail.trim())
    } catch (err: any) {
      console.error('Failed to send magic link', err)
      alert('Failed to send magic link: ' + (err?.message || err?.code || String(err)))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box auth-gate-box" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>

        {sentTo ? (
          <div style={{ textAlign: 'center', padding: '10px 0' }}>
            <div style={{ fontSize: 42, marginBottom: 10 }}>✉️</div>
            <h4>{lang === 'fr' ? 'Vérifiez votre boîte !' : 'Check your inbox!'}</h4>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
              {lang === 'fr'
                ? <>Lien magique envoyé à <strong>{sentTo}</strong>. Cliquez-le pour continuer.</>
                : <>Magic link sent to <strong>{sentTo}</strong>. Click it to continue.</>}
            </p>
          </div>
        ) : authMode === 'signup' ? (
          <form onSubmit={handleSignupSubmit}>
            <h4>{lang === 'fr' ? 'CONNEXION REQUISE' : 'SIGN IN TO CONTINUE'}</h4>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, marginBottom: 16 }}>
              {lang === 'fr'
                ? 'Inscrivez-vous pour aimer et sauvegarder des guides.'
                : 'Sign up to like and save guides to your library.'}
            </p>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>{lang === 'fr' ? 'Nom' : 'Name'}</label>
              <input value={signupName} onChange={e => setSignupName(e.target.value)} placeholder={lang === 'fr' ? 'Votre nom' : 'Your name'} required />
            </div>
            <div className="field" style={{ marginBottom: 16 }}>
              <label>{lang === 'fr' ? 'E-mail' : 'Email'}</label>
              <input type="email" value={signupEmail} onChange={e => setSignupEmail(e.target.value)} placeholder="you@example.com" required />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={submitting}>
              {submitting ? (lang === 'fr' ? 'Envoi…' : 'Sending…') : (lang === 'fr' ? "S'inscrire" : 'Sign up')}
            </button>
            <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: 14 }}>
              {lang === 'fr' ? 'Déjà inscrit(e) ?' : 'Already subscribed?'}{' '}
              <button type="button" onClick={() => setAuthMode('login')} className="link-btn">
                {lang === 'fr' ? 'Se connecter' : 'Log in'}
              </button>
            </p>
          </form>
        ) : (
          <form onSubmit={handleLoginSubmit}>
            <h4>{lang === 'fr' ? 'SE CONNECTER' : 'LOG IN'}</h4>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, marginBottom: 16 }}>
              {lang === 'fr' ? 'Recevez un nouveau lien magique.' : 'Get a fresh magic link.'}
            </p>
            <div className="field" style={{ marginBottom: 16 }}>
              <label>{lang === 'fr' ? 'E-mail' : 'Email'}</label>
              <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="you@example.com" required />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={submitting}>
              {submitting ? (lang === 'fr' ? 'Envoi…' : 'Sending…') : (lang === 'fr' ? 'Envoyer le lien magique' : 'Send magic link')}
            </button>
            <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: 14 }}>
              {lang === 'fr' ? 'Pas encore inscrit(e) ?' : 'New here?'}{' '}
              <button type="button" onClick={() => setAuthMode('signup')} className="link-btn">
                {lang === 'fr' ? "S'inscrire" : 'Sign up'}
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
