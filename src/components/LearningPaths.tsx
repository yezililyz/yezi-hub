import { useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, query, orderBy, where } from 'firebase/firestore'
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

interface Playlist {
  id: string
  title: string
  title_fr?: string
  description: string
  description_fr?: string
  icon: string
  order: number
  published: boolean
  guideIds: string[]
}

export default function LearningPaths() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [currentUser, setCurrentUser] = useState<User | null | undefined>(undefined)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [guidesById, setGuidesById] = useState<Map<string, Guide>>(new Map())
  const [loading, setLoading] = useState(true)
  const [lang] = useState<'en' | 'fr'>(() => {
    const params = new URLSearchParams(window.location.search)
    const urlLang = params.get('lang')
    if (urlLang === 'fr' || urlLang === 'en') return urlLang
    const saved = localStorage.getItem('yezi-hub-lang')
    return (saved === 'fr' || saved === 'en') ? saved : 'en'
  })

  const { library, toggleLike, toggleSave } = useLibrary(currentUser ?? null)

  useEffect(() => {
    return onAuthStateChanged(auth, u => setCurrentUser(u))
  }, [])

  useEffect(() => {
    setLoading(true)
    getDocs(query(collection(db, 'playlists'), where('published', '==', true), orderBy('order', 'asc')))
      .then(async snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as Playlist))
        setPlaylists(all)
        const guideIds = [...new Set(all.flatMap(p => p.guideIds))]
        const guideSnaps = await Promise.all(guideIds.map(gid => getDoc(doc(db, 'guides', gid))))
        const map = new Map<string, Guide>()
        guideSnaps.forEach(s => { if (s.exists()) map.set(s.id, { id: s.id, ...s.data() } as Guide) })
        setGuidesById(map)
      })
      .catch(err => console.error('Failed to load learning paths', err))
      .finally(() => setLoading(false))
  }, [])

  async function handleToggleLike(guideId: string) {
    await toggleLike(guideId)
  }
  async function handleToggleSave(guideId: string) {
    await toggleSave(guideId)
  }

  const activePlaylist = id ? playlists.find(p => p.id === id) : undefined
  const activeGuides = activePlaylist ? activePlaylist.guideIds.map(gid => guidesById.get(gid)).filter((g): g is Guide => !!g) : []

  return (
    <>
      <header className="hub-header">
        <div className="hub-header-wrap">
          <div className="brand">
            <div className="brand-icon">🎯</div>
            <div className="brand-text">
              <h1>{lang === 'fr' ? 'Parcours d\'apprentissage' : 'Learning Paths'}</h1>
              <p>{lang === 'fr' ? 'Programmes de lecture guidés' : 'Guided reading programs'}</p>
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
        {loading ? (
          <div className="loading">{lang === 'fr' ? 'Chargement…' : 'Loading…'}</div>
        ) : id ? (
          activePlaylist ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/paths?lang=${lang}`)}>
                  {lang === 'fr' ? '← Tous les parcours' : '← All paths'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, margin: '18px 0 28px' }}>
                <div style={{ fontSize: 40 }}>{activePlaylist.icon}</div>
                <div>
                  <h2 style={{ margin: '0 0 6px' }}>
                    {lang === 'fr' && activePlaylist.title_fr ? activePlaylist.title_fr : activePlaylist.title}
                  </h2>
                  <p style={{ color: 'var(--ink-soft)', margin: 0 }}>
                    {lang === 'fr' && activePlaylist.description_fr ? activePlaylist.description_fr : activePlaylist.description}
                  </p>
                </div>
              </div>
              <div className="guide-grid">
                {activeGuides.map((guide, i) => (
                  <div key={guide.id} style={{ position: 'relative' }}>
                    <div style={{
                      position: 'absolute', top: -10, left: -10, zIndex: 1,
                      background: 'var(--orange)', color: '#fff', fontWeight: 700,
                      fontFamily: 'var(--mono)', fontSize: 12, width: 26, height: 26,
                      borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: '2px solid var(--ink)',
                    }}>{i + 1}</div>
                    <GuideCard
                      guide={guide}
                      lang={lang}
                      liked={library.get(guide.id)?.liked ?? false}
                      saved={library.get(guide.id)?.saved ?? false}
                      onOpen={() => navigate(`/guide/${guide.id}?lang=${lang}`)}
                      onToggleLike={() => handleToggleLike(guide.id)}
                      onToggleSave={() => handleToggleSave(guide.id)}
                    />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <span className="icon">🤷</span>
              <p>{lang === 'fr' ? 'Parcours introuvable.' : 'Learning path not found.'}</p>
            </div>
          )
        ) : playlists.length === 0 ? (
          <div className="empty-state">
            <span className="icon">📭</span>
            <p>{lang === 'fr' ? 'Aucun parcours pour le moment.' : 'No learning paths yet.'}</p>
          </div>
        ) : (
          <div className="guide-grid">
            {playlists.map(playlist => (
              <div
                key={playlist.id}
                className="guide-card"
                onClick={() => navigate(`/paths/${playlist.id}?lang=${lang}`)}
              >
                <div className="card-top">
                  <div className="card-icon">{playlist.icon}</div>
                  <div className="card-meta">
                    <div className="card-tag">{lang === 'fr' ? 'Parcours' : 'Learning Path'}</div>
                    <div className="card-title">
                      {lang === 'fr' && playlist.title_fr ? playlist.title_fr : playlist.title}
                    </div>
                  </div>
                </div>
                <div className="card-desc">
                  {lang === 'fr' && playlist.description_fr ? playlist.description_fr : playlist.description}
                </div>
                <div className="card-footer">
                  <div className="card-chips">
                    <span className="chip">
                      {playlist.guideIds.length} {lang === 'fr' ? 'guides' : 'guides'}
                    </span>
                  </div>
                  <span className="card-arrow">→</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  )
}
