import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { useLibrary } from '../useLibrary'
import AuthGateModal from './AuthGateModal'
import GuideCard from './GuideCard'

interface Guide {
  id: string; title: string; title_fr?: string
  description: string; description_fr?: string
  icon: string; tag: string; tag_fr?: string
  chips: string[]; chips_fr?: string[]
  visibility?: 'public' | 'private' | 'draft'
  private?: boolean
  likeCount?: number
}

export default function MyLibrary() {
  const navigate = useNavigate()
  const [currentUser, setCurrentUser] = useState<User | null | undefined>(undefined)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [guides, setGuides] = useState<Guide[]>([])
  const [loadingGuides, setLoadingGuides] = useState(true)
  const [lang] = useState<'en' | 'fr'>(() => {
    const params = new URLSearchParams(window.location.search)
    const urlLang = params.get('lang')
    if (urlLang === 'fr' || urlLang === 'en') return urlLang
    const saved = localStorage.getItem('yezi-hub-lang')
    return (saved === 'fr' || saved === 'en') ? saved : 'en'
  })

  const { library, loaded, toggleLike, toggleSave } = useLibrary(currentUser ?? null)

  useEffect(() => {
    return onAuthStateChanged(auth, u => setCurrentUser(u))
  }, [])

  useEffect(() => {
    if (!loaded || !currentUser) { setLoadingGuides(false); return }
    const savedIds = [...library.entries()].filter(([, e]) => e.saved).map(([id]) => id)
    if (savedIds.length === 0) { setGuides([]); setLoadingGuides(false); return }

    setLoadingGuides(true)
    Promise.all(savedIds.map(id => getDoc(doc(db, 'guides', id))))
      .then(snaps => {
        setGuides(snaps.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() } as Guide)))
      })
      .finally(() => setLoadingGuides(false))
  }, [loaded, currentUser, library])

  async function handleToggleLike(guideId: string) {
    const delta = await toggleLike(guideId)
    setGuides(prev => prev.map(g => g.id === guideId ? { ...g, likeCount: (g.likeCount ?? 0) + delta } : g))
  }

  async function handleToggleSave(guideId: string) {
    await toggleSave(guideId)
    setGuides(prev => prev.filter(g => g.id !== guideId))
  }

  if (currentUser === undefined) return <div className="loading">Loading…</div>

  return (
    <>
      <header className="hub-header">
        <div className="hub-header-wrap">
          <div className="brand">
            <div className="brand-icon">🔖</div>
            <div className="brand-text">
              <h1>{lang === 'fr' ? 'Ma bibliothèque' : 'My Library'}</h1>
              <p>{lang === 'fr' ? 'Guides sauvegardés' : 'Saved guides'}</p>
            </div>
          </div>
          <Link to={`/?lang=${lang}`} className="btn btn-secondary btn-sm">
            {lang === 'fr' ? '← Accueil' : '← Hub'}
          </Link>
        </div>
      </header>

      {showAuthModal && (
        <AuthGateModal lang={lang} onClose={() => setShowAuthModal(false)} onMagicLinkSent={() => {}} />
      )}

      <main className="hub-main" style={{ maxWidth: 1180, margin: '0 auto' }}>
        {!currentUser ? (
          <div className="empty-state">
            <span className="icon">🔒</span>
            <p>
              {lang === 'fr'
                ? 'Connectez-vous pour voir vos guides sauvegardés.'
                : 'Sign in to see your saved guides.'}
            </p>
            <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => setShowAuthModal(true)}>
              {lang === 'fr' ? 'Se connecter' : 'Sign in'}
            </button>
          </div>
        ) : loadingGuides ? (
          <div className="loading">{lang === 'fr' ? 'Chargement…' : 'Loading…'}</div>
        ) : guides.length === 0 ? (
          <div className="empty-state">
            <span className="icon">📭</span>
            <p>
              {lang === 'fr'
                ? "Vous n'avez encore sauvegardé aucun guide — cliquez \"Save\" sur un guide pour le retrouver ici."
                : 'No saved guides yet — click "Save" on a guide to find it here.'}
            </p>
            <button className="btn btn-secondary" style={{ marginTop: 14 }} onClick={() => navigate('/')}>
              {lang === 'fr' ? 'Parcourir les guides' : 'Browse guides'}
            </button>
          </div>
        ) : (
          <div className="guide-grid">
            {guides.map(guide => (
              <GuideCard
                key={guide.id}
                guide={guide}
                lang={lang}
                liked={library.get(guide.id)?.liked ?? false}
                saved={library.get(guide.id)?.saved ?? false}
                onOpen={() => navigate(`/guide/${guide.id}?lang=${lang}`)}
                onToggleLike={() => handleToggleLike(guide.id)}
                onToggleSave={() => handleToggleSave(guide.id)}
              />
            ))}
          </div>
        )}
      </main>
    </>
  )
}
