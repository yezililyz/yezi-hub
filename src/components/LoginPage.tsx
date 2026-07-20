import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { collection, addDoc } from 'firebase/firestore'
import { auth, db, ADMIN_EMAIL } from '../firebase'
import { sendMagicLink } from '../sendMagicLink'

export default function LoginPage() {
  const navigate = useNavigate()
  const [authMode, setAuthMode] = useState<'signup' | 'login'>('signup')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [currentUser, setCurrentUser] = useState<any>(null)

  const lang: 'en' | 'fr' = (() => {
    const s = localStorage.getItem('yezi-hub-lang')
    return s === 'fr' ? 'fr' : 'en'
  })()

  useEffect(() => {
    return onAuthStateChanged(auth, u => setCurrentUser(u))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    // Admin uses email+password at /admin, not a magic link
    if (email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      navigate('/admin')
      return
    }
    setSubmitting(true)
    try {
      if (authMode === 'signup') {
        await addDoc(collection(db, 'subscribers'), {
          name: name.trim(),
          email: email.trim(),
          guideId: null,
          signedUpAt: new Date().toISOString(),
        })
      }
      localStorage.setItem('emailForSignIn', email.trim())
      if (name.trim()) localStorage.setItem('nameForSignIn', name.trim())
      await sendMagicLink(email.trim(), {
        url: window.location.origin + '/',
        lang,
        name: name.trim(),
        mode: authMode,
      })
      setSent(true)
    } catch (err: any) {
      alert('Failed to send link: ' + (err?.message || String(err)))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page-wrap">
      <div className="login-page-card">
        <Link to="/hub" className="login-page-back">← {lang === 'fr' ? 'Retour au hub' : 'Back to hub'}</Link>

        {currentUser ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
            <h2>{lang === 'fr' ? 'Vous êtes connecté(e)' : 'You\'re signed in'}</h2>
            <p style={{ color: 'var(--muted)', margin: '8px 0 20px', fontSize: 14 }}>{currentUser.email}</p>
            {currentUser.email !== ADMIN_EMAIL && (
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                <Link to="/library" className="btn btn-primary">{lang === 'fr' ? 'Ma bibliothèque' : 'My Library'}</Link>
                <Link to="/hub" className="btn btn-secondary">{lang === 'fr' ? 'Parcourir les guides' : 'Browse guides'}</Link>
                <button className="btn btn-secondary" onClick={() => signOut(auth)}>
                  {lang === 'fr' ? 'Déconnexion' : 'Sign out'}
                </button>
              </div>
            )}
          </div>
        ) : sent ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✉️</div>
            <h2>{lang === 'fr' ? 'Vérifiez votre boîte !' : 'Check your inbox!'}</h2>
            <p style={{ color: 'var(--muted)', margin: '10px 0', fontSize: 14, maxWidth: 340, marginInline: 'auto' }}>
              {lang === 'fr'
                ? <>Lien magique envoyé à <strong>{email}</strong>. Cliquez dessus pour vous connecter.</>
                : <>Magic link sent to <strong>{email}</strong>. Click it to sign in.</>}
            </p>
            <p style={{ fontSize: 12, color: 'var(--faint)' }}>
              {lang === 'fr' ? '(Vérifiez vos spams)' : '(Check your spam folder)'}
            </p>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontFamily: '"Archivo",sans-serif', fontWeight: 800, fontSize: 24, marginBottom: 6 }}>
                {authMode === 'signup'
                  ? (lang === 'fr' ? 'Créer un compte' : 'Create an account')
                  : (lang === 'fr' ? 'Se connecter' : 'Sign in')}
              </h2>
              <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                {lang === 'fr'
                  ? 'Recevez un lien magique par e-mail — aucun mot de passe requis.'
                  : 'Get a magic link by email — no password needed.'}
              </p>
            </div>

            <div className="login-page-tabs">
              <button
                className={`login-page-tab ${authMode === 'signup' ? 'active' : ''}`}
                onClick={() => setAuthMode('signup')}
              >
                {lang === 'fr' ? 'Nouveau compte' : 'Sign up'}
              </button>
              <button
                className={`login-page-tab ${authMode === 'login' ? 'active' : ''}`}
                onClick={() => setAuthMode('login')}
              >
                {lang === 'fr' ? 'Déjà inscrit(e)' : 'Already a member'}
              </button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {authMode === 'signup' && (
                <div className="field">
                  <label>{lang === 'fr' ? 'Nom' : 'Name'}</label>
                  <input
                    type="text"
                    placeholder={lang === 'fr' ? 'Votre nom' : 'Your name'}
                    value={name}
                    onChange={e => setName(e.target.value)}
                  />
                </div>
              )}
              <div className="field">
                <label>{lang === 'fr' ? 'Adresse e-mail' : 'Email address'}</label>
                <input
                  type="email"
                  required
                  autoFocus
                  placeholder="you@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '14px' }} disabled={submitting}>
                {submitting
                  ? (lang === 'fr' ? 'Envoi en cours…' : 'Sending…')
                  : (lang === 'fr' ? '→ Envoyer le lien magique' : '→ Send magic link')}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
