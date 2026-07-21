import { useEffect, useState } from 'react'
import { collection, getDocs, getDoc, doc, query, where, updateDoc } from 'firebase/firestore'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { db, auth, ADMIN_EMAIL } from '../firebase'
import { signOut } from 'firebase/auth'
import { trackGuideLiked, trackGuideSaved, trackPinnedClicked, trackLanguageSwitched, trackSignedOut, trackSectionNavigation } from '../analytics'
import PinnedCarousel from './PinnedCarousel'
import AuthGateModal from './AuthGateModal'
import GuideCard, { type QuickTagUpdate } from './GuideCard'
import Breadcrumbs from './Breadcrumbs'
import { useLibrary } from '../useLibrary'

interface Guide {
  id: string; title: string; description: string; icon: string
  tag: string; chips: string[]; published: boolean; order: number
  sectionId?: string | null
  title_fr?: string
  description_fr?: string
  tag_fr?: string
  chips_fr?: string[]
  htmlContent_fr?: string
  visibility?: 'public' | 'private' | 'draft'
  private?: boolean
  pinned?: boolean
  likeCount?: number
  created_at?: { toMillis?: () => number; seconds?: number } | null
  updated_at?: { toMillis?: () => number; seconds?: number } | null
  level?: string
  level_fr?: string
  topics?: string[]
  topics_fr?: string[]
  overlay?: string[]
  overlay_fr?: string[]
  format?: string[]
  format_fr?: string[]
}

// Same 9-value controlled vocabulary as AdminHub.tsx's TOPICS — kept as an
// independent copy per this codebase's existing per-file Guide-shape convention.
const TOPICS: { en: string; fr: string }[] = [
  { en: 'Growth & Retention', fr: 'Croissance et rétention' },
  { en: 'Strategy & Positioning', fr: 'Stratégie et positionnement' },
  { en: 'Team & Organization', fr: 'Équipe et organisation' },
  { en: 'Building & Shipping', fr: 'Conception et livraison' },
  { en: 'Operating Cadence & Communication', fr: 'Cadence opérationnelle et communication' },
  { en: 'Discovery & Research', fr: 'Découverte et recherche' },
  { en: 'Launch & Go-to-Market', fr: 'Lancement et mise sur le marché' },
  { en: 'Planning & Prioritization', fr: 'Planification et priorisation' },
  { en: 'Career', fr: 'Carrière' },
]

