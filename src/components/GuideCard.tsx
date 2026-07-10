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

export default function GuideCard({ guide, lang, liked, saved, isNew, onOpen, onToggleLike, onToggleSave }: GuideCardProps) {
  const title = lang === 'fr' ? (guide.title_fr || guide.title) : guide.title
  const desc = lang === 'fr' ? (guide.description_fr || guide.description) : guide.description
  const tag = lang === 'fr' ? (guide.tag_fr || guide.tag) : guide.tag
  const chips = lang === 'fr' && guide.chips_fr && guide.chips_fr.length > 0 ? guide.chips_fr : guide.chips
  const isPrivate = guide.visibility === 'private' || guide.private

  return (
    <div className="guide-card" onClick={onOpen}>
      <div className="card-top">
        <div className="card-icon">{guide.icon}</div>
        <div className="card-meta">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="card-tag">{tag}</div>
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
          <div className="card-title">{title}</div>
        </div>
      </div>
      <p className="card-desc">{desc}</p>
      <div className="card-footer">
        <div className="card-chips">
          {chips?.map(c => <span key={c} className="chip">{c}</span>)}
        </div>
        <div className="card-actions" onClick={e => e.stopPropagation()}>
          <button className={`card-like-btn ${liked ? 'liked' : ''}`} onClick={onToggleLike} title={liked ? (lang === 'fr' ? 'Retirer le like' : 'Unlike') : (lang === 'fr' ? "J'aime" : 'Like')}>
            {liked ? '❤️' : '🤍'} <span>{guide.likeCount ?? 0}</span>
          </button>
          <button className={`card-save-btn ${saved ? 'saved' : ''}`} onClick={onToggleSave}>
            {saved
              ? (lang === 'fr' ? '🔖 Dans ma bibliothèque' : '🔖 In Library')
              : (lang === 'fr' ? '＋ Sauvegarder' : '＋ Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
