import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { doc, getDoc, getDocs, collection, addDoc, query, where } from 'firebase/firestore'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { db, auth } from '../firebase'
import TtsPlayer, { type GuideSection } from './TtsPlayer'
import { trackGuideViewed, trackExportRequested, trackTtsStarted, trackTtsSectionPlayed, trackLanguageSwitched, trackSignedOut } from '../analytics'
import { sendMagicLink } from '../sendMagicLink'
import Breadcrumbs from './Breadcrumbs'

interface Guide {
  title: string
  title_fr?: string
  published: boolean
  htmlContent?: string
  htmlContent_fr?: string
  // Large guides store their HTML in Storage instead of inline — htmlContent
  // is then empty and this URL must be fetched to get the actual HTML.
  htmlUrl?: string | null
  htmlUrl_fr?: string | null
  audioUrls_en?: Record<string, string>
  audioUrls_fr?: Record<string, string>
  updated_at?: { toMillis?: () => number; seconds?: number } | null
  tag?: string
  tag_fr?: string
  level?: string
  topics?: string[]
  overlay?: string[]
  format?: string[]
  description?: string
  description_fr?: string
}

interface RelatedGuide {
  id: string
  title: string
  description: string
  tag: string
}

// Same 9-value controlled vocabulary as AdminHub.tsx/PublicHub.tsx's TOPICS —
// kept as an independent copy per this codebase's existing per-file convention.
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

function formatUpdated(ts: Guide['updated_at'], lang: 'en' | 'fr'): string | null {
  if (!ts) return null
  const millis = typeof ts.toMillis === 'function' ? ts.toMillis() : (typeof ts.seconds === 'number' ? ts.seconds * 1000 : 0)
  if (!millis) return null
  const formatted = new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(millis))
  return lang === 'fr' ? `Mis à jour le ${formatted}` : `Updated ${formatted}`
}

// Resolves a guide's HTML: inline content if present, else fetches it from
// its Storage URL (used for large guides that don't fit inline in Firestore).
async function resolveHtml(inline?: string | null, url?: string | null): Promise<string> {
  if (inline) return inline
  if (url) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.text()
    } catch { /* fall through to empty */ }
  }
  return ''
}