function topicSlug(en: string): string {
  return en.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function topicFromSlug(slug: string): string | null {
  return TOPICS.find(t => topicSlug(t.en) === slug)?.en ?? null
}

// Same 4-value controlled vocabulary as AdminHub.tsx's OVERLAYS. Sparser than
// Topics (cross-cutting, 0-2 per guide, most guides have none), so it doesn't
// get its own /category route — see filterOverlay below.
const OVERLAYS: { en: string; fr: string }[] = [
  { en: 'Zero-to-One / Founder', fr: 'Zéro à un / Fondateur' },
  { en: 'Marketplace', fr: 'Marketplace' },
  { en: 'Building AI Products', fr: 'Conception de produits IA' },
  { en: 'Enterprise/PLG', fr: 'Entreprise/PLG' },
]

// Same 4-value controlled vocabulary as AdminHub.tsx's FORMAT_TYPES — used
// only by the admin quick-tag save handler (derives format_fr at save time).
const FORMAT_TYPES: { en: string; fr: string }[] = [
  { en: 'Checklist', fr: 'Liste de contrôle' },
  { en: 'Templates', fr: 'Modèles' },
  { en: 'Interactive Tool', fr: 'Outil interactif' },
  { en: 'Reference', fr: 'Référence' },
]
type SortMode = 'manual' | 'recent' | 'az' | 'popular'

const SORT_LABELS: Record<SortMode, { en: string; fr: string }> = {
  manual: { en: 'Curated', fr: 'Sélection' },
  recent: { en: 'Recent', fr: 'Récent' },
  az: { en: 'A–Z', fr: 'A–Z' },
  popular: { en: 'Popular', fr: 'Populaire' },
}

const NEW_WINDOW_MS = 1000 * 60 * 60 * 24 * 7 // 7 days

function createdMillis(g: Guide): number {
  const c = g.created_at
  if (!c) return 0
  if (typeof c.toMillis === 'function') return c.toMillis()
  if (typeof c.seconds === 'number') return c.seconds * 1000
  return 0
}

function sortGuides(arr: Guide[], mode: SortMode, lang: 'en' | 'fr'): Guide[] {
  const list = [...arr]
  if (mode === 'recent') return list.sort((a, b) => createdMillis(b) - createdMillis(a))
  if (mode === 'az') return list.sort((a, b) => {
    const ta = lang === 'fr' ? (a.title_fr || a.title) : a.title
    const tb = lang === 'fr' ? (b.title_fr || b.title) : b.title
    return ta.localeCompare(tb)
  })
  if (mode === 'popular') return list.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
  // Curated (manual) order, but guides still inside the 7-day "New" window
  // float to the front of their section — newest first among themselves —
  // so a fresh upload doesn't get buried by whatever order value it inherited.
  const now = Date.now()
  const isNew = (g: Guide) => createdMillis(g) > 0 && (now - createdMillis(g)) < NEW_WINDOW_MS
  return list.sort((a, b) => {
    const aNew = isNew(a), bNew = isNew(b)
    if (aNew !== bNew) return aNew ? -1 : 1
    if (aNew && bNew) return createdMillis(b) - createdMillis(a)
    return (a.order ?? 0) - (b.order ?? 0)
  })
}

interface Section {
  id: string; name: string; intro: string; order: number
  name_fr?: string
  intro_fr?: string
  megaGroup?: string
  icon?: string
}

const MEGA_GROUPS = ['Product', 'Tools', 'Books'] as const
const MEGA_GROUP_LABEL_FR: Record<string, string> = { Product: 'Produit', Tools: 'Outils', Books: 'Livres' }

interface LinkItem {
  id: string; title: string; url: string
  title_fr?: string
}

interface LinkList {
  id: string; title: string; sectionId: string | null
  order: number; items: LinkItem[]
  title_fr?: string
}

interface SiteMeta {
  title: string; tagline: string; subtitle: string
  title_fr?: string
  tagline_fr?: string
  subtitle_fr?: string
}

const DEFAULT_META: SiteMeta = {
  title: 'Product Fieldwork',
  tagline: 'Learn the moves, not the theory',
  subtitle: 'The practical operating library for builders navigating growth, AI, and high-stakes product bets. Find the guide for the decision in front of you.',
}

export default function PublicHub() {
  const [guides, setGuides] = useState<Guide[]>([])
  const [sections, setSections] = useState<Section[]>([])
  const [linkLists, setLinkLists] = useState<LinkList[]>([])
  const [siteMeta, setSiteMeta] = useState<SiteMeta>(DEFAULT_META)
  const [loading, setLoading] = useState(true)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [pendingAction, setPendingAction] = useState<{ kind: 'like' | 'save'; guideId: string } | null>(null)
  const [lang, setLang] = useState<'en' | 'fr'>(() => {
    const saved = localStorage.getItem('yezi-hub-lang')
    return (saved === 'fr' || saved === 'en') ? saved : 'en'
  })
  const [sortMode, setSortMode] = useState<SortMode>('manual')
  const [filterSection, setFilterSection] = useState<string | null>(null)
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [filterLevel, setFilterLevel] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedTocGroups, setExpandedTocGroups] = useState<Set<string>>(new Set())
  const [showFilters, setShowFilters] = useState(false)

  // /category/:topic support — the slug in the URL seeds the Topics filter
  // once on mount/navigation; the filter chip below stays the single source
  // of truth for the rest of the session (both reachable, per plan).
  const { topic: topicSlugParam } = useParams<{ topic?: string }>()
  const [filterTopic, setFilterTopic] = useState<string | null>(() => topicSlugParam ? topicFromSlug(topicSlugParam) : null)
  useEffect(() => {
    if (topicSlugParam) {
      setFilterTopic(topicFromSlug(topicSlugParam))
      setShowFilters(true)
    }
  }, [topicSlugParam])

  // Overlay is sparser/cross-cutting — no dedicated route, just an in-page
  // filter toggled from either the landing showcase or the filter panel.
  const [filterOverlay, setFilterOverlay] = useState<string | null>(null)

  function selectFilterSection(sectionId: string | null) {
    setFilterSection(prev => {
      const next = prev === sectionId ? null : sectionId
      setFilterTag(null) // topics are scoped to the chosen section — reset on any section change
      return next
    })
  }

  const isAdmin = currentUser?.email === ADMIN_EMAIL
  // Lets the admin preview the hub exactly as a reader would see it — a
  // computed UI flag only, never touches auth/currentUser, so it can't be
  // mistaken for an actual permission downgrade.
  const [viewingAsReader, setViewingAsReader] = useState(false)
  const effectiveIsAdmin = isAdmin && !viewingAsReader
  const navigate = useNavigate()
  const { library, toggleLike, toggleSave } = useLibrary(currentUser)

  useEffect(() => {
    return onAuthStateChanged(auth, u => setCurrentUser(u))
  }, [])

  // Resume whatever like/save action the reader was trying to do before they
  // had to sign in — mirrors the triggerPrintAfterSignIn pattern in GuideViewer.
  useEffect(() => {
    if (!currentUser) return
    const raw = localStorage.getItem('pendingLibraryAction')
    if (!raw) return
    localStorage.removeItem('pendingLibraryAction')
    try {
      const action = JSON.parse(raw) as { kind: 'like' | 'save'; guideId: string }
      if (action.kind === 'like') runToggleLike(action.guideId)
      else runToggleSave(action.guideId)
    } catch { /* ignore malformed flag */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser])

  function requireAuth(kind: 'like' | 'save', guideId: string): boolean {
    if (currentUser) return true
    setPendingAction({ kind, guideId })
    setShowAuthModal(true)
    return false
  }

  async function runToggleLike(guideId: string) {
    const delta = await toggleLike(guideId)
    const guide = guides.find(g => g.id === guideId)
    trackGuideLiked(guideId, guide?.title || '', delta > 0)
    setGuides(prev => prev.map(g => g.id === guideId ? { ...g, likeCount: (g.likeCount ?? 0) + delta } : g))
  }

  async function runToggleSave(guideId: string) {
    const wasSaved = library.get(guideId)?.saved ?? false
    await toggleSave(guideId)
    const guide = guides.find(g => g.id === guideId)
    trackGuideSaved(guideId, guide?.title || '', !wasSaved)
  }

  // Admin-only quick metatag editor (card grid "+" button) — writes directly
  // to Firestore, deriving _fr fields the same way AdminHub's EditPanel does
  // so they can never drift out of sync with the EN values.
  async function saveQuickTags(guideId: string, update: QuickTagUpdate) {
    await updateDoc(doc(db, 'guides', guideId), {
      level: update.level,
      level_fr: update.level ? LEVEL_LABEL_FR[update.level] : '',
      topics: update.topics,
      topics_fr: update.topics.map(en => TOPICS.find(t => t.en === en)?.fr || en),
      format: update.format,
      format_fr: update.format.map(en => FORMAT_TYPES.find(t => t.en === en)?.fr || en),
      overlay: update.overlay,
      overlay_fr: update.overlay.map(en => OVERLAYS.find(t => t.en === en)?.fr || en),
    })
    setGuides(prev => prev.map(g => g.id === guideId ? { ...g, ...update } : g))
  }

  function handleToggleLike(guideId: string) {
    if (!requireAuth('like', guideId)) return
    runToggleLike(guideId)
  }

  function handleToggleSave(guideId: string) {
    if (!requireAuth('save', guideId)) return
    runToggleSave(guideId)
  }

  useEffect(() => {
    async function load() {
      try {
        setLoading(true)
        const guidesQuery = effectiveIsAdmin
          ? collection(db, 'guides')
          : query(collection(db, 'guides'), where('published', '==', true))

        const [guidesSnap, sectionsSnap, listsSnap, metaSnap] = await Promise.all([
          getDocs(guidesQuery),
          getDocs(collection(db, 'sections')),
          getDocs(collection(db, 'link_lists')),
          getDoc(doc(db, 'meta', 'site')),
        ])

        const allGuides = guidesSnap.docs.map(d => ({ id: d.id, ...d.data() } as Guide))

        // Filter visible: public sees only published, admin sees published and private (not drafts).
        // Uses effectiveIsAdmin so "view as reader" mode queries and filters exactly like a real
        // reader would, not just an over-fetch that's hidden client-side.
        const visibleGuides = effectiveIsAdmin
          ? allGuides.filter(g => g.sectionId && (g.published || g.visibility === 'private' || g.private))
          : allGuides.filter(g => g.published && g.sectionId)

        setGuides(visibleGuides)

        // Cluster sections by mega-group (Product → Tools → Books → unassigned),
        // preserving each section's existing relative order within its group.
        const allSections = sectionsSnap.docs
          .map(d => ({ id: d.id, ...d.data() } as Section))
          .sort((a, b) => {
            const mgA = MEGA_GROUPS.indexOf((a.megaGroup ?? '') as typeof MEGA_GROUPS[number])
            const mgB = MEGA_GROUPS.indexOf((b.megaGroup ?? '') as typeof MEGA_GROUPS[number])
            const rankA = mgA === -1 ? MEGA_GROUPS.length : mgA
            const rankB = mgB === -1 ? MEGA_GROUPS.length : mgB
            if (rankA !== rankB) return rankA - rankB
            return (a.order ?? 0) - (b.order ?? 0)
          })
        setSections(allSections)

        const allLists = listsSnap.docs
          .map(d => ({ id: d.id, ...d.data() } as LinkList))
          .filter(l => l.sectionId && l.items?.length > 0)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        setLinkLists(allLists)

        if (metaSnap.exists()) setSiteMeta(metaSnap.data() as SiteMeta)
      } catch (err) {
        console.error('Failed to load', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [effectiveIsAdmin])

  function changeLang(val: 'en' | 'fr') {
    trackLanguageSwitched(lang, val, 'public_hub')
    setLang(val)
    localStorage.setItem('yezi-hub-lang', val)
  }

  // Level 1 of the progressive filter: sections that actually have guides
  const sectionsWithGuides = sections.filter(s => guides.some(g => g.sectionId === s.id))

  // Level 2: content type (guide.tag — a controlled vocabulary: Playbook,
  // Framework, Case Study/Teardown, Field Guide, Toolkit, Interview Guide),
  // scoped to the chosen section once one is picked
  const tagPool = filterSection ? guides.filter(g => g.sectionId === filterSection) : guides
  const allTags = Array.from(new Set(
    tagPool.map(g => (lang === 'fr' ? (g.tag_fr || g.tag) : g.tag)).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b))

  // Level filter: Beginner/Intermediate/Advanced, kept in that fixed order
  // rather than alphabetical
  const LEVEL_ORDER = ['Beginner', 'Intermediate', 'Advanced']
  const LEVEL_LABEL_FR: Record<string, string> = { Beginner: 'Débutant', Intermediate: 'Intermédiaire', Advanced: 'Avancé' }
  const allLevels = LEVEL_ORDER.filter(lvl => guides.some(g => g.level === lvl))

  // Topics facet — independent of Section/Content Type/Level, and reachable
  // both via the filter chip below and via a direct /category/:topic link.
  const allTopics = TOPICS.filter(t => guides.some(g => g.topics?.includes(t.en)))
  const allOverlays = OVERLAYS.filter(o => guides.some(g => g.overlay?.includes(o.en)))

  // Live counts for the landing-page browse showcase — computed from the
  // already-loaded guides state so they never drift from the static numbers
  // in the planning artifact.
  const topicCounts = allTopics.map(t => ({ ...t, count: guides.filter(g => g.topics?.includes(t.en)).length }))
  const overlayCounts = allOverlays.map(o => ({ ...o, count: guides.filter(g => g.overlay?.includes(o.en)).length }))

  const hasActiveFilter = !!filterSection || !!filterTag || !!filterLevel || !!filterTopic || !!filterOverlay || searchQuery.trim().length > 0

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const filteredGuides = guides.filter(g => {
    const tag = lang === 'fr' ? (g.tag_fr || g.tag) : g.tag
    const chips = (lang === 'fr' && Array.isArray(g.chips_fr) && g.chips_fr.length ? g.chips_fr : g.chips) ?? []
    if (filterSection && g.sectionId !== filterSection) return false
    if (filterTag && tag !== filterTag) return false
    if (filterLevel && g.level !== filterLevel) return false
    if (filterTopic && !g.topics?.includes(filterTopic)) return false
    if (filterOverlay && !g.overlay?.includes(filterOverlay)) return false
    if (normalizedQuery) {
      const title = lang === 'fr' ? (g.title_fr || g.title) : g.title
      const desc = lang === 'fr' ? (g.description_fr || g.description) : g.description
      const haystack = `${title} ${desc} ${tag} ${chips.join(' ')}`.toLowerCase()
      if (!haystack.includes(normalizedQuery)) return false
    }
    return true
  })

  // Group guides by sectionId
  const guidesBySection = new Map<string, Guide[]>()
  for (const s of sections) guidesBySection.set(s.id, [])
  for (const g of filteredGuides) {
    if (g.sectionId && guidesBySection.has(g.sectionId))
      guidesBySection.get(g.sectionId)!.push(g)
  }
  for (const [id, arr] of guidesBySection) guidesBySection.set(id, sortGuides(arr, sortMode, lang))

  // Group link lists by sectionId. Link lists have no tag/chip/search fields,
  // so any active guide filter hides them rather than showing them unfiltered.
  const listsBySection = new Map<string, LinkList[]>()
  for (const s of sections) listsBySection.set(s.id, [])
  if (!hasActiveFilter) {
    for (const l of linkLists) {
      if (l.sectionId && listsBySection.has(l.sectionId))
        listsBySection.get(l.sectionId)!.push(l)
    }
  }

  // Only render sections that have at least one guide or link list
  const activeSections = sections.filter(s =>
    (guidesBySection.get(s.id)?.length ?? 0) > 0 ||
    (listsBySection.get(s.id)?.length ?? 0) > 0
  )

  const activeSectionIds = activeSections.map(s => s.id).join(',')

  // Scroll-spy: highlight the TOC entry for whichever section is currently in view
  useEffect(() => {
    if (loading || !activeSectionIds) return
    const ids = activeSectionIds.split(',')
    const elements = ids
      .map(id => document.getElementById(`section-${id}`))
      .filter((el): el is HTMLElement => !!el)
    if (elements.length === 0) return

    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting)
        if (visible.length === 0) return
        const topMost = visible.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b))
        const id = topMost.target.id.replace(/^section-/, '')
        setActiveSectionId(id)
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: 0 }
    )
    elements.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [loading, activeSectionIds])

  const currentTitle = lang === 'fr' ? (siteMeta.title_fr || siteMeta.title) : siteMeta.title
  const currentTagline = lang === 'fr' ? (siteMeta.tagline_fr || siteMeta.tagline) : siteMeta.tagline
  const currentSubtitle = lang === 'fr' ? (siteMeta.subtitle_fr || siteMeta.subtitle) : siteMeta.subtitle

  useEffect(() => {
    if (filterTopic) {
      const topicLabel = lang === 'fr' ? (TOPICS.find(t => t.en === filterTopic)?.fr ?? filterTopic) : filterTopic
      document.title = `${topicLabel} · ${currentTitle}`
    } else {
      document.title = currentTitle
    }
  }, [filterTopic, currentTitle, lang])

  return (
    <>
      <header className="hub-header">
        <div className="hub-header-wrap">
          <div className="brand">
            <div className="brand-icon">✦</div>
            <div className="brand-text">
              <h1>{currentTitle}</h1>
              <p>{currentTagline}</p>
            </div>
          </div>
          <div className="hub-header-actions">
            <Link to={`/paths?lang=${lang}`} className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
              🎯 {lang === 'fr' ? 'Parcours' : 'Learning Paths'}
            </Link>
            {currentUser ? (
              <>
                {!effectiveIsAdmin && (
                  <Link to={`/library?lang=${lang}`} className="my-library-btn">
                    📚 <span className="lib-label">{lang === 'fr' ? 'Ma bibliothèque' : 'My Library'}</span>
                    {[...library.values()].filter(e => e.saved).length > 0 && (
                      <span className="my-library-badge">{[...library.values()].filter(e => e.saved).length}</span>
                    )}
                  </Link>
                )}
                <div className="reader-auth-bar">
                  <span className="reader-email">{currentUser.email}</span>
                  {isAdmin && (
                    <button
                      className="btn btn-secondary btn-sm"
                      title={viewingAsReader ? 'Return to your admin view' : 'Preview the hub as a signed-out reader would see it'}
                      onClick={() => setViewingAsReader(v => !v)}
                    >
                      {viewingAsReader ? '← Back to admin' : '👁 View as reader'}
                    </button>
                  )}
                  {effectiveIsAdmin && (
                    <Link to="/admin" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>
                      ⚙ Admin
                    </Link>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => { trackSignedOut(); signOut(auth) }}>
                    {lang === 'fr' ? 'Déconnexion' : 'Sign out'}
                  </button>
                </div>
              </>
            ) : (
              <button className="btn btn-primary hub-signin-btn" onClick={() => setShowAuthModal(true)}>
                {lang === 'fr' ? '→ Se connecter' : '→ Sign in'}
              </button>
            )}
            <div className="lang-switcher">
              <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => changeLang('en')}>EN</button>
              <button className={`lang-btn ${lang === 'fr' ? 'active' : ''}`} onClick={() => changeLang('fr')}>FR</button>
            </div>
          </div>
        </div>
        <p className="header-desc">{currentSubtitle}</p>
      </header>

      {filterTopic && (
        <div style={{ padding: '10px 22px', borderBottom: '1px solid var(--line)', background: 'var(--cream-deep)' }}>
          <Breadcrumbs items={[
            { label: lang === 'fr' ? 'Accueil' : 'Hub', to: '/' },
            { label: lang === 'fr' ? (TOPICS.find(t => t.en === filterTopic)?.fr ?? filterTopic) : filterTopic },
          ]} />
        </div>
      )}

      {showAuthModal && (
        <AuthGateModal
          lang={lang}
          onClose={() => { setShowAuthModal(false); setPendingAction(null) }}
          onMagicLinkSent={() => {
            if (pendingAction) localStorage.setItem('pendingLibraryAction', JSON.stringify(pendingAction))
          }}
        />
      )}

      {!loading && (
        <div className="pinned-strip-wrap">
          <PinnedCarousel
            guides={guides.filter(g => g.pinned)}
            lang={lang}
            onSelect={id => {
              const guide = guides.find(g => g.id === id)
              trackPinnedClicked(id, guide?.title || '')
              navigate(`/guide/${id}?lang=${lang}`)
            }}
          />
        </div>
      )}

      {!loading && guides.length > 0 && (
        <div className="hub-toolbar-wrap">
          <div className="hub-toolbar">
            <div className="hub-search">
              <span className="hub-search-icon">🔍</span>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={lang === 'fr' ? 'Rechercher un guide, un sujet…' : 'Search guides or topics…'}
              />
            </div>

            {(allTags.length > 0 || allLevels.length > 0 || allTopics.length > 0 || allOverlays.length > 0) && (
              <button
                className={`hub-filters-btn ${showFilters ? 'active' : ''}`}
                onClick={() => setShowFilters(v => !v)}
              >
                <svg className="hub-filters-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2" fill="var(--paper)" />
                  <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2" fill="var(--paper)" />
                  <line x1="4" y1="18" x2="20" y2="18" /><circle cx="11" cy="18" r="2" fill="var(--paper)" />
                </svg>
                {lang === 'fr' ? 'Filtres' : 'Filters'}
                {(filterSection || filterTag || filterLevel || filterTopic || filterOverlay) && <span className="hub-filters-dot" />}
              </button>
            )}

            <div className="hub-toolbar-group hub-sort-group">
              <span className="hub-toolbar-label">{lang === 'fr' ? 'TRIER' : 'SORT'}</span>
              <select
                className="hub-sort-select"
                value={sortMode}
                onChange={e => setSortMode(e.target.value as SortMode)}
              >
                {(Object.keys(SORT_LABELS) as SortMode[]).map(mode => (
                  <option key={mode} value={mode}>{SORT_LABELS[mode][lang]}</option>
                ))}
              </select>
            </div>
          </div>

          {showFilters && (sectionsWithGuides.length > 0 || allLevels.length > 0 || allTopics.length > 0 || allOverlays.length > 0) && (
            <div className="hub-filters-panel">
              {allTopics.length > 0 && (
                <div className="hub-filters-group">
                  <span className="hub-toolbar-label">{lang === 'fr' ? 'SUJET' : 'TOPIC'}</span>
                  <div className="filter-chips">
                    <button
                      className={`filter-chip ${!filterTopic ? 'active' : ''}`}
                      onClick={() => setFilterTopic(null)}
                    >
                      {lang === 'fr' ? 'Tous les sujets' : 'All Topics'}
                    </button>
                    {allTopics.map(t => (
                      <button
                        key={t.en}
                        className={`filter-chip ${filterTopic === t.en ? 'active' : ''}`}
                        onClick={() => {
                          const next = filterTopic === t.en ? null : t.en
                          setFilterTopic(next)
                          navigate(next ? `/category/${topicSlug(t.en)}?lang=${lang}` : '/')
                        }}
                      >
                        {lang === 'fr' ? t.fr : t.en}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {allOverlays.length > 0 && (
                <div className="hub-filters-group">
                  <span className="hub-toolbar-label">{lang === 'fr' ? 'CONTEXTE' : 'OVERLAY'}</span>
                  <div className="filter-chips">
                    <button
                      className={`filter-chip ${!filterOverlay ? 'active' : ''}`}
                      onClick={() => setFilterOverlay(null)}
                    >
                      {lang === 'fr' ? 'Tous les contextes' : 'All Overlays'}
                    </button>
                    {allOverlays.map(o => (
                      <button
                        key={o.en}
                        className={`filter-chip ${filterOverlay === o.en ? 'active' : ''}`}
                        onClick={() => setFilterOverlay(prev => prev === o.en ? null : o.en)}
                      >
                        {lang === 'fr' ? o.fr : o.en}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {sectionsWithGuides.length > 0 && (
                <div className="hub-filters-group">
                  <span className="hub-toolbar-label">{lang === 'fr' ? 'SECTION' : 'SECTION'}</span>
                  <div className="filter-chips">
                    <button
                      className={`filter-chip ${!filterSection ? 'active' : ''}`}
                      onClick={() => selectFilterSection(null)}
                    >
                      {lang === 'fr' ? 'Toutes les sections' : 'All Sections'}
                    </button>
                  </div>
                  {[...MEGA_GROUPS, 'Unassigned'].map(mg => {
                    const inGroup = sectionsWithGuides.filter(s => (s.megaGroup || 'Unassigned') === mg)
                    if (inGroup.length === 0) return null
                    return (
                      <div key={mg} className="hub-filters-mega-row">
                        <span className="hub-filters-mega-label">{lang === 'fr' ? (MEGA_GROUP_LABEL_FR[mg] || mg) : mg}</span>
                        <div className="filter-chips">
                          {inGroup.map(s => {
                            const name = lang === 'fr' ? (s.name_fr || s.name) : s.name
                            return (
                              <button
                                key={s.id}
                                className={`filter-chip ${filterSection === s.id ? 'active' : ''}`}
                                onClick={() => selectFilterSection(s.id)}
                              >
                                {name}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}

                  {/* Level 2 — content type (guide.tag), scoped to the chosen section, revealed progressively */}
                  {filterSection && allTags.length > 0 && (
                    <div className="hub-filters-subgroup">
                      <span className="hub-toolbar-label">{lang === 'fr' ? 'TYPE DE CONTENU' : 'CONTENT TYPE'}</span>
                      <div className="filter-chips">
                        <button
                          className={`filter-chip ${!filterTag ? 'active' : ''}`}
                          onClick={() => setFilterTag(null)}
                        >
                          {lang === 'fr' ? 'Tous les types' : 'All Types'}
                        </button>
                        {allTags.map(t => (
                          <button
                            key={t}
                            className={`filter-chip ${filterTag === t ? 'active' : ''}`}
                            onClick={() => setFilterTag(prev => prev === t ? null : t)}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {allLevels.length > 0 && (
                <div className="hub-filters-group">
                  <span className="hub-toolbar-label">{lang === 'fr' ? 'NIVEAU' : 'LEVEL'}</span>
                  <div className="filter-chips">
                    <button
                      className={`filter-chip ${!filterLevel ? 'active' : ''}`}
                      onClick={() => setFilterLevel(null)}
                    >
                      {lang === 'fr' ? 'Tous niveaux' : 'All Levels'}
                    </button>
                    {allLevels.map(lvl => (
                      <button
                        key={lvl}
                        className={`filter-chip ${filterLevel === lvl ? 'active' : ''}`}
                        onClick={() => setFilterLevel(prev => prev === lvl ? null : lvl)}
                      >
                        {lang === 'fr' ? LEVEL_LABEL_FR[lvl] : lvl}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="hub-layout">
        {!loading && activeSections.length > 0 && (
          <nav className="hub-toc" aria-label="Section index">
            {[...MEGA_GROUPS, 'Unassigned'].map(mg => {
              const inGroup = activeSections.filter(s => (s.megaGroup || 'Unassigned') === mg)
              if (inGroup.length === 0) return null
              return (
                <div key={mg} className="hub-toc-mega-group">
                  <button 
                    className="hub-toc-mega-label"
                    onClick={() => {
                      setExpandedTocGroups(prev => {
                        const next = new Set(prev)
                        if (next.has(mg)) next.delete(mg)
                        else next.add(mg)
                        return next
                      })
                    }}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', outline: 'none', textAlign: 'left', display: 'flex', alignItems: 'center', width: '100%' }}
                  >
                    {lang === 'fr' ? (MEGA_GROUP_LABEL_FR[mg] || mg) : mg}
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--orange)' }}>
                      {expandedTocGroups.has(mg) ? '▾' : '▸'}
                    </span>
                  </button>
                  {expandedTocGroups.has(mg) && inGroup.map(section => {
                    const sectionName = lang === 'fr' ? (section.name_fr || section.name) : section.name
                    return (
                      <a
                        key={section.id}
                        href={`#section-${section.id}`}
                        className={`hub-toc-link ${activeSectionId === section.id ? 'active' : ''}`}
                        onClick={e => {
                          e.preventDefault()
                          trackSectionNavigation(section.id, section.name)
                          document.getElementById(`section-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }}
                      >
                        {section.icon && <span className="hub-toc-link-icon">{section.icon}</span>}
                        {sectionName}
                      </a>
                    )
                  })}
                </div>
              )
            })}
          </nav>
        )}

      <main className="hub-main">
        {loading ? (
          <div className="loading">{lang === 'fr' ? 'Chargement des guides…' : 'Loading guides…'}</div>
        ) : activeSections.length === 0 && hasActiveFilter ? (
          <div className="empty-state">
            <span className="icon">🔍</span>
            <p>
              {lang === 'fr'
                ? 'Aucun guide ne correspond à ces critères.'
                : 'No guides match your search or filters.'}
            </p>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => { setFilterSection(null); setFilterTag(null); setFilterLevel(null); setFilterTopic(null); setFilterOverlay(null); setSearchQuery('') }}
              style={{ marginTop: 10 }}
            >
              {lang === 'fr' ? 'Effacer les filtres' : 'Clear filters'}
            </button>
          </div>
        ) : activeSections.length === 0 ? (
          <div className="empty-state">
            <span className="icon">📭</span>
            <p>
              {lang === 'fr'
                ? 'Aucun guide publié pour le moment — repassez bientôt.'
                : 'No guides published yet — check back soon.'}
            </p>
          </div>
        ) : (
          activeSections.map(section => {
            const sectionGuides = guidesBySection.get(section.id) ?? []
            const sectionLists = listsBySection.get(section.id) ?? []
            const sectionName = lang === 'fr' ? (section.name_fr || section.name) : section.name
            const sectionIntro = lang === 'fr' ? (section.intro_fr || section.intro) : section.intro

            return (
              <div key={section.id} id={`section-${section.id}`} className="hub-section">
                <div className="hub-section-heading">{section.icon && <span className="hub-section-heading-icon">{section.icon}</span>}{sectionName}</div>
                
                {true && (
                  <div className="hub-section-content" style={{ marginTop: 16 }}>
                    {sectionIntro && <p className="hub-section-intro">{sectionIntro}</p>}

                    {/* Guide cards */}
                    {sectionGuides.length > 0 && (
                      <div className="reader-grid">
                        {sectionGuides.map(guide => (
                          <GuideCard
                            key={guide.id}
                            guide={guide}
                            lang={lang}
                            liked={library.get(guide.id)?.liked ?? false}
                            saved={library.get(guide.id)?.saved ?? false}
                            isNew={createdMillis(guide) > 0 && (Date.now() - createdMillis(guide)) < NEW_WINDOW_MS}
                            isAdmin={effectiveIsAdmin}
                            onOpen={() => navigate(`/guide/${guide.id}?lang=${lang}`)}
                            onToggleLike={() => handleToggleLike(guide.id)}
                            onToggleSave={() => handleToggleSave(guide.id)}
                            onQuickTagSave={update => saveQuickTags(guide.id, update)}
                          />
                        ))}
                      </div>
                    )}

                {/* Link lists */}
                {sectionLists.map(list => {
                  const listTitle = lang === 'fr' ? (list.title_fr || list.title) : list.title
                  return (
                    <div key={list.id} className="link-list-block">
                      <div className="link-list-heading">📋 {listTitle}</div>
                      <ul className="link-list">
                        {list.items.map(item => {
                          const itemTitle = lang === 'fr' ? (item.title_fr || item.title) : item.title
                          return (
                            <li key={item.id}>
                              <a href={item.url} target="_blank" rel="noopener noreferrer">
                                {itemTitle}
                              </a>
                              <span className="link-url">{item.url.replace(/^https?:\/\//, '')}</span>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )
                })}
                </div>
                )}
              </div>
            )
          })
        )}

        {!loading && topicCounts.length > 0 && (
          <div className="topic-browse-section">
            <div className="pinned-header">
              <span className="pinned-header-label">
                <span className="pinned-pin">🧭</span>
                {lang === 'fr' ? 'Parcourir par sujet' : 'Browse by Topic'}
              </span>
            </div>
            <div className="topic-browse-row">
              {topicCounts.map(t => (
                <button
                  key={t.en}
                  className="topic-chip"
                  onClick={() => {
                    setFilterTopic(t.en)
                    navigate(`/category/${topicSlug(t.en)}?lang=${lang}`)
                  }}
                >
                  <span className="topic-chip-label">{lang === 'fr' ? t.fr : t.en}</span>
                  <span className="topic-chip-count">{t.count}</span>
                </button>
              ))}
            </div>
            {overlayCounts.length > 0 && (
              <div className="topic-browse-row overlay-row">
                {overlayCounts.map(o => (
                  <button
                    key={o.en}
                    className="overlay-chip"
                    onClick={() => { setFilterOverlay(o.en); setShowFilters(true) }}
                  >
                    <span className="topic-chip-label">{lang === 'fr' ? o.fr : o.en}</span>
                    <span className="topic-chip-count">{o.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
      </div>
    </>
  )
}
