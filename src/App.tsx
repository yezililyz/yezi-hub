import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { onAuthStateChanged, isSignInWithEmailLink, signInWithEmailLink, type User } from 'firebase/auth'
import { collection, addDoc } from 'firebase/firestore'
import { auth, db, ADMIN_EMAIL } from './firebase'
import { trackPage, trackSignedIn } from './analytics'
import PublicHub from './components/PublicHub'
import GuideViewer from './components/GuideViewer'
import AdminHub from './components/AdminHub'
import Login from './components/Login'
import MyLibrary from './components/MyLibrary'
import LoginPage from './components/LoginPage'

function AdminRoute() {
  const [user, setUser] = useState<User | null | undefined>(undefined)

  useEffect(() => {
    return onAuthStateChanged(auth, u => setUser(u))
  }, [])

  if (user === undefined) return <div className="loading">Loading…</div>
  if (!user || user.email !== ADMIN_EMAIL) return <Login />
  return <AdminHub />
}

export default function App() {
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  // When the magic link is clicked on a different device/browser than where
  // it was requested, localStorage has no emailForSignIn — window.prompt()
  // is unreliable in email-client embedded browsers. Instead we show a proper
  // in-page form to collect the email before completing sign-in.
  const [needsEmailConfirm, setNeedsEmailConfirm] = useState(false)
  const [confirmEmail, setConfirmEmail] = useState('')
  const [confirmName, setConfirmName] = useState('')

  // Stored so we can call signInWithEmailLink after the confirm form submits
  const pendingLinkRef = { href: window.location.href }

  async function completeSignIn(email: string, name: string) {
    setAuthLoading(true)
    setNeedsEmailConfirm(false)
    try {
      await signInWithEmailLink(auth, email, pendingLinkRef.href)
      localStorage.removeItem('emailForSignIn')
      localStorage.removeItem('nameForSignIn')
      try {
        await addDoc(collection(db, 'subscribers'), {
          name: name || '',
          email,
          signedUpAt: new Date().toISOString(),
        })
      } catch (e) {
        console.warn('Could not save subscriber', e)
      }
      trackSignedIn(email)
      setAuthLoading(false)
      window.location.replace(window.location.pathname)
    } catch (err) {
      console.error('Sign-in link failed', err)
      setAuthError('Failed to sign in. The link may have expired or already been used.')
      setAuthLoading(false)
    }
  }

  useEffect(() => {
    if (!isSignInWithEmailLink(auth, window.location.href)) return

    const email = localStorage.getItem('emailForSignIn') || ''
    const name  = localStorage.getItem('nameForSignIn') || ''

    if (email) {
      completeSignIn(email, name)
    } else {
      // Cross-device or different browser — show the in-page confirm form
      setNeedsEmailConfirm(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sharedPageStyle: React.CSSProperties = {
    minHeight: '100vh', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    gap: 16, background: 'var(--cream)', color: 'var(--ink)',
    padding: 24, textAlign: 'center',
  }

  if (authLoading) return (
    <div style={sharedPageStyle}>
      <div style={{ fontSize: 36 }}>✉️</div>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--muted)' }}>Signing you in…</p>
    </div>
  )

  if (needsEmailConfirm) return (
    <div style={sharedPageStyle}>
      <div style={{ fontSize: 36 }}>🔐</div>
      <h2 style={{ fontFamily: '"Archivo",sans-serif', fontWeight: 800, fontSize: 22, marginBottom: 4 }}>
        Confirm your email
      </h2>
      <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 360, marginBottom: 20 }}>
        You opened this link on a different device. Enter the email address you used to request it.
      </p>
      <form
        onSubmit={e => { e.preventDefault(); if (confirmEmail.trim()) completeSignIn(confirmEmail.trim(), confirmName.trim()) }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 340 }}
      >
        <input
          type="text"
          placeholder="Your name (optional)"
          value={confirmName}
          onChange={e => setConfirmName(e.target.value)}
          style={{ padding: '12px 14px', border: '2px solid var(--line)', borderRadius: 10, fontSize: 14, fontFamily: 'inherit', background: 'var(--paper)' }}
        />
        <input
          type="email"
          required
          autoFocus
          placeholder="you@example.com"
          value={confirmEmail}
          onChange={e => setConfirmEmail(e.target.value)}
          style={{ padding: '12px 14px', border: '2px solid var(--line)', borderRadius: 10, fontSize: 14, fontFamily: 'inherit', background: 'var(--paper)' }}
        />
        <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center' }}>
          Continue →
        </button>
      </form>
    </div>
  )

  if (authError) return (
    <div style={sharedPageStyle}>
      <div style={{ fontSize: 48 }}>⚠</div>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--muted)', maxWidth: 400 }}>{authError}</p>
      <button className="btn btn-primary" onClick={() => window.location.replace('/')}>Go to Hub</button>
    </div>
  )

  return (
    <BrowserRouter>
      <PageviewTracker />
      <Routes>
        <Route path="/" element={<PublicHub />} />
        <Route path="/library" element={<MyLibrary />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/guide/:id" element={<GuideViewer />} />
        <Route path="/admin" element={<AdminRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

function PageviewTracker() {
  const location = useLocation()
  useEffect(() => {
    trackPage(window.location.href)
  }, [location.pathname, location.search])
  return null
}