export default function GuideViewer() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const [guide, setGuide] = useState<Guide | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [lang, setLang] = useState<'en' | 'fr'>('en')
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  // authReady gates the guide fetch so private guides can be read with the
  // admin's token — without it, getDoc fires before Firebase Auth initialises
  // and the Firestore rule `isAdmin()` evaluates false → "Guide not found."
  const [authReady, setAuthReady] = useState(false)
  // iframeLoaded tracks when the iframe signals it's ready to receive HTML
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [relatedGuides, setRelatedGuides] = useState<RelatedGuide[]>([])
  // TTS player
  const [ttsOpen, setTtsOpen] = useState(false)
  const [ttsSections, setTtsSections] = useState<GuideSection[]>([])

  // Reader signup state
  const [showSignup, setShowSignup] = useState(false)
  const [authMode, setAuthMode] = useState<'signup' | 'login'>('signup')
  const [signupName, setSignupName] = useState('')
  const [signupEmail, setSignupEmail] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [signupSent, setSignupSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [btnHover, setBtnHover] = useState(false)

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const urlLang = searchParams.get('lang')
    if (urlLang === 'fr' || urlLang === 'en') {
      setLang(urlLang)
      localStorage.setItem('yezi-hub-lang', urlLang)
    } else {
      const saved = localStorage.getItem('yezi-hub-lang')
      if (saved === 'fr' || saved === 'en') setLang(saved)
    }
  }, [])

  // Listen to Firebase Auth state. Setting authReady on the first callback
  // guarantees the guide fetch runs with the correct auth token already loaded.
  useEffect(() => {
    return onAuthStateChanged(auth, u => {
      setCurrentUser(u)
      setAuthReady(true)
    })
  }, [])

  // Auto-trigger print after magic link sign-in
  useEffect(() => {
    if (currentUser && !loading && localStorage.getItem('triggerPrintAfterSignIn') === 'true') {
      localStorage.removeItem('triggerPrintAfterSignIn')
      setTimeout(() => {
        iframeRef.current?.contentWindow?.postMessage({ type: 'DO_NATIVE_PRINT' }, '*')
      }, 800)
    }
  }, [currentUser, loading])

  // Push guide HTML to iframe when both are ready.
  // For public guides (published:true): the iframe's REST API fetch already works
  // for English. We ONLY inject when:
  //   a) guide is private (REST returns 403, iframe will send REQUEST_HTML), OR
  //   b) lang=fr AND a proper htmlContent_fr exists (reliable FR; don't override
  //      Google Translate path which is the best available for guides missing FR)
  // For lang=en the REST path is always fine; skip INJECT_HTML to avoid race.
  useEffect(() => {
    if (!iframeLoaded || !guide) return
    const isPrivate = !guide.published
    const hasFrContent = !!(guide.htmlContent_fr || guide.htmlUrl_fr)
    if (!(lang === 'fr' && hasFrContent) && !isPrivate) {
      // Public EN-only guide without FR: skip INJECT_HTML entirely — the
      // iframe's REST fetch + Google Translate is the better path.
      return
    }

    let cancelled = false
    ;(async () => {
      let html = ''
      if (lang === 'fr' && hasFrContent) {
        html = await resolveHtml(guide.htmlContent_fr, guide.htmlUrl_fr)
      } else if (isPrivate) {
        // Private guide: REST 403 → use parent's authenticated read (EN or FR)
        html = lang === 'fr'
          ? (await resolveHtml(guide.htmlContent_fr, guide.htmlUrl_fr)) || (await resolveHtml(guide.htmlContent, guide.htmlUrl))
          : await resolveHtml(guide.htmlContent, guide.htmlUrl)
      }
      if (!html || cancelled) return
      iframeRef.current?.contentWindow?.postMessage({ type: 'INJECT_HTML', html, lang }, '*')
    })()
    return () => { cancelled = true }
  }, [iframeLoaded, guide, lang])

  // Listen for postMessage from the iframe: print button + HTML request
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (!e.data) return
      if (e.data.type === 'EXPORT_PDF') {
        handleExportTrigger()
      }
      // Iframe asks for HTML when its own REST API fetch fails (private guide)
      if (e.data.type === 'REQUEST_HTML' && guide) {
        (async () => {
          const html = lang === 'fr'
            ? (await resolveHtml(guide.htmlContent_fr, guide.htmlUrl_fr)) || (await resolveHtml(guide.htmlContent, guide.htmlUrl))
            : await resolveHtml(guide.htmlContent, guide.htmlUrl)
          if (html) iframeRef.current?.contentWindow?.postMessage({ type: 'INJECT_HTML', html, lang }, '*')
        })()
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [currentUser, guide, lang])

  // Wait for auth to initialise before fetching, so admin token is present
  // for private guide reads — without authReady the read fires unauthenticated.
  useEffect(() => {
    if (!authReady) return
    if (!id) { setNotFound(true); setLoading(false); return }
    getDoc(doc(db, 'guides', id)).then(snap => {
      if (!snap.exists()) { setNotFound(true); setLoading(false); return }
      const data = snap.data() as Guide
      setGuide(data)
      setLoading(false)
      trackGuideViewed(id, data.title, lang)
    }).catch(() => { setNotFound(true); setLoading(false) })
  }, [id, authReady])

  // Related Guides — ranked by topic overlap (primary), then same content
  // type (secondary), then same level (tertiary), per the taxonomy-audit
  // ranking already recorded for this feature. Skips entirely (no empty
  // state) if the guide has no topics or the query fails.
  useEffect(() => {
    if (!guide || !guide.topics || guide.topics.length === 0 || !id) { setRelatedGuides([]); return }
    let cancelled = false
    ;(async () => {
      try {
        const q = query(
          collection(db, 'guides'),
          where('topics', 'array-contains-any', guide.topics!.slice(0, 10)),
          where('published', '==', true)
        )
        const snap = await getDocs(q)
        const scored = snap.docs
          .filter(d => d.id !== id)
          .map(d => {
            const c = d.data() as Guide
            const topicOverlap = (c.topics ?? []).filter(t => guide.topics!.includes(t)).length
            const sameTag = c.tag && c.tag === guide.tag ? 1 : 0
            const sameLevel = c.level && c.level === guide.level ? 1 : 0
            const title = lang === 'fr' && c.title_fr ? c.title_fr : c.title
            const description = lang === 'fr' && c.description_fr ? c.description_fr : (c.description || '')
            const tag = lang === 'fr' && c.tag_fr ? c.tag_fr : (c.tag || '')
            return { id: d.id, title, description, tag, topicOverlap, sameTag, sameLevel }
          })
          .sort((a, b) => (b.topicOverlap - a.topicOverlap) || (b.sameTag - a.sameTag) || (b.sameLevel - a.sameLevel))
          .slice(0, 4)
          .map(({ id, title, description, tag }) => ({ id, title, description, tag }))
        if (!cancelled) setRelatedGuides(scored)
      } catch (err) {
        console.warn('Related guides query failed', err)
        if (!cancelled) setRelatedGuides([])
      }
    })()
    return () => { cancelled = true }
  }, [guide, id, lang])

  // Push the computed related-guides list into the iframe once it's loaded —
  // rendered there (not as a React block) because the iframe fills the full
  // viewport height by design; the natural place for "what to read next" is
  // at the end of the guide content itself, like reaching the end of an article.
  useEffect(() => {
    if (!iframeLoaded || relatedGuides.length === 0) return
    const items = relatedGuides.map(g => ({ title: g.title, description: g.description, tag: g.tag, url: `/guide/${g.id}?lang=${lang}` }))
    iframeRef.current?.contentWindow?.postMessage({ type: 'RELATED_GUIDES', items, lang }, '*')
  }, [iframeLoaded, relatedGuides, lang])

  useEffect(() => {
    if (!guide) return
    document.title = (lang === 'fr' ? (guide.title_fr || guide.title) : guide.title) + ' · Product Fieldwork'
  }, [guide, lang])

  function changeLang(val: 'en' | 'fr') {
    trackLanguageSwitched(lang, val, 'guide_viewer')
    setLang(val)
    localStorage.setItem('yezi-hub-lang', val)
  }

  function handleExportTrigger() {
    trackExportRequested(id || '', guide?.title || '', !!currentUser)
    if (currentUser) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'DO_NATIVE_PRINT' }, '*')
    } else {
      setShowSignup(true)
    }
  }

  async function handleSignupSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!signupName.trim() || !signupEmail.trim()) return
    setSubmitting(true)

    try {
      // 1. Save subscriber to Firestore IMMEDIATELY on form submit
      //    (so email is captured even if user never clicks the magic link)
      await addDoc(collection(db, 'subscribers'), {
        name: signupName.trim(),
        email: signupEmail.trim(),
        guideId: id || null,
        signedUpAt: new Date().toISOString(),
      })

      // 2. Send magic link via Firebase Auth for authentication + PDF unlock
      await sendMagicLink(signupEmail.trim(), {
        lang,
        name: signupName.trim(),
        mode: 'signup',
      })

      // Store name + email in localStorage for use after magic link callback
      localStorage.setItem('emailForSignIn', signupEmail.trim())
      localStorage.setItem('nameForSignIn', signupName.trim())
      localStorage.setItem('triggerPrintAfterSignIn', 'true')

      setSignupSent(true)
    } catch (err: any) {
      console.error('Failed to send magic link', err)
      alert('Failed to send magic link: ' + (err?.message || err?.code || String(err)))
    } finally {
      setSubmitting(false)
    }
  }

  // Returning subscriber: just send a magic link, no new subscribers doc
  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!loginEmail.trim()) return
    setSubmitting(true)

    try {
      await sendMagicLink(loginEmail.trim(), {
        lang,
        mode: 'login',
      })

      localStorage.setItem('emailForSignIn', loginEmail.trim())
      localStorage.setItem('triggerPrintAfterSignIn', 'true')

      setSignupEmail(loginEmail.trim())
      setSignupSent(true)
    } catch (err: any) {
      console.error('Failed to send magic link', err)
      alert('Failed to send magic link: ' + (err?.message || err?.code || String(err)))
    } finally {
      setSubmitting(false)
    }
  }

  // Extract readable sections from the guide HTML for TTS. Strips nav, topbar,
  // buttons, code blocks, and chips — anything that doesn't read well aloud.
  function extractSections(html: string): GuideSection[] {
    const parser = new DOMParser()
    const d = parser.parseFromString(html, 'text/html')
    d.querySelectorAll('nav.rail, .topbar, style, script, button, pre, code, .copy-btn, .chip, .tprogress, .lang-switcher, [aria-hidden="true"]').forEach(el => el.remove())

    const blocks = d.querySelectorAll('section.block, .block[id]')
    if (blocks.length > 0) {
      const sections: GuideSection[] = []
      // Include the hero section first if it has a meaningful title
      const heroHeadline = d.querySelector('.hero h1, .hero h2, .hero .headline')
      if (heroHeadline) {
        const heroClone = d.querySelector('.hero')?.cloneNode(true) as Element
        heroClone?.querySelectorAll('button, .pill-label, .spark').forEach(el => el.remove())
        const heroText = heroClone?.textContent?.replace(/\s+/g, ' ').trim() || ''
        if (heroText.length > 30) sections.push({ id: 'hero', title: heroHeadline.textContent?.trim() || 'Introduction', text: heroText })
      }
      blocks.forEach(block => {
        const id = block.id || ''
        const clone = block.cloneNode(true) as Element
        // Get heading before stripping sec-num
        const secNum = clone.querySelector('.sec-num')?.textContent?.trim() || ''
        const heading = clone.querySelector('h1, h2, h3')?.textContent?.trim()
          || clone.querySelector('[class*="title"], [class*="heading"]')?.textContent?.trim()
          || id
        clone.querySelectorAll('.sec-num, button, .copy-btn').forEach(el => el.remove())
        const text = clone.textContent?.replace(/\s+/g, ' ').trim() || ''
        if (text.length > 20) {
          sections.push({ id, title: (secNum ? secNum + ' ' : '') + heading, text })
        }
      })
      return sections
    }
    // Fallback: read the entire body as one section
    const bodyText = d.body?.textContent?.replace(/\s+/g, ' ').trim() || ''
    return bodyText.length > 20 ? [{ id: 'body', title: guide?.title || 'Guide', text: bodyText }] : []
  }

  async function handleListenClick() {
    if (!guide) return
    // Use the French HTML when available so the French voice reads French text.
    // If no French version exists, fall back to English with a note.
    const hasFr = !!(guide.htmlContent_fr || guide.htmlUrl_fr)
    const html = lang === 'fr'
      ? (await resolveHtml(guide.htmlContent_fr, guide.htmlUrl_fr)) || (await resolveHtml(guide.htmlContent, guide.htmlUrl))
      : await resolveHtml(guide.htmlContent, guide.htmlUrl)
    if (!html) return
    const sections = extractSections(html)
    if (!sections.length) return
    // Warn reader if FR is selected but no French content is available
    if (lang === 'fr' && !hasFr) {
      sections.unshift({
        id: 'lang-notice',
        title: lang === 'fr' ? 'Note de langue' : 'Language note',
        text: 'Ce guide n\'a pas encore de version française. La lecture se fera en anglais.',
      })
    }
    setTtsSections(sections)
    setTtsOpen(true)
    trackTtsStarted(id || '', lang, sections.length)
  }

  if (loading) return <div className="loading">{lang === 'fr' ? 'Chargement du guide…' : 'Loading guide…'}</div>

  if (notFound || !guide) return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'var(--cream)' }}>
      <div style={{ fontSize: 48 }}>📭</div>
      <p style={{ color: 'var(--muted)', fontSize: 16 }}>{lang === 'fr' ? 'Guide introuvable.' : 'Guide not found.'}</p>
      <button className="btn btn-secondary" onClick={() => navigate('/')}>
        {lang === 'fr' ? '← Retour à l\'accueil' : '← Back to hub'}
      </button>
    </div>
  )

  const currentTitle = lang === 'fr' ? (guide.title_fr || guide.title) : guide.title
  const updatedLabel = formatUpdated(guide.updated_at, lang)
  const primaryTopic = guide.topics && guide.topics.length > 0 ? guide.topics[0] : null
  const primaryTopicLabel = primaryTopic
    ? (lang === 'fr' ? (TOPICS.find(t => t.en === primaryTopic)?.fr ?? primaryTopic) : primaryTopic)
    : null

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Slim back bar */}
      <div style={{
        background: 'var(--cream-deep)', borderBottom: '2px solid var(--line)',
        padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12,
        flexShrink: 0, zIndex: 10
      }}>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/?lang=${lang}`)}>
          {lang === 'fr' ? '← Accueil' : '← Hub'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Breadcrumbs items={[
            { label: lang === 'fr' ? 'Accueil' : 'Hub', to: `/?lang=${lang}` },
            ...(primaryTopic ? [{ label: primaryTopicLabel!, to: `/category/${topicSlug(primaryTopic)}?lang=${lang}` }] : []),
          ]} />
          <div style={{ fontFamily: '"Archivo",sans-serif', fontWeight: 800, fontSize: 14, display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 2, overflow: 'hidden' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTitle}</span>
            {updatedLabel && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--ink-soft)', flexShrink: 0 }}>{updatedLabel}</span>}
          </div>
        </div>
        <div className="lang-switcher">
          <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => changeLang('en')}>EN</button>
          <button className={`lang-btn ${lang === 'fr' ? 'active' : ''}`} onClick={() => changeLang('fr')}>FR</button>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          style={{ flexShrink: 0 }}
          onClick={handleExportTrigger}
          title={lang === 'fr' ? 'Enregistrer et exporter en PDF' : 'Save and export as PDF'}
        >
          💾 {lang === 'fr' ? 'Exporter' : 'Save & Export'}
        </button>
        {guide?.htmlContent && !ttsOpen && (
          <button
            className="btn btn-secondary btn-sm tts-listen-btn"
            style={{ flexShrink: 0 }}
            onClick={handleListenClick}
            title={lang === 'fr' ? 'Écouter ce guide' : 'Listen to this guide'}
          >
            🔊 {lang === 'fr' ? 'Écouter' : 'Listen'}
          </button>
        )}
        {ttsOpen && (
          <button
            className="btn btn-secondary btn-sm"
            style={{ flexShrink: 0, color: 'var(--orange-deep)', borderColor: 'var(--orange)' }}
            onClick={() => setTtsOpen(false)}
          >
            ⏹ {lang === 'fr' ? 'Arrêter' : 'Stop'}
          </button>
        )}
        {!currentUser && (
          <button
            className="btn btn-primary btn-sm"
            style={{ fontWeight: 700, flexShrink: 0 }}
            onClick={() => setShowSignup(true)}
          >
            {lang === 'fr' ? '→ Se connecter' : '→ Sign in'}
          </button>
        )}
        {currentUser && (
          <button
            className="btn btn-secondary btn-sm"
            style={{ flexShrink: 0 }}
            onClick={() => signOut(auth)}
          >
            {lang === 'fr' ? 'Déconnexion' : 'Sign out'}
          </button>
        )}
      </div>

      {/* Full-page iframe renders the guide HTML exactly as authored.
          allow="clipboard-write" — many guides embed their own "Copy" buttons
          (navigator.clipboard.writeText) for templates/snippets; without this
          the permission is silently denied and the button appears to do nothing. */}
      <iframe
        ref={iframeRef}
        src={`/raw-guide.html?id=${id}&lang=${lang}`}
        title={currentTitle}
        allow="clipboard-write"
        style={{ flex: 1, width: '100%', border: 'none' }}
        onLoad={() => setIframeLoaded(true)}
      />

      {/* TTS Player — sticky at bottom of viewer, above the iframe */}
      {ttsOpen && ttsSections.length > 0 && (
        <TtsPlayer
          key={lang}
          sections={ttsSections}
          lang={lang}
          audioUrls={lang === 'fr' ? guide?.audioUrls_fr : guide?.audioUrls_en}
          onClose={() => setTtsOpen(false)}
          onSectionChange={(sectionId, sectionTitle, idx) => {
            iframeRef.current?.contentWindow?.postMessage({ type: 'SCROLL_TO_SECTION', id: sectionId }, '*')
            trackTtsSectionPlayed(id || '', sectionId, sectionTitle, idx)
          }}
        />
      )}

      {/* Campfire Signup Overlay Modal */}
      {showSignup && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          background: 'rgba(28, 24, 20, 0.4)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{
            background: '#f6ece2', border: '3px solid #000000',
            boxShadow: '6px 6px 0px #000000', padding: 32, maxWidth: 440, width: '90%',
            position: 'relative', borderRadius: 0
          }}>
            <button
              onClick={() => { setShowSignup(false); setSignupSent(false); setAuthMode('signup') }}
              style={{
                position: 'absolute', top: 16, right: 18, border: 'none', background: 'none',
                fontSize: 24, cursor: 'pointer', fontFamily: 'inherit', fontWeight: '900',
                color: '#000000', lineHeight: 1, outline: 'none'
              }}
            >
              ×
            </button>
            
            {!signupSent ? authMode === 'signup' ? (
              <form onSubmit={handleSignupSubmit}>
                <h3 style={{
                  fontFamily: '"Archivo", sans-serif', fontWeight: 900, fontSize: '26px',
                  letterSpacing: '-0.5px', textTransform: 'uppercase', color: '#1c1814',
                  marginTop: 0, marginBottom: 8
                }}>
                  {lang === 'fr' ? 'ACCÉDER AU GUIDE PDF' : 'GET THE PDF GUIDE'}
                </h3>
                <p style={{
                  fontSize: '13px', color: '#4a423a', lineHeight: '1.5',
                  marginTop: 0, marginBottom: 16
                }}>
                  {lang === 'fr'
                    ? 'Inscrivez-vous pour recevoir les boîtes à outils et la newsletter.'
                    : 'Sign up to receive toolkits and the newsletter.'}
                </p>
                {/* Step indicators */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 20, fontSize: 12, color: '#6b5e52' }}>
                  <span style={{ background: '#c78c5d', color: '#fff', borderRadius: 0, padding: '2px 8px', fontWeight: 800 }}>1</span>
                  <span>{lang === 'fr' ? 'Entrez vos infos' : 'Enter your info'}</span>
                  <span style={{ margin: '0 4px' }}>→</span>
                  <span style={{ background: '#1c1814', color: '#fff', borderRadius: 0, padding: '2px 8px', fontWeight: 800 }}>2</span>
                  <span>{lang === 'fr' ? 'Cliquez le lien magique' : 'Click the magic link'}</span>
                  <span style={{ margin: '0 4px' }}>→</span>
                  <span style={{ background: '#1c1814', color: '#fff', borderRadius: 0, padding: '2px 8px', fontWeight: 800 }}>3</span>
                  <span>PDF 📄</span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{
                      fontFamily: 'var(--mono), monospace', fontSize: '11px', fontWeight: 'bold',
                      letterSpacing: '0.5px', textTransform: 'uppercase', color: '#1c1814'
                    }}>
                      {lang === 'fr' ? 'NOM' : 'NAME'}
                    </label>
                    <input 
                      type="text" 
                      required
                      value={signupName}
                      onChange={e => setSignupName(e.target.value)}
                      placeholder={lang === 'fr' ? 'Votre nom' : 'Your name'}
                      style={{
                        padding: '12px', border: '2px solid #000000', borderRadius: 0,
                        fontSize: '14px', fontFamily: 'inherit', outline: 'none', background: '#ffffff',
                        color: '#1c1814'
                      }}
                    />
                  </div>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{
                      fontFamily: 'var(--mono), monospace', fontSize: '11px', fontWeight: 'bold',
                      letterSpacing: '0.5px', textTransform: 'uppercase', color: '#1c1814'
                    }}>
                      {lang === 'fr' ? 'ADRESSE E-MAIL' : 'EMAIL ADDRESS'}
                    </label>
                    <input 
                      type="email" 
                      required
                      value={signupEmail}
                      onChange={e => setSignupEmail(e.target.value)}
                      placeholder="you@example.com"
                      style={{
                        padding: '12px', border: '2px solid #000000', borderRadius: 0,
                        fontSize: '14px', fontFamily: 'inherit', outline: 'none', background: '#ffffff',
                        color: '#1c1814'
                      }}
                    />
                  </div>
                </div>
                
                <button 
                  type="submit" 
                  disabled={submitting}
                  onMouseEnter={() => setBtnHover(true)}
                  onMouseLeave={() => setBtnHover(false)}
                  style={{
                    width: '100%', padding: '14px', background: '#c78c5d', border: '2px solid #000000',
                    borderRadius: 0, fontFamily: '"Archivo", sans-serif', fontWeight: 800, fontSize: '14px',
                    letterSpacing: '0.5px', color: '#ffffff', textTransform: 'uppercase', cursor: 'pointer',
                    boxShadow: btnHover ? '5px 5px 0px #000000' : '3px 3px 0px #000000',
                    transform: btnHover ? 'translate(-2px, -2px)' : 'none',
                    transition: 'transform 0.1s ease, box-shadow 0.1s ease',
                    outline: 'none'
                  }}
                >
                  {submitting
                    ? (lang === 'fr' ? 'Envoi en cours…' : 'Submitting...')
                    : (lang === 'fr' ? 'S\'INSCRIRE & ENREGISTRER' : 'REGISTER & SAVE')}
                </button>

                <p style={{ fontSize: '13px', color: '#4a423a', textAlign: 'center', marginTop: 16, marginBottom: 0 }}>
                  {lang === 'fr' ? 'Déjà inscrit(e) ?' : 'Already subscribed?'}{' '}
                  <button
                    type="button"
                    onClick={() => setAuthMode('login')}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: 'var(--orange-deep)', fontWeight: 700, textDecoration: 'underline',
                      fontFamily: 'inherit', fontSize: 'inherit'
                    }}
                  >
                    {lang === 'fr' ? 'Se connecter' : 'Log in'}
                  </button>
                </p>
              </form>
            ) : (
              <form onSubmit={handleLoginSubmit}>
                <h3 style={{
                  fontFamily: '"Archivo", sans-serif', fontWeight: 900, fontSize: '26px',
                  letterSpacing: '-0.5px', textTransform: 'uppercase', color: '#1c1814',
                  marginTop: 0, marginBottom: 8
                }}>
                  {lang === 'fr' ? 'SE CONNECTER' : 'LOG IN'}
                </h3>
                <p style={{
                  fontSize: '13px', color: '#4a423a', lineHeight: '1.5',
                  marginTop: 0, marginBottom: 16
                }}>
                  {lang === 'fr'
                    ? 'Entrez votre e-mail pour recevoir un nouveau lien magique.'
                    : 'Enter your email to receive a fresh magic link.'}
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{
                      fontFamily: 'var(--mono), monospace', fontSize: '11px', fontWeight: 'bold',
                      letterSpacing: '0.5px', textTransform: 'uppercase', color: '#1c1814'
                    }}>
                      {lang === 'fr' ? 'ADRESSE E-MAIL' : 'EMAIL ADDRESS'}
                    </label>
                    <input
                      type="email"
                      required
                      value={loginEmail}
                      onChange={e => setLoginEmail(e.target.value)}
                      placeholder="you@example.com"
                      style={{
                        padding: '12px', border: '2px solid #000000', borderRadius: 0,
                        fontSize: '14px', fontFamily: 'inherit', outline: 'none', background: '#ffffff',
                        color: '#1c1814'
                      }}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  onMouseEnter={() => setBtnHover(true)}
                  onMouseLeave={() => setBtnHover(false)}
                  style={{
                    width: '100%', padding: '14px', background: '#c78c5d', border: '2px solid #000000',
                    borderRadius: 0, fontFamily: '"Archivo", sans-serif', fontWeight: 800, fontSize: '14px',
                    letterSpacing: '0.5px', color: '#ffffff', textTransform: 'uppercase', cursor: 'pointer',
                    boxShadow: btnHover ? '5px 5px 0px #000000' : '3px 3px 0px #000000',
                    transform: btnHover ? 'translate(-2px, -2px)' : 'none',
                    transition: 'transform 0.1s ease, box-shadow 0.1s ease',
                    outline: 'none'
                  }}
                >
                  {submitting
                    ? (lang === 'fr' ? 'Envoi en cours…' : 'Sending...')
                    : (lang === 'fr' ? 'ENVOYER LE LIEN MAGIQUE' : 'SEND MAGIC LINK')}
                </button>

                <p style={{ fontSize: '13px', color: '#4a423a', textAlign: 'center', marginTop: 16, marginBottom: 0 }}>
                  {lang === 'fr' ? 'Pas encore inscrit(e) ?' : 'New here?'}{' '}
                  <button
                    type="button"
                    onClick={() => setAuthMode('signup')}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: 'var(--orange-deep)', fontWeight: 700, textDecoration: 'underline',
                      fontFamily: 'inherit', fontSize: 'inherit'
                    }}
                  >
                    {lang === 'fr' ? 'S\'inscrire' : 'Sign up'}
                  </button>
                </p>
              </form>
            ) : (
              <div style={{ textAlign: 'center', padding: '10px 0' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>✉️</div>
                <h3 style={{
                  fontFamily: '"Archivo", sans-serif', fontWeight: 900, fontSize: '24px',
                  letterSpacing: '-0.5px', textTransform: 'uppercase', color: '#1c1814',
                  marginTop: 0, marginBottom: 12
                }}>
                  {lang === 'fr' ? 'Vérifiez votre boîte !' : 'Check your inbox!'}
                </h3>
                <p style={{ fontSize: '14px', color: '#4a423a', lineHeight: '1.6', marginBottom: 8 }}>
                  {lang === 'fr'
                    ? <><strong style={{ color: 'var(--orange-deep)' }}>{signupEmail}</strong><br />Nous vous avons envoyé un lien magique. Cliquez dessus pour valider et télécharger le guide en PDF.</>
                    : <><strong style={{ color: 'var(--orange-deep)' }}>{signupEmail}</strong><br />We sent you a magic link. Click it to verify your account and download the guide as PDF.</>}
                </p>
                <p style={{ fontSize: '12px', color: '#888', marginTop: 8 }}>
                  {lang === 'fr' ? '(Pensez à vérifier vos spams)' : '(Check your spam folder if you don\'t see it)'}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

