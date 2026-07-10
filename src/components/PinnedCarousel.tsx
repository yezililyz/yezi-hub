interface PinnedGuide {
  id: string
  title: string
  title_fr?: string
  icon: string
  tag?: string
  tag_fr?: string
}

interface PinnedCarouselProps {
  guides: PinnedGuide[]
  lang: 'en' | 'fr'
  onSelect: (id: string) => void
  onUnpin?: (id: string) => void
}

export default function PinnedCarousel({ guides, lang, onSelect, onUnpin }: PinnedCarouselProps) {
  if (guides.length === 0) return null

  return (
    <div className="pinned-section">
      <div className="pinned-header">
        <span className="pinned-header-label">
          <span className="pinned-pin">📌</span>
          {lang === 'fr' ? 'Épinglés & recommandés' : 'Pinned & Recommended'}
        </span>
        <span className="pinned-count">
          {guides.length} {lang === 'fr' ? 'épinglé' + (guides.length !== 1 ? 's' : '') : 'Pinned'}
        </span>
      </div>
      <div className="pinned-carousel">
        {guides.map(g => {
          const title = lang === 'fr' ? (g.title_fr || g.title) : g.title
          const tag = lang === 'fr' ? (g.tag_fr || g.tag) : g.tag
          return (
            <div key={g.id} className="pin-chip" onClick={() => onSelect(g.id)}>
              <span className="pin-chip-icon">{g.icon}</span>
              <span className="pin-chip-title">{title}</span>
              {tag && <span className="pin-chip-tag">{tag}</span>}
              {onUnpin && (
                <button
                  className="pin-chip-unpin"
                  title={lang === 'fr' ? 'Désépingler' : 'Unpin'}
                  onClick={e => { e.stopPropagation(); onUnpin(g.id) }}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
