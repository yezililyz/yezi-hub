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
}

interface GuideCardProps {
  guide: GuideCardData
  lang: 'en' | 'fr'
  liked: boolean
  saved: boolean
  isNew?: boolean
  onOpen: () => void
  onToggleLike: () => void
  onToggleSave: () => void
}

// Defensive guard against leaked translation-pipeline artifacts (the LLM
// sometimes echoes a "§"-based segment separator into translated text
// instead of a clean value — see guide-builder/RECURRENT_BUGS.md). Auto-fall
// back to the English value rather than ever show broken text to a reader.
function isClean(s: string | undefined | null): s is string {
  return !!s && !s.includes('§')
}

export default function GuideCard({ guide, lang, liked, saved, isNew, onOpen, onToggleLike, onToggleSave }: GuideCardProps) {
  const title = lang === 'fr' && isClean(guide.title_fr) ? guide.title_fr : guide.title
  const desc = lang === 'fr' && isClean(guide.description_fr) ? guide.description_fr : guide.description
  const tag = lang === 'fr' && isClean(guide.tag_fr) ? guide.tag_fr : guide.tag
  const chipsFr = lang === 'fr' && Array.isArray(guide.chips_fr) ? guide.chips_fr.filter(isClean) : undefined
  const chips = chipsFr && chipsFr.length > 0 ? chipsFr : guide.chips
  const isPrivate = guide.visibility === 'private' || guide.private

  const visibleChips = chips?.slice(0, 2) ?? []
  const extraChipCount = (chips?.length ?? 0) - visibleChips.length

  return (
    <div className="reader-card" onClick={onOpen}>
      <div className="reader-card-top">
        <div className="reader-card-tag">{tag}</div>
        <div className="reader-card-title">{title}</div>
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
        </div>
      </div>
    </div>
  )
}
