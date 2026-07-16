// Bold, abstract geometric cover marks — one per Content Type taxonomy value
// (see CONTENT_TYPES in AdminHub.tsx), reused across every guide sharing that
// type rather than generated per-guide, so the look stays consistent and
// there's no per-guide image cost/hosting to manage. Solid filled shapes
// (not line art) on a warm gradient, with a thin decorative squiggle behind
// the mark, per the reference mood board.

function Mark({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 64 64" width="34" height="34" fill="#faf3e6">
      {children}
    </svg>
  )
}

// Playbook — an abstracted open-page/flag fold
function PlaybookMark() {
  return (
    <Mark>
      <path d="M32 6 L54 20 C 54 20, 50 40, 32 58 C 14 40, 10 20, 10 20 Z" />
      <path d="M32 6 L32 58" fill="none" stroke="#9c5233" strokeWidth="2.5" opacity="0.35" />
    </Mark>
  )
}

// Framework — a segmented rounded square (quadrant blueprint)
function FrameworkMark() {
  return (
    <Mark>
      <path d="M12 8 h20 a4 4 0 0 1 4 4 v20 h-24 a4 4 0 0 1 -4 -4 v-16 a4 4 0 0 1 4 -4 Z" />
      <path d="M36 12 h16 a4 4 0 0 1 4 4 v16 h-20 z" />
      <path d="M12 40 h20 v20 h-16 a4 4 0 0 1 -4 -4 z" />
      <circle cx="46" cy="46" r="10" />
    </Mark>
  )
}

// Case Study/Teardown — a magnifier abstracted into a crescent + dot
function TeardownMark() {
  return (
    <Mark>
      <path d="M28 8 a20 20 0 1 0 0.1 0 Z M28 16 a12 12 0 1 1 -0.1 0" fillRule="evenodd" />
      <circle cx="49" cy="49" r="7" />
    </Mark>
  )
}

// Field Guide — a four-point compass star
function FieldGuideMark() {
  return (
    <Mark>
      <path d="M32 4 L39 27 L60 32 L39 37 L32 60 L25 37 L4 32 L25 27 Z" />
      <circle cx="32" cy="32" r="5" fill="#6d8c6b" opacity="0.4" />
    </Mark>
  )
}

// Toolkit — a faceted hexagon with a notch
function ToolkitMark() {
  return (
    <Mark>
      <path d="M32 6 L54 18 V 44 L32 58 L10 44 V 18 Z" />
      <path d="M32 6 L32 32 L10 18 Z" fill="#b8934a" opacity="0.35" />
      <circle cx="32" cy="34" r="7" fill="#faf3e6" stroke="#b8934a" strokeWidth="2" opacity="0.9" />
    </Mark>
  )
}

// Interview Guide — an abstracted speech bubble
function InterviewMark() {
  return (
    <Mark>
      <path d="M10 12 h44 a4 4 0 0 1 4 4 v22 a4 4 0 0 1 -4 4 H26 L14 54 V 42 H10 a4 4 0 0 1 -4 -4 V16 a4 4 0 0 1 4 -4 Z" />
      <circle cx="22" cy="27" r="3" fill="#7d5f8a" />
      <circle cx="32" cy="27" r="3" fill="#7d5f8a" />
      <circle cx="42" cy="27" r="3" fill="#7d5f8a" />
    </Mark>
  )
}

// Personal Notes — a sparkle + swoosh (feather motion, abstracted)
function PersonalNotesMark() {
  return (
    <Mark>
      <path d="M40 6 L44 20 L58 24 L44 28 L40 42 L36 28 L22 24 L36 20 Z" />
      <path d="M8 50 C 16 44, 20 36, 18 30" fill="none" stroke="#6f6ba0" strokeWidth="3" strokeLinecap="round" opacity="0.55" />
      <circle cx="14" cy="52" r="4" />
    </Mark>
  )
}

function DefaultMark() {
  return (
    <Mark>
      <path d="M16 6 L38 6 L48 16 V 58 H16 Z" />
      <path d="M38 6 L38 16 L48 16 Z" fill="#8a7d70" opacity="0.4" />
    </Mark>
  )
}

const COVER_STYLES: Record<string, { from: string; to: string; accent: string; icon: () => React.ReactNode }> = {
  'Playbook':             { from: '#e7a37a', to: '#b0603d', accent: '#f2c9a8', icon: PlaybookMark },
  'Framework':            { from: '#8fb2c9', to: '#4a6b81', accent: '#c3dbe8', icon: FrameworkMark },
  'Case Study/Teardown':  { from: '#c98564', to: '#823f22', accent: '#e8b998', icon: TeardownMark },
  'Field Guide':          { from: '#9bbb92', to: '#516b4f', accent: '#cfe2ca', icon: FieldGuideMark },
  'Toolkit':              { from: '#dab86e', to: '#96742f', accent: '#f0dcac', icon: ToolkitMark },
  'Interview Guide':      { from: '#a888b8', to: '#5f4770', accent: '#d8c3e3', icon: InterviewMark },
  'Personal Notes':       { from: '#9793c2', to: '#544f85', accent: '#cfccea', icon: PersonalNotesMark },
}
const DEFAULT_STYLE = { from: '#b0a596', to: '#6e6153', accent: '#ded4c5', icon: DefaultMark }

export default function CoverArt({ contentType }: { contentType?: string }) {
  const style = (contentType && COVER_STYLES[contentType]) || DEFAULT_STYLE
  const Icon = style.icon
  return (
    <div
      className="cover-art"
      style={{ background: `radial-gradient(120% 140% at 15% 10%, ${style.from} 0%, ${style.to} 75%)` }}
    >
      <svg className="cover-art-squiggle" viewBox="0 0 200 118" preserveAspectRatio="none">
        <path
          d="M-10 100 C 30 40, 60 90, 100 20 C 130 -20, 150 60, 190 10"
          fill="none"
          stroke={style.accent}
          strokeWidth="1.5"
          opacity="0.55"
        />
      </svg>
      <div className="cover-art-frame">
        <Icon />
      </div>
    </div>
  )
}
