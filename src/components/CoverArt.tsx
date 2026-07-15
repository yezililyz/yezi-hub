// Hand-drawn-style line-art cover illustrations, one per Content Type
// taxonomy value (see CONTENT_TYPES in AdminHub.tsx) — reused across every
// guide sharing that type rather than generated per-guide, so the look
// stays consistent and there's no per-guide image cost/hosting to manage.

function IconFrame({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 64 64" width="34" height="34" fill="none" stroke="#1c1814" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

function BookIcon() {
  return (
    <IconFrame>
      <path d="M10 14 C 18 10, 26 10, 32 14 C 38 10, 46 10, 54 14 L 54 50 C 46 46, 38 46, 32 50 C 26 46, 18 46, 10 50 Z" />
      <path d="M32 14 L32 50" />
      <path d="M16 22 L26 20" />
      <path d="M16 30 L26 28" />
      <path d="M38 20 L48 22" />
      <path d="M38 28 L48 30" />
    </IconFrame>
  )
}

function BlueprintIcon() {
  return (
    <IconFrame>
      <rect x="10" y="12" width="44" height="40" rx="2" />
      <path d="M10 24 L54 24" />
      <path d="M24 24 L24 52" />
      <path d="M38 12 L38 24" />
      <circle cx="16" cy="18" r="1.5" fill="#1c1814" />
      <path d="M30 34 L48 34" />
      <path d="M30 42 L44 42" />
    </IconFrame>
  )
}

function MagnifierIcon() {
  return (
    <IconFrame>
      <rect x="10" y="10" width="26" height="34" rx="2" />
      <path d="M16 18 L30 18" />
      <path d="M16 25 L30 25" />
      <path d="M16 32 L24 32" />
      <circle cx="40" cy="38" r="10" />
      <path d="M47 45 L56 54" />
    </IconFrame>
  )
}

function CompassIcon() {
  return (
    <IconFrame>
      <circle cx="32" cy="32" r="22" />
      <path d="M32 8 L32 13" />
      <path d="M32 51 L32 56" />
      <path d="M8 32 L13 32" />
      <path d="M51 32 L56 32" />
      <path d="M32 18 L38 32 L32 46 L26 32 Z" />
    </IconFrame>
  )
}

function ToolboxIcon() {
  return (
    <IconFrame>
      <rect x="8" y="26" width="48" height="26" rx="3" />
      <path d="M22 26 L22 18 C 22 15, 24 13, 27 13 L37 13 C 40 13, 42 15, 42 18 L 42 26" />
      <path d="M8 38 L56 38" />
      <rect x="28" y="34" width="8" height="8" rx="1" />
    </IconFrame>
  )
}

function MicIcon() {
  return (
    <IconFrame>
      <rect x="24" y="8" width="16" height="28" rx="8" />
      <path d="M16 28 C 16 38, 23 45, 32 45 C 41 45, 48 38, 48 28" />
      <path d="M32 45 L32 56" />
      <path d="M22 56 L42 56" />
    </IconFrame>
  )
}

function FeatherIcon() {
  return (
    <IconFrame>
      <path d="M42 10 C 30 10, 18 22, 18 38 C 18 46, 22 50, 22 50 C 22 50, 44 48, 50 26 C 52 18, 48 12, 42 10 Z" />
      <path d="M22 50 L44 22" />
      <path d="M28 42 L34 36" />
      <path d="M22 50 L14 58" />
      <path d="M6 40 L12 42" />
      <path d="M6 48 L13 48" />
    </IconFrame>
  )
}

function DocumentIcon() {
  return (
    <IconFrame>
      <path d="M16 8 L38 8 L48 18 L48 56 L16 56 Z" />
      <path d="M38 8 L38 18 L48 18" />
      <path d="M22 28 L42 28" />
      <path d="M22 36 L42 36" />
      <path d="M22 44 L34 44" />
    </IconFrame>
  )
}

const COVER_STYLES: Record<string, { bg: string; icon: () => React.ReactNode }> = {
  'Playbook': { bg: '#b86b4a', icon: BookIcon },
  'Framework': { bg: '#5c7f99', icon: BlueprintIcon },
  'Case Study/Teardown': { bg: '#9c5233', icon: MagnifierIcon },
  'Field Guide': { bg: '#6d8c6b', icon: CompassIcon },
  'Toolkit': { bg: '#b8934a', icon: ToolboxIcon },
  'Interview Guide': { bg: '#7d5f8a', icon: MicIcon },
  'Personal Notes': { bg: '#6f6ba0', icon: FeatherIcon },
}
const DEFAULT_STYLE = { bg: '#8a7d70', icon: DocumentIcon }

export default function CoverArt({ contentType }: { contentType?: string }) {
  const style = (contentType && COVER_STYLES[contentType]) || DEFAULT_STYLE
  const Icon = style.icon
  return (
    <div className="cover-art" style={{ background: style.bg }}>
      <div className="cover-art-frame">
        <Icon />
      </div>
    </div>
  )
}
