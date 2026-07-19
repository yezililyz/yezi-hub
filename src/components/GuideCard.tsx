import { useState } from 'react'
import CoverArt from './CoverArt'

interface GuideCardData {
  id: string
  title: string
  title_fr?: string
  description: string
  description_fr?: string
  icon: string
  tag: string
  tag_fr?: string
  chips: string[]
  chips_fr?: string[]
  visibility?: 'public' | 'private' | 'draft'
  private?: boolean
  likeCount?: number
  updated_at?: { toMillis?: () => number; seconds?: number } | null
  level?: string
  topics?: string[]
  format?: string[]
  overlay?: string[]
}

export interface QuickTagUpdate {
  level: string
  topics: string[]
  format: string[]
  overlay: string[]
}

interface GuideCardProps {
  guide: GuideCardData
  lang: 'en' | 'fr'
  liked: boolean
  saved: boolean
  isNew?: boolean
  isAdmin?: boolean
  onOpen: () => void
  onToggleLike: () => void
  onToggleSave: () => void
  onQuickTagSave?: (update: QuickTagUpdate) => void
}

// Same controlled vocabularies as PublicHub.tsx/AdminHub.tsx — kept as an
// independent copy per this codebase's existing per-file convention.
const QT_LEVELS = ['Beginner', 'Intermediate', 'Advanced']
const QT_TOPICS = [
  'Growth & Retention', 'Strategy & Positioning', 'Team & Organization', 'Building & Shipping',
  'Operating Cadence & Communication', 'Discovery & Research', 'Launch & Go-to-Market',
  'Planning & Prioritization', 'Career',
]
const QT_FORMAT = ['Checklist', 'Templates', 'Interactive Tool', 'Reference']
const QT_OVERLAY = ['Zero-to-One / Founder', 'Marketplace', 'Building AI Products', 'Enterprise/PLG']

// Defensive guard against leaked translation-pipeline artifacts (the LLM
// sometimes echoes a "§"-based segment separator into translated text
// instead of a clean value — see guide-builder/RECURRENT_BUGS.md). Auto-fall
// back to the English value rather than ever show broken text to a reader.
function isClean(s: string | undefined | null): s is string {
  return !!s && !s.includes('§')
}

function formatUpdated(ts: GuideCardData['updated_at'], lang: 'en' | 'fr'): string | null {
  if (!ts) return null
  const millis = typeof ts.toMillis === 'function' ? ts.toMillis() : (typeof ts.seconds === 'number' ? ts.seconds * 1000 : 0)
  if (!millis) return null
  const formatted = new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(millis))
  return lang === 'fr' ? `Mis à jour le ${formatted}` : `Updated ${formatted}`
}

