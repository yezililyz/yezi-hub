import { useEffect, useState } from 'react'
import { collection, getDocs, getDoc, doc, query, where } from 'firebase/firestore'
import { Link, useNavigate } from 'react-router-dom'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { db, auth, ADMIN_EMAIL } from '../firebase'
import { trackSignedOut, trackGuideSaved } from '../analytics'
import { useLibrary } from '../useLibrary'
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
  const [pendingAction, setPendingAction] = useState<{ kind: 'save'; guideId: string } | null>(null)
  const [lang, setLang] = useState<'en' | 'fr'>(() => {
    const saved = localStorage.getItem('yezi-hub-lang')
    return (saved === 'fr' || saved === 'en') ? saved : 'en'
  })
  const navigate = useNavigate()
  const isAdmin = currentUser?.email === ADMIN_EMAIL
  const { library, toggleSave } = useLibrary(currentUser)

  useEffect(() => {
    return onAuthStateChanged(auth, u => setCurrentUser(u))
  }, [])

  // Resume a save the reader tried before signing in — same pattern as
  // PublicHub.tsx's pendingLibraryAction flag.
  useEffect(() => {
    if (!currentUser) return
    const raw = localStorage.getItem('pendingLibraryAction')
    if (!raw) return
    localStorage.removeItem('pendingLibraryAction')
    try {
      const action = JSON.parse(raw) as { kind: 'save'; guideId: string }
      if (action.kind === 'save') runToggleSave(action.guideId)
    } catch { /* ignore malformed flag */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser])

  function requireAuth(guideId: string): boolean {
    if (currentUser) return true
    setPendingAction({ kind: 'save', guideId })
    setShowAuthModal(true)
    return false
  }

  async function runToggleSave(guideId: string) {
    const wasSaved = library.get(guideId)?.saved ?? false
    await toggleSave(guideId)
    const guide = guides.find(g => g.id === guideId)
    trackGuideSaved(guideId, guide?.title || '', !wasSaved)
  }

  function handleToggleSave(guideId: string) {
    if (!requireAuth(guideId)) return
    runToggleSave(guideId)
  }

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

  // "Today's fieldwork" hero preview — real guides, not a fabricated snapshot.
  const heroPool = mostPopularGuides.length > 0 ? mostPopularGuides : guides
  const heroFeatured = heroPool[0]
  const heroMini = heroPool.slice(1, 3)
  const heroShownIds = new Set([heroFeatured?.id, ...heroMini.map(g => g.id)].filter(Boolean))
  // Don't repeat a guide already teased in the hero card further down the page.
  const belowFoldPopular = mostPopularGuides.filter(g => !heroShownIds.has(g.id))

  return (
    <div className="landing-page" id="top">
      <nav className="landing-nav">
        <Link to="/" className="brand" style={{ textDecoration: 'none' }}>
          <div className="brand-icon">✦</div>
          <div className="brand-text"><h1>{currentTitle}</h1></div>
        </Link>
        <div className="landing-nav-links">
          <Link to="/hub" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
            {lang === 'fr' ? 'Bibliothèque' : 'Library'}
          </Link>
          <a href="#most-discussed" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
            {lang === 'fr' ? 'Les plus discutés' : 'Most Discussed'}
          </a>
          <a href="#download" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
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
            <button className="btn btn-secondary btn-sm" onClick={() => setShowAuthModal(true)}>
              {lang === 'fr' ? 'Accès gratuit' : 'Get Free Access'} ↗
            </button>
          )}
          <div className="lang-switcher">
            <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => changeLang('en')}>EN</button>
            <button className={`lang-btn ${lang === 'fr' ? 'active' : ''}`} onClick={() => changeLang('fr')}>FR</button>
          </div>
        </div>
      </nav>

      {showAuthModal && (
        <AuthGateModal
          lang={lang}
          onClose={() => { setShowAuthModal(false); setPendingAction(null) }}
          onMagicLinkSent={() => {
            if (pendingAction) localStorage.setItem('pendingLibraryAction', JSON.stringify(pendingAction))
          }}
        />
      )}

      <header className="landing-hero">
        <div className="landing-hero-grid">
          <div>
            <p className="landing-kicker">
              {lang === 'fr' ? 'Pratique produit · Cadres et compétences' : 'Product Practice · Frameworks & Skills'}
            </p>
            <div className="landing-hero-eyebrow">✦ {currentTagline}</div>
            <h1 className="landing-hero-headline">
              {lang === 'fr'
                ? <>Développez un meilleur <span className="hl">jugement</span> produit.</>
                : <>Build better <span className="hl">product</span> judgment.</>}
            </h1>
            <p className="landing-hero-subtitle">{currentSubtitle}</p>

            <form
              className="landing-hero-form"
              onSubmit={e => { e.preventDefault(); setShowAuthModal(true) }}
            >
              <input type="email" placeholder={lang === 'fr' ? 'Votre email' : 'Enter your email'} />
              <button type="submit" className="btn btn-primary">
                {lang === 'fr' ? '→ Se connecter' : 'Get Free Access'}
              </button>
            </form>
            <p className="landing-hero-form-hint">
              {lang === 'fr'
                ? 'Connexion par lien magique — pas de mot de passe. Désabonnement à tout moment.'
                : 'Sign in with a magic link — no password. Unsubscribe anytime.'}
            </p>

            <div className="landing-hero-ctas">
              <a
                className="btn btn-primary"
                href="https://github.com/yezililyz/yezi-hub-mcp/blob/main/CONNECTING.md"
                target="_blank" rel="noopener noreferrer"
              >
                {lang === 'fr' ? "Installer comme compétence d'agent" : 'Install as Agent Skill'} ↗
              </a>
              <button className="btn btn-secondary" onClick={() => navigate('/hub')}>
                {lang === 'fr' ? 'Parcourir la bibliothèque →' : 'Browse the Hub →'}
              </button>
            </div>
          </div>

          {!loading && heroFeatured && (
            <div className="landing-hero-card">
              <div className="landing-hero-card-head">
                <span>{lang === 'fr' ? "Aujourd'hui sur le terrain" : "Today's Fieldwork"}</span>
                {heroPool.length > 1 && <span>01 / {Math.min(heroPool.length, 3)}</span>}
              </div>
              <div className={`landing-hero-card-grid ${heroMini.length === 0 ? 'landing-hero-card-grid--single' : ''}`}>
                <Link to={`/guide/${heroFeatured.id}?lang=${lang}`} className="landing-hero-feature">
                  <div style={{ position: 'absolute', inset: 0 }}><CoverArt contentType={heroFeatured.tag} /></div>
                  <span className="landing-hero-feature-tag">
                    {lang === 'fr' && heroFeatured.tag_fr ? heroFeatured.tag_fr : heroFeatured.tag}
                  </span>
                  <div className="landing-hero-feature-title">
                    {lang === 'fr' && heroFeatured.title_fr ? heroFeatured.title_fr : heroFeatured.title}
                  </div>
                </Link>
                {heroMini.length > 0 && (
                  <div className="landing-hero-mini">
                    {heroMini.map(g => (
                      <Link key={g.id} to={`/guide/${g.id}?lang=${lang}`} className="landing-hero-mini-item">
                        <span className="landing-hero-mini-tag">{lang === 'fr' && g.tag_fr ? g.tag_fr : g.tag}</span>
                        <div className="landing-hero-mini-title">{lang === 'fr' && g.title_fr ? g.title_fr : g.title}</div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
              <p className="landing-hero-card-note">
                {lang === 'fr'
                  ? 'Un kit de terrain pour la décision qui vous occupe.'
                  : 'A field kit for the decision in front of you.'}
              </p>
            </div>
          )}
        </div>
      </header>

      <section className="landing-section">
        <div className="landing-library-head">
          <div>
            <p className="landing-kicker">{lang === 'fr' ? 'La bibliothèque de terrain' : 'The field library'}</p>
            <h2 className="landing-section-headline">
              {lang === 'fr'
                ? 'Une bibliothèque pratique pour les décisions qui comptent.'
                : 'A practical library for the decisions that matter.'}
            </h2>
          </div>
          <p className="landing-library-desc">
            {lang === 'fr'
              ? `${guides.length} guides pratiques tirés de cadres opérationnels, de vrais moments produit, et des questions difficiles que les équipes affrontent en construisant, en développant et en fixant leurs prix. Apprenez les gestes derrière des lancements IA plus solides, des boucles d'activation, la synthèse de recherche et la stratégie — et intégrez-les à votre espace de travail IA quand vous en avez besoin.`
              : `${guides.length} practical guides distilled from operating frameworks, real product moments, and the hard questions teams face while building, growing, and pricing products. Learn the moves behind stronger AI launches, activation loops, research synthesis, and strategy — and bring them into your AI workspace when you need them.`}
          </p>
        </div>

        {!loading && guides.length > 0 && (
          <div className="landing-stats-grid">
            <div className="landing-stat-box">
              <span className="num">{guides.length}</span>
              <span className="label">{lang === 'fr' ? 'Guides' : 'Guides'}</span>
            </div>
            {contentTypeCounts.map(([tag, count]) => {
              const g = guides.find(g => g.tag === tag)
              const tagLabel = lang === 'fr' ? (g?.tag_fr || tag) : tag
              return (
                <div className="landing-stat-box" key={tag}>
                  <span className="num">{count}</span>
                  <span className="label">{tagLabel}</span>
                </div>
              )
            })}
          </div>
        )}

        <button className="btn btn-secondary" onClick={() => navigate('/hub')}>
          {lang === 'fr' ? 'Parcourir toute la bibliothèque →' : 'Browse the full hub →'}
        </button>
      </section>

      {!loading && belowFoldPopular.length > 0 && (
        <section className="landing-section" id="most-discussed">
          <div className="landing-library-head">
            <div>
              <p className="landing-kicker">{lang === 'fr' ? 'Commencez par le travail' : 'Start with the work'}</p>
              <h2 className="landing-section-headline">
                {lang === 'fr' ? 'Les compétences produit les plus discutées.' : 'Most Discussed Product Skills.'}
              </h2>
            </div>
            <p className="landing-library-desc">
              {lang === 'fr'
                ? "Partez des problèmes que les équipes produit résolvent activement — pas de théorie générique."
                : 'Start with the problems product teams are actively solving — not generic theory.'}
            </p>
          </div>
          <div className="landing-popular-grid">
            {belowFoldPopular.map(guide => {
              const title = lang === 'fr' && guide.title_fr ? guide.title_fr : guide.title
              const desc = lang === 'fr' && guide.description_fr ? guide.description_fr : guide.description
              const tagLabel = lang === 'fr' && guide.tag_fr ? guide.tag_fr : guide.tag
              const isSaved = library.get(guide.id)?.saved ?? false
              return (
                <div key={guide.id} className="landing-popular-card">
                  <Link to={`/guide/${guide.id}?lang=${lang}`} className="landing-popular-card-link">
                    <div className="landing-popular-banner">
                      <CoverArt contentType={guide.tag} />
                      <span className="landing-popular-banner-tag">{tagLabel}</span>
                    </div>
                  </Link>
                  <div className="landing-popular-body">
                    <div className="landing-popular-title-row">
                      <div className="landing-popular-title">{title}</div>
                      <button
                        type="button"
                        className={`landing-popular-save ${isSaved ? 'saved' : ''}`}
                        aria-label={isSaved ? (lang === 'fr' ? 'Retirer des favoris' : 'Remove from saved') : (lang === 'fr' ? 'Enregistrer' : 'Save')}
                        onClick={() => handleToggleSave(guide.id)}
                      >
                        {isSaved ? '✓' : '+'}
                      </button>
                    </div>
                    <p className="landing-popular-desc">{desc}</p>
                    <Link to={`/guide/${guide.id}?lang=${lang}`} className="landing-popular-cta">
                      {lang === 'fr' ? 'Ouvrir' : 'Open'} →
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section className="landing-section" id="download">
        <div className="landing-install-panel">
          <div>
            <p className="landing-install-kicker">
              {lang === 'fr' ? 'Pour les agents IA' : 'Download for AI agents'}
            </p>
            <h2>{lang === 'fr' ? 'Intégrez la bibliothèque à votre flux de travail.' : 'Put the library in your workflow.'}</h2>
            <p>
              {lang === 'fr'
                ? "Connectez Product Fieldwork à Claude comme base de connaissances MCP — recherche sémantique, guides complets, et parcours d'apprentissage depuis n'importe quelle conversation."
                : 'Connect Product Fieldwork to Claude as an MCP knowledge base — semantic search, full guide retrieval, and learning paths from any conversation.'}
            </p>
            <a
              className="btn btn-primary"
              href="https://github.com/yezililyz/yezi-hub-mcp/blob/main/CONNECTING.md"
              target="_blank" rel="noopener noreferrer"
            >
              {lang === 'fr' ? "Voir le guide d'installation →" : 'View setup guide →'}
            </a>
          </div>
          <ul className="landing-install-steps">
            <li>{lang === 'fr' ? 'Réglages → Connecteurs → Ajouter un connecteur personnalisé' : 'Settings → Connectors → Add custom connector'}</li>
            <li>{lang === 'fr' ? 'Collez l\'URL du serveur et le jeton fourni' : 'Paste the server URL and provided token'}</li>
            <li>{lang === 'fr' ? "Demandez à Claude d'explorer la bibliothèque" : 'Ask Claude to search the library'}</li>
          </ul>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="brand">
          <div className="brand-icon">✦</div>
          <div className="brand-text"><h1>{currentTitle}</h1><p>{currentTagline}</p></div>
        </div>
        <div className="landing-footer-links">
          <Link to="/hub">{lang === 'fr' ? 'Bibliothèque' : 'Library'}</Link>
          <Link to="/paths">{lang === 'fr' ? 'Parcours' : 'Learning Paths'}</Link>
          <a href="#most-discussed">{lang === 'fr' ? 'Les plus discutés' : 'Most Discussed'}</a>
          <a href="#download">{lang === 'fr' ? "Compétences d'agent" : 'Agent Skills'}</a>
          <a href="#top">{lang === 'fr' ? 'Haut de page ↑' : 'Back to top ↑'}</a>
        </div>
      </footer>
    </div>
  )
}
