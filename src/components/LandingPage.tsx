import { useEffect, useState } from 'react'
import { collection, getDocs, getDoc, doc, query, where } from 'firebase/firestore'
import { Link, useNavigate } from 'react-router-dom'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { db, auth, ADMIN_EMAIL } from '../firebase'
import { trackSignedOut } from '../analytics'
import AuthGateModal from './AuthGateModal'
import CoverArt from './CoverArt'

interface Guide {
  id: string; title: string; title_fr?: string
  description: string; description_fr?: string
  tag: string; tag_fr?: string
  published: boolean; sectionId?: string | null
  likeCount?: number
}

interface SiteMeta {
  title: string; tagline: string; subtitle: string
  title_fr?: string; tagline_fr?: string; subtitle_fr?: string
}

const DEFAULT_META: SiteMeta = {
  title: 'Product Fieldwork',
  tagline: 'Learn the moves, not the theory',
  subtitle: 'The practical operating library for builders navigating growth, AI, and high-stakes product bets. Find the guide for the decision in front of you.',
}

export default function LandingPage() {
  const [guides, setGuides] = useState<Guide[]>([])
  const [siteMeta, setSiteMeta] = useState<SiteMeta>(DEFAULT_META)
  const [loading, setLoading] = useState(true)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [lang, setLang] = useState<'en' | 'fr'>(() => {
    const saved = localStorage.getItem('yezi-hub-lang')
    return (saved === 'fr' || saved === 'en') ? saved : 'en'
  })
  const navigate = useNavigate()
  const isAdmin = currentUser?.email === ADMIN_EMAIL

  useEffect(() => {
    return onAuthStateChanged(auth, u => setCurrentUser(u))
  }, [])

  useEffect(() => {
    async function load() {
      try {
        const [guidesSnap, metaSnap] = await Promise.all([
          getDocs(query(collection(db, 'guides'), where('published', '==', true))),
          getDoc(doc(db, 'meta', 'site')),
        ])
        setGuides(
          guidesSnap.docs
            .map(d => ({ id: d.id, ...d.data() } as Guide))
            .filter(g => g.sectionId)
        )
        if (metaSnap.exists()) setSiteMeta(metaSnap.data() as SiteMeta)
      } catch (err) {
        console.error('Failed to load landing page data', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  useEffect(() => {
    document.title = siteMeta.title
  }, [siteMeta.title])

  function changeLang(val: 'en' | 'fr') {
    setLang(val)
    localStorage.setItem('yezi-hub-lang', val)
  }

  const currentTitle = lang === 'fr' ? (siteMeta.title_fr || siteMeta.title) : siteMeta.title
  const currentTagline = lang === 'fr' ? (siteMeta.tagline_fr || siteMeta.tagline) : siteMeta.tagline
  const currentSubtitle = lang === 'fr' ? (siteMeta.subtitle_fr || siteMeta.subtitle) : siteMeta.subtitle

  // Same live-computed stats/most-popular logic used in PublicHub.tsx before
  // it moved here — real numbers, no static/fabricated landing-page snapshot.
  const contentTypeCounts = Array.from(
    guides.reduce((map, g) => {
      const tag = g.tag
      if (!tag) return map
      map.set(tag, (map.get(tag) ?? 0) + 1)
      return map
    }, new Map<string, number>())
  ).sort((a, b) => b[1] - a[1]).slice(0, 3)

  const mostPopularGuides = [...guides]
    .filter(g => (g.likeCount ?? 0) > 0)
    .sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
    .slice(0, 6)

  return (
    <div className="landing-page">
      <nav className="landing-nav">
        <Link to="/" className="brand" style={{ textDecoration: 'none' }}>
          <div className="brand-icon">✦</div>
          <div className="brand-text"><h1>{currentTitle}</h1></div>
        </Link>
        <div className="landing-nav-links">
          <Link to="/hub" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
            {lang === 'fr' ? 'Bibliothèque' : 'Library'}
          </Link>
          <a
            className="btn btn-secondary btn-sm"
            href="https://github.com/yezililyz/yezi-hub-mcp/blob/main/CONNECTING.md"
            target="_blank" rel="noopener noreferrer"
            style={{ textDecoration: 'none' }}
          >
            {lang === 'fr' ? "Compétences d'agent" : 'Agent Skills'}
          </a>
          {currentUser ? (
            <>
              <span className="reader-email">{currentUser.email}</span>
              {isAdmin && (
                <Link to="/admin" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>⚙ Admin</Link>
              )}
              <button className="btn btn-secondary btn-sm" onClick={() => { trackSignedOut(); signOut(auth) }}>
                {lang === 'fr' ? 'Déconnexion' : 'Sign out'}
              </button>
            </>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => setShowAuthModal(true)}>
              {lang === 'fr' ? '→ Se connecter' : 'Get Free Access'}
            </button>
          )}
          <div className="lang-switcher">
            <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => changeLang('en')}>EN</button>
            <button className={`lang-btn ${lang === 'fr' ? 'active' : ''}`} onClick={() => changeLang('fr')}>FR</button>
          </div>
        </div>
      </nav>

      {showAuthModal && (
        <AuthGateModal lang={lang} onClose={() => setShowAuthModal(false)} onMagicLinkSent={() => {}} />
      )}

      <header className="landing-hero">
        <div className="landing-hero-eyebrow">{currentTagline}</div>
        <h1 className="landing-hero-headline">{currentTitle}</h1>
        <p className="landing-hero-subtitle">{currentSubtitle}</p>
        <div className="landing-hero-ctas">
          <button className="btn btn-primary" onClick={() => navigate('/hub')}>
            {lang === 'fr' ? 'Parcourir la bibliothèque →' : 'Browse the Hub →'}
          </button>
          <a
            className="hero-install-btn"
            href="https://github.com/yezililyz/yezi-hub-mcp/blob/main/CONNECTING.md"
            target="_blank" rel="noopener noreferrer"
          >
            ⚡ {lang === 'fr' ? "Installer comme compétence d'agent" : 'Install as Agent Skill'} ↗
          </a>
        </div>

        {!loading && guides.length > 0 && (
          <div className="hero-stats-bar">
            <div className="hero-stat">
              <span className="hero-stat-num">{guides.length}</span>
              <span className="hero-stat-label">Guides</span>
            </div>
            {contentTypeCounts.map(([tag, count]) => {
              const g = guides.find(g => g.tag === tag)
              const tagLabel = lang === 'fr' ? (g?.tag_fr || tag) : tag
              return (
                <div className="hero-stat" key={tag}>
                  <span className="hero-stat-num">{count}</span>
                  <span className="hero-stat-label">{tagLabel}</span>
                </div>
              )
            })}
          </div>
        )}
      </header>

      {!loading && mostPopularGuides.length > 0 && (
        <section className="most-popular-section landing-section">
          <div className="pinned-header">
            <span className="pinned-header-label">
              <span className="pinned-pin">🔥</span>
              {lang === 'fr' ? 'Les plus populaires' : 'Most Popular'}
            </span>
          </div>
          <div className="landing-popular-grid">
            {mostPopularGuides.map(guide => {
              const title = lang === 'fr' && guide.title_fr ? guide.title_fr : guide.title
              const desc = lang === 'fr' && guide.description_fr ? guide.description_fr : guide.description
              const tagLabel = lang === 'fr' && guide.tag_fr ? guide.tag_fr : guide.tag
              return (
                <Link key={guide.id} to={`/guide/${guide.id}?lang=${lang}`} className="landing-popular-card">
                  <div className="landing-popular-banner"><CoverArt contentType={guide.tag} /></div>
                  <span className="landing-popular-tag">{tagLabel}</span>
                  <div className="landing-popular-title">{title}</div>
                  <p className="landing-popular-desc">{desc}</p>
                  <span className="landing-popular-cta">{lang === 'fr' ? 'Ouvrir' : 'Open'} →</span>
                </Link>
              )
            })}
          </div>
        </section>
      )}

      <footer className="landing-footer">
        <div className="brand">
          <div className="brand-icon">✦</div>
          <div className="brand-text"><h1>{currentTitle}</h1><p>{currentTagline}</p></div>
        </div>
        <div className="landing-footer-links">
          <Link to="/hub">{lang === 'fr' ? 'Bibliothèque' : 'Library'}</Link>
          <Link to="/paths">{lang === 'fr' ? 'Parcours' : 'Learning Paths'}</Link>
          <a href="https://github.com/yezililyz/yezi-hub-mcp/blob/main/CONNECTING.md" target="_blank" rel="noopener noreferrer">
            {lang === 'fr' ? "Compétences d'agent" : 'Agent Skills'}
          </a>
        </div>
      </footer>
    </div>
  )
}