export default function GuideCard({ guide, lang, liked, saved, isNew, isAdmin, onOpen, onToggleLike, onToggleSave, onQuickTagSave }: GuideCardProps) {
  const title = lang === 'fr' && isClean(guide.title_fr) ? guide.title_fr : guide.title
  const desc = lang === 'fr' && isClean(guide.description_fr) ? guide.description_fr : guide.description
  const chipsFr = lang === 'fr' && Array.isArray(guide.chips_fr) ? guide.chips_fr.filter(isClean) : undefined
  const chips = chipsFr && chipsFr.length > 0 ? chipsFr : guide.chips
  const isPrivate = guide.visibility === 'private' || guide.private

  const visibleChips = chips?.slice(0, 2) ?? []
  const extraChipCount = (chips?.length ?? 0) - visibleChips.length
  const updatedLabel = formatUpdated(guide.updated_at, lang)

  const [quickTagOpen, setQuickTagOpen] = useState(false)
  const [qtLevel, setQtLevel] = useState(guide.level || '')
  const [qtTopics, setQtTopics] = useState<string[]>(guide.topics || [])
  const [qtFormat, setQtFormat] = useState<string[]>(guide.format || [])
  const [qtOverlay, setQtOverlay] = useState<string[]>(guide.overlay || [])

  function toggleIn(arr: string[], set: (v: string[]) => void, val: string, max: number) {
    set(arr.includes(val) ? arr.filter(v => v !== val) : arr.length >= max ? arr : [...arr, val])
  }

  function saveQuickTags() {
    onQuickTagSave?.({ level: qtLevel, topics: qtTopics, format: qtFormat, overlay: qtOverlay })
    setQuickTagOpen(false)
  }

  return (
    <div className="reader-card" onClick={onOpen}>
      <div className="reader-card-top">
        <div className="reader-card-title">{title}</div>
        {updatedLabel && <div className="reader-card-date">{updatedLabel}</div>}
      </div>
      <div className="reader-card-banner">
        <CoverArt contentType={guide.tag} />
        {(isNew || isPrivate) && (
          <div className="reader-card-badges">
            {isNew && (
              <span className="card-new-badge">
                {lang === 'fr' ? '✨ Nouveau' : '✨ New'}
              </span>
            )}
            {isPrivate && (
              <span className="card-private-badge">
                {lang === 'fr' ? '🔒 Privé' : '🔒 Private'}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="reader-card-body">
        <p className="reader-card-desc">{desc}</p>
      </div>
      <div className="reader-card-footer">
        <div className="card-chips">
          {visibleChips.map(c => <span key={c} className="chip">{c}</span>)}
          {extraChipCount > 0 && <span className="chip">+{extraChipCount}</span>}
        </div>
        <div className="card-actions" onClick={e => e.stopPropagation()}>
          <button className={`card-like-btn ${liked ? 'liked' : ''}`} onClick={onToggleLike} title={liked ? (lang === 'fr' ? 'Retirer le like' : 'Unlike') : (lang === 'fr' ? "J'aime" : 'Like')}>
            {liked ? '❤️' : '🤍'} <span>{guide.likeCount ?? 0}</span>
          </button>
          <button className={`card-save-btn ${saved ? 'saved' : ''}`} onClick={onToggleSave}>
            {saved
              ? (lang === 'fr' ? '🔖 Sauvé' : '🔖 Saved')
              : (lang === 'fr' ? '＋ Sauvegarder' : '＋ Save')}
          </button>
          {isAdmin && (
            <button
              className="card-quicktag-btn"
              title="Quick-edit metatags"
              onClick={() => setQuickTagOpen(v => !v)}
            >
              {quickTagOpen ? '×' : '+'}
            </button>
          )}
        </div>
      </div>
      {quickTagOpen && (
        <div className="quick-tag-panel" onClick={e => e.stopPropagation()}>
          <div className="qt-row">
            <span className="qt-label">Level</span>
            {QT_LEVELS.map(l => (
              <button key={l} className={`qt-pill ${qtLevel === l ? 'active' : ''}`} onClick={() => setQtLevel(prev => prev === l ? '' : l)}>{l}</button>
            ))}
          </div>
          <div className="qt-row">
            <span className="qt-label">Topics</span>
            {QT_TOPICS.map(t => (
              <button key={t} className={`qt-pill ${qtTopics.includes(t) ? 'active' : ''}`} onClick={() => toggleIn(qtTopics, setQtTopics, t, 2)}>{t}</button>
            ))}
          </div>
          <div className="qt-row">
            <span className="qt-label">Format</span>
            {QT_FORMAT.map(f => (
              <button key={f} className={`qt-pill ${qtFormat.includes(f) ? 'active' : ''}`} onClick={() => toggleIn(qtFormat, setQtFormat, f, 2)}>{f}</button>
            ))}
          </div>
          <div className="qt-row">
            <span className="qt-label">Overlay</span>
            {QT_OVERLAY.map(o => (
              <button key={o} className={`qt-pill ${qtOverlay.includes(o) ? 'active' : ''}`} onClick={() => toggleIn(qtOverlay, setQtOverlay, o, 2)}>{o}</button>
            ))}
          </div>
          <button className="btn btn-primary btn-sm qt-save" onClick={saveQuickTags}>Save tags</button>
        </div>
      )}
    </div>
  )
}
